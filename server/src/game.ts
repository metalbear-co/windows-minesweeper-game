/* Game logic: pure board math. No Redis here -- see board.ts for the
   stateful, per-game Redis operations built on top of these functions. */
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

export interface RevealedCell { x: number; y: number; n: number; }
export interface Point { x: number; y: number; }

/**
 * Mine layout as a row-major '0'/'1' bitstring -- compact enough to store as a
 * single Redis hash field, one char per cell (max 480 cells on Expert).
 */
export function buildMinesBits(difficulty: Difficulty, hexSeed: string, safeX: number, safeY: number): string {
  const { w, h, m } = DIFFS[difficulty];
  const mines = placeMinesFromSeed(w, h, m, hexSeed, safeX, safeY);
  let bits = "";
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) bits += mines[y][x] ? "1" : "0";
  return bits;
}

export function bitsToPoints(bits: string, w: number, h: number): Point[] {
  const out: Point[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (bits[y * w + x] === "1") out.push({ x, y });
  }
  return out;
}

function neighborMineCount(minesBits: string, w: number, h: number, x: number, y: number): number {
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (dx === 0 && dy === 0) continue;
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && nx < w && ny >= 0 && ny < h && minesBits[ny * w + nx] === "1") n++;
  }
  return n;
}

/**
 * Flood-reveal from (x,y): classic zero-cell flood fill, run authoritatively
 * against the server-held mine layout. Returns the updated `open` bitstring
 * plus only the cells newly opened by this single click -- the caller (a
 * player's real click, one at a time) never learns about cells it hasn't
 * earned by actually revealing them or their zero-neighbors.
 */
export function floodReveal(minesBits: string, openBits: string, w: number, h: number, x: number, y: number): { openBits: string; newly: RevealedCell[] } {
  const open = openBits.split("");
  const newly: RevealedCell[] = [];
  const stack: [number, number][] = [[x, y]];
  while (stack.length) {
    const [cx, cy] = stack.pop()!;
    const idx = cy * w + cx;
    if (open[idx] === "1" || minesBits[idx] === "1") continue;
    open[idx] = "1";
    const n = neighborMineCount(minesBits, w, h, cx, cy);
    newly.push({ x: cx, y: cy, n });
    if (n === 0) {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && open[ny * w + nx] !== "1") stack.push([nx, ny]);
      }
    }
  }
  return { openBits: open.join(""), newly };
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
