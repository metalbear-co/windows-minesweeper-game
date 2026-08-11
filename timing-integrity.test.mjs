/**
 * Live-server regression test: the board must be server-authoritative.
 *
 * HISTORY
 *   This used to guard against a disclosed bug where the server handed the
 *   client a public seed at /game/start and only checked that "enough" real
 *   time passed before submit -- so a script could solve the board offline
 *   from the seed, sleep out the clock, and submit a perfect run. That was
 *   fixed for a while by measuring server-side elapsed time, but it never
 *   stopped a script from reconstructing the whole board and waiting out the
 *   clock; it only made the client's claimed time honest.
 *
 *   The real fix: /game/start no longer returns a seed or any board data at
 *   all. Mines are placed server-side on the first /game/reveal (safe zone
 *   centred on that click) and the response only ever discloses the cells
 *   that exact click opened -- never the rest of the board. There is nothing
 *   to solve offline anymore. See server/src/board.ts.
 *
 * WHAT THIS GUARDS (against a live/staging server, not unit-level)
 *   - /game/start response carries no seed/board data.
 *   - /game/reveal never discloses mines before the game ends.
 *   - /game/submit refuses a game that hasn't been played through to a finish
 *     via real /game/reveal calls (no gameId, no moves, nothing to fabricate).
 *   - A genuinely-played session (real reveal calls) submits and scores.
 *
 * SAFETY
 *   BASE_URL defaults to your local/staging server. Do NOT point this at
 *   production -- it plays real games and posts real (if throwaway) names.
 *
 * RUN
 *   node timing-integrity.test.mjs
 *   BASE_URL=http://localhost:3001 node timing-integrity.test.mjs
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';
const HANDLE = process.env.HANDLE || 'regression-test';

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

/** Play beginner blind (center-first, then row-major) until the game ends.
 *  Returns every /game/reveal response so the caller can inspect them. */
async function playToFinish(gameId) {
  const W = 9, H = 9;
  const opened = new Set();
  const responses = [];
  const order = [[4, 4]];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (x === 4 && y === 4) continue;
    order.push([x, y]);
  }
  for (const [x, y] of order) {
    if (opened.has(`${x},${y}`)) continue;
    const r = await api('POST', '/game/reveal', { gameId, x, y });
    responses.push(r);
    if (!r.ok) continue;
    if (r.json.hitMine || r.json.won) return responses;
    for (const c of r.json.newly) opened.add(`${c.x},${c.y}`);
  }
  return responses;
}

(async () => {
  let failures = 0;
  console.log(`Target: ${BASE_URL}`);

  // INVARIANT 1 -- /game/start discloses no board data.
  const start = await api('POST', '/game/start', { difficulty: 'beginner' });
  if (!start.ok) throw new Error(`/game/start failed: ${start.status} ${start.text}`);
  const leaked = ['seed', 'seedSig', 'mines', 'board'].filter((k) => k in (start.json ?? {}));
  if (leaked.length) {
    console.error(`\n✗ VULNERABLE: /game/start response leaks board data: ${leaked.join(', ')}`);
    failures++;
  } else {
    console.log('\n✓ OK: /game/start discloses no board data.');
  }
  const gameId = start.json.gameId;

  // INVARIANT 2 -- a fabricated/unplayed submission is rejected.
  const fabricated = await api('POST', '/game/submit', { gameId, handle: HANDLE, nameKey: 'regression-test-key-0000' });
  if (fabricated.ok) {
    console.error('\n✗ VULNERABLE: submitting a gameId with no reveal calls was accepted.');
    failures++;
  } else {
    console.log('✓ OK: a game with no reveal calls can\'t be submitted.');
  }
  const neverStarted = await api('POST', '/game/submit', { gameId: 'not-a-real-game-id', handle: HANDLE, nameKey: 'regression-test-key-0000' });
  if (neverStarted.ok) {
    console.error('\n✗ VULNERABLE: submitting a fabricated gameId was accepted.');
    failures++;
  } else {
    console.log('✓ OK: a fabricated gameId can\'t be submitted.');
  }

  // INVARIANT 3 -- mines are never disclosed before the game ends, and a
  // genuinely-played session (real /game/reveal calls) submits and scores.
  const responses = await playToFinish(gameId);
  const leakedEarly = responses.slice(0, -1).some((r) => r.ok && r.json.mines);
  if (leakedEarly) {
    console.error('\n✗ VULNERABLE: /game/reveal disclosed mines before the game ended.');
    failures++;
  } else {
    console.log('✓ OK: mines were never disclosed before the game ended.');
  }

  const submit = await api('POST', '/game/submit', { gameId, handle: HANDLE, nameKey: 'regression-test-key-0000' });
  const scored = submit.ok && submit.json && submit.json.score != null;
  console.log(`  submit -> HTTP ${submit.status}  score=${submit.json?.score ?? '(none)'}  reason=${submit.json?.reason ?? '-'}`);
  if (!scored) {
    console.error('\n✗ SETUP/REGRESSION: a genuinely-played, finished session was rejected.');
    failures++;
  } else {
    console.log('✓ OK: a genuinely-played session was accepted and scored.');
  }

  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(2); });
