/**
 * Regression test: /game/submit must not trust client-reported move timings.
 *
 * WHAT THIS GUARDS
 *   The leaderboard is ranked by score, and score is a function of time. Every
 *   input that establishes time (move.t and timeSeconds) is supplied by the
 *   client. This test submits valid winning runs for the same seeded board and
 *   asserts the server's timing checks behave. Two invariants hold regardless
 *   of which fix you've shipped, so they are ALWAYS asserted:
 *     - attack  : a real solve with cadence compressed to a few ms/move so the
 *                 whole clear "takes" under a second -> must be REJECTED
 *     - genuine : the same solve at a fast-but-human time where we ACTUALLY WAIT
 *                 OUT the clock before submitting -> must be ACCEPTED (this is
 *                 the false-positive guard: don't punish legitimately quick
 *                 players; it also sanity-checks that the replay wins at all)
 *
 *   With --wallclock (use once you enforce server-measured elapsed time, i.e.
 *   compare submit-arrival to seed-issue) one more run is added:
 *     - instant : a plausible time is CLAIMED but the request is fired with no
 *                 wall-clock elapsed (the "solve offline, submit immediately"
 *                 attack) -> must be REJECTED
 *   Without --wallclock the `genuine` run also submits immediately, since the
 *   only defense being exercised is the plausibility floor.
 *
 * SAFETY
 *   BASE_URL defaults to your local/staging server. Do NOT point this at
 *   production — it exists to prove the FIX rejects the payload, and a fresh
 *   seedSig is only valid against the server that issued it anyway. Uses a
 *   throwaway handle, never a real leaderboard identity.
 *
 * RUN
 *   Start the server locally (dev config in api.js proxies to :3001), then:
 *     node timing-integrity.test.mjs
 *     node timing-integrity.test.mjs --difficulty=intermediate
 *     node timing-integrity.test.mjs --difficulty=expert --wallclock
 *     BASE_URL=http://localhost:3001 node timing-integrity.test.mjs
 *   Note: --wallclock makes the `genuine`/`instant` runs WAIT the full claimed
 *   time (up to ~110s on expert). That real delay is the point of the test.
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';
const HANDLE   = process.env.HANDLE   || 'regression-test';

function argVal(name, def) {
  const pref = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : def;
}
const DIFFICULTY = (process.env.DIFFICULTY || argVal('difficulty', 'beginner')).toLowerCase();
// --wallclock: assert the server enforces server-measured elapsed time.
// (--mimic kept as an alias — its "wait out the clock" behaviour is the same.)
const WALLCLOCK = process.argv.includes('--wallclock') ||
                  process.argv.includes('--mimic') || process.argv.includes('--mimick');

// Fast-but-human clear times per difficulty (near real-world records). The
// `genuine` run targets these to be a strong false-positive guard.
const FAST_LEGIT_SECONDS = { beginner: 8, intermediate: 45, expert: 110 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- board reconstruction: copied verbatim from the public game.js ---- */
/* These MUST match server/src/prng.ts, which is the whole point of the test:
   the client (and therefore anyone) can rebuild the board from the seed. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}
function seedToUint32(hexSeed) {
  return parseInt(hexSeed.slice(0, 8), 16);
}
function placeMinesFromSeed(w, h, mineCount, hexSeed, safeX, safeY) {
  const prng = mulberry32(seedToUint32(hexSeed));
  const safe = new Set();
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const nx = safeX + dx, ny = safeY + dy;
      if (nx >= 0 && nx < w && ny >= 0 && ny < h) safe.add(`${nx},${ny}`);
    }
  const candidates = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (!safe.has(`${x},${y}`)) candidates.push([x, y]);
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(prng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const mines = Array.from({ length: h }, () => new Array(w).fill(false));
  for (let i = 0; i < mineCount; i++) {
    const [x, y] = candidates[i];
    mines[y][x] = true;
  }
  return mines;
}

const DIFFS = {
  beginner:     { w: 9,  h: 9,  m: 10 },
  intermediate: { w: 16, h: 16, m: 40 },
  expert:       { w: 30, h: 16, m: 99 },
};

/* Produce a VALID winning reveal order for a seeded board:
   first click at (fx,fy), then a reveal for every remaining safe cell.
   Redundant reveals (cells a flood already opened) are harmless — the win
   condition is "all safe cells revealed", which this trivially satisfies. */
function solveReveals(seed, dif, fx, fy) {
  const { w, h, m } = DIFFS[dif];
  const mines = placeMinesFromSeed(w, h, m, seed, fx, fy);
  const order = [[fx, fy]];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (!mines[y][x] && !(x === fx && y === fy)) order.push([x, y]);
  return order;
}

/* Stamp a reveal order with timestamps. cadenceMs controls the story we tell
   the server about how fast the human moved. */
function buildMoves(reveals, cadenceMs) {
  return reveals.map(([x, y], i) => ({ type: 'reveal', x, y, t: i * cadenceMs }));
}

async function api(method, path, body) {
  const res = await fetch(BASE_URL + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  return { status: res.status, ok: res.ok, json, text };
}

async function submitRun(label, opts) {
  const { cadenceMs: fixedCadence, targetSeconds, sleepToMatch = false } = opts;

  // Fresh signed seed from the TARGET server (its own key).
  const start = await api('POST', '/game/start', { difficulty: DIFFICULTY });
  if (!start.ok) throw new Error(`/game/start failed: ${start.status} ${start.text}`);
  const { gameId, seed, seedSig } = start.json;

  const fx = 4, fy = 4; // first click; anything on the board works
  const reveals = solveReveals(seed, DIFFICULTY, fx, fy);

  // Cadence is either a fixed ms/move, or derived so the whole solve spans
  // targetSeconds (used by the mimic run to hit a realistic total time).
  const gaps = Math.max(1, reveals.length - 1);
  const cadenceMs = targetSeconds != null
    ? Math.max(1, Math.floor((targetSeconds * 1000) / gaps))
    : fixedCadence;

  const moves = buildMoves(reveals, cadenceMs);
  const lastMs = moves.length ? Math.max(...moves.map((m) => m.t)) : 0;
  const timeSeconds = Math.round(lastMs / 1000);

  // A real client lets wall-clock time actually pass between /game/start and
  // /game/submit. sleepToMatch waits ~timeSeconds so a server that compares
  // submit-arrival to seed-issue sees an elapsed consistent with the claim.
  // control/attack skip this (sleepToMatch=false) and submit instantly.
  if (sleepToMatch && timeSeconds > 0) {
    console.log(`\n[${label}] waiting ${timeSeconds}s to match the claimed time...`);
    await sleep(timeSeconds * 1000);
  }

  const submit = await api('POST', '/game/submit', {
    gameId, seed, seedSig,
    difficulty: DIFFICULTY,
    moves,
    handle: HANDLE,
    nameKey: 'regression-test-key-0000',
    timeSeconds,
  });

  console.log(`\n[${label}] cadence=${cadenceMs}ms/move  timeSeconds=${timeSeconds}  waited=${sleepToMatch ? timeSeconds + 's' : '0s'}`);
  console.log(`  HTTP ${submit.status}  score=${submit.json?.score ?? '(none)'}  ` +
              `reason=${submit.json?.reason ?? '-'}  onLeaderboard=${submit.json?.onLeaderboard ?? '-'}`);
  return submit;
}

/* A run is "accepted as a real score" if the server returns 2xx AND a
   non-null score. Adjust to your server's exact reject signal if it differs. */
function scored(r) {
  return r.ok && r.json && r.json.score != null;
}

(async () => {
  if (!DIFFS[DIFFICULTY]) {
    console.error(`Unknown difficulty "${DIFFICULTY}". Use one of: ${Object.keys(DIFFS).join(', ')}`);
    process.exit(2);
  }
  const fastSecs = FAST_LEGIT_SECONDS[DIFFICULTY];
  console.log(`Target: ${BASE_URL}  difficulty: ${DIFFICULTY}  wallclock: ${WALLCLOCK}`);

  let failures = 0;

  // INVARIANT 1 — the impossibly-fast run must always be rejected.
  const attack = await submitRun('attack', { cadenceMs: 3 });        // whole board in ~1s
  if (scored(attack)) {
    console.error('\n✗ VULNERABLE: sub-second clear was accepted and scored. ' +
                  'Server is trusting client timing.');
    failures++;
  } else {
    console.log('\n✓ OK: impossibly-fast clear was rejected.');
  }

  // INVARIANT 2 — a genuine fast-but-human run must always be accepted. Under
  // --wallclock it actually waits out the clock; otherwise it submits at once.
  // Doubles as the harness sanity check that the replay wins at all.
  const genuine = await submitRun('genuine', { targetSeconds: fastSecs, sleepToMatch: WALLCLOCK });
  if (!scored(genuine)) {
    console.error(`\n✗ ${WALLCLOCK ? 'REGRESSION' : 'SETUP'}: the genuine fast run was rejected — ` +
                  (WALLCLOCK
                    ? 'the fix is punishing legitimately quick players (or the wait is mis-timed vs. how the server measures elapsed).'
                    : 'harness or seed/replay mismatch; fix before trusting the result.'));
    failures++;
  } else {
    console.log('\n✓ OK: genuine fast-but-human run accepted.');
  }

  // INVARIANT 3 (only with --wallclock) — solve offline, claim a plausible time,
  // but submit with zero elapsed. A server-authoritative clock must reject it.
  if (WALLCLOCK) {
    const instant = await submitRun('instant', { targetSeconds: fastSecs, sleepToMatch: false });
    if (scored(instant)) {
      console.error('\n✗ BYPASSABLE: a plausible time was accepted with no wall-clock elapsed. ' +
                    'Server is not measuring elapsed time from seed-issue to submit.');
      failures++;
    } else {
      console.log('\n✓ OK: instant-submit (no elapsed time) was rejected.');
    }
  }

  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(2); });
