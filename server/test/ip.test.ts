/* Regression test: the rate-limit key must not be resettable by a spoofed header. */
import { resolveClientIp } from "../src/ip.js";

describe("resolveClientIp", () => {
  test("uses CF-Connecting-IP when present, ignoring a spoofed XFF", () => {
    expect(resolveClientIp("9.9.9.9", "attacker-controlled, 9.9.9.9")).toBe("9.9.9.9");
  });

  test("a fake CF-Connecting-IP value would still be trusted -- Cloudflare is what guarantees it's real", () => {
    // Documents the trust boundary: this function trusts the header value it's given.
    // Safety comes from Cloudflare always overwriting CF-Connecting-IP at the edge,
    // never from anything in this function.
    expect(resolveClientIp("spoofed-if-cloudflare-didnt-strip-it", undefined)).toBe("spoofed-if-cloudflare-didnt-strip-it");
  });

  test("falls back to the first X-Forwarded-For hop when CF-Connecting-IP is absent (dev/non-CF setups)", () => {
    expect(resolveClientIp(undefined, "10.0.0.1, 10.0.0.2")).toBe("10.0.0.1");
  });

  test("falls back to 'unknown' when neither header is present", () => {
    expect(resolveClientIp(undefined, undefined)).toBe("unknown");
  });
});
