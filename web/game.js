/* MetalBear Minesweeper -- game engine + API integration
   Core game logic preserved exactly from prototype.
   Added: seeded board (mulberry32), move tracking, real API calls.
*/
import { startGame, submitGame, getLeaderboard } from './api.js';
import { downloadImage } from './share.js';

/* ============================================================
   PRNG -- mulberry32 (must be bit-for-bit identical to server/src/prng.ts)
   ============================================================ */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

function seedToUint32(hexSeed) {
  return parseInt(hexSeed.slice(0, 8), 16);
}

/* Mine placement: Fisher-Yates shuffle of non-safe cells, take first mineCount.
   Safe zone = 3x3 around first click. */
function placeMinesFromSeed(w, h, mineCount, hexSeed, safeX, safeY) {
  const prng = mulberry32(seedToUint32(hexSeed));
  const safe = new Set();
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const nx = safeX + dx, ny = safeY + dy;
    if (nx >= 0 && nx < w && ny >= 0 && ny < h) safe.add(`${nx},${ny}`);
  }
  const candidates = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!safe.has(`${x},${y}`)) candidates.push([x, y]);
  }
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

/* ============================================================
   Constants
   ============================================================ */
const DIFFS = {
  beginner:     { w: 9,  h: 9,  m: 10, label: 'Beginner',     desc: '9x9 - 10 mines' },
  intermediate: { w: 16, h: 16, m: 40, label: 'Intermediate', desc: '16x16 - 40 mines' },
  expert:       { w: 30, h: 16, m: 99, label: 'Expert',       desc: '30x16 - 99 mines' },
};

/* ============================================================
   State
   ============================================================ */
let state = {
  dif: 'intermediate',
  grid: [], w: 0, h: 0, mines: 0,
  started: false, over: false, win: false,
  flags: 0, revealed: 0,
  time: 0, timerId: null,
  placed: false, flagMode: false,
  // server-issued values
  gameId: null, seed: null, seedSig: null, serverTimeUTC: null,
  // move tracking: [{type, x, y, t}] where t = ms since first reveal
  moves: [],
  firstRevealAt: null,
  // result from /game/submit
  submitResult: null,
  // leaderboard data
  lbData: null,
  myToken: null,
};

/* ============================================================
   DOM helpers
   ============================================================ */
const $ = id => document.getElementById(id);
const board = $('board');

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ============================================================
   Board setup
   ============================================================ */
async function newGame() {
  const d = DIFFS[state.dif];
  state.w = d.w; state.h = d.h; state.mines = d.m;
  state.grid = []; state.started = false; state.over = false; state.win = false;
  state.flags = 0; state.revealed = 0; state.time = 0; state.placed = false;
  state.moves = []; state.firstRevealAt = null; state.submitResult = null;
  clearInterval(state.timerId); state.timerId = null;
  state.gameId = null; state.seed = null; state.seedSig = null; state.serverTimeUTC = null;

  $('smiley').textContent = '🙂';
  $('timer').textContent = '000';
  setMineCounter();

  for (let y = 0; y < d.h; y++) {
    const row = [];
    for (let x = 0; x < d.w; x++) {
      row.push({ mine: false, open: false, flag: false, n: 0 });
    }
    state.grid.push(row);
  }
  renderBoard();

  // Fetch seed from server in background, so it's ready before first click
  try {
    const data = await startGame(state.dif);
    state.gameId = data.gameId;
    state.seed = data.seed;
    state.seedSig = data.seedSig;
    state.serverTimeUTC = data.serverTimeUTC;
  } catch (err) {
    console.warn('Could not fetch game seed from server:', err);
    // ponytail: fall back to random play so game is never blocked on server
    state.seed = null;
  }
}

function renderBoard() {
  board.style.gridTemplateColumns = `repeat(${state.w}, 1fr)`;
  board.innerHTML = '';
  for (let y = 0; y < state.h; y++) for (let x = 0; x < state.w; x++) {
    const c = document.createElement('div');
    c.className = 'cell'; c.dataset.x = x; c.dataset.y = y;
    board.appendChild(c);
  }
}

function placeMines(safeX, safeY) {
  if (state.seed) {
    // Seeded placement: deterministic, same as server verifier
    const mineGrid = placeMinesFromSeed(state.w, state.h, state.mines, state.seed, safeX, safeY);
    for (let y = 0; y < state.h; y++) for (let x = 0; x < state.w; x++) {
      state.grid[y][x].mine = mineGrid[y][x];
    }
  } else {
    // ponytail: unseeded fallback when server is unreachable -- score won't be submittable
    const d = DIFFS[state.dif];
    const safe = new Set();
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      safe.add((safeY + dy) + '_' + (safeX + dx));
    }
    let placed = 0;
    while (placed < d.m) {
      const x = Math.floor(Math.random() * state.w), y = Math.floor(Math.random() * state.h);
      if (state.grid[y][x].mine) continue;
      if (safe.has(y + '_' + x)) continue;
      state.grid[y][x].mine = true; placed++;
    }
  }

  // Compute neighbor counts
  for (let y = 0; y < state.h; y++) for (let x = 0; x < state.w; x++) {
    if (state.grid[y][x].mine) continue;
    let n = 0;
    neighbors(x, y).forEach(([nx, ny]) => { if (state.grid[ny][nx].mine) n++; });
    state.grid[y][x].n = n;
  }
  state.placed = true;
}

function neighbors(x, y) {
  const out = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (dx === 0 && dy === 0) continue;
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && nx < state.w && ny >= 0 && ny < state.h) out.push([nx, ny]);
  }
  return out;
}

function cellEl(x, y) { return board.children[y * state.w + x]; }

/* ============================================================
   Interaction
   ============================================================ */
function startTimer() {
  if (state.timerId) return;
  state.timerId = setInterval(() => {
    if (state.over) return;
    state.time = Math.min(999, state.time + 1);
    $('timer').textContent = String(state.time).padStart(3, '0');
  }, 1000);
}

function nowMs() { return Date.now(); }

function recordMove(type, x, y) {
  const t = state.firstRevealAt !== null ? nowMs() - state.firstRevealAt : 0;
  state.moves.push({ type, x, y, t });
}

function reveal(x, y) {
  if (state.over) return;
  const cell = state.grid[y][x];
  if (cell.open || cell.flag) return;
  if (!state.placed) {
    // First click: plant mines, start clock
    placeMines(x, y);
    state.started = true;
    state.firstRevealAt = nowMs();
    startTimer();
  }
  recordMove('reveal', x, y);
  if (cell.mine) { boom(x, y); return; }
  floodReveal(x, y);
  checkWin();
}

function floodReveal(x, y) {
  const stack = [[x, y]];
  while (stack.length) {
    const [cx, cy] = stack.pop();
    const c = state.grid[cy][cx];
    if (c.open || c.flag || c.mine) continue;
    c.open = true; state.revealed++;
    const el = cellEl(cx, cy); el.classList.add('open'); el.classList.remove('flag');
    if (c.n > 0) { el.textContent = c.n; el.classList.add('n' + c.n); }
    else {
      el.textContent = '';
      neighbors(cx, cy).forEach(([nx, ny]) => {
        if (!state.grid[ny][nx].open) stack.push([nx, ny]);
      });
    }
  }
}

function toggleFlag(x, y) {
  if (state.over) return;
  const c = state.grid[y][x]; if (c.open) return;
  c.flag = !c.flag; state.flags += c.flag ? 1 : -1;
  const el = cellEl(x, y);
  el.textContent = c.flag ? '🚩' : ''; el.classList.toggle('flag', c.flag);
  setMineCounter();
  recordMove(c.flag ? 'flag' : 'unflag', x, y);
}

function setMineCounter() {
  $('mineCount').textContent = String(Math.max(-99, state.mines - state.flags)).padStart(3, '0');
}

function boom(x, y) {
  state.over = true; state.win = false; clearInterval(state.timerId);
  $('smiley').textContent = '😵';
  for (let yy = 0; yy < state.h; yy++) for (let xx = 0; xx < state.w; xx++) {
    const c = state.grid[yy][xx]; const el = cellEl(xx, yy);
    if (c.mine && !c.flag) { el.classList.add('open', 'mine'); el.textContent = ''; }
    if (!c.mine && c.flag) { el.classList.add('open'); el.textContent = '❌'; }
  }
  const el = cellEl(x, y); el.classList.add('exploded'); el.textContent = '💥';
  setTimeout(handleLoss, 350);
}

function checkWin() {
  const total = state.w * state.h;
  if (state.revealed === total - state.mines) {
    state.over = true; state.win = true; clearInterval(state.timerId);
    $('smiley').textContent = '😎';
    // auto-flag remaining mines
    for (let y = 0; y < state.h; y++) for (let x = 0; x < state.w; x++) {
      const c = state.grid[y][x];
      if (c.mine && !c.flag) { c.flag = true; const el = cellEl(x, y); el.textContent = '🚩'; }
    }
    state.flags = state.mines; setMineCounter();
    setTimeout(handleWin, 350);
  }
}

/* ============================================================
   Win flow: submit to server, show results
   ============================================================ */
function handleWin() { submitSession(true); }
function handleLoss() { submitSession(false); }

/* Every session scores now -- win or loss. The server computes the real score
   from the replay; the client just shows it and refreshes the board. */
async function submitSession(won) {
  const timeSeconds = state.time;

  // Ensure a name lands on the leaderboard: prompt if the nickname field is empty.
  let handle = getHandle();
  if (!handle) {
    handle = (await win98Prompt('Enter your name for the leaderboard:')) || '';
    if (handle) $('handle').value = handle;  // reflect in the field so modal/share use it
  }

  // Unseeded fallback game -- can't submit; just show the local result.
  if (!state.gameId || !state.seed || !state.seedSig) {
    showResults({ won, timeSeconds, score: null, rank: null });
    return;
  }

  // Resolve the name FIRST -- keep submitting/prompting until it lands or the
  // player bails. The score card is only revealed once the name is settled, so a
  // "name taken" dialog never appears on top of (or after) the results modal.
  const nameKey = getNameKey();
  let result = null;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      result = await submitGame({
        gameId: state.gameId,
        seed: state.seed,
        seedSig: state.seedSig,
        difficulty: state.dif,
        moves: state.moves,
        handle: handle || undefined,
        nameKey,
        timeSeconds,
      });

      if (result.reason === 'name_taken') {
        const next = (await win98Prompt(`"${handle}" is already taken by another player. Pick a different name:`)) || '';
        if (next) { handle = next; $('handle').value = next; continue; }
        // Bailed out -- keep this (off-board) result and show the score anyway.
      }
      break;
    }
  } catch (err) {
    console.warn('Score submission failed:', err);
  }

  // Name is settled -- now reveal the score card with the final data.
  if (result) {
    state.submitResult = result;
    if (result.claimToken) state.myToken = result.claimToken;  // highlight my row
    showResults({ won: result.won, timeSeconds, score: result.score, rank: result.rank, onLeaderboard: result.onLeaderboard });
    if (result.onLeaderboard) loadLeaderboard();
  } else {
    // Network error -- still show the local win/loss so the player isn't left hanging.
    showResults({ won, timeSeconds, score: null, rank: null });
  }
}

/* Per-browser secret that proves ownership of a leaderboard name (first-come). */
function getNameKey() {
  let k = localStorage.getItem('nameKey');
  if (!k) { k = crypto.randomUUID() + crypto.randomUUID(); localStorage.setItem('nameKey', k); }
  return k;
}

/* Win98-styled replacement for window.prompt. Resolves to a trimmed name, or
   null if the player cancels. */
function win98Prompt(message, defaultValue = '') {
  return new Promise((resolve) => {
    const ov = $('nameOverlay'), input = $('namePromptInput');
    $('namePromptMsg').textContent = message;
    input.value = defaultValue;
    ov.classList.add('show');
    input.focus(); input.select();

    const close = (val) => {
      ov.classList.remove('show');
      input.onkeydown = null;
      $('namePromptOk').onclick = $('namePromptCancel').onclick = $('namePromptX').onclick = null;
      resolve(val);
    };
    const ok = () => close(input.value.trim().slice(0, 14));
    $('namePromptOk').onclick = ok;
    $('namePromptCancel').onclick = () => close(null);
    $('namePromptX').onclick = () => close(null);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') ok();
      else if (e.key === 'Escape') close(null);
    };
  });
}

/* ============================================================
   Results modal (win or loss -- both shareable)
   ============================================================ */
function showResults(result) {
  const won = result.won;
  const timeSeconds = result.timeSeconds || state.time;
  const handle = getHandle() || 'anon';
  const dlabel = label(state.dif);
  const safeTotal = state.w * state.h - state.mines;
  const revealed = state.revealed;

  const score = result.score;  // null while the submission is in flight
  const emoji = won ? '🏆' : '💥';
  const rankPart = result.rank != null ? ` · Rank #${result.rank}` : '';

  $('resTitle').textContent = `${emoji} Minesweeper · ${dlabel}${rankPart}`;
  $('resScore').textContent = score != null ? score.toLocaleString() : '…';
  $('resTime').textContent = `${timeSeconds}s`;
  $('resCleared').textContent = `${revealed}/${safeTotal}`;
  $('resPlayer').textContent = handle;

  const note = $('resNote');
  if (score != null && result.onLeaderboard === false) {
    note.hidden = false;
    note.textContent = 'Add a name to claim your spot on the leaderboard.';
  } else {
    note.hidden = true;
  }

  // Data for the downloaded PNG (Save button renders share.js drawCard off-screen).
  const shareData = { handle, difficulty: state.dif, timeSeconds, won, revealed, safeTotal, score, rank: result.rank };
  $('saveImg').onclick = () => downloadImage(shareData);

  $('overlay').classList.add('show');
}

/* Capitalised full difficulty name for the title (DIFFS.label is abbreviated). */
function label(dif) { return dif.charAt(0).toUpperCase() + dif.slice(1); }

function closeModal() { $('overlay').classList.remove('show'); }

/* ============================================================
   Leaderboard
   ============================================================ */
async function loadLeaderboard() {
  const lbEl = $('leaderboard');
  try {
    const data = await getLeaderboard(state.dif, state.myToken || undefined);
    state.lbData = data;
    renderLeaderboard(data);
  } catch {
    lbEl.innerHTML = '<div class="lb-error">Could not load leaderboard.</div>';
  }
}

function renderLeaderboard(data) {
  const lbEl = $('leaderboard');
  if (!data || !data.entries || data.entries.length === 0) {
    lbEl.innerHTML = '<div class="small" style="color:#555;padding:4px 0">No scores yet -- be the first!</div>';
    return;
  }
  lbEl.innerHTML = data.entries.map((e) =>
    `<div class="lbrow${e.isMe ? ' me' : ''}">
      <span class="rk">${e.rank}.</span>
      <span class="nm">${escapeHtml(e.handle)}</span>
      <span class="tm">${fmtScore(e.score)}</span>
    </div>`
  ).join('');
}

function fmtScore(s) { return Number(s).toLocaleString(); }
function getHandle() { return $('handle').value.trim().slice(0, 14); }

/* ============================================================
   Taskbar clock
   ============================================================ */
function pad(n) { return String(n).padStart(2, '0'); }

function tick() {
  const now = new Date();
  $('taskclock').textContent = `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())} UTC`;
}
setInterval(tick, 1000); tick();

/* ============================================================
   Pointer handling (left/right/touch) -- identical to prototype
   ============================================================ */
board.addEventListener('mousedown', e => {
  const t = e.target.closest('.cell'); if (!t || state.over) return;
  if (e.button === 0 && !state.flagMode) $('smiley').textContent = '😮';
});
document.addEventListener('mouseup', () => { if (!state.over) $('smiley').textContent = '🙂'; });

board.addEventListener('click', e => {
  const t = e.target.closest('.cell'); if (!t) return;
  const x = +t.dataset.x, y = +t.dataset.y;
  if (state.flagMode) toggleFlag(x, y); else reveal(x, y);
  if (!state.over) $('smiley').textContent = '🙂';
});
board.addEventListener('contextmenu', e => {
  e.preventDefault();
  const t = e.target.closest('.cell'); if (!t) return;
  toggleFlag(+t.dataset.x, +t.dataset.y);
});

let pressTimer = null;
board.addEventListener('touchstart', e => {
  const t = e.target.closest('.cell'); if (!t) return;
  pressTimer = setTimeout(() => { toggleFlag(+t.dataset.x, +t.dataset.y); pressTimer = null; }, 350);
}, { passive: true });
board.addEventListener('touchend', () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } }, { passive: true });

$('smiley').addEventListener('click', newGame);
$('modalClose').addEventListener('click', closeModal);

$('flagToggle').addEventListener('click', () => {
  state.flagMode = !state.flagMode;
  $('flagToggle').textContent = '🚩 Flag mode: ' + (state.flagMode ? 'ON' : 'OFF');
  $('flagToggle').style.background = state.flagMode ? '#ffe08a' : '';
});

/* Difficulty tabs */
document.querySelectorAll('.diftab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.diftab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    state.dif = tab.dataset.d;
    $('difDesc').textContent = DIFFS[state.dif].desc;
    $('lbDif').textContent = DIFFS[state.dif].label;
    loadLeaderboard();
    newGame();
  });
});

/* CTA links */
const ctaUrl = 'https://app.metalbear.com/account/sign-up';  // "Try Free"
$('bannerCta').addEventListener('click', () => window.open(ctaUrl, '_blank'));
$('footCta').addEventListener('click', () => window.open(ctaUrl, '_blank'));
$('footInstall').addEventListener('click', () => window.open('https://metalbear.com/contact/', '_blank'));  // "Book a Demo"

/* ============================================================
   Boot
   ============================================================ */
loadLeaderboard();
newGame();

// Refresh leaderboard every 60 seconds
setInterval(loadLeaderboard, 60_000);
