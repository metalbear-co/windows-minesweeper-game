/* MetalBear Minesweeper -- shareable result card (Launch Week design).
   Matches Figma node 5542:2817 ("Minesweeper shared image 2"). */

/* ---------- caption (for clipboard) ---------- */
export function buildCaption(o) {
  const d = label(o.difficulty);
  const s = o.score != null ? `${o.score.toLocaleString()} pts` : null;
  if (o.won) {
    const rank = o.rank != null ? ` (ranked #${o.rank})` : '';
    return `I scored ${s || `a ${o.timeSeconds}s clear`}${rank} on ${d} in MetalBear Minesweeper 🏆 — think you can beat me at the MetalBear booth? KubeCon Japan 🇯🇵 https://minesweeper.metalbear.com/ (brought to you by mirrord)`;
  }
  const rank = o.rank != null ? `, ranked #${o.rank}` : '';
  return `I scored ${s || `${o.revealed}/${o.safeTotal} cells`}${rank} on ${d} in MetalBear Minesweeper 💥 — can you do better? Find us at the MetalBear booth, KubeCon Japan 🇯🇵 https://minesweeper.metalbear.com/ (brought to you by mirrord)`;
}

export async function copyCaption(o) {
  try { await navigator.clipboard.writeText(buildCaption(o)); return true; }
  catch { return false; }
}

/* ---------- assets (preloaded once) ---------- */
const mascotBoard = new Image();
mascotBoard.src = 'img/mascot-board.svg';
const bear = new Image();
bear.src = 'metalbear-bear.png';

function loaded(img) { return img.complete && img.naturalWidth > 0; }
function decode(img) { return loaded(img) ? Promise.resolve() : img.decode().catch(() => {}); }

/* ---------- download ---------- */
export async function downloadImage(o) {
  await Promise.all([decode(mascotBoard), decode(bear)]); // guarantee art is drawn
  const canvas = document.createElement('canvas');
  drawCard(canvas, o);
  const a = document.createElement('a');
  const tag = o.score != null ? `${o.score}pts` : (o.won ? `${o.timeSeconds}s` : `${o.revealed}of${o.safeTotal}`);
  a.download = `metalbear-minesweeper-${tag}.png`;
  a.href = canvas.toDataURL('image/png');
  a.click();
}

/* ---------- palette (Launch Week) ---------- */
const C = {
  navy: '#2e2a5e', purple: '#756df3', gold: '#ffcb5c', goldSoft: '#ffe09b',
  chip: '#fad7a0', red: '#e11d48', grey: '#c0c0c0', lo: '#808080', white: '#ffffff',
  scoreBg: '#1a1836', statBg: '#fbfbfb', tb0: '#312d65', tb1: '#6e66e2',
};

function label(dif) { return dif.charAt(0).toUpperCase() + dif.slice(1); }

/* set canvas letterSpacing where supported; harmless no-op otherwise */
function tracking(ctx, px) { try { ctx.letterSpacing = `${px}px`; } catch {} }

/**
 * Draw the share card at 2x for crisp output. All coordinates below are in the
 * Figma logical space (1034 x 576); ctx.scale(2,2) doubles the pixel density.
 */
export function drawCard(canvas, o) {
  const W = 1034, H = 576, S = 2;
  canvas.width = W * S; canvas.height = H * S;
  const ctx = canvas.getContext('2d');
  ctx.scale(S, S);
  ctx.textBaseline = 'alphabetic';

  const d = label(o.difficulty);
  const safeTotal = o.safeTotal;
  const hasScore = o.score != null;
  const scoreStr = hasScore ? o.score.toLocaleString() : '—';

  /* window: white raised frame + grey face */
  ctx.fillStyle = C.white; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = C.grey; ctx.fillRect(7, 7, W - 14, H - 14);

  /* title bar */
  const g = ctx.createLinearGradient(8, 0, 8 + 1019, 0);
  g.addColorStop(0, C.tb0); g.addColorStop(1, C.tb1);
  ctx.fillStyle = g; ctx.fillRect(8, 7, 1019, 40);
  // bear chip (white app-icon tile)
  ctx.fillStyle = C.white; roundRect(ctx, 25, 15, 24, 24, 4); ctx.fill();
  if (loaded(bear)) ctx.drawImage(bear, 27, 18, 20, 20);
  // title text
  ctx.fillStyle = C.white; ctx.font = 'bold 18px Tahoma, sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText('MetalBear Minesweeper.exe', 58, 28);
  // window buttons
  const syms = ['_', '□', '×'], bxs = [913.95, 944.5, 975.05];
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = C.grey; ctx.fillRect(bxs[i], 15, 27, 23.36);
    ctx.strokeStyle = C.white; ctx.lineWidth = 2; ctx.strokeRect(bxs[i] + 1, 16, 25, 21.36);
    ctx.fillStyle = '#000'; ctx.font = 'bold 14px Tahoma, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(syms[i], bxs[i] + 13.5, 27.5);
  }

  /* menu bar */
  ctx.fillStyle = C.lo; ctx.fillRect(10, 86, W - 17, 1); // bottom hairline
  ctx.fillStyle = '#000'; ctx.font = '15px Tahoma, sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  menuItem(ctx, 'Game', 26, 69);
  menuItem(ctx, 'Help', 26 + ctx.measureText('Game').width + 13, 69);

  /* eyebrow pill (left-aligned with the title/score box at x=74) */
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 12px Unbounded, sans-serif'; tracking(ctx, 1);
  const pillText = 'METALBEAR · KUBECON JAPAN';
  const tw = ctx.measureText(pillText).width;
  const padX = 18, dot = 8, gap = 8, pillH = 30, pillW = padX * 2 + dot + gap + tw;
  const px = 74, py = 123;
  ctx.fillStyle = 'rgba(0,0,0,.15)'; roundRect(ctx, px + 3, py + 3, pillW, pillH, pillH / 2); ctx.fill();
  ctx.fillStyle = C.navy; roundRect(ctx, px, py, pillW, pillH, pillH / 2); ctx.fill();
  ctx.fillStyle = C.red; roundRect(ctx, px + padX, py + pillH / 2 - 4, 8, 8, 2); ctx.fill();
  ctx.fillStyle = C.gold; ctx.textAlign = 'left';
  ctx.fillText(pillText, px + padX + dot + gap, py + pillH / 2 + 1);
  tracking(ctx, 0);

  /* title — shrink to stay clear of the mascot (x≈679) so the rank never hides */
  ctx.fillStyle = C.navy; tracking(ctx, -1);
  const emoji = o.won ? '🏆' : '💥';
  const rankPart = o.rank != null ? ` · Rank #${o.rank}` : '';
  const titleStr = `${emoji} Minesweeper · ${d}${rankPart}`;
  let tfs = 30; ctx.font = `800 ${tfs}px Unbounded, sans-serif`;
  while (ctx.measureText(titleStr).width > 655 - 74 && tfs > 18) { tfs -= 1; ctx.font = `800 ${tfs}px Unbounded, sans-serif`; }
  ctx.textBaseline = 'middle';
  ctx.fillText(titleStr, 74, 201);
  ctx.textBaseline = 'alphabetic';
  tracking(ctx, 0);

  /* SCORE label */
  ctx.font = 'bold 10px Unbounded, sans-serif'; tracking(ctx, 3);
  ctx.fillStyle = C.purple; ctx.fillText('SCORE', 74, 250);
  tracking(ctx, 0);

  /* score box */
  ctx.fillStyle = C.lo; ctx.fillRect(74, 275, 348, 100);       // 4px grey border
  ctx.fillStyle = C.scoreBg; ctx.fillRect(78, 279, 340, 92);   // inner
  ctx.fillStyle = C.white; ctx.fillRect(74, 375, 352, 4); ctx.fillRect(422, 271, 4, 108); // raised highlight
  const bigTxt = hasScore ? scoreStr : (o.won ? `${o.timeSeconds}s` : `${o.revealed}/${safeTotal}`);
  ctx.save();
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  let fs = 72; ctx.font = `800 ${fs}px Unbounded, sans-serif`; tracking(ctx, 4);
  while (ctx.measureText(bigTxt).width > 300 && fs > 40) { fs -= 4; ctx.font = `800 ${fs}px Unbounded, sans-serif`; }
  ctx.shadowColor = 'rgba(255,203,92,.5)'; ctx.shadowBlur = 20;
  ctx.fillStyle = C.gold; ctx.fillText(bigTxt, 114, 326);
  ctx.restore(); tracking(ctx, 0);

  /* mascot + minesweeper board (combined art) with a soft shadow */
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,.12)';
  ctx.beginPath(); ctx.ellipse(872, 500, 120, 24, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  if (loaded(mascotBoard)) {
    const dw = 298, dh = dw * 373 / 266.264;
    ctx.drawImage(mascotBoard, 679, 92, dw, dh);
  }

  /* stat boxes: TIME / CLEARED / PLAYER (rank now lives in the title) */
  const boxes = [
    ['TIME', `${o.timeSeconds}s`],
    ['CLEARED', `${o.revealed}/${safeTotal}`],
    ['PLAYER', o.handle || 'anon'],
  ];
  const rowLeft = 74, sgap = 8, bw = 228, bh = 58, top = 433;
  let sx = rowLeft;
  for (const [lab, val] of boxes) { statBox(ctx, sx, top, bw, bh, lab, val); sx += bw + sgap; }

  /* footer bar */
  ctx.fillStyle = C.navy; ctx.fillRect(7, 539, W - 14, H - 539 - 7);
  ctx.fillStyle = C.white; ctx.fillRect(7, 539, W - 14, 1);
  const fy = 539 + (H - 7 - 539) / 2 + 1;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = C.goldSoft; ctx.font = 'bold 15px Tahoma, sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('MetalBear booth · KubeCon Japan 2026', 27, fy);
  ctx.fillStyle = C.white; ctx.font = '16px Tahoma, sans-serif'; ctx.textAlign = 'right';
  ctx.fillText('metalbear.com', W - 27, fy);
}

/* menu item with the first letter underlined (win98 accelerator) */
function menuItem(ctx, text, x, y) {
  ctx.fillText(text, x, y);
  const fw = ctx.measureText(text[0]).width;
  ctx.fillRect(x, y + 9, fw, 1);
}

/* sunken stat cell: purple label over navy value */
function statBox(ctx, x, y, w, h, lab, val) {
  ctx.fillStyle = C.statBg; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = C.lo; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = C.purple; ctx.font = 'bold 9px Unbounded, sans-serif'; tracking(ctx, 2);
  ctx.fillText(lab, x + w / 2, y + 22);
  tracking(ctx, 0);
  ctx.fillStyle = C.navy;
  let fs = 22; ctx.font = `bold ${fs}px Unbounded, sans-serif`;
  let v = String(val);
  while (ctx.measureText(v).width > w - 16 && fs > 12) { fs -= 2; ctx.font = `bold ${fs}px Unbounded, sans-serif`; }
  ctx.fillText(v, x + w / 2, y + h - 15);
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
