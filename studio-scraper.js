// =============================================================================
// studio-scraper.js
// Plano B: abre a página real do Studio analytics num BrowserWindow oculto
// com os cookies importados do Chrome, espera o SPA renderizar, e lê o
// número do DOM — exatamente como o usuário vê. Mais lento que API mas
// é o caminho mais resistente a mudanças no formato de resposta.
// =============================================================================

const { BrowserWindow, session } = require('electron');

const scrapers = {};

async function setCookies(partition, byName) {
  const ses = session.fromPartition(partition);
  // Limpa cookies antigos pra não conflitar
  await ses.clearStorageData({ storages: ['cookies'] });

  for (const c of Object.values(byName)) {
    if (!c || !c.host || !c.name) continue;
    let host = c.host;
    let domain = host;
    let urlHost = host.startsWith('.') ? host.slice(1) : host;
    try {
      await ses.cookies.set({
        url: `https://${urlHost}${c.path || '/'}`,
        name: c.name,
        value: c.value,
        domain,
        path: c.path || '/',
        secure: c.secure !== false,
        httpOnly: !!c.httpOnly,
        sameSite: 'no_restriction'
      });
    } catch (e) {
      // continua mesmo se um cookie falhar
    }
  }
}

const SCRAPE_JS = `
(() => {
  function* walk(root) {
    yield root;
    const cs = root.children || [];
    for (const c of cs) {
      try { yield* walk(c); } catch (_) {}
    }
    if (root.shadowRoot) {
      try { yield* walk(root.shadowRoot); } catch (_) {}
    }
  }
  function txt(el) {
    return (el.textContent || '').trim().replace(/\\s+/g, ' ');
  }
  const allCandidates = [];
  for (const el of walk(document)) {
    if (!el || el.nodeType !== 1) continue;
    if (el.children && el.children.length > 0) continue; // queremos folhas
    const t = txt(el);
    if (!t) continue;
    // Aceita formatos "1,802,026", "1.802.026", "1802026"
    if (!/^[\\d.,]{4,15}$/.test(t)) continue;
    const digits = t.replace(/[^\\d]/g, '');
    if (digits.length < 4 || digits.length > 10) continue;
    const n = parseInt(digits, 10);
    if (!(n >= 1000 && n <= 5e9)) continue;

    // Sobe a árvore (incluindo shadow DOM via getRootNode().host) procurando contexto "subscriber"
    let p = el; let label = '';
    for (let i = 0; i < 12 && p; i++) {
      const pt = txt(p).toLowerCase();
      if (/subscriber|inscritos?|inscri[çc][ãa]o|inscri[çc][õo]es/.test(pt)) {
        label = pt.slice(0, 220);
        break;
      }
      p = p.parentElement || (p.getRootNode && p.getRootNode().host) || null;
    }
    allCandidates.push({ value: n, label, hasLabel: !!label });
  }
  // Prioriza com label "subscriber/inscrito"; depois pelo MAIOR número
  allCandidates.sort((a, b) => {
    if (a.hasLabel !== b.hasLabel) return a.hasLabel ? -1 : 1;
    return b.value - a.value;
  });
  if (allCandidates.length === 0) return { ok: false, error: 'no_candidates', url: location.href };
  return {
    ok: true,
    count: allCandidates[0].value,
    label: allCandidates[0].label,
    top: allCandidates.slice(0, 8),
    url: location.href,
    title: document.title
  };
})()
`;

async function ensureScraper(slotId, channelId, byName) {
  let s = scrapers[slotId];
  if (s && !s.window.isDestroyed() && s.channelId === channelId) return s;
  if (s) try { s.window.destroy(); } catch (_) {}

  const partition = `persist:studio-scraper-${slotId}`;
  await setCookies(partition, byName);

  const win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 900,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      offscreen: false
    }
  });
  win.webContents.setAudioMuted(true);

  const url = `https://studio.youtube.com/channel/${channelId}/analytics/tab-overview/period-default/explore?entity_type=CHANNEL&entity_id=${channelId}&time_period=4_weeks&explore_type=SUBSCRIBERS`;
  await win.loadURL(url);

  s = { window: win, partition, channelId, lastReloadAt: Date.now(), lastValue: null };
  scrapers[slotId] = s;

  // Espera o SPA renderizar (10 s na primeira carga)
  await new Promise(r => setTimeout(r, 10000));
  return s;
}

async function scrapeStudioCount(slotId, channelId, byName, opts = {}) {
  const RELOAD_AFTER_MS = 5 * 60 * 1000;
  const s = await ensureScraper(slotId, channelId, byName);
  if (Date.now() - s.lastReloadAt > RELOAD_AFTER_MS) {
    try {
      await s.window.webContents.reload();
      await new Promise(r => setTimeout(r, 7000));
    } catch (_) {}
    s.lastReloadAt = Date.now();
  }
  let result;
  try {
    result = await s.window.webContents.executeJavaScript(SCRAPE_JS, true);
  } catch (e) {
    throw new Error(`scraper executeJS falhou: ${e.message}`);
  }
  if (opts.dumpDir) {
    try {
      require('fs').mkdirSync(opts.dumpDir, { recursive: true });
      require('fs').writeFileSync(
        require('path').join(opts.dumpDir, 'scraper-result.json'),
        JSON.stringify(result, null, 2)
      );
    } catch (_) {}
  }
  if (!result || !result.ok) {
    throw new Error(`scraper: ${result && result.error || 'sem dados'} (URL: ${result && result.url || '?'})`);
  }
  s.lastValue = result.count;
  return { count: result.count, source: 'yt-studio-scraper', label: result.label };
}

function destroyScraper(slotId) {
  const s = scrapers[slotId];
  if (s) {
    try { s.window.destroy(); } catch (_) {}
    delete scrapers[slotId];
  }
}

function destroyAll() {
  for (const slotId of Object.keys(scrapers)) destroyScraper(slotId);
}

module.exports = { scrapeStudioCount, destroyScraper, destroyAll };
