/* MetalBear Minesweeper -- shareable result card (win98 style) */

/* ---------- caption (for clipboard) ---------- */
export function buildCaption(o) {
  const d = label(o.difficulty);
  const s = o.score != null ? `${o.score.toLocaleString()} pts` : null;
  if (o.won) {
    const rank = o.rank != null ? ` (ranked #${o.rank})` : '';
    return `I scored ${s || `a ${o.timeSeconds}s clear`}${rank} on ${d} in MetalBear Minesweeper 🏆, think you can beat me? https://minesweeper.metalbear.com/ (brought to you by mirrord, now on Windows 🪟)`;
  }
  const rank = o.rank != null ? `, ranked #${o.rank}` : '';
  return `I scored ${s || `${o.revealed}/${o.safeTotal} cells`}${rank} on ${d} in MetalBear Minesweeper 💥, can you do better? https://minesweeper.metalbear.com/ (brought to you by mirrord, now on Windows 🪟)`;
}

export async function copyCaption(o) {
  try { await navigator.clipboard.writeText(buildCaption(o)); return true; }
  catch { return false; }
}

/* ---------- image ---------- */
export function downloadImage(o) {
  const canvas = document.createElement('canvas');
  drawCard(canvas, o);
  const a = document.createElement('a');
  const tag = o.score != null ? `${o.score}pts` : (o.won ? `${o.timeSeconds}s` : `${o.revealed}of${o.safeTotal}`);
  a.download = `metalbear-minesweeper-${tag}.png`;
  a.href = canvas.toDataURL('image/png');
  a.click();
}

/* palette */
const C = {
  desktop:'#756DF3', grey:'#c0c0c0', hi:'#ffffff', lo:'#808080', dk:'#000000',
  navy:'#232141', yellow:'#FFCB7D', red:'#ff3b3b', blue0:'#00007b', blue1:'#1084d0',
  ink:'#1a1a1a', sub:'#444',
};

function label(dif){ return dif.charAt(0).toUpperCase() + dif.slice(1); }

/* raised (or sunken) win98 bevel panel */
function bevel(ctx, x, y, w, h, raised = true, t = 3, fill = C.grey) {
  ctx.fillStyle = fill; ctx.fillRect(x, y, w, h);
  const light = raised ? C.hi : C.lo, dark = raised ? C.lo : C.hi;
  ctx.fillStyle = light; ctx.fillRect(x, y, w, t); ctx.fillRect(x, y, t, h);
  ctx.fillStyle = dark; ctx.fillRect(x, y + h - t, w, t); ctx.fillRect(x + w - t, y, t, h);
}

/* mascot art — preloaded once; redraw the last card when it lands.
   ponytail: download path assumes it's loaded by game-over (it is — preload
   starts at page load). If ever raced, await mascot.decode() in downloadImage. */
const mascot = new Image();
mascot.src = 'img/mascot-win98.png';
const bear = new Image();
bear.src = 'metalbear-bear.png';
let _lastCard = null;
const _redraw = () => { if (_lastCard) drawCard(_lastCard.c, _lastCard.o); };
mascot.onload = _redraw;
bear.onload = _redraw;

/* sunken stat cell: small label + big value */
function statBox(ctx, x, y, w, h, lab, val) {
  bevel(ctx, x, y, w, h, false, 3);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = C.sub;
  ctx.font = '600 17px Poppins, sans-serif';
  ctx.fillText(lab.toUpperCase(), x + w / 2, y + 30);
  ctx.fillStyle = C.navy;
  ctx.font = '700 34px Unbounded, sans-serif';
  ctx.fillText(val, x + w / 2, y + h - 22);
}

export function drawCard(canvas, o) {
  const W = 1200, H = 630;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  _lastCard = { c: canvas, o };
  const d = label(o.difficulty);
  const safeTotal = o.safeTotal;
  const hasScore = o.score != null;
  const scoreStr = hasScore ? o.score.toLocaleString() : '—';

  /* desktop */
  ctx.fillStyle = C.desktop; ctx.fillRect(0, 0, W, H);
  // faint dotted desktop texture
  ctx.fillStyle = 'rgba(255,255,255,.06)';
  for (let yy = 0; yy < H; yy += 6) for (let xx = 0; xx < W; xx += 6) ctx.fillRect(xx, yy, 1, 1);

  /* window */
  const wx = 42, wy = 26, ww = W - 84, wh = H - 26 - 66;
  bevel(ctx, wx, wy, ww, wh, true, 3);

  /* title bar */
  const tbx = wx + 4, tby = wy + 4, tbw = ww - 8, tbh = 42;
  const g = ctx.createLinearGradient(tbx, 0, tbx + tbw, 0);
  g.addColorStop(0, C.blue0); g.addColorStop(1, C.blue1);
  ctx.fillStyle = g; ctx.fillRect(tbx, tby, tbw, tbh);
  // bear chip
  ctx.fillStyle = '#fff'; ctx.fillRect(tbx + 8, tby + 8, 26, 26);
  if (bear.complete && bear.naturalWidth) ctx.drawImage(bear, tbx + 9, tby + 9, 24, 24);
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff'; ctx.font = '700 20px Poppins, sans-serif';
  ctx.fillText('MetalBear Minesweeper.exe', tbx + 44, tby + tbh / 2);
  // window buttons
  for (let i = 0; i < 3; i++) {
    const bx = tbx + tbw - 6 - (3 - i) * 30;
    bevel(ctx, bx, tby + 8, 26, 26, true, 2);
    ctx.fillStyle = '#000'; ctx.textAlign = 'center';
    ctx.font = '700 15px Tahoma, sans-serif';
    ctx.fillText(['_', '▢', '✕'][i], bx + 13, tby + 22);
  }

  /* menu bar */
  const my = tby + tbh + 2;
  ctx.fillStyle = C.ink; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.font = '15px Tahoma, sans-serif';
  ctx.fillText('Game', tbx + 8, my + 12); ctx.fillText('Help', tbx + 66, my + 12);
  ctx.fillStyle = C.lo; ctx.textAlign = 'right';
  ctx.fillText('Sponsored by mirrord on Windows', tbx + tbw - 8, my + 12);
  ctx.strokeStyle = C.lo; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(tbx, my + 26); ctx.lineTo(tbx + tbw, my + 26); ctx.stroke();

  /* result banner (emoji inline so it can't collide with the title) */
  const contentTop = my + 26;
  const title = o.won ? 'You cleared the board!' : 'Boom! You hit an evil mirrord.';
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = C.navy; ctx.font = '700 30px Unbounded, sans-serif';
  ctx.fillText(`${o.won ? '🏆' : '💥'}  ${title}`, W / 2, contentTop + 54);

  // difficulty pill
  ctx.font = '600 18px Poppins, sans-serif';
  const dpw = ctx.measureText(d).width + 36;
  const dpx = W / 2 - dpw / 2, dpy = contentTop + 80;
  ctx.fillStyle = C.navy; roundRect(ctx, dpx, dpy, dpw, 34, 17); ctx.fill();
  ctx.fillStyle = C.yellow; ctx.textBaseline = 'middle'; ctx.fillText(d, W / 2, dpy + 18);
  ctx.textBaseline = 'alphabetic';

  /* mascot at the computer, top-right — right edge on the Player box line */
  if (mascot.complete && mascot.naturalWidth) {
    const mw = 232, mh = 232;
    const statRight = W / 2 + (4 * 250 + 3 * 18) / 2; // right edge of last stat box
    const mxx = statRight - mw, myy = contentTop + 14;
    ctx.drawImage(mascot, mxx, myy, mw, mh);
  }

  /* SCORE — the headline number in a purple readout box */
  ctx.fillStyle = C.sub; ctx.font = '600 18px Poppins, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillText('SCORE', W / 2, contentTop + 150);
  const sbw = 360, sbh = 118, sbx = W / 2 - sbw / 2, sby = contentTop + 168;
  ctx.fillStyle = C.desktop; ctx.fillRect(sbx, sby, sbw, sbh);
  ctx.strokeStyle = C.hi; ctx.lineWidth = 4; ctx.strokeRect(sbx + 2, sby + 2, sbw - 4, sbh - 4);
  const bigTxt = hasScore ? scoreStr : (o.won ? `${o.timeSeconds}s` : `${o.revealed}/${safeTotal}`);
  ctx.save();
  ctx.textBaseline = 'middle';
  let fs = 68; ctx.font = `700 ${fs}px Unbounded, sans-serif`;
  while (ctx.measureText(bigTxt).width > sbw - 44 && fs > 34) { fs -= 4; ctx.font = `700 ${fs}px Unbounded, sans-serif`; }
  ctx.shadowColor = 'rgba(255,203,125,.85)'; ctx.shadowBlur = 20;
  ctx.fillStyle = C.hi; ctx.fillText(bigTxt, W / 2, sby + sbh / 2 + 2);
  ctx.restore();
  ctx.textBaseline = 'alphabetic';

  /* stat boxes */
  const boxes = [
    ['Rank', o.rank != null ? `#${o.rank}` : '—'],
    ['Time', `${o.timeSeconds}s`],
    ['Cleared', `${o.revealed}/${safeTotal}`],
    ['Player', o.handle || 'anon'],
  ];
  const gap = 18, bw2 = 250, total = boxes.length * bw2 + (boxes.length - 1) * gap;
  let sx = W / 2 - total / 2; const sy = contentTop + 328, bh2 = 96;
  for (const [lab, val] of boxes) {
    let v = String(val);
    // shrink over-long player names to fit
    if (lab === 'Player') { ctx.font = '700 34px Unbounded, sans-serif'; if (ctx.measureText(v).width > bw2 - 24) v = v.slice(0, 10); }
    statBox(ctx, sx, sy, bw2, bh2, lab, v);
    sx += bw2 + gap;
  }

  /* taskbar */
  const tky = H - 52, tkh = 40;
  bevel(ctx, 0, tky, W, tkh + 12, true, 2);
  bevel(ctx, 10, tky + 6, 150, 30, true, 2);
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  if (bear.complete && bear.naturalWidth) ctx.drawImage(bear, 16, tky + 9, 24, 24);
  ctx.fillStyle = C.ink; ctx.font = '700 17px Tahoma, sans-serif'; ctx.fillText('Start', 46, tky + 22);
  // clock chip
  bevel(ctx, W - 340, tky + 6, 330, 30, false, 2);
  ctx.fillStyle = C.navy; ctx.font = '600 17px Poppins, sans-serif';
  ctx.textAlign = 'center'; ctx.fillText('mirrord — now on Windows 🪟', W - 175, tky + 22);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
