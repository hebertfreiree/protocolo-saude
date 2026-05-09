const counterEl = document.getElementById('counter');
const deltaEl = document.getElementById('delta');
const gridEl = document.getElementById('grid');
const statusText = document.getElementById('status-text');
const updatedText = document.getElementById('updated-text');
const brandDot = document.getElementById('brand-dot');
const brandDot2 = document.getElementById('brand-dot-2');

const SLOT_META = {
  yt1: { platform: 'youtube',  cls: 'yt', defLabel: 'YouTube 1' },
  yt2: { platform: 'youtube',  cls: 'yt', defLabel: 'YouTube 2' },
  ig1: { platform: 'instagram', cls: 'ig', defLabel: 'Instagram 1' },
  ig2: { platform: 'instagram', cls: 'ig', defLabel: 'Instagram 2' },
  tt1: { platform: 'tiktok',    cls: 'tt', defLabel: 'TikTok 1' },
  tt2: { platform: 'tiktok',    cls: 'tt', defLabel: 'TikTok 2' }
};
const SLOT_ORDER = ['yt1', 'ig1', 'tt1', 'yt2', 'ig2', 'tt2'];
const PLATFORM_NAME = { youtube: 'YOUTUBE', instagram: 'INSTAGRAM', tiktok: 'TIKTOK' };

let lastTotal = null;
let displayed = 0;
let target = 0;
let lastCollectedTs = 0;

function fmt(n) { return new Intl.NumberFormat('pt-BR').format(Math.round(n)); }

function timeAgo(ts) {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'agora';
  if (s < 60) return `${s}s atrás`;
  if (s < 3600) return `${Math.floor(s / 60)}min atrás`;
  return `${Math.floor(s / 3600)}h atrás`;
}

function animateCounter() {
  const diff = target - displayed;
  if (Math.abs(diff) < 0.5) displayed = target;
  else displayed += diff * 0.18;
  counterEl.textContent = fmt(displayed);
  requestAnimationFrame(animateCounter);
}
animateCounter();

function renderGrid(payload) {
  const { config = {}, counts = {}, errors = {} } = payload;
  gridEl.innerHTML = '';
  for (const slotId of SLOT_ORDER) {
    const meta = SLOT_META[slotId];
    const slot = config[slotId];
    const card = document.createElement('div');
    if (!slot || !slot.identifier) {
      card.className = `bd-item ${meta.cls} bd-empty`;
      card.innerHTML = `
        <div class="bd-platform"><span class="swatch"></span>${PLATFORM_NAME[meta.platform]}</div>
        <div class="bd-count">—</div>
        <div class="bd-label">vazio</div>`;
      gridEl.appendChild(card);
      continue;
    }
    card.className = `bd-item ${meta.cls}`;
    const count = counts[slotId];
    const err = errors[slotId];
    const labelText = (slot.label && slot.label.trim()) || meta.defLabel;
    let countHtml;
    if (typeof count === 'number') countHtml = `<div class="bd-count">${fmt(count)}</div>`;
    else if (err) countHtml = `<div class="bd-count error">${err.length > 60 ? err.slice(0, 57) + '…' : err}</div>`;
    else countHtml = `<div class="bd-count error">carregando…</div>`;
    card.innerHTML = `
      <div class="bd-platform"><span class="swatch"></span>${PLATFORM_NAME[meta.platform]}</div>
      ${countHtml}
      <div class="bd-label">${labelText}</div>`;
    gridEl.appendChild(card);
  }
}

function update(payload) {
  const counts = payload.counts || {};
  let total = 0, anyValid = false, anyError = false;
  for (const k of Object.keys(counts)) {
    if (typeof counts[k] === 'number') { total += counts[k]; anyValid = true; }
  }
  if (payload.errors) {
    for (const k of Object.keys(payload.errors)) {
      if (payload.errors[k] && typeof counts[k] !== 'number') anyError = true;
    }
  }

  if (anyValid) {
    target = total;
    if (lastTotal === null) lastTotal = total;
    const diff = total - lastTotal;
    if (diff > 0) { deltaEl.textContent = `+${fmt(diff)} desde o início`; deltaEl.className = 'delta'; }
    else if (diff < 0) { deltaEl.textContent = `${fmt(diff)} desde o início`; deltaEl.className = 'delta down'; }
    else if (lastTotal !== null) { deltaEl.textContent = `±0 desde o início`; deltaEl.className = 'delta zero'; }
    counterEl.classList.add('bump');
    setTimeout(() => counterEl.classList.remove('bump'), 450);
  }

  if (!anyValid && anyError) {
    statusText.textContent = 'erro nas coletas';
    brandDot.classList.add('error');
    brandDot2.classList.add('error');
  } else if (!anyValid) {
    statusText.textContent = 'aguardando primeira coleta';
    brandDot.classList.remove('error');
    brandDot2.classList.remove('error');
  } else {
    statusText.textContent = 'ao vivo';
    brandDot.classList.remove('error');
    brandDot2.classList.remove('error');
  }

  let mostRecent = 0;
  for (const k of Object.keys(payload.updated || {})) {
    if (payload.updated[k] > mostRecent) mostRecent = payload.updated[k];
  }
  if (mostRecent) lastCollectedTs = mostRecent;
  updatedText.textContent = lastCollectedTs ? timeAgo(lastCollectedTs) : '—';

  renderGrid(payload);
}

window.api.onCountsUpdate(update);

document.getElementById('btn-setup').addEventListener('click', () => window.api.openSetup());
document.getElementById('btn-exit').addEventListener('click', () => window.api.exit());

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.api.openSetup();
  if (e.key === 'F11') window.api.toggleFullscreen();
  if ((e.ctrlKey && (e.key === 'q' || e.key === 'Q'))) window.api.exit();
});

setInterval(() => {
  if (lastCollectedTs) updatedText.textContent = timeAgo(lastCollectedTs);
}, 1000);
