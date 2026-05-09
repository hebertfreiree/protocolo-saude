const { app, BrowserWindow, BrowserView, ipcMain, powerSaveBlocker, session, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const CONFIG_FILE = path.join(app.getPath('userData'), 'accounts.json');
const SLOTS = ['yt1', 'yt2', 'ig1', 'ig2', 'tt1', 'tt2'];
const IS_DEV = process.argv.includes('--dev') || !app.isPackaged;

// === Security: domínios permitidos por plataforma ===
// Qualquer navegação ou abertura de janela fora dessas listas é bloqueada.
const ALLOWED_DOMAINS = {
  youtube: [
    'studio.youtube.com', 'www.youtube.com', 'youtube.com', 'm.youtube.com',
    'accounts.google.com', 'accounts.youtube.com', 'myaccount.google.com',
    'ssl.gstatic.com', 'www.gstatic.com', 'fonts.gstatic.com', 'fonts.googleapis.com',
    'apis.google.com', 'play.google.com', 'i.ytimg.com', 'yt3.ggpht.com',
    'lh3.googleusercontent.com', 'content-autofill.googleapis.com',
    'clients4.google.com', 'clients2.google.com'
  ],
  instagram: [
    'www.instagram.com', 'instagram.com', 'i.instagram.com',
    'static.cdninstagram.com', 'scontent.cdninstagram.com',
    'graph.instagram.com', 'graph.facebook.com',
    'www.facebook.com', 'facebook.com', 'm.facebook.com', 'b.i.instagram.com'
  ],
  tiktok: [
    'www.tiktok.com', 'tiktok.com', 'm.tiktok.com',
    'lf16-tiktok-web.ttwstatic.com', 'lf16-tiktok-common.ttwstatic.com',
    'sf16-website-login.neutral.ttwstatic.com', 'webcast.tiktok.com',
    'www.tiktokcdn.com', 'p16-sign.tiktokcdn-us.com', 'p16-sign-va.tiktokcdn.com',
    'mssdk.tiktokv.com', 'mssdk-va.tiktokv.com', 'mssdk-sg.tiktokv.com',
    'mcs.tiktokw.us', 'mon16-normal-useast5.tiktokv.us',
    'login.tiktok.com', 'mssdk.tiktok.com'
  ]
};

function urlMatchesAllowed(urlStr, platform) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'https:' && u.protocol !== 'about:' && u.protocol !== 'data:') {
      return false;
    }
    const list = ALLOWED_DOMAINS[platform] || [];
    return list.some(d => u.hostname === d || u.hostname.endsWith('.' + d));
  } catch { return false; }
}

let mainWindow = null;
let setupWindow = null;
let powerSaveId = null;
const scraperViews = {};
const lastCounts = {};
const lastUpdated = {};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Erro ao ler config:', e);
  }
  return {};
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}

function getPartition(slotId) {
  return `persist:${slotId}`;
}

function buildScraperUrl(platform, identifier) {
  if (!identifier) return null;
  const id = identifier.trim();
  if (platform === 'youtube') {
    let channelId = id;
    const m = id.match(/channel\/(UC[A-Za-z0-9_-]{20,})/);
    if (m) channelId = m[1];
    if (!channelId.startsWith('UC')) return null;
    return `https://studio.youtube.com/channel/${channelId}/analytics/tab-overview/period-default/explore?entity_type=CHANNEL&entity_id=${channelId}&time_period=4_weeks&explore_type=SUBSCRIBERS`;
  }
  if (platform === 'instagram') {
    let username = id.replace(/^@/, '');
    const m = id.match(/instagram\.com\/([^\/?#]+)/i);
    if (m) username = m[1];
    return `https://www.instagram.com/${username}/`;
  }
  if (platform === 'tiktok') {
    let username = id.replace(/^@/, '');
    const m = id.match(/tiktok\.com\/@([^\/?#]+)/i);
    if (m) username = m[1];
    return `https://www.tiktok.com/@${username}`;
  }
  return null;
}

function startPowerSaveBlocker() {
  if (powerSaveId === null || !powerSaveBlocker.isStarted(powerSaveId)) {
    powerSaveId = powerSaveBlocker.start('prevent-display-sleep');
    console.log('PowerSaveBlocker iniciado:', powerSaveId);
  }
}

function stopPowerSaveBlocker() {
  if (powerSaveId !== null && powerSaveBlocker.isStarted(powerSaveId)) {
    powerSaveBlocker.stop(powerSaveId);
    powerSaveId = null;
  }
}

function hardenLocalWindow(win) {
  // Bloqueia novas janelas e qualquer navegação para fora dos arquivos locais.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  if (!IS_DEV) {
    win.webContents.on('before-input-event', (e, input) => {
      // Bloqueia DevTools em produção
      if ((input.control || input.meta) && input.shift && (input.key === 'I' || input.key === 'i')) {
        e.preventDefault();
      }
      if (input.key === 'F12') e.preventDefault();
    });
  }
}

function createSetupWindow() {
  if (setupWindow) {
    setupWindow.focus();
    return;
  }
  setupWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'Configurar contas — Seguidores Tempo Real',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false
    }
  });
  setupWindow.loadFile(path.join(__dirname, 'src', 'setup', 'setup.html'));
  hardenLocalWindow(setupWindow);
  setupWindow.on('closed', () => { setupWindow = null; });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    fullscreen: true,
    autoHideMenuBar: true,
    title: 'Seguidores em Tempo Real',
    backgroundColor: '#000000',
    kiosk: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false
    }
  });
  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'src', 'display', 'display.html'));
  hardenLocalWindow(mainWindow);
  mainWindow.on('closed', () => {
    mainWindow = null;
    stopAllScrapers();
    stopPowerSaveBlocker();
  });
}

function hardenScraperSession(ses, platform) {
  // Bloqueia permissões sensíveis (câmera, mic, geolocalização, notificações, etc.)
  ses.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_req, callback) => callback({}));
  // Não baixar nada do navegador embutido
  ses.on('will-download', (e) => e.preventDefault());
}

function createScraperView(slotId, platform, url) {
  const partition = getPartition(slotId);
  const ses = session.fromPartition(partition);
  ses.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');
  hardenScraperSession(ses, platform);

  const view = new BrowserView({
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      autoplayPolicy: 'document-user-activation-required',
      offscreen: false
    }
  });

  view.setBackgroundColor('#000000');
  view.webContents.setAudioMuted(true);

  view.webContents.setWindowOpenHandler(({ url: newUrl }) => {
    if (urlMatchesAllowed(newUrl, platform)) return { action: 'allow' };
    return { action: 'deny' };
  });
  view.webContents.on('will-navigate', (e, navUrl) => {
    if (!urlMatchesAllowed(navUrl, platform)) {
      console.warn(`[${slotId}] navegação bloqueada para ${navUrl}`);
      e.preventDefault();
    }
  });
  view.webContents.on('will-redirect', (e, navUrl) => {
    if (!urlMatchesAllowed(navUrl, platform)) {
      console.warn(`[${slotId}] redirect bloqueado para ${navUrl}`);
      e.preventDefault();
    }
  });

  view.webContents.loadURL(url).catch(err => console.error(`Erro carregando ${slotId}:`, err));

  scraperViews[slotId] = { view, platform, url, lastReload: Date.now() };
  return view;
}

function stopAllScrapers() {
  for (const slotId of Object.keys(scraperViews)) {
    try {
      const entry = scraperViews[slotId];
      if (entry && entry.view && !entry.view.webContents.isDestroyed()) {
        entry.view.webContents.close();
      }
    } catch (e) { /* ignore */ }
    delete scraperViews[slotId];
  }
}

const SCRAPE_SCRIPTS = {
  youtube: `
    (() => {
      function parseNum(s) {
        if (!s) return null;
        const cleaned = s.toString().replace(/[^\\d.,]/g, '').replace(/\\./g, '').replace(/,/g, '');
        const n = parseInt(cleaned, 10);
        return Number.isFinite(n) ? n : null;
      }
      function findInDeep(root, predicate) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let node;
        const results = [];
        while ((node = walker.nextNode())) {
          if (predicate(node)) results.push(node);
          if (node.shadowRoot) {
            results.push(...findInDeep(node.shadowRoot, predicate));
          }
        }
        return results;
      }
      const candidates = [];
      const selectors = [
        '#total-metric-value',
        '.metric-value-figure',
        'ytcp-explore-metric-summary .metric-value',
        '.ytcp-analytics-deep-dive-card .metric-value',
        '[class*="metric-total"]',
        '[class*="explore-metric"]'
      ];
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach(el => {
          const n = parseNum(el.textContent);
          if (n !== null && n >= 0) candidates.push({ value: n, source: sel });
        });
      }
      const deepNodes = findInDeep(document, (el) => {
        const t = (el.textContent || '').trim();
        return el.children.length === 0 && /^[\\d.,]{1,20}$/.test(t);
      });
      for (const el of deepNodes) {
        const n = parseNum(el.textContent);
        if (n !== null && n > 100) candidates.push({ value: n, source: 'deep-text' });
      }
      const text = (document.body && document.body.innerText) || '';
      const m = text.match(/([\\d.,]+)\\s*(?:inscritos|subscribers)/i);
      if (m) {
        const n = parseNum(m[1]);
        if (n !== null) candidates.push({ value: n, source: 'regex' });
      }
      if (candidates.length === 0) return { ok: false, error: 'no_candidate', url: location.href };
      candidates.sort((a, b) => b.value - a.value);
      return { ok: true, count: candidates[0].value, source: candidates[0].source, all: candidates.slice(0, 5) };
    })();
  `,
  instagram: `
    (() => {
      function parseNum(s) {
        if (!s) return null;
        const cleaned = s.toString().replace(/[^\\d.,KMBkmb]/g, '').trim();
        const m = cleaned.match(/^([\\d.,]+)([KMB])?$/i);
        if (!m) {
          const justDigits = cleaned.replace(/\\./g, '').replace(/,/g, '');
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
      const candidates = [];
      const titleEl = document.querySelector('meta[property="og:description"]');
      if (titleEl && titleEl.content) {
        const m = titleEl.content.match(/([\\d.,KMB]+)\\s*(?:Followers|Seguidores|seguidores)/i);
        if (m) {
          const n = parseNum(m[1]);
          if (n !== null) candidates.push({ value: n, source: 'og:description' });
        }
      }
      const links = document.querySelectorAll('a[href$="/followers/"], a[href*="/followers/"]');
      links.forEach(a => {
        const titleAttr = a.querySelector('span[title]');
        if (titleAttr && titleAttr.title) {
          const n = parseNum(titleAttr.title);
          if (n !== null) candidates.push({ value: n, source: 'span-title' });
        }
        const span = a.querySelector('span');
        if (span && span.textContent) {
          const n = parseNum(span.textContent);
          if (n !== null) candidates.push({ value: n, source: 'span-text' });
        }
      });
      const ulItems = document.querySelectorAll('header ul li, header section ul li');
      ulItems.forEach(li => {
        const t = li.textContent || '';
        const m = t.match(/([\\d.,KMB]+)\\s*(?:followers|seguidores)/i);
        if (m) {
          const n = parseNum(m[1]);
          if (n !== null) candidates.push({ value: n, source: 'header-li' });
        }
      });
      if (candidates.length === 0) return { ok: false, error: 'no_candidate', url: location.href };
      candidates.sort((a, b) => b.value - a.value);
      return { ok: true, count: candidates[0].value, source: candidates[0].source, all: candidates.slice(0, 5) };
    })();
  `,
  tiktok: `
    (() => {
      function parseNum(s) {
        if (!s) return null;
        const cleaned = s.toString().replace(/[^\\d.,KMBkmb]/g, '').trim();
        const m = cleaned.match(/^([\\d.,]+)([KMB])?$/i);
        if (!m) {
          const justDigits = cleaned.replace(/\\./g, '').replace(/,/g, '');
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
      const candidates = [];
      const e2e = document.querySelector('[data-e2e="followers-count"]');
      if (e2e && e2e.textContent) {
        const titleAttr = e2e.getAttribute('title');
        if (titleAttr) {
          const n = parseNum(titleAttr);
          if (n !== null) candidates.push({ value: n, source: 'e2e-title' });
        }
        const n2 = parseNum(e2e.textContent);
        if (n2 !== null) candidates.push({ value: n2, source: 'e2e-text' });
      }
      const strong = document.querySelector('strong[title][data-e2e="followers-count"]');
      if (strong && strong.title) {
        const n = parseNum(strong.title);
        if (n !== null) candidates.push({ value: n, source: 'strong-title' });
      }
      const text = (document.body && document.body.innerText) || '';
      const m = text.match(/([\\d.,KMB]+)\\s*(?:Followers|Seguidores|seguidores)/i);
      if (m) {
        const n = parseNum(m[1]);
        if (n !== null) candidates.push({ value: n, source: 'regex' });
      }
      if (candidates.length === 0) return { ok: false, error: 'no_candidate', url: location.href };
      candidates.sort((a, b) => b.value - a.value);
      return { ok: true, count: candidates[0].value, source: candidates[0].source, all: candidates.slice(0, 5) };
    })();
  `
};

const RELOAD_INTERVAL_MS = {
  youtube: 30 * 60 * 1000,
  instagram: 60 * 1000,
  tiktok: 60 * 1000
};

async function scrapeOne(slotId) {
  const entry = scraperViews[slotId];
  if (!entry) return { ok: false, error: 'no_view' };
  const { view, platform } = entry;
  if (view.webContents.isDestroyed()) return { ok: false, error: 'destroyed' };
  if (view.webContents.isLoading()) return { ok: false, error: 'loading' };

  try {
    const result = await view.webContents.executeJavaScript(SCRAPE_SCRIPTS[platform], true);
    if (result && result.ok) {
      lastCounts[slotId] = result.count;
      lastUpdated[slotId] = Date.now();
    }
    const interval = RELOAD_INTERVAL_MS[platform] || 60000;
    if (Date.now() - entry.lastReload > interval) {
      entry.lastReload = Date.now();
      view.webContents.reload();
    }
    return result;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function startScraping(config) {
  stopAllScrapers();
  for (const slotId of SLOTS) {
    const slot = config[slotId];
    if (!slot || !slot.platform || !slot.identifier) continue;
    const url = buildScraperUrl(slot.platform, slot.identifier);
    if (!url) continue;
    createScraperView(slotId, slot.platform, url);
  }
  setInterval(async () => {
    const results = {};
    for (const slotId of Object.keys(scraperViews)) {
      results[slotId] = await scrapeOne(slotId);
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('counts-update', {
        counts: lastCounts,
        updated: lastUpdated,
        results,
        config
      });
    }
  }, 5000);
}

ipcMain.handle('config:get', () => loadConfig());

ipcMain.handle('config:save', (_evt, cfg) => {
  saveConfig(sanitizeConfig(cfg));
  return true;
});

ipcMain.handle('account:login', async (_evt, slotIdRaw, platformRaw) => {
  // Validação rigorosa dos parâmetros vindos do renderer
  if (!SLOTS.includes(slotIdRaw)) return { ok: false, error: 'invalid_slot' };
  const platform = String(platformRaw || '').toLowerCase();
  if (!['youtube', 'instagram', 'tiktok'].includes(platform)) return { ok: false, error: 'invalid_platform' };
  const slotId = slotIdRaw;

  const partition = getPartition(slotId);
  const ses = session.fromPartition(partition);
  ses.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');
  hardenScraperSession(ses, platform);

  const loginUrl = {
    youtube: 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fstudio.youtube.com%2F',
    instagram: 'https://www.instagram.com/accounts/login/',
    tiktok: 'https://www.tiktok.com/login'
  }[platform];

  const win = new BrowserWindow({
    width: 1000,
    height: 800,
    title: `Login ${platform} (slot ${slotId}) — feche esta janela ao terminar`,
    autoHideMenuBar: true,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false
    }
  });
  win.webContents.setWindowOpenHandler(({ url: newUrl }) => (
    urlMatchesAllowed(newUrl, platform) ? { action: 'allow' } : { action: 'deny' }
  ));
  win.webContents.on('will-navigate', (e, navUrl) => {
    if (!urlMatchesAllowed(navUrl, platform)) e.preventDefault();
  });
  win.webContents.on('will-redirect', (e, navUrl) => {
    if (!urlMatchesAllowed(navUrl, platform)) e.preventDefault();
  });
  await win.loadURL(loginUrl);
  return new Promise((resolve) => {
    win.on('closed', () => resolve({ ok: true }));
  });
});

ipcMain.handle('account:logout', async (_evt, slotIdRaw) => {
  if (!SLOTS.includes(slotIdRaw)) return { ok: false, error: 'invalid_slot' };
  const partition = getPartition(slotIdRaw);
  const ses = session.fromPartition(partition);
  await ses.clearStorageData();
  await ses.clearAuthCache();
  await ses.clearCache();
  return { ok: true };
});

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

ipcMain.handle('app:start-display', async (_evt, rawConfig) => {
  const config = sanitizeConfig(rawConfig);
  saveConfig(config);
  if (setupWindow) setupWindow.close();
  createMainWindow();
  startPowerSaveBlocker();
  mainWindow.webContents.once('did-finish-load', () => {
    startScraping(config);
  });
  return { ok: true };
});

ipcMain.handle('app:open-setup', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
  }
  stopAllScrapers();
  stopPowerSaveBlocker();
  createSetupWindow();
  return { ok: true };
});

ipcMain.handle('app:exit', () => {
  app.quit();
});

ipcMain.handle('display:toggle-fullscreen', () => {
  if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
});

ipcMain.handle('display:get-debug', () => {
  const out = {};
  for (const slotId of Object.keys(scraperViews)) {
    const entry = scraperViews[slotId];
    out[slotId] = {
      platform: entry.platform,
      url: entry.url,
      lastReload: entry.lastReload,
      currentUrl: entry.view.webContents.getURL(),
      isLoading: entry.view.webContents.isLoading(),
      lastCount: lastCounts[slotId] || null,
      lastUpdated: lastUpdated[slotId] || null
    };
  }
  return out;
});

function applyDefaultSessionHardening() {
  // Sessão padrão (telas locais setup/display): CSP estrita e nada de permissões.
  const def = session.defaultSession;
  def.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
  def.setPermissionCheckHandler(() => false);
  def.setDevicePermissionHandler(() => false);

  def.webRequest.onHeadersReceived((details, callback) => {
    const url = details.url || '';
    if (url.startsWith('file://')) {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; " +
            "script-src 'self'; " +
            "style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data:; " +
            "font-src 'self' data:; " +
            "connect-src 'none'; " +
            "object-src 'none'; " +
            "base-uri 'self'; " +
            "form-action 'none'; " +
            "frame-ancestors 'none';"
          ]
        }
      });
    } else {
      callback({ responseHeaders: details.responseHeaders });
    }
  });
}

// Mata pedidos de novas WebContents que tentem usar configurações inseguras.
app.on('web-contents-created', (_evt, contents) => {
  contents.on('will-attach-webview', (e, webPreferences) => {
    delete webPreferences.preload;
    delete webPreferences.preloadURL;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    e.preventDefault();
  });
});

app.whenReady().then(() => {
  applyDefaultSessionHardening();
  const cfg = loadConfig();
  const hasAny = SLOTS.some(s => cfg[s] && cfg[s].identifier);
  if (hasAny && cfg.__autoStart) {
    createMainWindow();
    startPowerSaveBlocker();
    mainWindow.webContents.once('did-finish-load', () => {
      startScraping(cfg);
    });
  } else {
    createSetupWindow();
  }
});

app.on('window-all-closed', () => {
  stopAllScrapers();
  stopPowerSaveBlocker();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createSetupWindow();
});
