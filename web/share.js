/* MetalBear Minesweeper -- shareable result card (win98 style) */

/* ---------- caption (for clipboard) ---------- */
export function buildCaption(o) {
  const d = label(o.difficulty);
  const s = o.score != null ? `${o.score.toLocaleString()} pts` : null;
  if (o.won) {
    const rank = o.rank != null ? ` (ranked #${o.rank})` : '';
    return `I scored ${s || `a ${o.timeSeconds}s clear`}${rank} on ${d} in MetalBear Minesweeper 🏆, think you can beat me? minesweeper.metalbear.co (brought to you by mirrord, now on Windows 🪟)`;
  }
  const rank = o.rank != null ? `, ranked #${o.rank}` : '';
  return `I scored ${s || `${o.revealed}/${o.safeTotal} cells`}${rank} on ${d} in MetalBear Minesweeper 💥, can you do better? minesweeper.metalbear.co (brought to you by mirrord, now on Windows 🪟)`;
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

/* black LED readout like the mine/timer displays */
function led(ctx, cx, cy, text, size) {
  ctx.font = `700 ${size}px "Courier New", monospace`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width;
  const padX = size * 0.55, padY = size * 0.28;
  const bx = cx - w / 2 - padX, by = cy - size / 2 - padY;
  const bw = w + padX * 2, bh = size + padY * 2;
  ctx.fillStyle = '#000'; ctx.fillRect(bx, by, bw, bh);
  ctx.strokeStyle = '#500'; ctx.lineWidth = 2; ctx.strokeRect(bx + 1, by + 1, bw - 2, bh - 2);
  ctx.save();
  ctx.shadowColor = 'rgba(255,59,59,.75)'; ctx.shadowBlur = size * 0.22;
  ctx.fillStyle = C.red; ctx.fillText(text, cx, cy + 1);
  ctx.restore();
  return { bx, by, bw, bh };
}

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
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.font = '20px "Segoe UI Emoji", sans-serif'; ctx.fillText('🐻', tbx + 11, tby + 22);
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

  /* SCORE — the headline number, as an LED readout */
  ctx.fillStyle = C.sub; ctx.font = '600 18px Poppins, sans-serif';
  ctx.fillText('SCORE', W / 2, contentTop + 152);
  led(ctx, W / 2, contentTop + 218, hasScore ? scoreStr : (o.won ? `${o.timeSeconds}s` : `${o.revealed}/${safeTotal}`), 60);
  if (hasScore) { ctx.fillStyle = C.sub; ctx.font = '600 19px Poppins, sans-serif'; ctx.fillText('points', W / 2, contentTop + 300); }

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
  ctx.font = '18px "Segoe UI Emoji", sans-serif'; ctx.fillText('🐻', 20, tky + 21);
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
