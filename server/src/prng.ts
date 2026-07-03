/* Seeded PRNG -- mulberry32
   MUST be bit-for-bit identical to the implementation in web/game.js.
   Any divergence will cause the server verifier to disagree with the client. */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

export function seedToUint32(hexSeed: string): number {
  return parseInt(hexSeed.slice(0, 8), 16);
}

/**
 * Place mines using Fisher-Yates shuffle of non-safe candidates.
 * Safe zone = 3x3 around (safeX, safeY).
 * Returns a 2-D boolean array: mines[row][col].
 */
export function placeMinesFromSeed(
  w: number,
  h: number,
  mineCount: number,
  hexSeed: string,
  safeX: number,
  safeY: number
): boolean[][] {
  const prng = mulberry32(seedToUint32(hexSeed));

  const safe = new Set<string>();
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = safeX + dx, ny = safeY + dy;
      if (nx >= 0 && nx < w && ny >= 0 && ny < h) safe.add(`${nx},${ny}`);
    }
  }

  const candidates: [number, number][] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!safe.has(`${x},${y}`)) candidates.push([x, y]);
    }
  }

  // Fisher-Yates in-place
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(prng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  const mines: boolean[][] = Array.from({ length: h }, () => new Array(w).fill(false));
  for (let i = 0; i < mineCount; i++) {
    const [x, y] = candidates[i];
    mines[y][x] = true;
  }
  return mines;
}
