/* Tests for the replay verifier */
import { replayVerify, scoreSession } from "../src/game.js";
import { placeMinesFromSeed } from "../src/prng.js";
import type { Move } from "../src/game.js";

/* ---- helpers ---- */

/** Build a move list that fully clears a beginner board from the given seed. */
function buildHonestRun(
  seed: string,
  safeX: number,
  safeY: number
): { moves: Move[]; timeSeconds: number } {
  const W = 9, H = 9, M = 10;
  const mines = placeMinesFromSeed(W, H, M, seed, safeX, safeY);

  // Compute neighbor counts
  const grid: Array<{ mine: boolean; n: number; open: boolean; flag: boolean }> = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    grid.push({ mine: mines[y][x], n: 0, open: false, flag: false });
  }
  const idx = (x: number, y: number) => y * W + x;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (grid[idx(x, y)].mine) continue;
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < W && ny >= 0 && ny < H && grid[idx(nx, ny)].mine) n++;
    }
    grid[idx(x, y)].n = n;
  }

  // Flood fill from safeX,safeY -- reveal all reachable non-mine cells
  const moves: Move[] = [];
  let t = 0;

  function floodReveal(startX: number, startY: number) {
    const stack: [number, number][] = [[startX, startY]];
    while (stack.length) {
      const [cx, cy] = stack.pop()!;
      const c = grid[idx(cx, cy)];
      if (c.open || c.mine) continue;
      c.open = true;
      if (moves.length === 0) {
        // First reveal
        moves.push({ type: "reveal", x: cx, y: cy, t: 0 });
      } else {
        t += 200; // 200ms between moves
        moves.push({ type: "reveal", x: cx, y: cy, t });
      }
      if (c.n === 0) {
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx, ny = cy + dy;
          if (nx >= 0 && nx < W && ny >= 0 && ny < H && !grid[idx(nx, ny)].open) {
            stack.push([nx, ny]);
          }
        }
      }
    }
  }
  floodReveal(safeX, safeY);

  // Reveal any unreachable safe cells individually
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!grid[idx(x, y)].open && !grid[idx(x, y)].mine) {
      t += 200;
      moves.push({ type: "reveal", x, y, t });
      grid[idx(x, y)].open = true;
    }
  }

  return { moves, timeSeconds: Math.ceil(t / 1000) };
}

const TEST_SEED = "aabbccdd11223344aabbccdd11223344";

/* ---- tests ---- */

describe("replayVerify", () => {
  test("honest run is accepted and marked as a win", () => {
    const { moves, timeSeconds } = buildHonestRun(TEST_SEED, 4, 4);
    expect(timeSeconds).toBeGreaterThanOrEqual(2);
    const result = replayVerify("beginner", TEST_SEED, moves, timeSeconds);
    expect(result.ok).toBe(true);
    expect(result.won).toBe(true);
    expect(result.revealed).toBe(9 * 9 - 10);
  });

  test("hitting a mine is a valid session but not a win", () => {
    // Controlled loss: first reveal is safe, second reveal steps on a known mine.
    const mines = placeMinesFromSeed(9, 9, 10, TEST_SEED, 4, 4);
    let mineXY: [number, number] | null = null;
    for (let y = 0; y < 9 && !mineXY; y++) for (let x = 0; x < 9; x++) {
      if (mines[y][x]) { mineXY = [x, y]; break; }
    }
    expect(mineXY).not.toBeNull();
    const moves: Move[] = [
      { type: "reveal", x: 4, y: 4, t: 0 },
      { type: "reveal", x: mineXY![0], y: mineXY![1], t: 500 },
    ];
    const result = replayVerify("beginner", TEST_SEED, moves, 1);
    expect(result.ok).toBe(true);
    expect(result.won).toBe(false);
    expect(result.revealed).toBeGreaterThanOrEqual(1);
  });

  test("tampered time claim (claimed 1s but moves span 30s) is rejected", () => {
    const { moves } = buildHonestRun(TEST_SEED, 4, 4);
    // Override last move timestamp to 30 000ms but claim 1s
    const longerMoves: Move[] = moves.map((m, i) =>
      i === moves.length - 1 ? { ...m, t: 30_000 } : m
    );
    const result = replayVerify("beginner", TEST_SEED, longerMoves, 1);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/time/i);
  });

  test("a win claimed impossibly fast is rejected", () => {
    const { moves } = buildHonestRun(TEST_SEED, 4, 4);
    // Full clear but claiming 0s -- time can't match the move timestamps.
    const result = replayVerify("beginner", TEST_SEED, moves, 0);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/fast|time/i);
  });

  test("instant submit (plausible time claimed, ~0s server-measured elapsed) is rejected", () => {
    const { moves, timeSeconds } = buildHonestRun(TEST_SEED, 4, 4);
    // Consistent, above-floor claim -- but the server saw no wall-clock pass.
    const result = replayVerify("beginner", TEST_SEED, moves, timeSeconds, 0);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/elapsed/i);
  });

  test("run is accepted when server-measured elapsed matches the claimed time", () => {
    const { moves, timeSeconds } = buildHonestRun(TEST_SEED, 4, 4);
    // A real client: at least `timeSeconds` of wall-clock actually elapsed.
    const result = replayVerify("beginner", TEST_SEED, moves, timeSeconds, timeSeconds + 1);
    expect(result.ok).toBe(true);
    expect(result.won).toBe(true);
  });

  test("invalid seed produces different board -- not a win", () => {
    const { moves, timeSeconds } = buildHonestRun(TEST_SEED, 4, 4);
    // Different seed means mines are in different places
    const result = replayVerify("beginner", "00000000ffffffffffffffffffffffff", moves, timeSeconds);
    expect(result.won).toBe(false);
  });

  test("scoreSession: wins beat losses; harder + faster scores higher", () => {
    const safeInter = 16 * 16 - 40;
    const winFast = scoreSession("intermediate", true, safeInter, 40);
    const winSlow = scoreSession("intermediate", true, safeInter, 250);
    const loss = scoreSession("intermediate", false, safeInter - 1, 40);
    expect(winFast).toBeGreaterThan(winSlow);      // speed bonus
    expect(winSlow).toBeGreaterThan(loss);         // a win always beats a near-clear loss
    expect(scoreSession("expert", true, 30 * 16 - 99, 40))
      .toBeGreaterThan(winFast);                   // harder board weighs more
  });

  test("moves list with no reveals is rejected", () => {
    const result = replayVerify("beginner", TEST_SEED, [{ type: "flag", x: 0, y: 0, t: 0 }], 5);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/reveal/i);
  });

  test("empty moves list is rejected", () => {
    const result = replayVerify("beginner", TEST_SEED, [], 5);
    expect(result.ok).toBe(false);
  });
});
