/* Client IP resolution for rate limiting. */

/**
 * CF-Connecting-IP is set by Cloudflare at the edge from the real TCP peer and
 * is overwritten there even if a client sends one -- unlike X-Forwarded-For,
 * whose *first* hop is whatever the client puts in, so trusting index 0 let
 * anyone reset their own rate-limit bucket per request with a fake header.
 * Production (minesweeper.metalbear.com) always runs behind Cloudflare.
 */
export function resolveClientIp(cfConnectingIp: string | undefined, xForwardedFor: string | undefined): string {
  if (cfConnectingIp) return cfConnectingIp.trim();
  // Fallback for setups without Cloudflare in front (e.g. a bare dev proxy).
  if (xForwardedFor) return xForwardedFor.split(",")[0].trim();
  return "unknown";
}
