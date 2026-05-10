const { app, BrowserWindow, ipcMain, powerSaveBlocker, net, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const oauth = require('./oauth.js');
const studioFetch = require('./studio-fetch.js');

const CONFIG_FILE = path.join(app.getPath('userData'), 'accounts.json');
const OAUTH_CFG_FILE = path.join(app.getPath('userData'), 'oauth-credentials.json');
const SLOTS = ['yt1', 'yt2', 'ig1', 'ig2', 'tt1', 'tt2'];
const IS_DEV = process.argv.includes('--dev') || !app.isPackaged;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

let mainWindow = null;
let setupWindow = null;
let powerSaveId = null;
let pollTimer = null;
const lastCounts = {};
const lastUpdated = {};
const lastError = {};
const lastFetched = {};

// =============================================================================
// Config
// =============================================================================
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch (e) { console.error('Config:', e); }
  return {};
}
function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}
function sanitizeConfig(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const slotId of SLOTS) {
    const v = raw[slotId];
    if (v && typeof v === 'object') {
      out[slotId] = {
        platform: ['youtube', 'instagram', 'tiktok'].includes(v.platform) ? v.platform : null,
        identifier: typeof v.identifier === 'string' ? v.identifier.slice(0, 200).trim() : '',
        label: typeof v.label === 'string' ? v.label.slice(0, 60) : ''
      };
    }
  }
  out.__autoStart = !!raw.__autoStart;
  return out;
}

function loadOAuthCfg() {
  try {
    if (fs.existsSync(OAUTH_CFG_FILE)) return JSON.parse(fs.readFileSync(OAUTH_CFG_FILE, 'utf-8'));
  } catch (e) { /* noop */ }
  return null;
}
function saveOAuthCfg(cfg) {
  fs.mkdirSync(path.dirname(OAUTH_CFG_FILE), { recursive: true });
  fs.writeFileSync(OAUTH_CFG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}

// =============================================================================
// Identifier parsing
// =============================================================================
function parseChannelId(id) {
  if (!id) return null;
  const s = id.trim();
  const m = s.match(/(UC[A-Za-z0-9_-]{20,})/);
  if (m) return m[1];
  if (s.startsWith('UC')) return s;
  return null;
}
function parseUsername(id) {
  if (!id) return null;
  let s = id.trim().replace(/^@/, '');
  const ig = s.match(/instagram\.com\/([^\/?#]+)/i);
  if (ig) return ig[1].replace(/^@/, '');
  const tt = s.match(/tiktok\.com\/@([^\/?#]+)/i);
  if (tt) return tt[1];
  return s;
}

// =============================================================================
// HTTP fetch helper (uses Electron's Chromium net stack)
// =============================================================================
async function httpGet(url, headers = {}) {
  const res = await net.fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      'Accept': 'text/html,application/json,*/*',
      ...headers
    },
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

// =============================================================================
// YouTube — uses mixerno.space (the API behind livecounts.io)
// =============================================================================
async function fetchYouTube(channelIdRaw, slotId) {
  const channelId = parseChannelId(channelIdRaw);
  if (!channelId) throw new Error('Channel ID inválido (precisa começar com UC...)');

  // Strategy -1: Studio cookies importados do Chrome (mais EXATO — mesmo número
  // que aparece em studio.youtube.com/.../explore_type=SUBSCRIBERS)
  if (slotId) {
    const stored = studioFetch.loadStudioCookies(app.getPath('userData'), slotId);
    if (stored && stored.cookies) {
      try {
        const r = await studioFetch.fetchStudioCount(channelId, stored.cookies);
        return r;
      } catch (e) {
        // Se for erro de auth, marca pra usuário reimportar; mas continua tentando outras fontes
        if (/expirad|inválid|401|403/i.test(e.message || '')) {
          // não loga em loop
        }
      }
    }
  }

  // Strategy 0: OAuth (se o usuário fez login externo neste slot) — mais preciso que mixerno
  if (slotId) {
    const oauthCfg = loadOAuthCfg();
    const tokens = oauth.loadTokens(app.getPath('userData'), slotId);
    if (oauthCfg && oauthCfg.clientId && tokens && tokens.refresh_token) {
      try {
        const r = await oauth.fetchYouTubeWithOAuth(slotId, oauthCfg, app.getPath('userData'), channelId);
        return r;
      } catch (e) { /* cai pro mixerno */ }
    }
  }

  // Primary: mixerno.space (real-time exact count, used by live counters)
  try {
    const res = await httpGet(
      `https://mixerno.space/api/youtube-channel-counter/user/${channelId}`,
      { 'Referer': 'https://livecounts.io/', 'Origin': 'https://livecounts.io' }
    );
    const data = await res.json();
    const counts = data && data.counts;
    if (Array.isArray(counts)) {
      const subEntry =
        counts.find(c => /api\s*sub|subscribers/i.test(c.value && c.name) || c.name === 'youtubeCounter') ||
        counts.find(c => typeof c.count === 'number') ||
        counts[0];
      const n = subEntry && (subEntry.count ?? subEntry.value);
      if (typeof n === 'number' && n >= 0) return { count: n, source: 'mixerno' };
    }
    if (data && typeof data.subscriberCount === 'number') return { count: data.subscriberCount, source: 'mixerno' };
  } catch (e) {
    // continue to fallback
  }

  // Fallback: scrape public channel page (rounded for >1000 subs)
  const res = await httpGet(`https://www.youtube.com/channel/${channelId}/about`);
  const html = await res.text();
  // Look for subscriberCountText (rounded display) and various other fields
  let m = html.match(/"subscriberCount":"(\d+)"/);
  if (m) return { count: parseInt(m[1], 10), source: 'yt-public-exact' };
  m = html.match(/"subscriberCountText":\{"simpleText":"([^"]+)"\}/);
  if (m) {
    const n = parseAbbreviated(m[1]);
    if (n != null) return { count: n, source: 'yt-public-rounded' };
  }
  m = html.match(/(\d[\d.,]*\s*(?:K|M|B|mil|mi|bi)?)\s*(?:subscribers|inscritos)/i);
  if (m) {
    const n = parseAbbreviated(m[1]);
    if (n != null) return { count: n, source: 'yt-public-text' };
  }
  throw new Error('Não consegui extrair inscritos do canal público');
}

// =============================================================================
// Instagram — múltiplas estratégias para tentar pegar EXATO sem login
// =============================================================================
async function fetchInstagram(usernameRaw) {
  const username = parseUsername(usernameRaw);
  if (!username) throw new Error('Username inválido');

  const igHeadersBase = {
    'X-IG-App-ID': '936619743392459',
    'X-ASBD-ID': '198387',
    'X-IG-WWW-Claim': '0',
    'X-Requested-With': 'XMLHttpRequest',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'Referer': `https://www.instagram.com/${username}/`,
    'Origin': 'https://www.instagram.com',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9'
  };

  // Strategy 1: instagram.com/api/v1/users/web_profile_info (mesma origem)
  try {
    const res = await httpGet(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
      igHeadersBase
    );
    const data = await res.json();
    const n = data?.data?.user?.edge_followed_by?.count;
    if (typeof n === 'number' && n >= 0) return { count: n, source: 'ig-webapi' };
  } catch (e) { /* try next */ }

  // Strategy 2: i.instagram.com (mobile API, mesma rota)
  try {
    const res = await httpGet(
      `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
      igHeadersBase
    );
    const data = await res.json();
    const n = data?.data?.user?.edge_followed_by?.count;
    if (typeof n === 'number' && n >= 0) return { count: n, source: 'ig-webapi-i' };
  } catch (e) { /* try next */ }

  // Strategy 3: scraping inline JSON dentro da página pública
  let html;
  try {
    const res = await httpGet(`https://www.instagram.com/${encodeURIComponent(username)}/`, {
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Upgrade-Insecure-Requests': '1',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
    });
    html = await res.text();
  } catch (e) {
    html = '';
  }
  if (html) {
    // edge_followed_by.count (preferencial — exato)
    let m = html.match(/"edge_followed_by":\{"count":(\d+)\}/);
    if (m) return { count: parseInt(m[1], 10), source: 'ig-html-graphql' };
    m = html.match(/"follower_count":(\d+)/);
    if (m) return { count: parseInt(m[1], 10), source: 'ig-html-fc' };
    // og:description (rounded — só como último recurso)
    m = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
    if (m) {
      const f = m[1].match(/([\d.,KMB]+)\s*(?:Followers|Seguidores)/i);
      if (f) {
        const n = parseAbbreviated(f[1]);
        if (n != null) return { count: n, source: 'ig-og (rounded)' };
      }
    }
  }

  // Strategy 4: livecounts.io (último fallback)
  try {
    const res = await httpGet(
      `https://api.livecounts.io/instagram-live-follower-counter/stats/${encodeURIComponent(username)}`,
      { 'Referer': 'https://livecounts.io/', 'Origin': 'https://livecounts.io' }
    );
    const data = await res.json();
    const n = data && (data.followerCount ?? data.followers ?? (data.user && data.user.followerCount));
    if (typeof n === 'number' && n > 0) return { count: n, source: 'ig-livecounts' };
  } catch (e) { /* fim */ }

  throw new Error('Não consegui ler seguidores (perfil privado ou IG bloqueou IP)');
}

// =============================================================================
// TikTok — livecounts.io API (primary) + scraping (fallback)
// =============================================================================
async function fetchTikTok(usernameRaw) {
  const username = parseUsername(usernameRaw);
  if (!username) throw new Error('Username inválido');

  // Strategy 0: livecounts.io public API (mais confiável; mesma fonte do TikTok Counter ao vivo)
  try {
    const res = await httpGet(
      `https://tiktok.livecounts.io/user/stats/${encodeURIComponent(username)}`,
      { 'Referer': 'https://livecounts.io/', 'Origin': 'https://livecounts.io' }
    );
    const data = await res.json();
    const n = data && (data.followerCount ?? data.followers ?? (data.user && data.user.followerCount));
    if (typeof n === 'number' && n > 0) return { count: n, source: 'tt-livecounts' };
  } catch (e) { /* fall through */ }

  // Strategy 0b: alternative livecounts endpoint
  try {
    const res = await httpGet(
      `https://api.livecounts.io/tiktok-live-follower-counter/stats/${encodeURIComponent(username)}`,
      { 'Referer': 'https://livecounts.io/', 'Origin': 'https://livecounts.io' }
    );
    const data = await res.json();
    const n = data && (data.followerCount ?? data.followers ?? (data.user && data.user.followerCount));
    if (typeof n === 'number' && n > 0) return { count: n, source: 'tt-livecounts2' };
  } catch (e) { /* fall through */ }

  let html;
  try {
    const res = await httpGet(`https://www.tiktok.com/@${encodeURIComponent(username)}`, {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Upgrade-Insecure-Requests': '1'
    });
    html = await res.text();
  } catch (e) {
    throw new Error('TikTok bloqueou o acesso (use perfil público; tente de novo em 1min)');
  }

  // Strategy 1: __UNIVERSAL_DATA_FOR_REHYDRATION__ (current)
  let m = html.match(/<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (m) {
    try {
      const json = JSON.parse(m[1]);
      const stack = [json];
      while (stack.length) {
        const node = stack.pop();
        if (node && typeof node === 'object') {
          if (typeof node.followerCount === 'number') return { count: node.followerCount, source: 'tt-universal' };
          for (const k of Object.keys(node)) {
            const v = node[k];
            if (v && typeof v === 'object') stack.push(v);
          }
        }
      }
    } catch (e) { /* fall through */ }
  }

  // Strategy 2: SIGI_STATE (legacy)
  m = html.match(/<script[^>]+id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
  if (m) {
    try {
      const json = JSON.parse(m[1]);
      const stack = [json];
      while (stack.length) {
        const node = stack.pop();
        if (node && typeof node === 'object') {
          if (typeof node.followerCount === 'number') return { count: node.followerCount, source: 'tt-sigi' };
          for (const k of Object.keys(node)) {
            const v = node[k];
            if (v && typeof v === 'object') stack.push(v);
          }
        }
      }
    } catch (e) { /* fall through */ }
  }

  // Strategy 3: regex on raw HTML
  m = html.match(/"followerCount":\s*(\d+)/);
  if (m) return { count: parseInt(m[1], 10), source: 'tt-regex' };

  // Strategy 4: meta description
  m = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
  if (m) {
    const f = m[1].match(/([\d.,KMB]+)\s*Followers/i);
    if (f) {
      const n = parseAbbreviated(f[1]);
      if (n != null) return { count: n, source: 'tt-meta' };
    }
  }

  throw new Error('Não consegui ler seguidores do TikTok (perfil privado ou TT bloqueou)');
}

function parseAbbreviated(s) {
  if (!s) return null;
  const cleaned = s.toString().replace(/[^\d.,KMBkmb]/g, '').trim();
  if (!cleaned) return null;
  const m = cleaned.match(/^([\d.,]+)([KMB])?$/i);
  if (!m) {
    const justDigits = cleaned.replace(/\./g, '').replace(/,/g, '');
    const n = parseInt(justDigits, 10);
    return Number.isFinite(n) ? n : null;
  }
  let n = parseFloat(m[1].replace(/,/g, '.'));
  const suf = (m[2] || '').toUpperCase();
  if (suf === 'K') n *= 1000;
  else if (suf === 'M') n *= 1000000;
  else if (suf === 'B') n *= 1000000000;
  return Math.round(n);
}

// =============================================================================
// Polling
// =============================================================================
const PLATFORM_MIN_INTERVAL = {
  youtube: 5 * 1000,    // mixerno tolera ~3-5s
  instagram: 60 * 1000, // IG bloqueia se for muito agressivo
  tiktok: 30 * 1000     // TT idem
};

async function pollSlot(slotId, slot) {
  const now = Date.now();
  const minInt = PLATFORM_MIN_INTERVAL[slot.platform] || 30000;
  if (lastFetched[slotId] && now - lastFetched[slotId] < minInt) return;
  lastFetched[slotId] = now;

  try {
    let result;
    if (slot.platform === 'youtube') result = await fetchYouTube(slot.identifier, slotId);
    else if (slot.platform === 'instagram') result = await fetchInstagram(slot.identifier);
    else if (slot.platform === 'tiktok') result = await fetchTikTok(slot.identifier);
    if (result && typeof result.count === 'number') {
      lastCounts[slotId] = result.count;
      lastUpdated[slotId] = Date.now();
      lastError[slotId] = null;
    }
  } catch (e) {
    lastError[slotId] = (e && e.message) || String(e);
  }
}

function clearSlotState(slotId) {
  delete lastCounts[slotId];
  delete lastUpdated[slotId];
  delete lastError[slotId];
  delete lastFetched[slotId];
}

function clearAllState() {
  for (const k of Object.keys(lastCounts)) delete lastCounts[k];
  for (const k of Object.keys(lastUpdated)) delete lastUpdated[k];
  for (const k of Object.keys(lastError)) delete lastError[k];
  for (const k of Object.keys(lastFetched)) delete lastFetched[k];
}

function startPolling(config) {
  stopPolling();
  // Reset estado pra evitar valor "fantasma" de slot limpo no display
  clearAllState();
  const tick = async () => {
    const tasks = [];
    for (const slotId of SLOTS) {
      const slot = config[slotId];
      if (slot && slot.platform && slot.identifier) tasks.push(pollSlot(slotId, slot));
    }
    await Promise.allSettled(tasks);
    if (mainWindow && !mainWindow.isDestroyed()) {
      // Filtra: só envia slots que ainda têm identificador na config atual.
      const counts = {}, updated = {}, errors = {};
      for (const slotId of SLOTS) {
        const slot = config[slotId];
        if (!slot || !slot.identifier) continue;
        if (slotId in lastCounts) counts[slotId] = lastCounts[slotId];
        if (slotId in lastUpdated) updated[slotId] = lastUpdated[slotId];
        if (slotId in lastError) errors[slotId] = lastError[slotId];
      }
      mainWindow.webContents.send('counts-update', { counts, updated, errors, config });
    }
  };
  tick();
  pollTimer = setInterval(tick, 5000);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// =============================================================================
// Power save
// =============================================================================
function startPowerSaveBlocker() {
  if (powerSaveId === null || !powerSaveBlocker.isStarted(powerSaveId)) {
    powerSaveId = powerSaveBlocker.start('prevent-display-sleep');
  }
}
function stopPowerSaveBlocker() {
  if (powerSaveId !== null && powerSaveBlocker.isStarted(powerSaveId)) {
    powerSaveBlocker.stop(powerSaveId); powerSaveId = null;
  }
}

// =============================================================================
// Windows
// =============================================================================
function hardenLocalWindow(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) e.preventDefault(); });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  if (!IS_DEV) {
    win.webContents.on('before-input-event', (e, input) => {
      if ((input.control || input.meta) && input.shift && (input.key === 'I' || input.key === 'i')) e.preventDefault();
      if (input.key === 'F12') e.preventDefault();
    });
  }
}

function createSetupWindow() {
  if (setupWindow) { setupWindow.focus(); return; }
  setupWindow = new BrowserWindow({
    width: 1100, height: 760,
    title: 'Configurar contas — Seguidores Tempo Real',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, experimentalFeatures: false
    }
  });
  setupWindow.loadFile(path.join(__dirname, 'src', 'setup', 'setup.html'));
  hardenLocalWindow(setupWindow);
  setupWindow.on('closed', () => { setupWindow = null; });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    fullscreen: true, autoHideMenuBar: true,
    title: 'Seguidores em Tempo Real', backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, experimentalFeatures: false
    }
  });
  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'src', 'display', 'display.html'));
  hardenLocalWindow(mainWindow);
  mainWindow.on('closed', () => {
    mainWindow = null;
    stopPolling();
    stopPowerSaveBlocker();
  });
}

// =============================================================================
// IPC
// =============================================================================
ipcMain.handle('config:get', () => loadConfig());
ipcMain.handle('config:save', (_e, cfg) => { saveConfig(sanitizeConfig(cfg)); return true; });
ipcMain.handle('slot:clear-state', (_e, slotIdRaw) => {
  if (!SLOTS.includes(slotIdRaw)) return { ok: false };
  clearSlotState(slotIdRaw);
  return { ok: true };
});
ipcMain.handle('app:start-display', async (_e, raw) => {
  const cfg = sanitizeConfig(raw);
  saveConfig(cfg);
  if (setupWindow) setupWindow.close();
  createMainWindow();
  startPowerSaveBlocker();
  mainWindow.webContents.once('did-finish-load', () => startPolling(cfg));
  return { ok: true };
});
ipcMain.handle('app:open-setup', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  stopPolling(); stopPowerSaveBlocker();
  createSetupWindow();
  return { ok: true };
});
ipcMain.handle('app:exit', () => app.quit());
ipcMain.handle('display:toggle-fullscreen', () => { if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen()); });

// === OAuth handlers ===
ipcMain.handle('oauth:get-cfg', () => {
  const cfg = loadOAuthCfg();
  if (!cfg) return null;
  return { clientId: cfg.clientId || '', hasSecret: !!cfg.clientSecret };
});
ipcMain.handle('oauth:save-cfg', (_e, { clientId, clientSecret }) => {
  if (!clientId || typeof clientId !== 'string') return { ok: false, error: 'clientId obrigatório' };
  saveOAuthCfg({ clientId: clientId.trim(), clientSecret: (clientSecret || '').trim() });
  return { ok: true };
});
ipcMain.handle('oauth:login', async (_e, slotIdRaw) => {
  if (!SLOTS.includes(slotIdRaw)) return { ok: false, error: 'invalid_slot' };
  const cfg = loadOAuthCfg();
  if (!cfg || !cfg.clientId) return { ok: false, error: 'Configure o Client ID antes de logar' };
  try {
    const tokens = await oauth.startLoginFlow({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      userDataPath: app.getPath('userData')
    });
    oauth.saveTokens(app.getPath('userData'), slotIdRaw, tokens);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});
ipcMain.handle('oauth:logout', (_e, slotIdRaw) => {
  if (!SLOTS.includes(slotIdRaw)) return { ok: false, error: 'invalid_slot' };
  oauth.clearTokens(app.getPath('userData'), slotIdRaw);
  return { ok: true };
});
ipcMain.handle('oauth:status', (_e, slotIdRaw) => {
  if (!SLOTS.includes(slotIdRaw)) return { ok: false };
  const tokens = oauth.loadTokens(app.getPath('userData'), slotIdRaw);
  return { ok: !!(tokens && tokens.refresh_token), savedAt: tokens && tokens.saved_at };
});

// === Studio Cookies handlers (caminho EXATO via cookies do Chrome) ===
ipcMain.handle('studio:import', async (_e, slotIdRaw) => {
  if (!SLOTS.includes(slotIdRaw)) return { ok: false, error: 'invalid_slot' };
  if (process.platform !== 'win32') {
    return { ok: false, error: 'Importar cookies só funciona no Windows (DPAPI)' };
  }
  try {
    const chromeCookies = require('./chrome-cookies.js');
    const { browser, cookies } = await chromeCookies.readBrowserCookiesForYouTube();
    const byName = studioFetch.pickCookies(cookies);
    if (!byName.SAPISID && !byName['__Secure-3PAPISID'] && !byName['__Secure-1PAPISID']) {
      return { ok: false, error: 'Não logado no Studio neste navegador. Faça login em studio.youtube.com no Chrome e tente de novo.' };
    }
    studioFetch.saveStudioCookies(app.getPath('userData'), slotIdRaw, byName);
    // Validação imediata: tenta uma chamada
    const cfg = loadConfig();
    const channelIdRaw = cfg[slotIdRaw] && cfg[slotIdRaw].identifier;
    const channelId = channelIdRaw ? parseChannelId(channelIdRaw) : null;
    let testCount = null;
    if (channelId) {
      try {
        const r = await studioFetch.fetchStudioCount(channelId, byName);
        testCount = r.count;
      } catch (e) {
        return { ok: false, error: `Cookies importados de ${browser}, mas Studio rejeitou: ${e.message}` };
      }
    }
    return { ok: true, browser, cookieCount: cookies.length, testCount };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});
ipcMain.handle('studio:status', (_e, slotIdRaw) => {
  if (!SLOTS.includes(slotIdRaw)) return { ok: false };
  const stored = studioFetch.loadStudioCookies(app.getPath('userData'), slotIdRaw);
  return { ok: !!(stored && stored.cookies), savedAt: stored && stored.saved_at };
});
ipcMain.handle('studio:clear', (_e, slotIdRaw) => {
  if (!SLOTS.includes(slotIdRaw)) return { ok: false };
  studioFetch.clearStudioCookies(app.getPath('userData'), slotIdRaw);
  return { ok: true };
});
ipcMain.handle('account:test', async (_e, slotIdRaw) => {
  if (!SLOTS.includes(slotIdRaw)) return { ok: false, error: 'invalid_slot' };
  const cfg = loadConfig();
  const slot = cfg[slotIdRaw];
  if (!slot || !slot.identifier) return { ok: false, error: 'sem identificador' };
  try {
    let result;
    if (slot.platform === 'youtube') result = await fetchYouTube(slot.identifier, slotIdRaw);
    else if (slot.platform === 'instagram') result = await fetchInstagram(slot.identifier);
    else if (slot.platform === 'tiktok') result = await fetchTikTok(slot.identifier);
    else return { ok: false, error: 'plataforma inválida' };
    return { ok: true, count: result.count, source: result.source };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// =============================================================================
// Boot
// =============================================================================
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e, webPreferences) => {
    delete webPreferences.preload; delete webPreferences.preloadURL;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    e.preventDefault();
  });
});

function applyDefaultSessionHardening() {
  const def = require('electron').session.defaultSession;
  def.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  def.setPermissionCheckHandler(() => false);
  def.setDevicePermissionHandler(() => false);
  def.webRequest.onHeadersReceived((details, cb) => {
    if (details.url && details.url.startsWith('file://')) {
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data:; font-src 'self' data:; connect-src 'none'; " +
            "object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none';"
          ]
        }
      });
    } else cb({ responseHeaders: details.responseHeaders });
  });
}

app.whenReady().then(() => {
  applyDefaultSessionHardening();
  const cfg = loadConfig();
  const hasAny = SLOTS.some(s => cfg[s] && cfg[s].identifier);
  if (hasAny && cfg.__autoStart) {
    createMainWindow();
    startPowerSaveBlocker();
    mainWindow.webContents.once('did-finish-load', () => startPolling(cfg));
  } else {
    createSetupWindow();
  }
});

app.on('window-all-closed', () => {
  stopPolling(); stopPowerSaveBlocker();
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createSetupWindow(); });
