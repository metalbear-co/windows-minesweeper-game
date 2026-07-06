import { reserveName, type NameStore } from "../src/names.js";

// In-memory fake of the two Redis ops reserveName uses (SET NX + GET).
function fakeRedis(): NameStore {
  const m = new Map<string, string>();
  return {
    async set(key, value, _mode) { if (m.has(key)) return null; m.set(key, value); return "OK"; },
    async get(key) { return m.get(key) ?? null; },
  };
}

test("first browser owns the name; a different nameKey is rejected", async () => {
  const r = fakeRedis();
  expect(await reserveName(r, "Jake", "owner-key-aaaaaaaa")).toBe("ok");
  // same owner can resubmit under the same name
  expect(await reserveName(r, "Jake", "owner-key-aaaaaaaa")).toBe("ok");
  // hijacker with a different key is blocked
  expect(await reserveName(r, "Jake", "hijacker-key-bbbb")).toBe("taken");
});

test("ownership is case-insensitive so 'jake' can't dodge 'Jake'", async () => {
  const r = fakeRedis();
  expect(await reserveName(r, "Jake", "owner-key-aaaaaaaa")).toBe("ok");
  expect(await reserveName(r, "jake", "hijacker-key-bbbb")).toBe("taken");
});
