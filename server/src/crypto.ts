import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const GAME_SECRET = process.env.GAME_SECRET ?? "dev-game-secret-change-in-prod";
const SHARE_SECRET = process.env.SHARE_SECRET ?? "dev-secret-change-in-prod";

/* ---- HMAC helpers ---- */

function hmacGame(payload: string): string {
  return createHmac("sha256", GAME_SECRET).update(payload).digest("base64url");
}

function hmacShare(payload: string): string {
  return createHmac("sha256", SHARE_SECRET).update(payload).digest("base64url");
}

function timingSafeEqual64(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/* ---- Seed signature ---- */

/** Sign gameId + seed. Stored alongside the game so the client can't swap seeds. */
export function signSeed(gameId: string, seed: string): string {
  return hmacGame(`${gameId}:${seed}`);
}

export function verifySeed(gameId: string, seed: string, sig: string): boolean {
  return timingSafeEqual64(hmacGame(`${gameId}:${seed}`), sig);
}

/* ---- Claim token ---- */
// Format: base64url({difficulty}:{date}:{handle}).HMAC(GAME_SECRET)

export function signClaimToken(difficulty: string, date: string, handle: string): string {
  const payload = Buffer.from(`${difficulty}:${date}:${handle}`).toString("base64url");
  return `${payload}.${hmacGame(payload)}`;
}

export function verifyClaimToken(token: string): { difficulty: string; date: string; handle: string } {
  const dot = token.lastIndexOf(".");
  if (dot === -1) throw new Error("malformed claim token");
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!timingSafeEqual64(hmacGame(payload), sig)) throw new Error("invalid claim token signature");
  const decoded = Buffer.from(payload, "base64url").toString("utf8");
  const parts = decoded.split(":");
  if (parts.length < 3) throw new Error("malformed claim token payload");
  // handle may contain colons -- rejoin the tail
  const [difficulty, date, ...handleParts] = parts;
  return { difficulty, date, handle: handleParts.join(":") };
}

/* ---- Share token ---- */
// Format: base64url(JSON.stringify(ShareResult)).HMAC(SHARE_SECRET)
// Must be compatible with share-image-service/src/token.ts signResult().

export interface ShareResult {
  handle: string;
  timeSeconds: number;
  difficulty: "beginner" | "intermediate" | "expert";
  isWinner: boolean;
  url: string;
}

export function signShareToken(result: ShareResult): string {
  const payload = Buffer.from(JSON.stringify(result)).toString("base64url");
  return `${payload}.${hmacShare(payload)}`;
}

/* ---- Random seed ---- */

export function generateSeed(): string {
  return randomBytes(16).toString("hex");
}
