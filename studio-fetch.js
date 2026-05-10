// =============================================================================
// studio-fetch.js
// Chama a API interna do YouTube Studio (a mesma que a página
// studio.youtube.com/.../explore_type=SUBSCRIBERS usa internamente)
// usando os cookies importados do Chrome do usuário.
//
// Auth: SAPISIDHASH = sha1(timestamp + ' ' + SAPISID + ' ' + origin)
// (3 variantes: SAPISID/SAPISIDHASH, __Secure-1PAPISID/SAPISID1PHASH,
//  __Secure-3PAPISID/SAPISID3PHASH — mandamos as 3 separadas por vírgula)
// =============================================================================

const crypto = require('crypto');
const { net, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const STUDIO_API_KEY = 'AIzaSyBUPetSUmoZL-OhlxA7wSac5XinrygCqMo'; // chave Innertube pública do Studio
const ORIGIN = 'https://studio.youtube.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

// Cookies importantes da sessão Studio. SID e SAPISID são o mínimo, mas
// quanto mais incluir, mais robusta a auth (alguns endpoints checam vários).
const RELEVANT = new Set([
  'SID', 'HSID', 'SSID', 'APISID', 'SAPISID',
  '__Secure-1PSID', '__Secure-3PSID',
  '__Secure-1PSIDTS', '__Secure-3PSIDTS',
  '__Secure-1PAPISID', '__Secure-3PAPISID',
  '__Secure-1PSIDCC', '__Secure-3PSIDCC',
  'LOGIN_INFO', 'PREF', 'YSC',
  'VISITOR_INFO1_LIVE', 'VISITOR_PRIVACY_METADATA',
  'CONSENT'
]);

function pickCookies(cookies) {
  const byName = {};
  for (const c of cookies) {
    // Prefere host explícito sobre wildcard, e prefere o mais recente
    if (!RELEVANT.has(c.name)) continue;
    if (!byName[c.name] || (c.expiresUtc > (byName[c.name].expiresUtc || 0))) {
      byName[c.name] = c;
    }
  }
  return byName;
}

function buildCookieHeader(byName) {
  return Object.values(byName).map(c => `${c.name}=${c.value}`).join('; ');
}

function sha1Hex(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

function buildAuthHeader(byName, origin) {
  const ts = Math.floor(Date.now() / 1000);
  const parts = [];
  if (byName['SAPISID']) {
    parts.push(`SAPISIDHASH ${ts}_${sha1Hex(`${ts} ${byName['SAPISID'].value} ${origin}`)}`);
  }
  if (byName['__Secure-1PAPISID']) {
    parts.push(`SAPISID1PHASH ${ts}_${sha1Hex(`${ts} ${byName['__Secure-1PAPISID'].value} ${origin}`)}`);
  }
  if (byName['__Secure-3PAPISID']) {
    parts.push(`SAPISID3PHASH ${ts}_${sha1Hex(`${ts} ${byName['__Secure-3PAPISID'].value} ${origin}`)}`);
  }
  return parts.join(' ');
}

function findNumberInJson(obj, predicate) {
  // BFS pela árvore JSON, retorna o primeiro número que casa com predicate
  const stack = [obj];
  while (stack.length) {
    const node = stack.pop();
    if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (typeof v === 'number' && predicate(k, v, node)) return v;
        if (typeof v === 'string' && /^\d+$/.test(v) && predicate(k, parseInt(v, 10), node)) {
          return parseInt(v, 10);
        }
        if (v && typeof v === 'object') stack.push(v);
      }
    }
  }
  return null;
}

async function fetchStudioCount(channelId, byName, opts = {}) {
  const cookieHeader = buildCookieHeader(byName);
  const authHeader = buildAuthHeader(byName, ORIGIN);
  if (!authHeader) {
    throw new Error('Cookies SAPISID/__Secure-1PAPISID/__Secure-3PAPISID não encontrados');
  }

  // Tenta 2 endpoints diferentes em ordem; o primeiro que devolver um número válido vence.
  const attempts = [
    {
      name: 'analytics/get_screen explore=SUBSCRIBERS',
      url: `${ORIGIN}/youtubei/v1/analytics/get_screen?alt=json&prettyPrint=false&key=${STUDIO_API_KEY}`,
      body: {
        context: {
          client: {
            clientName: 'WEB_CREATOR', clientVersion: '1.20240101.00.00',
            hl: 'en', gl: 'US', screenWidthPoints: 1280, screenHeightPoints: 800, screenPixelDensity: 1
          },
          request: { useSsl: true },
          user: { lockedSafetyMode: false }
        },
        desktopState: { selectedTab: { tabType: 'TAB_TYPE_OVERVIEW' } },
        screenConfig: {
          entity: { externalChannelId: channelId, type: 'ENTITY_TYPE_CHANNEL' },
          timePeriodType: 'ANALYTICS_TIME_PERIOD_TYPE_LAST_4_WEEKS',
          analyticsScreenType: 'ANALYTICS_SCREEN_TYPE_OVERVIEW',
          explore: { exploreType: 'ANALYTICS_EXPLORE_TYPE_SUBSCRIBERS' }
        }
      }
    },
    {
      name: 'analytics/get_card_data SUBSCRIBERS lifetime',
      url: `${ORIGIN}/youtubei/v1/analytics/get_card_data?alt=json&prettyPrint=false&key=${STUDIO_API_KEY}`,
      body: {
        context: {
          client: { clientName: 'WEB_CREATOR', clientVersion: '1.20240101.00.00', hl: 'en', gl: 'US' },
          request: { useSsl: true },
          user: { lockedSafetyMode: false }
        },
        desktopState: { entity: { externalChannelId: channelId, type: 'ENTITY_TYPE_CHANNEL' } },
        cardConfig: {
          entity: { externalChannelId: channelId, type: 'ENTITY_TYPE_CHANNEL' },
          metric: 'SUBSCRIBERS',
          timePeriodType: 'ANALYTICS_TIME_PERIOD_TYPE_LIFETIME'
        }
      }
    },
    {
      name: 'creator/get_creator_videos',
      url: `${ORIGIN}/youtubei/v1/creator/get_creator_videos?alt=json&prettyPrint=false&key=${STUDIO_API_KEY}`,
      body: {
        context: {
          client: { clientName: 'WEB_CREATOR', clientVersion: '1.20240101.00.00', hl: 'en', gl: 'US' },
          request: { useSsl: true },
          user: { lockedSafetyMode: false }
        },
        channelId,
        pageSize: 1,
        mask: { channelId: true, lifetimeMetrics: { all: true } }
      }
    }
  ];

  const baseHeaders = {
    'Authorization': authHeader,
    'Cookie': cookieHeader,
    'Content-Type': 'application/json',
    'User-Agent': UA,
    'Origin': ORIGIN,
    'Referer': `${ORIGIN}/channel/${channelId}/analytics/tab-overview/period-default/explore?entity_type=CHANNEL&entity_id=${channelId}&time_period=4_weeks&explore_type=SUBSCRIBERS`,
    'X-Origin': ORIGIN,
    'X-YouTube-Client-Name': '62',
    'X-YouTube-Client-Version': '1.20240101.00.00',
    'Accept': '*/*',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
  };

  const debugLog = [];
  let lastErr = null;
  for (const att of attempts) {
    try {
      const res = await net.fetch(att.url, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify(att.body),
        redirect: 'manual'
      });
      const text = await res.text();
      debugLog.push({ name: att.name, status: res.status, bodyPreview: text.slice(0, 800) });
      if (res.status === 401 || res.status === 403) {
        lastErr = `Studio API rejeitou auth (status ${res.status}) — cookies expirados/inválidos. Reimporte do Chrome.`;
        continue;
      }
      if (!res.ok) { lastErr = `${att.name}: HTTP ${res.status}`; continue; }
      let data;
      try { data = JSON.parse(text); } catch (e) { lastErr = `${att.name}: JSON invalido`; continue; }

      // Salva a resposta inteira pra debugging
      if (opts.dumpDir) {
        try {
          fs.mkdirSync(opts.dumpDir, { recursive: true });
          fs.writeFileSync(path.join(opts.dumpDir, `studio-${att.name.replace(/[^a-z0-9]+/gi, '_')}.json`),
            JSON.stringify(data, null, 2));
        } catch (_) {}
      }

      const found = extractSubscriberCount(data);
      if (found && found.count > 0) {
        return { count: found.count, source: 'yt-studio-cookies', attempt: att.name, hint: found.hint };
      }
      lastErr = `${att.name}: respondeu mas não achei contagem de inscritos (resposta salva em debug)`;
    } catch (e) {
      lastErr = `${att.name}: ${(e && e.message) || String(e)}`;
      debugLog.push({ name: att.name, error: lastErr });
    }
  }
  if (opts.dumpDir) {
    try {
      fs.writeFileSync(path.join(opts.dumpDir, 'studio-attempts.json'), JSON.stringify(debugLog, null, 2));
    } catch (_) {}
  }
  throw new Error(lastErr || 'Falha em todas as tentativas Studio');
}

// Extração robusta de inscritos: busca caminhos comuns + fallback heurístico
function extractSubscriberCount(root) {
  // Paths conhecidos em respostas do Innertube/Studio
  const directPaths = [
    // get_card_data
    'cardData.mainSeries.dataPoints',  // pega o último ponto
    'lifetimeValue.value',
    'totalValue',
    // get_creator_videos: lifetimeMetrics
    'lifetimeMetrics.subscriberCount',
    // common
    'subscriberCount',
    'subscribers'
  ];
  // Tenta paths exatos
  for (const p of directPaths) {
    const v = getByPath(root, p);
    if (typeof v === 'number' && v > 0) return { count: v, hint: p };
    if (typeof v === 'string' && /^\d+$/.test(v)) return { count: parseInt(v, 10), hint: p };
    if (Array.isArray(v) && v.length > 0) {
      const last = v[v.length - 1];
      if (last && typeof last.y === 'number' && last.y > 0) return { count: last.y, hint: `${p}[last].y` };
      if (last && typeof last.value === 'number' && last.value > 0) return { count: last.value, hint: `${p}[last].value` };
    }
  }

  // BFS pelos nós, prioriza nós cujo "metric" ou "metricKey" indique TOTAL/SUBSCRIBERS
  const stack = [{ node: root, path: '$' }];
  let bestExact = null;
  while (stack.length) {
    const { node, path: p } = stack.pop();
    if (!node || typeof node !== 'object') continue;
    const blob = JSON.stringify(node).slice(0, 600);
    const keysSubFlag = /metric.{0,30}(?:TOTAL_)?SUBSCRIBER/i.test(blob)
                     || /\b(subscriberCount|totalSubscribers|aggregateMetrics?)\b/.test(blob);
    if (keysSubFlag) {
      // Procura uma propriedade numérica grande
      for (const k of Object.keys(node)) {
        const v = node[k];
        let n = null;
        if (typeof v === 'number') n = v;
        else if (typeof v === 'string' && /^\d{4,}$/.test(v)) n = parseInt(v, 10);
        if (n != null && n >= 100 && n < 1e10 && /value|count|metric|total|aggregate/i.test(k)) {
          if (!bestExact || n > bestExact.count) {
            bestExact = { count: n, hint: `${p}.${k}` };
          }
        }
      }
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === 'object') stack.push({ node: v, path: `${p}.${k}` });
    }
  }
  return bestExact;
}

function getByPath(root, path) {
  return path.split('.').reduce((acc, key) => {
    if (acc == null) return undefined;
    return acc[key];
  }, root);
}

// =============================================================================
// Persistência segura dos cookies importados
// =============================================================================
function cookieFile(userDataPath, slotId) {
  return path.join(userDataPath, 'studio-cookies', `${slotId}.bin`);
}

function saveStudioCookies(userDataPath, slotId, byName) {
  const dir = path.dirname(cookieFile(userDataPath, slotId));
  fs.mkdirSync(dir, { recursive: true });
  const json = JSON.stringify({
    saved_at: Date.now(),
    cookies: byName
  });
  let payload;
  if (safeStorage.isEncryptionAvailable()) {
    payload = safeStorage.encryptString(json);
  } else {
    payload = Buffer.from('PLAIN:' + json, 'utf-8');
  }
  fs.writeFileSync(cookieFile(userDataPath, slotId), payload);
}

function loadStudioCookies(userDataPath, slotId) {
  const p = cookieFile(userDataPath, slotId);
  if (!fs.existsSync(p)) return null;
  try {
    const buf = fs.readFileSync(p);
    let json;
    if (buf.toString('utf-8').startsWith('PLAIN:')) {
      json = buf.toString('utf-8').slice(6);
    } else {
      json = safeStorage.decryptString(buf);
    }
    const parsed = JSON.parse(json);
    return parsed && parsed.cookies ? parsed : null;
  } catch (e) {
    return null;
  }
}

function clearStudioCookies(userDataPath, slotId) {
  const p = cookieFile(userDataPath, slotId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

module.exports = {
  pickCookies,
  fetchStudioCount,
  saveStudioCookies,
  loadStudioCookies,
  clearStudioCookies
};
