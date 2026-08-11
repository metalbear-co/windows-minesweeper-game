/* Tests for the server-authoritative board (board.ts) + pure board math (game.ts).
 *
 * WHAT THIS GUARDS
 *   Previously the server handed the client a public seed at /game/start; anyone
 *   could reconstruct the whole board offline and script a perfect win (the only
 *   defense was a wall-clock "did enough real time pass" check). Now the mine
 *   layout is generated server-side on the first real reveal and never leaves
 *   board.ts except cell-by-cell, as each click earns it. These tests assert the
 *   two things that make that true: a reveal response never discloses mines
 *   before the game ends, and a game can't be scored without actually having
 *   been played through to a finish via real reveal calls.
 */
import { DIFFS } from "../src/game.js";
import { createGame, revealCell, readFinishedGame, isUsed, markUsed, type BoardRedis } from "../src/board.js";

/* ---- in-memory fake, just the hash ops board.ts needs ---- */
class FakeRedis implements BoardRedis {
  private store = new Map<string, Record<string, string>>();
  async hgetall(key: string) { return { ...(this.store.get(key) ?? {}) }; }
  async hset(key: string, obj: Record<string, string>) {
    const cur = this.store.get(key) ?? {};
    Object.assign(cur, obj);
    this.store.set(key, cur);
    return Object.keys(obj).length;
  }
  async hget(key: string, field: string) { return this.store.get(key)?.[field] ?? null; }
  async hsetnx(key: string, field: string, value: string) {
    const cur = this.store.get(key) ?? {};
    if (cur[field] !== undefined) return 0;
    cur[field] = value;
    this.store.set(key, cur);
    return 1;
  }
  async expire() { return 1; }
}

const GAME_ID = "test-game";

/** Play a beginner board blind (scan row-major), stopping at a mine or a win.
 *  Returns every reveal response, so tests can assert on each one. */
async function playBlind(redis: FakeRedis, gameId: string) {
  const { w, h } = DIFFS.beginner;
  const responses: Awaited<ReturnType<typeof revealCell>>[] = [];
  outer: for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = await revealCell(redis, gameId, x, y);
      responses.push(r);
      if (!r.ok) continue; // already open from a prior flood -- fine
      if (r.hitMine || (!r.hitMine && r.won)) break outer;
    }
  }
  return responses;
}

describe("revealCell", () => {
  test("first reveal is always safe (safe zone centred on that click)", async () => {
    const redis = new FakeRedis();
    await createGame(redis, GAME_ID, "beginner");
    const r = await revealCell(redis, GAME_ID, 4, 4);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.hitMine).toBe(false);
  });

  test("mines are never disclosed before the game ends", async () => {
    const redis = new FakeRedis();
    await createGame(redis, GAME_ID, "beginner");
    const responses = await playBlind(redis, GAME_ID);
    for (const r of responses.slice(0, -1)) {
      if (r.ok && !r.hitMine) expect(r.mines).toBeUndefined();
    }
  });

  test("hitting a mine ends the game and discloses the full layout", async () => {
    const redis = new FakeRedis();
    await createGame(redis, GAME_ID, "beginner");
    const responses = await playBlind(redis, GAME_ID);
    const last = responses[responses.length - 1];
    expect(last.ok).toBe(true);
    if (last.ok && last.hitMine) {
      expect(last.mines).toHaveLength(DIFFS.beginner.m);
    }
    // Further reveals on a finished (lost) game are rejected either way.
    const after = await revealCell(redis, GAME_ID, 0, 0);
    if (!(last.ok && last.hitMine)) return; // this blind run happened to win instead
    expect(after.ok).toBe(false);
  });

  test("a duplicate reveal on an already-open cell is a harmless no-op", async () => {
    const redis = new FakeRedis();
    await createGame(redis, GAME_ID, "beginner");
    await revealCell(redis, GAME_ID, 4, 4);
    const again = await revealCell(redis, GAME_ID, 4, 4);
    expect(again.ok).toBe(true);
    if (again.ok && !again.hitMine) expect(again.newly).toEqual([]);
  });

  test("out-of-bounds coordinates are rejected", async () => {
    const redis = new FakeRedis();
    await createGame(redis, GAME_ID, "beginner");
    const r = await revealCell(redis, GAME_ID, 99, 99);
    expect(r.ok).toBe(false);
  });

  test("unknown gameId is rejected", async () => {
    const redis = new FakeRedis();
    const r = await revealCell(redis, "nope", 0, 0);
    expect(r.ok).toBe(false);
  });
});

describe("submission integrity", () => {
  test("a game can't be scored before it's finished", async () => {
    const redis = new FakeRedis();
    await createGame(redis, GAME_ID, "beginner");
    await revealCell(redis, GAME_ID, 4, 4); // one click, board not cleared
    const finalized = await readFinishedGame(redis, GAME_ID);
    expect(finalized.ok).toBe(false);
  });

  test("a fabricated gameId can't be submitted", async () => {
    const redis = new FakeRedis();
    const finalized = await readFinishedGame(redis, "never-started");
    expect(finalized.ok).toBe(false);
  });

  test("revealed count and outcome come from server-tracked reveals, not client input", async () => {
    const redis = new FakeRedis();
    await createGame(redis, GAME_ID, "beginner");
    const responses = await playBlind(redis, GAME_ID);
    const finalized = await readFinishedGame(redis, GAME_ID);
    expect(finalized.ok).toBe(true);
    if (!finalized.ok) return;
    const opened = responses.filter((r) => r.ok && !r.hitMine).flatMap((r) => (r.ok && !r.hitMine ? r.newly : []));
    expect(finalized.game.revealed).toBe(opened.length);
  });

  test("markUsed is a one-shot guard", async () => {
    const redis = new FakeRedis();
    await createGame(redis, GAME_ID, "beginner");
    expect(await isUsed(redis, GAME_ID)).toBe(false);
    expect(await markUsed(redis, GAME_ID)).toBe(true);
    expect(await isUsed(redis, GAME_ID)).toBe(true);
    expect(await markUsed(redis, GAME_ID)).toBe(false); // second claim fails
  });
});
