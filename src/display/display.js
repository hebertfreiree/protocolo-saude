const counterEl = document.getElementById('counter');
const deltaEl = document.getElementById('delta');
const breakdownEl = document.getElementById('breakdown');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const updatedText = document.getElementById('updated-text');

const SLOT_META = {
  yt1: { platform: 'youtube', label: 'YT 1', icon: 'YT', cls: 'yt' },
  yt2: { platform: 'youtube', label: 'YT 2', icon: 'YT', cls: 'yt' },
  ig1: { platform: 'instagram', label: 'IG 1', icon: 'IG', cls: 'ig' },
  ig2: { platform: 'instagram', label: 'IG 2', icon: 'IG', cls: 'ig' },
  tt1: { platform: 'tiktok', label: 'TT 1', icon: 'TT', cls: 'tt' },
  tt2: { platform: 'tiktok', label: 'TT 2', icon: 'TT', cls: 'tt' }
};

let lastTotal = null;
let displayed = 0;
let target = 0;

function formatNumber(n) {
  return new Intl.NumberFormat('pt-BR').format(Math.round(n));
}

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
  if (Math.abs(diff) < 0.5) {
    displayed = target;
  } else {
    displayed += diff * 0.18;
  }
  counterEl.textContent = formatNumber(displayed);
  requestAnimationFrame(animateCounter);
}
animateCounter();

function renderBreakdown(payload) {
  const { config = {}, counts = {}, results = {} } = payload;
  const cards = [];
  for (const slotId of Object.keys(SLOT_META)) {
    const meta = SLOT_META[slotId];
    const slotCfg = config[slotId];
    if (!slotCfg || !slotCfg.identifier) continue;
    const count = counts[slotId];
    const result = results[slotId] || {};
    const labelText = slotCfg.label || meta.label;

    const card = document.createElement('div');
    card.className = 'bd-item';
    const icon = document.createElement('div');
    icon.className = `bd-platform-icon ${meta.cls}`;
    icon.textContent = meta.icon;
    const info = document.createElement('div');
    info.className = 'bd-info';
    const lbl = document.createElement('div');
    lbl.className = 'bd-label';
    lbl.textContent = labelText;
    const cnt = document.createElement('div');
    cnt.className = 'bd-count';
    if (count != null) {
      cnt.textContent = formatNumber(count);
    } else if (result.error) {
      cnt.textContent = result.error === 'loading' ? 'carregando…' : 'sem dados';
      cnt.classList.add('error');
    } else {
      cnt.textContent = '—';
      cnt.classList.add('error');
    }
    info.appendChild(lbl);
    info.appendChild(cnt);
    card.appendChild(icon);
    card.appendChild(info);
    cards.push(card);
  }
  breakdownEl.innerHTML = '';
  cards.forEach(c => breakdownEl.appendChild(c));
}

function update(payload) {
  const counts = payload.counts || {};
  let total = 0;
  let any = false;
  for (const k of Object.keys(counts)) {
    if (typeof counts[k] === 'number') {
      total += counts[k];
      any = true;
    }
  }
  if (!any) {
    statusDot.classList.add('error');
    statusText.textContent = 'Aguardando primeiros dados (login + carregamento das páginas)…';
    return;
  }
  statusDot.classList.remove('error');
  statusText.textContent = 'Coletando ao vivo • atualiza a cada 5s';
  target = total;
  if (lastTotal !== null) {
    const diff = total - lastTotal;
    if (diff > 0) {
      deltaEl.textContent = `+${formatNumber(diff)} desde o início`;
      deltaEl.className = 'delta';
    } else if (diff < 0) {
      deltaEl.textContent = `${formatNumber(diff)} desde o início`;
      deltaEl.className = 'delta down';
    }
  } else {
    lastTotal = total;
  }
  counterEl.classList.add('bump');
  setTimeout(() => counterEl.classList.remove('bump'), 400);
  renderBreakdown(payload);
  let mostRecent = 0;
  for (const k of Object.keys(payload.updated || {})) {
    if (payload.updated[k] > mostRecent) mostRecent = payload.updated[k];
  }
  updatedText.textContent = mostRecent ? `última coleta: ${timeAgo(mostRecent)}` : '';
}

window.api.onCountsUpdate(update);

document.getElementById('btn-setup').addEventListener('click', () => window.api.openSetup());
document.getElementById('btn-exit').addEventListener('click', () => window.api.exit());

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.api.openSetup();
  if (e.key === 'F11') window.api.toggleFullscreen();
  if ((e.ctrlKey && e.key === 'q') || (e.ctrlKey && e.key === 'Q')) window.api.exit();
});

setInterval(() => {
  const last = updatedText.dataset.last;
  if (last) updatedText.textContent = `última coleta: ${timeAgo(parseInt(last, 10))}`;
}, 1000);
