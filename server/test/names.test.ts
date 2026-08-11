import { reserveName, type NameStore } from "../src/names.js";

// In-memory fake of the two Redis ops reserveName uses (SET NX + GET).
function fakeRedis(): NameStore {
  const m = new Map<string, string>();
  return {
    async set(key, value, _mode) { if (m.has(key)) return null; m.set(key, value); return "OK"; },
    async get(key) { return m.get(key) ?? null; },
  };
}

const SEASON = "test-season-1";

test("first browser owns the name; a different nameKey is rejected", async () => {
  const r = fakeRedis();
  expect(await reserveName(r, SEASON, "Jake", "owner-key-aaaaaaaa")).toBe("ok");
  // same owner can resubmit under the same name
  expect(await reserveName(r, SEASON, "Jake", "owner-key-aaaaaaaa")).toBe("ok");
  // hijacker with a different key is blocked
  expect(await reserveName(r, SEASON, "Jake", "hijacker-key-bbbb")).toBe("taken");
});

test("ownership is case-insensitive so 'jake' can't dodge 'Jake'", async () => {
  const r = fakeRedis();
  expect(await reserveName(r, SEASON, "Jake", "owner-key-aaaaaaaa")).toBe("ok");
  expect(await reserveName(r, SEASON, "jake", "hijacker-key-bbbb")).toBe("taken");
});

test("a name locked in one season is free again in the next season", async () => {
  const r = fakeRedis();
  expect(await reserveName(r, "kubecon-japan-2026", "Jake", "owner-key-aaaaaaaa")).toBe("ok");
  // A different person at the next event can take the same name under a new season.
  expect(await reserveName(r, "leaddev-nyc-2026", "Jake", "someone-elses-key-9")).toBe("ok");
});
