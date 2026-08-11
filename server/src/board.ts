/* Per-game board state in Redis. This is what makes the server authoritative
   over the board: the mine layout is generated on the *first* reveal (safe
   zone centred on that click, same as before) and never leaves this module --
   /game/reveal only ever returns the cells a click actually opened. A client
   (or a script calling the API directly) can only ever learn what a real
   click has earned; it can't reconstruct the board ahead of time the way it
   could when /game/start handed out the raw seed. */
import { generateSeed } from "./crypto.js";
import { DIFFS, buildMinesBits, bitsToPoints, floodReveal, type Difficulty, type RevealedCell, type Point } from "./game.js";

// Minimal slice of the Redis API we need -- keeps this unit-testable with a fake,
// same pattern as names.ts's NameStore.
export interface BoardRedis {
  hgetall(key: string): Promise<Record<string, string>>;
  hset(key: string, obj: Record<string, string>): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  hsetnx(key: string, field: string, value: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

function gameKey(gameId: string): string {
  return `game:${gameId}`;
}

type RawRec = Partial<{
  difficulty: string;
  issuedAt: string;
  started: string;
  mines: string;
  open: string;
  totalRevealed: string;
  firstRevealAt: string;
  finished: string;
  won: string;
  finishedAt: string;
  used: string;
}>;

export async function createGame(redis: BoardRedis, gameId: string, difficulty: Difficulty): Promise<void> {
  await redis.hset(gameKey(gameId), { difficulty, issuedAt: Date.now().toString() });
  await redis.expire(gameKey(gameId), 24 * 60 * 60);
}

export type RevealOutcome =
  | { ok: false; error: string }
  | { ok: true; hitMine: true; mines: Point[] }
  | { ok: true; hitMine: false; won: boolean; newly: RevealedCell[]; totalRevealed: number; mines?: Point[] };

export async function revealCell(redis: BoardRedis, gameId: string, x: number, y: number): Promise<RevealOutcome> {
  const key = gameKey(gameId);
  const rec = (await redis.hgetall(key)) as RawRec;
  if (!rec || !rec.difficulty) return { ok: false, error: "game not found or expired" };
  if (rec.finished === "1") return { ok: false, error: "game already finished" };

  const difficulty = rec.difficulty as Difficulty;
  const conf = DIFFS[difficulty];
  if (!conf) return { ok: false, error: "invalid difficulty" };
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= conf.w || y < 0 || y >= conf.h) {
    return { ok: false, error: "out of bounds" };
  }

  let mines: string;
  let open: string;
  let totalRevealed: number;

  if (rec.started !== "1") {
    // First reveal for this game: place mines now, safe zone centred on this click.
    // Nothing about the layout has been sent to the client before this point.
    mines = buildMinesBits(difficulty, generateSeed(), x, y);
    open = "0".repeat(conf.w * conf.h);
    totalRevealed = 0;
    await redis.hset(key, {
      started: "1",
      mines,
      open,
      totalRevealed: "0",
      firstRevealAt: Date.now().toString(),
    });
  } else {
    mines = rec.mines ?? "";
    open = rec.open ?? "";
    totalRevealed = Number(rec.totalRevealed ?? 0);
  }

  const idx = y * conf.w + x;

  if (mines[idx] === "1") {
    await redis.hset(key, { finished: "1", won: "0", finishedAt: Date.now().toString() });
    return { ok: true, hitMine: true, mines: bitsToPoints(mines, conf.w, conf.h) };
  }

  if (open[idx] === "1") {
    // Already revealed (e.g. a duplicate click) -- idempotent no-op.
    return { ok: true, hitMine: false, won: false, newly: [], totalRevealed };
  }

  const { openBits, newly } = floodReveal(mines, open, conf.w, conf.h, x, y);
  totalRevealed += newly.length;
  const totalSafe = conf.w * conf.h - conf.m;
  const won = totalRevealed === totalSafe;

  const update: Record<string, string> = { open: openBits, totalRevealed: String(totalRevealed) };
  if (won) {
    update.finished = "1";
    update.won = "1";
    update.finishedAt = Date.now().toString();
  }
  await redis.hset(key, update);

  return {
    ok: true,
    hitMine: false,
    won,
    newly,
    totalRevealed,
    ...(won ? { mines: bitsToPoints(mines, conf.w, conf.h) } : {}),
  };
}

export interface FinishedGame {
  difficulty: Difficulty;
  won: boolean;
  revealed: number;
  timeSeconds: number;
}

/** Read the authoritative outcome of a finished game -- everything scoring needs,
 *  measured entirely from server-observed timestamps and server-tracked reveals. */
export async function readFinishedGame(redis: BoardRedis, gameId: string): Promise<{ ok: true; game: FinishedGame } | { ok: false; error: string }> {
  const rec = (await redis.hgetall(gameKey(gameId))) as RawRec;
  if (!rec || !rec.difficulty) return { ok: false, error: "game not found or expired" };
  if (rec.finished !== "1") return { ok: false, error: "game not finished" };

  const firstRevealAt = Number(rec.firstRevealAt);
  const finishedAt = Number(rec.finishedAt);
  const timeSeconds = Number.isFinite(firstRevealAt) && Number.isFinite(finishedAt)
    ? Math.round((finishedAt - firstRevealAt) / 1000)
    : 0;

  return {
    ok: true,
    game: {
      difficulty: rec.difficulty as Difficulty,
      won: rec.won === "1",
      revealed: Number(rec.totalRevealed ?? 0),
      timeSeconds,
    },
  };
}

export async function isUsed(redis: BoardRedis, gameId: string): Promise<boolean> {
  return (await redis.hget(gameKey(gameId), "used")) === "1";
}

/** Atomic single-submission guard -- true only for the caller that claims it. */
export async function markUsed(redis: BoardRedis, gameId: string): Promise<boolean> {
  return (await redis.hsetnx(gameKey(gameId), "used", "1")) === 1;
}
