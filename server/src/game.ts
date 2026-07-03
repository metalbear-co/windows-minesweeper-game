/* Game logic: board construction + replay verifier */
import { placeMinesFromSeed } from "./prng.js";

export type Difficulty = "beginner" | "intermediate" | "expert";

export interface DiffConfig {
  w: number;
  h: number;
  m: number;
  minTimeSeconds: number;
}

export const DIFFS: Record<Difficulty, DiffConfig> = {
  beginner:     { w: 9,  h: 9,  m: 10, minTimeSeconds: 2 },
  intermediate: { w: 16, h: 16, m: 40, minTimeSeconds: 5 },
  expert:       { w: 30, h: 16, m: 99, minTimeSeconds: 15 },
};

export interface Move {
  type: "reveal" | "flag" | "unflag";
  x: number;
  y: number;
  t: number; // ms since first reveal
}

export interface VerifyResult {
  ok: boolean;         // replay is structurally valid and time-consistent
  reason?: string;
  won: boolean;        // true only if every safe cell was revealed and no mine hit
  revealed: number;    // safe cells revealed (authoritative -- from the replay)
}

/* ---- Internal cell type ---- */
interface Cell {
  mine: boolean;
  open: boolean;
  flag: boolean;
  n: number;
}

function buildBoard(w: number, h: number, mines: boolean[][]): Cell[][] {
  const grid: Cell[][] = Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => ({
      mine: mines[y][x],
      open: false,
      flag: false,
      n: 0,
    }))
  );
  // Compute neighbor counts
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (grid[y][x].mine) continue;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && grid[ny][nx].mine) n++;
      }
      grid[y][x].n = n;
    }
  }
  return grid;
}

function floodReveal(grid: Cell[][], w: number, h: number, startX: number, startY: number): number {
  let revealed = 0;
  const stack: [number, number][] = [[startX, startY]];
  while (stack.length) {
    const [cx, cy] = stack.pop()!;
    const c = grid[cy][cx];
    if (c.open || c.flag || c.mine) continue;
    c.open = true;
    revealed++;
    if (c.n === 0) {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && !grid[ny][nx].open) {
          stack.push([nx, ny]);
        }
      }
    }
  }
  return revealed;
}

/**
 * Replay the client's move list against the seeded board.
 * `ok` means the replay is valid and time-consistent (a legitimate session,
 * win OR loss). `won`/`revealed` describe the outcome for scoring.
 */
export function replayVerify(
  difficulty: Difficulty,
  hexSeed: string,
  moves: Move[],
  claimedTimeSeconds: number
): VerifyResult {
  const fail = (reason: string): VerifyResult => ({ ok: false, reason, won: false, revealed: 0 });

  const conf = DIFFS[difficulty];
  if (!conf) return fail("unknown difficulty");

  if (!Array.isArray(moves) || moves.length === 0) return fail("no moves");

  // Find first reveal -- determines mine placement
  const firstReveal = moves.find(m => m.type === "reveal");
  if (!firstReveal) return fail("no reveal move");
  const safeX = firstReveal.x, safeY = firstReveal.y;
  if (safeX < 0 || safeX >= conf.w || safeY < 0 || safeY >= conf.h) return fail("first reveal out of bounds");

  const mineGrid = placeMinesFromSeed(conf.w, conf.h, conf.m, hexSeed, safeX, safeY);
  const grid = buildBoard(conf.w, conf.h, mineGrid);
  if (grid[safeY][safeX].mine) return fail("mine placed on safe cell (seed bug)");

  let totalRevealed = 0;
  const totalSafe = conf.w * conf.h - conf.m;
  let lastMoveMs = 0;
  let hitMine = false;

  for (const move of moves) {
    if (move.x < 0 || move.x >= conf.w || move.y < 0 || move.y >= conf.h) return fail("move out of bounds");
    const cell = grid[move.y][move.x];
    if (move.t > lastMoveMs) lastMoveMs = move.t;

    if (move.type === "reveal") {
      if (cell.mine) { hitMine = true; break; }  // loss -- stop replaying at the boom
      if (!cell.open) totalRevealed += floodReveal(grid, conf.w, conf.h, move.x, move.y);
    } else if (move.type === "flag") {
      if (!cell.open) cell.flag = true;
    } else if (move.type === "unflag") {
      cell.flag = false;
    }
  }

  const won = !hitMine && totalRevealed === totalSafe;

  // Claimed time must track the move timestamps (blocks inflating/deflating time).
  const lastMoveSecs = lastMoveMs / 1000;
  if (Math.abs(claimedTimeSeconds - lastMoveSecs) > 3) {
    return { ok: false, won: false, revealed: totalRevealed,
      reason: `claimed time ${claimedTimeSeconds}s does not match move timestamps (last move at ${lastMoveSecs.toFixed(1)}s)` };
  }
  // A *win* claimed impossibly fast is rejected; a fast loss is legitimate.
  if (won && claimedTimeSeconds < conf.minTimeSeconds) {
    return { ok: false, won: false, revealed: totalRevealed,
      reason: `time ${claimedTimeSeconds}s too fast (min ${conf.minTimeSeconds}s)` };
  }

  return { ok: true, won, revealed: totalRevealed };
}

/* Difficulty weight -- harder boards are worth more per cell and per bonus. */
const DIFF_WEIGHT: Record<Difficulty, number> = { beginner: 1, intermediate: 2, expert: 3 };

/**
 * Session score, higher is better. Every session scores on cells cleared;
 * a full clear adds a completion bonus plus a speed bonus.
 * ponytail: flat linear formula -- tune the three weights, not the shape.
 *   near-full-clear losses can approach but never beat a real win.
 */
export function scoreSession(difficulty: Difficulty, won: boolean, revealed: number, timeSeconds: number): number {
  const d = DIFF_WEIGHT[difficulty] ?? 1;
  let score = revealed * 10 * d;
  if (won) score += 1000 * d + Math.max(0, 300 - timeSeconds) * d;
  return Math.round(score);
}
