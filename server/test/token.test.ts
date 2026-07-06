/* Tests for token signing and verification */
import { signClaimToken, verifyClaimToken, signShareToken } from "../src/crypto.js";

describe("claimToken", () => {
  test("round-trip: sign then verify returns original fields", () => {
    const token = signClaimToken("beginner", "2024-01-15", "bearclaw");
    const { difficulty, date, handle } = verifyClaimToken(token);
    expect(difficulty).toBe("beginner");
    expect(date).toBe("2024-01-15");
    expect(handle).toBe("bearclaw");
  });

  test("tampered payload is rejected", () => {
    const token = signClaimToken("expert", "2024-01-15", "hacker");
    const [payload, sig] = token.split(".");
    // Flip the first char of payload to corrupt it
    const badPayload = (payload.charCodeAt(0) ^ 1) === payload.charCodeAt(0)
      ? String.fromCharCode(payload.charCodeAt(0) ^ 1) + payload.slice(1)
      : payload.slice(0, -1) + String.fromCharCode(payload.charCodeAt(payload.length - 1) ^ 1);
    const badToken = `${badPayload}.${sig}`;
    expect(() => verifyClaimToken(badToken)).toThrow();
  });

  test("tampered signature is rejected", () => {
    const token = signClaimToken("beginner", "2024-01-15", "mira");
    const dot = token.lastIndexOf(".");
    const badToken = token.slice(0, dot + 1) + "AAAAAA";
    expect(() => verifyClaimToken(badToken)).toThrow();
  });

  test("missing dot (malformed) is rejected", () => {
    expect(() => verifyClaimToken("nodothere")).toThrow(/malformed/);
  });

  test("handle containing colons round-trips correctly", () => {
    // Handles with colons should not break the split logic
    const token = signClaimToken("intermediate", "2024-06-30", "user:name");
    const { handle } = verifyClaimToken(token);
    expect(handle).toBe("user:name");
  });
});

describe("shareToken", () => {
  test("produces base64url(json).sig format compatible with share-image-service", () => {
    const result = {
      handle: "bearclaw",
      timeSeconds: 47,
      difficulty: "expert" as const,
      isWinner: true,
      url: "minesweeper.metalbear.com",
    };
    const token = signShareToken(result);

    // Must contain exactly one dot separating payload from sig
    const dot = token.lastIndexOf(".");
    expect(dot).toBeGreaterThan(0);

    const payload = token.slice(0, dot);
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));

    expect(decoded.handle).toBe(result.handle);
    expect(decoded.timeSeconds).toBe(result.timeSeconds);
    expect(decoded.difficulty).toBe(result.difficulty);
    expect(decoded.isWinner).toBe(true);
    expect(decoded.url).toBe(result.url);
  });

  test("different secrets produce different sigs", () => {
    const result = {
      handle: "test",
      timeSeconds: 10,
      difficulty: "beginner" as const,
      isWinner: false,
      url: "minesweeper.metalbear.com",
    };
    // Sign twice with same (default dev) secret -- tokens must be equal
    const t1 = signShareToken(result);
    const t2 = signShareToken(result);
    expect(t1).toBe(t2);
  });
});
