/* First-come leaderboard name ownership. A name (case-insensitive) is locked to
   the SHA of the first browser's nameKey; anyone else submitting under it is
   "taken". This is what stops a player hijacking a name that isn't theirs.
   Scoped by season (see server.ts) so a name locked at one event doesn't stay
   locked forever -- a different attendee at the next event can reuse it. */
import { createHash } from "node:crypto";

// Minimal slice of the Redis API we need -- keeps this unit-testable with a fake.
export interface NameStore {
  set(key: string, value: string, mode: "NX"): Promise<"OK" | null>;
  get(key: string): Promise<string | null>;
}

export async function reserveName(redis: NameStore, season: string, handle: string, nameKey: string): Promise<"ok" | "taken"> {
  const key = `owner:${season}:${handle.toLowerCase()}`;
  const h = createHash("sha256").update(nameKey).digest("base64url");
  const set = await redis.set(key, h, "NX"); // first writer wins; no expiry for the event
  if (set === "OK") return "ok";
  return (await redis.get(key)) === h ? "ok" : "taken";
}
