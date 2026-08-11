/* MetalBear Minesweeper -- game engine + API integration
   Core game logic preserved exactly from prototype.
   The board is server-authoritative: mines are placed server-side on the first
   reveal and disclosed only cell-by-cell as real clicks earn them (see
   server/src/board.ts) -- there's no seed handed to the client to solve offline.
*/
import { startGame, submitGame, getLeaderboard, revealCell as apiReveal } from './api.js';
import { downloadImage } from './share.js';

/* ============================================================
   Constants
   ============================================================ */
const DIFFS = {
  intermediate: { w: 16, h: 16, m: 40 },
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
  gameId: null, serverTimeUTC: null,
  // true once a reveal has actually round-tripped to the server for this game;
  // false means we've fallen back to a local, unscored board (server unreachable).
  online: false,
  // guards against overlapping /game/reveal calls from a double-click
  pending: false,
  // result from /game/submit
  submitResult: null,
  // leaderboard data
  lbData: null,
  myToken: null,
  // player email, collected in the start popup, sent with the score submission
  email: '',
  // whether name + email have been confirmed for the current game (gates the first move)
  identityOk: false,
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

/* The board renders immediately on load; the start popup only appears when
   someone first tries to play (see the board tap handlers). It re-appears for every
   new game because newGame() clears state.identityOk. Pre-filled with the last entry
   so a repeat player just taps Start, while a new walk-up on the iPad types over it. */
let lastName = '';
let lastEmail = '';

/* Make sure we have a name + email for this game before the first move. Returns
   true once identity is set, false if the popup was dismissed. Must be called
   synchronously from the tap/click handler so iOS raises the keyboard. */
async function ensureIdentity() {
  if (state.identityOk) return true;
  const who = await askPlayer();
  if (!who) return false;
  lastName = who.name; lastEmail = who.email;
  state.email = who.email;
  $('handle').value = who.name;   // canonical name store (getHandle/showResults read it)
  $('playingAs').textContent = `Playing as ${who.name}`;
  state.identityOk = true;
  return true;
}

/* Device-local roster of players who've entered on THIS iPad, so a returning
   player can pick their name and have their email auto-filled. Stored only in
   localStorage -- never sent to other clients (emails stay off the wire). */
function loadRoster() {
  try {
    const raw = JSON.parse(localStorage.getItem('msw_players') || '{}');
    // Migrate the old name->email string form to { email, score }.
    const out = {};
    for (const [k, v] of Object.entries(raw)) out[k] = (typeof v === 'string') ? { email: v, score: null } : v;
    return out;
  } catch { return {}; }
}
/* Save a player. Called at the popup (name+email, no score) and after each game
   (with the score); keeps the player's best score so the fold-out can show it. */
function rememberPlayer(name, email, score) {
  const r = loadRoster();
  const prev = r[name] || {};
  const best = (score != null) ? Math.max(score, prev.score || 0) : (prev.score ?? null);
  r[name] = { email: email || prev.email || '', score: best };
  try { localStorage.setItem('msw_players', JSON.stringify(r)); } catch {}
}

/* Start popup -> resolves {name, email} or null if dismissed. */
function askPlayer() {
  return new Promise((resolve) => {
    const ov = $('startOverlay'), n = $('startName'), e = $('startEmail'), err = $('startErr');
    const roster = loadRoster();
    const names = Object.keys(roster);
    const sug = $('nameSuggest');

    // Custom fold-out of players who've played on this device (styled to match the
    // widget, unlike the native <datalist> dropdown). Filters as you type.
    const renderSuggest = () => {
      const f = n.value.trim().toLowerCase();
      const matches = names.filter(nm => nm.toLowerCase().includes(f));
      sug.innerHTML = matches.map(nm => {
        const s = roster[nm].score;
        const sc = (s != null) ? `<span class="ns-score">${Number(s).toLocaleString()}</span>` : '';
        return `<div class="ns-row" data-name="${escapeHtml(nm)}">${escapeHtml(nm)}${sc}</div>`;
      }).join('');
      sug.hidden = matches.length === 0;
    };
    const pick = (nm) => { n.value = nm; if (roster[nm]) e.value = roster[nm].email; sug.hidden = true; e.focus(); };

    n.value = lastName; e.value = lastEmail; err.hidden = true; sug.hidden = true;

    // Wire handlers BEFORE focusing so the initial autofocus shows the fold-out too.
    n.onfocus = renderSuggest;
    // Typing filters the list, and an exact name match auto-fills that player's email.
    n.oninput = () => { renderSuggest(); const hit = roster[n.value.trim()]; if (hit) e.value = hit.email; };
    n.onblur = () => setTimeout(() => { sug.hidden = true; }, 120);
    sug.onmousedown = (ev) => ev.preventDefault();   // keep the input focused so the tap registers
    sug.onclick = (ev) => { const row = ev.target.closest('.ns-row'); if (row) pick(row.dataset.name); };

    ov.classList.add('show');
    n.focus(); n.select();
    renderSuggest();   // reveal saved players on open (self-hides when the roster is empty)

    const done = (val) => {
      ov.classList.remove('show');
      $('startOk').onclick = null; $('startX').onclick = null;
      n.onkeydown = null; e.onkeydown = null;
      n.onfocus = null; n.oninput = null; n.onblur = null;
      sug.onmousedown = null; sug.onclick = null; sug.hidden = true;
      resolve(val);
    };
    const submit = () => {
      const name = n.value.trim().slice(0, 14);
      const email = e.value.trim().slice(0, 120);
      if (!name) { err.textContent = 'Please enter your name.'; err.hidden = false; n.focus(); return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        err.textContent = 'Please enter a valid email.'; err.hidden = false; e.focus(); return;
      }
      rememberPlayer(name, email);
      done({ name, email });
    };
    $('startOk').onclick = submit;
    $('startX').onclick = () => done(null);
    const onKey = (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
      else if (ev.key === 'Escape') done(null);
    };
    n.onkeydown = onKey; e.onkeydown = onKey;
  });
}

async function newGame() {
  state.identityOk = false;          // re-prompt for name + email on this game's first move
  $('playingAs').textContent = '';
  const d = DIFFS[state.dif];
  state.w = d.w; state.h = d.h; state.mines = d.m;
  state.grid = []; state.started = false; state.over = false; state.win = false;
  state.flags = 0; state.revealed = 0; state.time = 0; state.placed = false;
  state.submitResult = null; state.pending = false; state.online = false;
  clearInterval(state.timerId); state.timerId = null;
  state.gameId = null; state.serverTimeUTC = null;

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

  // Fetch a gameId from server in background, so it's ready before first click.
  // No board data comes back -- the server places mines on the first /game/reveal
  // and only ever discloses what that click actually opened.
  try {
    const data = await startGame(state.dif);
    state.gameId = data.gameId;
    state.serverTimeUTC = data.serverTimeUTC;
  } catch (err) {
    console.warn('Could not start a game with the server:', err);
    // ponytail: fall back to local random play so the game is never blocked on
    // the server -- this board is never submittable (no gameId), so it's not
    // a trust boundary, just a booth-WiFi resilience measure.
    state.gameId = null;
  }
}

function renderBoard() {
  board.dataset.dif = state.dif;
  board.style.setProperty('--cols', state.w);   // drives fit-to-width cell sizing on mobile
  board.style.gridTemplateColumns = `repeat(${state.w}, 1fr)`;
  board.innerHTML = '';
  for (let y = 0; y < state.h; y++) for (let x = 0; x < state.w; x++) {
    const c = document.createElement('div');
    c.className = 'cell'; c.dataset.x = x; c.dataset.y = y;
    board.appendChild(c);
  }
}

// ponytail: local-only fallback board for when /game/start couldn't reach the
// server (no gameId => reveal() never calls the API => never submittable, so a
// client-random layout here isn't a trust boundary, just booth-WiFi resilience).
function placeMinesLocal(safeX, safeY) {
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

/* Reveal is a real click, one at a time. When we have a gameId, the server is
   the sole authority: it places mines on the very first call and only ever
   tells us what THIS click opened -- never the rest of the board. Without a
   gameId (offline fallback) we fall back to a local, unscored board. */
async function reveal(x, y) {
  if (state.over || state.pending) return;
  const cell = state.grid[y][x];
  if (cell.open || cell.flag) return;

  if (!state.gameId) {
    if (!state.placed) { placeMinesLocal(x, y); state.started = true; startTimer(); }
    if (cell.mine) { finishLoss(x, y); return; }
    floodRevealLocal(x, y);
    if (state.revealed === state.w * state.h - state.mines) finishWin();
    return;
  }

  state.pending = true;
  let resp;
  try {
    resp = await apiReveal(state.gameId, x, y);
  } catch (err) {
    console.warn('reveal failed:', err);
    state.pending = false;
    return; // network hiccup -- the cell just stays closed, player can click again
  }
  state.pending = false;
  state.online = true;

  if (!state.placed) { state.placed = true; state.started = true; startTimer(); }

  if (resp.hitMine) {
    markMines(resp.mines);
    finishLoss(x, y);
    return;
  }

  applyRevealed(resp.newly);
  if (resp.won) { markMines(resp.mines); finishWin(); }
}

/* Apply cells the server actually opened for this click -- x/y/n as returned,
   never anything the player hasn't earned by clicking. */
function applyRevealed(cells) {
  for (const { x, y, n } of cells) {
    const c = state.grid[y][x];
    if (c.open) continue;
    c.open = true; c.n = n; state.revealed++;
    const el = cellEl(x, y); el.classList.add('open'); el.classList.remove('flag');
    if (n > 0) { el.textContent = n; el.classList.add('n' + n); } else { el.textContent = ''; }
  }
}

function markMines(points) {
  for (const { x, y } of points) state.grid[y][x].mine = true;
}

// Offline-fallback-only flood fill (mirrors applyRevealed for a locally-known board).
function floodRevealLocal(x, y) {
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
}

function setMineCounter() {
  $('mineCount').textContent = String(Math.max(-99, state.mines - state.flags)).padStart(3, '0');
}

function finishLoss(x, y) {
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

function finishWin() {
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

/* ============================================================
   Win flow: submit to server, show results
   ============================================================ */
function handleWin() { submitSession(true); }
function handleLoss() { submitSession(false); }

/* Every session scores now -- win or loss. The server computes the real score
   from its own tracked reveals + timestamps; the client just shows it and
   refreshes the board. There's no client-supplied timing or move data left to
   trust or distrust -- see server/src/board.ts. */
async function submitSession(won) {
  // Ensure a name lands on the leaderboard: prompt if the nickname field is empty.
  let handle = getHandle();
  if (!handle) {
    handle = (await win98Prompt('Enter your name for the leaderboard:')) || '';
    if (handle) $('handle').value = handle;  // reflect in the field so modal/share use it
  }

  // Offline fallback game (server was unreachable, or every reveal failed) --
  // never had a real gameId session, so there's nothing to submit.
  if (!state.gameId || !state.online) {
    showResults({ won, timeSeconds: state.time, score: null, rank: null });
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
        handle: handle || undefined,
        nameKey,
        email: state.email || undefined,
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
    rememberPlayer(handle, state.email, result.score);         // keep best score for the name fold-out
    showResults({ won: result.won, timeSeconds: result.timeSeconds, score: result.score, rank: result.rank, onLeaderboard: result.onLeaderboard });
    if (result.onLeaderboard) loadLeaderboard();
  } else {
    // Network error -- still show the local win/loss so the player isn't left hanging.
    showResults({ won, timeSeconds: state.time, score: null, rank: null });
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
  const safeTotal = state.w * state.h - state.mines;
  const revealed = state.revealed;

  const score = result.score;  // null while the submission is in flight
  const emoji = won ? '🏆' : '💥';
  const rankPart = result.rank != null ? ` · Rank #${result.rank}` : '';

  $('resTitle').textContent = `${emoji} Minesweeper${rankPart}`;
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

board.addEventListener('click', async e => {
  const t = e.target.closest('.cell'); if (!t) return;
  const x = +t.dataset.x, y = +t.dataset.y;
  // First tap of the game just wakes the popup (focuses synchronously so the iPad
  // keyboard opens). It is NOT a move -- the board only reveals on the player's next
  // deliberate tap, once name + email are in.
  if (!state.identityOk) { await ensureIdentity(); return; }
  if (state.flagMode) toggleFlag(x, y); else await reveal(x, y);
  if (!state.over) $('smiley').textContent = '🙂';
});
board.addEventListener('contextmenu', async e => {
  e.preventDefault();
  const t = e.target.closest('.cell'); if (!t) return;
  if (!state.identityOk) { await ensureIdentity(); return; }
  toggleFlag(+t.dataset.x, +t.dataset.y);
});

let pressTimer = null;
board.addEventListener('touchstart', e => {
  const t = e.target.closest('.cell'); if (!t) return;
  if (!state.identityOk) return;   // require name + email (via a normal tap) before flagging
  pressTimer = setTimeout(() => { toggleFlag(+t.dataset.x, +t.dataset.y); pressTimer = null; }, 350);
}, { passive: true });
board.addEventListener('touchend', () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } }, { passive: true });

$('smiley').addEventListener('click', newGame);
$('modalClose').addEventListener('click', closeModal);
// Play Again: close the results card and start a fresh game. newGame() keeps the
// current difficulty and never touches the #handle input, so the name carries over.
$('playAgain').addEventListener('click', () => { closeModal(); newGame(); });

$('flagToggle').addEventListener('click', () => {
  state.flagMode = !state.flagMode;
  $('flagToggle').textContent = '🚩 Flag mode: ' + (state.flagMode ? 'ON' : 'OFF');
  $('flagToggle').style.background = state.flagMode ? '#ffe08a' : '';
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
