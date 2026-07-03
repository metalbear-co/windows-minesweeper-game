/* Claim mechanics: window check, storage, one-shot enforcement */
import type { Redis } from "ioredis";
import { isLeader } from "./leaderboard.js";
import type { Difficulty } from "./game.js";

export interface ClaimRecord {
  difficulty: string;
  date: string;
  handle: string;
  rank: number;
  claimed: "0" | "1";
}

function claimKey(claimToken: string): string {
  return `claim:${claimToken}`;
}

/** Write a claim record after a successful submission. */
export async function storeClaim(
  redis: Redis,
  claimToken: string,
  difficulty: string,
  date: string,
  handle: string,
  rank: number
): Promise<void> {
  const key = claimKey(claimToken);
  await redis.hset(key, {
    difficulty,
    date,
    handle,
    rank: String(rank),
    claimed: "0",
  });
  // No expiry -- claim records live for the whole running event.
}

/** Check claim status without mutating anything. */
export async function getClaimStatus(
  redis: Redis,
  claimToken: string
): Promise<{ found: boolean; isLeader: boolean; claimWindowOpen: boolean; resetInSeconds: number; claimed: boolean }> {
  const key = claimKey(claimToken);
  const rec = await redis.hgetall(key) as Partial<ClaimRecord>;
  if (!rec || !rec.difficulty) {
    return { found: false, isLeader: false, claimWindowOpen: false, resetInSeconds: 0, claimed: false };
  }

  const leader = await isLeader(redis, rec.difficulty as Difficulty, claimToken);

  // Running event: the current leader can claim any time (we judge on Friday).
  return {
    found: true,
    isLeader: leader,
    claimWindowOpen: leader,
    resetInSeconds: 0,
    claimed: rec.claimed === "1",
  };
}

/**
 * Attempt to mark as claimed. Returns:
 * - "ok" on success
 * - "already_claimed" if already claimed
 * - "not_leader" if not currently #1
 * - "window_closed" if outside the final UTC hour
 * - "not_found" if token unknown
 */
export async function executeClaim(
  redis: Redis,
  claimToken: string,
  email: string,
  shippingAddress: string
): Promise<"ok" | "already_claimed" | "not_leader" | "window_closed" | "not_found"> {
  const key = claimKey(claimToken);
  const rec = await redis.hgetall(key) as Partial<ClaimRecord>;
  if (!rec || !rec.difficulty) return "not_found";
  if (rec.claimed === "1") return "already_claimed";

  const leader = await isLeader(redis, rec.difficulty as Difficulty, claimToken);
  if (!leader) return "not_leader";

  // Atomic: use HSETNX on the claimed field to avoid races
  const set = await redis.hsetnx(key, "claimed", "1");
  if (!set) return "already_claimed";

  // Store email + address alongside the claim record (same key, new fields)
  await redis.hset(key, { email, shippingAddress });

  return "ok";
}
