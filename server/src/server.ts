import { timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { v4 as uuidv4 } from "uuid";
import { getRedis } from "./redis.js";
import { signClaimToken, verifyClaimToken, signShareToken } from "./crypto.js";
import { scoreSession, DIFFS, type Difficulty } from "./game.js";
import { createGame, revealCell, readFinishedGame, isUsed, markUsed } from "./board.js";
import { addScore, getLeaderboard as getLb } from "./leaderboard.js";
import { storeClaim, getClaimStatus, executeClaim } from "./claim.js";
import { reserveName } from "./names.js";
import { resolveClientIp } from "./ip.js";

const app = new Hono();

const PORT = Number(process.env.PORT ?? 3001);

// Fixed identity for the running event -- keeps each name to one leaderboard row.
// Bumping this string starts a fresh leaderboard (old scores live under the old key).
const SEASON = "kubecon-japan-2026";

/* ---- CORS ---- */
const DEV_ORIGINS = ["http://localhost:5500", "http://127.0.0.1:5500", "http://localhost:8080", "http://127.0.0.1:8080"];
app.use(
  "/*",
  cors({
    origin: (origin) => {
      if (!origin) return "*";
      if (origin === "https://minesweeper.metalbear.com") return origin;
      // Allow any localhost origin in dev
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
      if (DEV_ORIGINS.includes(origin)) return origin;
      return null;
    },
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  })
);

/* ---- Rate limiting: Redis incr + expire (100 scored submissions / IP / 10 min) ----
   Counts only finalized, verified games (see the call site). It's per-IP, so a whole
   office / launch-week WiFi shares one bucket -- keep the cap generous. */
async function checkRateLimit(ip: string): Promise<boolean> {
  const redis = getRedis();
  const key = `ratelimit:submit:${ip}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 600);
  return count <= 100;
}

function getIp(c: Context): string {
  return resolveClientIp(c.req.header("cf-connecting-ip"), c.req.header("x-forwarded-for"));
}

/* ---- POST /game/start ---- */
app.post("/game/start", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { difficulty?: string };
  const difficulty = body.difficulty as Difficulty;

  if (!DIFFS[difficulty]) {
    return c.json({ error: "invalid difficulty" }, 400);
  }

  const redis = getRedis();
  const gameId = uuidv4();
  await createGame(redis, gameId, difficulty);

  // No mine layout is generated (or handed out) yet -- see board.ts. It's
  // created on the first /game/reveal, safe-zoned around that click.
  return c.json({
    gameId,
    serverTimeUTC: Math.floor(Date.now() / 1000),
  });
});

/* ---- POST /game/reveal ----
   One real click, one call. This is what makes the board server-authoritative:
   a caller only ever learns the cells a click actually opened, never the full
   layout up front, so there's nothing to solve offline. */
app.post("/game/reveal", async (c) => {
  const body = await c.req.json().catch(() => null) as null | { gameId?: string; x?: number; y?: number };
  if (!body || !body.gameId || typeof body.x !== "number" || typeof body.y !== "number") {
    return c.json({ error: "missing required fields" }, 400);
  }

  const redis = getRedis();
  const result = await revealCell(redis, body.gameId, body.x, body.y);
  if (!result.ok) {
    return c.json({ error: result.error }, result.error.startsWith("game not found") ? 404 : 400);
  }
  return c.json(result);
});

/* ---- POST /game/submit ----
   No moves/seed/timing fields anymore -- the outcome (won, revealed, timeSeconds)
   is read straight out of the server-tracked game record built up by /game/reveal
   calls, so there's nothing here for a client to lie about. */
app.post("/game/submit", async (c) => {
  const body = await c.req.json().catch(() => null) as null | {
    gameId?: string;
    handle?: string;
    nameKey?: string;
    email?: string;
  };

  if (!body || !body.gameId) return c.json({ error: "bad request" }, 400);
  const { gameId, handle } = body;

  const redis = getRedis();

  if (await isUsed(redis, gameId)) {
    return c.json({ error: "game already submitted" }, 409);
  }

  const finalized = await readFinishedGame(redis, gameId);
  if (!finalized.ok) return c.json({ error: finalized.error }, 404);

  // NOTE: we score BEFORE marking the game used, so a submission that is
  // rejected for a missing/taken name can be retried under a different name.
  // The single-use guard (markUsed) only fires once we actually finalise.
  const { difficulty, won, revealed, timeSeconds } = finalized.game;
  const conf = DIFFS[difficulty];

  // A *win* claimed impossibly fast (sub-floor real elapsed time) is rejected;
  // a fast loss is legitimate. Both firstRevealAt and finishedAt are server
  // timestamps from real requests, so this now guards raw request pacing
  // rather than a client-supplied claim.
  if (won && timeSeconds < conf.minTimeSeconds) {
    await markUsed(redis, gameId);
    return c.json({ accepted: false, reason: `time ${timeSeconds}s too fast (min ${conf.minTimeSeconds}s)` }, 422);
  }

  const score = scoreSession(difficulty, won, revealed, timeSeconds);

  // Sanitise handle -- empty string means "no name given".
  const safeHandle = sanitiseHandle(handle);

  // No name => show the score, but never write an anon row to the board.
  // Game stays unused so the player can add a name and resubmit.
  if (!safeHandle) {
    return c.json({ accepted: true, won, revealed, score, timeSeconds, rank: null, onLeaderboard: false, reason: "name_required" });
  }

  // First-come name ownership: a name is locked to the first nameKey that used it.
  if (typeof body.nameKey !== "string" || body.nameKey.length < 8) {
    return c.json({ error: "missing nameKey" }, 400);
  }
  if ((await reserveName(redis, safeHandle, body.nameKey)) === "taken") {
    // Return the score so the player keeps it; game stays unused for a rename+retry.
    return c.json({ accepted: true, won, revealed, score, timeSeconds, rank: null, onLeaderboard: false, reason: "name_taken" });
  }

  // Rate limit here -- only count verified, name-settled games about to be scored.
  // Checking before verification let junk/tampered submits and the client's name-retry
  // loop burn the per-IP budget, locking out honest players on a shared launch-week IP.
  if (!(await checkRateLimit(getIp(c)))) {
    return c.json({ error: "rate limit exceeded -- slow down!" }, 429);
  }

  // Finalise: consume the game exactly once now that the name is settled.
  if (!(await markUsed(redis, gameId))) {
    return c.json({ error: "game already submitted" }, 409);
  }

  // Record on the running leaderboard (GT keeps the player's highest score).
  // SEASON is fixed for the whole event so a name maps to one row (no daily reset).
  const claimToken = signClaimToken(difficulty, SEASON, safeHandle);
  const rank = await addScore(redis, difficulty, claimToken, safeHandle, score);
  const isLeader = rank === 1;

  // Store claim record
  await storeClaim(redis, claimToken, difficulty, SEASON, safeHandle, rank);

  // Capture the player's email (collected in the start popup) so we can reach the
  // winner if they're not at the booth. Keyed by name within the event; overwrites
  // on replay so the latest address wins. Skipped silently if absent/malformed.
  const email = (body.email ?? "").trim().slice(0, 120);
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    await redis.hset(`emails:${SEASON}`, safeHandle, email);
  }

  // Build share token compatible with share-image-service
  const shareToken = signShareToken({
    handle: safeHandle,
    timeSeconds,
    difficulty,
    isWinner: won,
    url: "minesweeper.metalbear.com",
  });

  return c.json({
    accepted: true,
    won,
    revealed,
    score,
    timeSeconds,
    rank,
    isLeader,
    onLeaderboard: true,
    claimToken,
    shareToken,
  });
});

/* ---- GET /leaderboard ---- */
app.get("/leaderboard", async (c) => {
  const difficulty = c.req.query("difficulty") as Difficulty;
  const myToken = c.req.query("myToken");

  if (!DIFFS[difficulty]) {
    return c.json({ error: "invalid difficulty" }, 400);
  }

  const redis = getRedis();

  // Extract claimToken from myToken (myToken is the full claimToken)
  const data = await getLb(redis, difficulty, myToken || undefined, 100);

  return c.json({ difficulty, ...data });
});

/* ---- GET /claim/status ---- */
app.get("/claim/status", async (c) => {
  const token = c.req.query("token");
  if (!token) return c.json({ error: "missing token" }, 400);

  const redis = getRedis();
  const status = await getClaimStatus(redis, token);
  if (!status.found) return c.json({ error: "not found" }, 404);

  return c.json({
    isLeader: status.isLeader,
    claimWindowOpen: status.claimWindowOpen,
    resetInSeconds: status.resetInSeconds,
    claimed: status.claimed,
  });
});

/* ---- POST /claim ---- */
app.post("/claim", async (c) => {
  const body = await c.req.json().catch(() => null) as null | {
    claimToken?: string;
    email?: string;
    shippingAddress?: string;
  };
  if (!body || !body.claimToken || !body.email) {
    return c.json({ error: "claimToken and email required" }, 400);
  }

  // Verify the claim token signature before touching Redis
  try {
    verifyClaimToken(body.claimToken);
  } catch {
    return c.json({ error: "invalid claim token" }, 403);
  }

  const redis = getRedis();
  const result = await executeClaim(redis, body.claimToken, body.email, body.shippingAddress ?? "");

  if (result === "ok") return c.json({ ok: true });
  if (result === "already_claimed") return c.json({ error: "already claimed" }, 409);
  if (result === "not_leader") return c.json({ error: "not the current leader" }, 403);
  if (result === "window_closed") return c.json({ error: "claim window not open" }, 403);
  return c.json({ error: "not found" }, 404);
});

/* ---- GET /admin/emails.csv?key=<token> ----
   Downloads captured players as CSV (name,email,expert_score). Guarded by the
   ADMIN_TOKEN secret; disabled entirely when that secret isn't set, so it can
   never be left open on a default. */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";

function tokenOk(provided: string | undefined): boolean {
  if (!ADMIN_TOKEN || !provided) return false;
  const a = Buffer.from(provided), b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Throttle the admin endpoint so it can't be used as a free token-brute oracle.
async function checkAdminRateLimit(ip: string): Promise<boolean> {
  const redis = getRedis();
  const key = `ratelimit:admin:${ip}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 600);
  return count <= 30;
}

// Quote for CSV AND neutralise spreadsheet formula injection: a cell starting
// with = + - @ (or a control char) gets a leading apostrophe so Excel/Sheets
// treat player-controlled names/emails as text, never as a formula.
function csvCell(s: string): string {
  const guarded = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return `"${guarded.replace(/"/g, '""')}"`;
}

app.get("/admin/emails.csv", async (c) => {
  if (!ADMIN_TOKEN) return c.json({ error: "admin export disabled" }, 503);
  if (!(await checkAdminRateLimit(getIp(c)))) return c.json({ error: "rate limit exceeded" }, 429);

  // Accept the token via Authorization: Bearer <token> (keeps it out of logs)
  // or the ?key= query param (convenient for a browser download).
  const auth = c.req.header("authorization");
  const headerToken = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
  if (!tokenOk(c.req.query("key") ?? headerToken)) return c.json({ error: "forbidden" }, 403);

  const redis = getRedis();
  const emails = await redis.hgetall(`emails:${SEASON}`) as Record<string, string>;

  // Join with the Expert leaderboard (the prize board). Members are stored as
  // `{claimToken}:{handle}`, so map handle -> score (one entry per name).
  const rawLb = await redis.zrevrange("lb:expert", 0, -1, "WITHSCORES");
  const expertByName: Record<string, number> = {};
  for (let i = 0; i < rawLb.length; i += 2) {
    const member = rawLb[i];
    const c = member.indexOf(":");
    const handle = c === -1 ? member : member.slice(c + 1);
    expertByName[handle] = Number(rawLb[i + 1]);
  }

  const rows = Object.entries(emails).map(([name, email]) => {
    const s = expertByName[name];
    return `${csvCell(name)},${csvCell(email)},${s != null ? s : ""}`;
  });
  const csv = ["name,email,expert_score", ...rows].join("\n") + "\n";

  return c.body(csv, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="minesweeper-emails-${SEASON}.csv"`,
    "Cache-Control": "no-store",
  });
});

/* ---- Health check ---- */
app.get("/health", c => c.json({ ok: true }));

/* ---- Static frontend (web/) ---- served last so API routes win.
   serveStatic returns files that exist and calls next() otherwise, so it
   only handles /, /index.html, /game.js, etc. WEB_ROOT is relative to cwd. */
const WEB_ROOT = process.env.WEB_ROOT ?? "./web";
// no-cache => browser revalidates every load, so a redeploy is never served stale.
app.use("/*", serveStatic({
  root: WEB_ROOT,
  onFound: (_path, c) => c.header("Cache-Control", "no-cache"),
}));

/* ---- Boot ---- */
serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`minesweeper-server listening on http://localhost:${PORT}`);
});

/* ---- Helpers ---- */
// Returns "" when no usable name was given -- callers treat that as "keep off the board".
function sanitiseHandle(raw: string | undefined): string {
  if (!raw) return "";
  return raw.replace(/[^\x20-\x7E]/g, "").trim().slice(0, 14);
}
