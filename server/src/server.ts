import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { v4 as uuidv4 } from "uuid";
import { getRedis } from "./redis.js";
import { generateSeed, signSeed, verifySeed, signClaimToken, verifyClaimToken, signShareToken } from "./crypto.js";
import { replayVerify, scoreSession, DIFFS, type Difficulty, type Move } from "./game.js";
import { addScore, getLeaderboard as getLb } from "./leaderboard.js";
import { storeClaim, getClaimStatus, executeClaim } from "./claim.js";
import { reserveName } from "./names.js";

const app = new Hono();

const PORT = Number(process.env.PORT ?? 3001);

// Fixed identity for the running event -- keeps each name to one leaderboard row.
const SEASON = "launchweek";

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

/* ---- Rate limiting: Redis incr + expire (10 submissions / IP / 10 min) ---- */
async function checkRateLimit(ip: string): Promise<boolean> {
  const redis = getRedis();
  const key = `ratelimit:submit:${ip}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 600);
  return count <= 10;
}

function getIp(c: Context): string {
  // Trust X-Forwarded-For when behind a proxy; fall back to socket address.
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return "unknown";
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
  const seed = generateSeed();
  const seedSig = signSeed(gameId, seed);

  // Store with 24h TTL. Leave `used` unset so submit's hsetnx(used) is the
  // atomic single-submission guard (hsetnx only sets when the field is absent).
  await redis.hset(`game:${gameId}`, { difficulty, seed, seedSig });
  await redis.expire(`game:${gameId}`, 24 * 60 * 60);

  return c.json({
    gameId,
    seed,
    seedSig,
    serverTimeUTC: Math.floor(Date.now() / 1000),
  });
});

/* ---- POST /game/submit ---- */
app.post("/game/submit", async (c) => {
  const body = await c.req.json().catch(() => null) as null | {
    gameId?: string;
    seed?: string;
    seedSig?: string;
    difficulty?: string;
    moves?: Move[];
    handle?: string;
    nameKey?: string;
    timeSeconds?: number;
  };

  if (!body) return c.json({ error: "bad request" }, 400);

  const { gameId, seed, seedSig, difficulty, moves, handle, timeSeconds } = body;

  // Basic field validation
  if (!gameId || !seed || !seedSig || !difficulty || !Array.isArray(moves) || typeof timeSeconds !== "number") {
    return c.json({ error: "missing required fields" }, 400);
  }
  if (!DIFFS[difficulty as Difficulty]) {
    return c.json({ error: "invalid difficulty" }, 400);
  }

  // Rate limit
  const ip = getIp(c);
  const allowed = await checkRateLimit(ip);
  if (!allowed) {
    return c.json({ error: "rate limit exceeded -- slow down!" }, 429);
  }

  const redis = getRedis();

  // Verify seedSig
  if (!verifySeed(gameId, seed, seedSig)) {
    return c.json({ error: "invalid seed signature" }, 403);
  }

  // Fetch game record
  const gameKey = `game:${gameId}`;
  const gameRec = await redis.hgetall(gameKey) as Partial<{ difficulty: string; seed: string; seedSig: string; used: string }>;
  if (!gameRec || !gameRec.seed) {
    return c.json({ error: "game not found or expired" }, 404);
  }
  if (gameRec.used === "1") {
    return c.json({ error: "game already submitted" }, 409);
  }
  // Verify seed matches what server originally issued
  if (gameRec.seed !== seed || gameRec.seedSig !== seedSig || gameRec.difficulty !== difficulty) {
    return c.json({ error: "seed mismatch" }, 403);
  }

  // NOTE: we verify + score BEFORE marking the game used, so a submission that
  // is rejected for a missing/taken name can be retried under a different name.
  // The single-use guard (hsetnx used) only fires once we actually finalise.

  // Replay verify (accepts wins and losses; rejects only tampered/invalid replays)
  const verification = replayVerify(difficulty as Difficulty, seed, moves, timeSeconds);
  if (!verification.ok) {
    // Consume the game so a tampered replay can't be re-probed.
    await redis.hsetnx(gameKey, "used", "1");
    return c.json({ accepted: false, reason: verification.reason }, 422);
  }

  const { won, revealed } = verification;
  const score = scoreSession(difficulty as Difficulty, won, revealed, timeSeconds);

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

  // Finalise: consume the game exactly once now that the name is settled.
  const set = await redis.hsetnx(gameKey, "used", "1");
  if (!set) {
    return c.json({ error: "game already submitted" }, 409);
  }

  // Record on the running leaderboard (GT keeps the player's highest score).
  // SEASON is fixed for the whole event so a name maps to one row (no daily reset).
  const claimToken = signClaimToken(difficulty, SEASON, safeHandle);
  const rank = await addScore(redis, difficulty as Difficulty, claimToken, safeHandle, score);
  const isLeader = rank === 1;

  // Store claim record
  await storeClaim(redis, claimToken, difficulty, SEASON, safeHandle, rank);

  // Build share token compatible with share-image-service
  const shareToken = signShareToken({
    handle: safeHandle,
    timeSeconds,
    difficulty: difficulty as Difficulty,
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
