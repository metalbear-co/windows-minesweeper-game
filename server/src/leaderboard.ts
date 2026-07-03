/* Redis sorted-set leaderboard operations */
import type { Redis } from "ioredis";
import type { Difficulty } from "./game.js";

// Single running leaderboard for the whole event -- no daily reset, no expiry.
function lbKey(difficulty: Difficulty): string {
  return `lb:${difficulty}`;
}

export interface LeaderboardEntry {
  rank: number;
  handle: string;
  score: number;
  isMe: boolean;
}

/**
 * Add a score to the running leaderboard. Higher is better.
 * Member format: `{claimToken}:{handle}` -- the claimToken is deterministic per
 * (difficulty, handle), so replaying under the same name maps to the same member.
 * GT keeps only the player's highest score, so each name appears once for the event.
 */
export async function addScore(
  redis: Redis,
  difficulty: Difficulty,
  claimToken: string,
  handle: string,
  score: number
): Promise<number> {
  const key = lbKey(difficulty);
  const member = `${claimToken}:${handle}`;
  // GT: update only if the new score beats the stored one; still adds new members.
  // No expiry -- this board runs for the whole event until we clear it manually.
  await redis.zadd(key, "GT", score, member);

  // Rank is 0-indexed from highest score descending
  const rank = await redis.zrevrank(key, member);
  return (rank ?? 0) + 1;
}

/**
 * Get the top entries (up to limit), optionally marking which one is "me".
 */
export async function getLeaderboard(
  redis: Redis,
  difficulty: Difficulty,
  myClaimToken?: string,
  limit = 10
): Promise<{ entries: LeaderboardEntry[] }> {
  const key = lbKey(difficulty);
  // ZREVRANGE with WITHSCORES -- descending by score (highest first)
  const raw = await redis.zrevrange(key, 0, limit - 1, "WITHSCORES");

  const entries: LeaderboardEntry[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const member = raw[i];
    const score = Number(raw[i + 1]);
    // member = "{claimToken}:{handle}" -- split on first colon after the token
    // claimToken itself is base64url.sig so it contains a dot but no colons until the handle part
    // Format: we stored as `${claimToken}:${handle}` so split at first ':'
    const colonIdx = member.indexOf(":");
    const memberClaimToken = colonIdx === -1 ? member : member.slice(0, colonIdx);
    const handle = colonIdx === -1 ? "anon" : member.slice(colonIdx + 1);

    entries.push({
      rank: entries.length + 1,
      handle,
      score,
      isMe: !!myClaimToken && memberClaimToken === myClaimToken,
    });
  }

  return { entries };
}

/**
 * Check if a given claimToken is currently the #1 (lowest score).
 */
export async function isLeader(redis: Redis, difficulty: Difficulty, claimToken: string): Promise<boolean> {
  const key = lbKey(difficulty);
  const top = await redis.zrevrange(key, 0, 0);  // highest score
  if (!top.length) return false;
  return top[0].startsWith(claimToken + ":");
}
