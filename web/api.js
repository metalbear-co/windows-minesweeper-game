/* MetalBear Minesweeper -- API client */

// In dev, hit local server. In prod, same origin (nginx proxies /api/* to the backend).
const API = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3001'
  : '';

async function apiFetch(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(API + path, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw Object.assign(new Error(text), { status: res.status });
  }
  return res.json();
}

export async function startGame(difficulty) {
  return apiFetch('POST', '/game/start', { difficulty });
}

export async function submitGame(payload) {
  return apiFetch('POST', '/game/submit', payload);
}

export async function getLeaderboard(difficulty, myToken) {
  const qs = myToken ? `?difficulty=${difficulty}&myToken=${encodeURIComponent(myToken)}` : `?difficulty=${difficulty}`;
  return apiFetch('GET', `/leaderboard${qs}`);
}

export async function getClaimStatus(token) {
  return apiFetch('GET', `/claim/status?token=${encodeURIComponent(token)}`);
}

export async function submitClaim(payload) {
  return apiFetch('POST', '/claim', payload);
}
