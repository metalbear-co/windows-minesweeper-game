/* Leaderboard for "Waiting for ECS", the platformer at metalbear.com/mirrord/ecs/game/.
   The game runs entirely in the browser, so the server can't replay it like the
   Minesweeper board. What it can do is the timing check from Nitzan's report:
   it records when a run starts and when it finishes, and rejects a run that
   claims less play time than really passed. The game's clock is a fixed 60 Hz
   step that never runs faster than real time, so honest runs always pass, and
   the best a script can do is wait out a real run and claim every coin. */
import { Hono, type Context } from "hono";
import { v4 as uuidv4 } from "uuid";
import type { Redis } from "ioredis";
import { getRedis } from "./redis.js";
import { reserveName } from "./names.js";

// Bumping this starts a fresh board, like SEASON in server.ts.
export const ECS_SEASON = "ecs-launch-2026";

// Must match the game: 32 coins in the level, 100 points each, plus 20 points
// for every second under 3 minutes of play.
export const MAX_COINS = 32;
const PAR_SECONDS = 180;
// No one gets through the ECS loop, grabs mirrord and ships in under this.
// A bot that plays the level straight through takes about 54 s.
export const MIN_SECONDS = 40;
// Slack for request latency and rounding: the run starts a moment before the
// server hears about it, so the game's clock can read slightly ahead.
const CLOCK_SLACK_SECONDS = 3;
const RUN_TTL_SECONDS = 2 * 60 * 60;

export function ecsScore(coins: number, seconds: number): number {
  return coins * 100 + Math.max(0, PAR_SECONDS - seconds) * 20;
}

export type FinishCheck = { ok: true; score: number } | { ok: false; error: string };

/** Validates a finished run against the server's own clock. */
export function checkFinish(startedAtMs: number, nowMs: number, coins: unknown, seconds: unknown): FinishCheck {
  if (!Number.isInteger(coins) || (coins as number) < 0 || (coins as number) > MAX_COINS) {
    return { ok: false, error: "invalid coins" };
  }
  if (!Number.isInteger(seconds) || (seconds as number) < MIN_SECONDS) {
    return { ok: false, error: "invalid time" };
  }
  const elapsed = (nowMs - startedAtMs) / 1000;
  if ((seconds as number) > elapsed + CLOCK_SLACK_SECONDS) {
    return { ok: false, error: "time doesn't match the server clock" };
  }
  return { ok: true, score: ecsScore(coins as number, seconds as number) };
}

/* Sorted-set value: the score, with ties going to whoever got there first.
   score * 1e6 + (1e6 - minutes since the season began) stays an exact integer
   in a double (max score ~6,800) for about two years of minutes. */
const SEASON_START_MS = Date.UTC(2026, 10, 1);
export function rankValue(score: number, nowMs: number): number {
  const minutes = Math.min(999_999, Math.max(0, Math.floor((nowMs - SEASON_START_MS) / 60_000)));
  return score * 1_000_000 + (1_000_000 - minutes);
}
export function scoreFromRankValue(v: number): number {
  return Math.floor((v - 1) / 1_000_000);
}

export function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

const lbKey = `ecs:lb:${ECS_SEASON}`;
const emailsKey = `ecs:emails:${ECS_SEASON}`;
const runKey = (id: string) => `ecs:run:${id}`;

interface Run {
  startedAt: number;
  score?: number;
  submitted?: boolean;
}

async function readRun(redis: Redis, id: unknown): Promise<Run | null> {
  if (typeof id !== "string" || id.length > 64) return null;
  const raw = await redis.get(runKey(id));
  return raw ? (JSON.parse(raw) as Run) : null;
}

async function standings(redis: Redis, name?: string, limit = 5) {
  const raw = await redis.zrevrange(lbKey, 0, limit - 1, "WITHSCORES");
  const top = [];
  for (let i = 0; i < raw.length; i += 2) {
    top.push({ rank: top.length + 1, name: raw[i], score: scoreFromRankValue(Number(raw[i + 1])) });
  }
  const total = await redis.zcard(lbKey);
  let me = null;
  if (name) {
    const [rank, v] = await Promise.all([redis.zrevrank(lbKey, name), redis.zscore(lbKey, name)]);
    if (rank !== null && v !== null) me = { rank: rank + 1, name, score: scoreFromRankValue(Number(v)) };
  }
  return { top, total, me };
}

export interface EcsDeps {
  checkRateLimit(bucket: string, ip: string, limit: number): Promise<boolean>;
  getIp(c: Context): string;
  sanitiseHandle(raw: string | undefined): string;
}

export function ecsRoutes({ checkRateLimit, getIp, sanitiseHandle }: EcsDeps): Hono {
  const app = new Hono();

  /* POST /ecs/start -- the game calls this when a run begins. */
  app.post("/start", async (c) => {
    if (!(await checkRateLimit("ecs-start", getIp(c), 120))) {
      return c.json({ error: "rate limit exceeded -- slow down!" }, 429);
    }
    const runId = uuidv4();
    await getRedis().set(runKey(runId), JSON.stringify({ startedAt: Date.now() } satisfies Run), "EX", RUN_TTL_SECONDS);
    return c.json({ runId });
  });

  /* POST /ecs/finish { runId, coins, seconds } -- called the moment the player
     ships, before they type a name, so typing doesn't count as play time. */
  app.post("/finish", async (c) => {
    const body = (await c.req.json().catch(() => null)) as null | { runId?: unknown; coins?: unknown; seconds?: unknown };
    const redis = getRedis();
    const run = await readRun(redis, body?.runId);
    if (!run) return c.json({ error: "run not found" }, 404);
    if (run.score !== undefined) return c.json({ error: "run already finished" }, 409);

    const check = checkFinish(run.startedAt, Date.now(), body?.coins, body?.seconds);
    if (!check.ok) return c.json({ accepted: false, reason: check.error }, 422);

    run.score = check.score;
    await redis.set(runKey(body!.runId as string), JSON.stringify(run), "EX", RUN_TTL_SECONDS);
    return c.json({ accepted: true, score: check.score });
  });

  /* POST /ecs/submit { runId, name, email, nameKey } -- puts a finished run on
     the board. Each name keeps its best score. */
  app.post("/submit", async (c) => {
    const body = (await c.req.json().catch(() => null)) as null | {
      runId?: unknown; name?: string; email?: string; nameKey?: string;
    };
    const name = sanitiseHandle(typeof body?.name === "string" ? body.name : undefined);
    if (!name) return c.json({ error: "name required", reason: "name_required" }, 400);
    const email = typeof body?.email === "string" ? body.email.trim().slice(0, 120) : "";
    if (!isEmail(email)) return c.json({ error: "email required", reason: "email_required" }, 400);
    if (typeof body?.nameKey !== "string" || body.nameKey.length < 8) {
      return c.json({ error: "missing nameKey" }, 400);
    }

    const redis = getRedis();
    const run = await readRun(redis, body.runId);
    if (!run || run.score === undefined) return c.json({ error: "run not found" }, 404);
    if (run.submitted) return c.json({ error: "run already submitted" }, 409);

    // Name stays unconsumed on "taken", so the player can pick another and retry.
    if ((await reserveName(redis, ECS_SEASON, name, body.nameKey)) === "taken") {
      return c.json({ error: "name taken", reason: "name_taken" }, 409);
    }
    if (!(await checkRateLimit("ecs-submit", getIp(c), 60))) {
      return c.json({ error: "rate limit exceeded -- slow down!" }, 429);
    }

    // Single use: only the request that flips this key gets to score the run.
    if ((await redis.set(`ecs:used:${body.runId}`, "1", "EX", RUN_TTL_SECONDS, "NX")) !== "OK") {
      return c.json({ error: "run already submitted" }, 409);
    }
    run.submitted = true;
    await redis.set(runKey(body.runId as string), JSON.stringify(run), "EX", RUN_TTL_SECONDS);

    // GT keeps the player's best run (and the earlier one on a tie).
    await redis.zadd(lbKey, "GT", rankValue(run.score, Date.now()), name);
    await redis.hset(emailsKey, name, email);

    return c.json({ accepted: true, score: run.score, ...(await standings(redis, name)) });
  });

  /* GET /ecs/leaderboard?name=<name> -- top 5, the total, and that name's rank. */
  app.get("/leaderboard", async (c) => {
    const name = sanitiseHandle(c.req.query("name")) || undefined;
    return c.json(await standings(getRedis(), name));
  });

  return app;
}

/** name,email,score rows for the admin CSV export. */
export async function ecsEmailRows(redis: Redis): Promise<Array<[string, string, number | null]>> {
  const emails = (await redis.hgetall(emailsKey)) as Record<string, string>;
  const raw = await redis.zrevrange(lbKey, 0, -1, "WITHSCORES");
  const scores: Record<string, number> = {};
  for (let i = 0; i < raw.length; i += 2) scores[raw[i]] = scoreFromRankValue(Number(raw[i + 1]));
  return Object.entries(emails).map(([name, email]) => [name, email, scores[name] ?? null]);
}
