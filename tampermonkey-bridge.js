// =============================================================================
// tampermonkey-bridge.js
// Servidor HTTP local que recebe contagens do userscript Tampermonkey
// rodando no Chrome real do usuário (na página do Studio Analytics).
//
// Fluxo:
//   1. App sobe servidor em 127.0.0.1:7777 (ou primeira porta livre)
//   2. App gera userscript personalizado com os Channel IDs configurados
//   3. Usuário instala Tampermonkey + abre o link do script
//   4. Script roda na página de studio.youtube.com, lê o número do DOM
//      a cada 5s e faz POST /count para nosso servidor
//   5. Servidor atualiza lastCounts[slot] = number
// =============================================================================

const http = require('http');

const PREFERRED_PORTS = [7777, 7778, 8787, 9090];

function tryListen(port) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.once('error', (err) => {
      if (err.code === 'EADDRINUSE') resolve(null);
      else reject(err);
    });
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(port));
    });
  });
}

async function findFreePort() {
  for (const p of PREFERRED_PORTS) {
    const ok = await tryListen(p);
    if (ok) return ok;
  }
  // Fallback: porta aleatória
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.once('error', reject);
  });
}

function genUserscript({ port, slots }) {
  // slots = [{ slot: 'yt1', channelId: 'UC...' }, ...]
  return `// ==UserScript==
// @name         Seguidores Tempo Real — Coletor YouTube Studio
// @namespace    com.hebert.seguidores
// @version      1.0.${Date.now()}
// @description  Le o numero de inscritos do Studio Analytics e envia pro app local
// @match        https://studio.youtube.com/*
// @match        https://studio.youtube.com/channel/*
// @match        https://studio.youtube.com/channel/*/analytics/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(function() {
  'use strict';
  const APP_URL = 'http://127.0.0.1:${port}';
  const SLOTS = ${JSON.stringify(slots)};

  function getCurrentChannelId() {
    const m = location.href.match(/channel\\/(UC[A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  }
  function slotForCurrentChannel() {
    const id = getCurrentChannelId();
    if (!id) return null;
    return SLOTS.find(s => s.channelId === id);
  }

  function* deepWalk(root) {
    yield root;
    const cs = root.children || [];
    for (const c of cs) { try { yield* deepWalk(c); } catch (_) {} }
    if (root.shadowRoot) { try { yield* deepWalk(root.shadowRoot); } catch (_) {} }
  }
  function txt(el) { return (el.textContent || '').trim().replace(/\\s+/g, ' '); }

  function findCount() {
    const candidates = [];
    for (const el of deepWalk(document)) {
      if (!el || el.nodeType !== 1) continue;
      if (el.children && el.children.length > 0) continue;
      const t = txt(el);
      if (!/^[\\d.,\\s]{4,15}$/.test(t)) continue;
      const digits = t.replace(/[^\\d]/g, '');
      if (digits.length < 4 || digits.length > 10) continue;
      const n = parseInt(digits, 10);
      if (!(n >= 1000 && n <= 5e9)) continue;
      // Sobe a arvore (incl. shadow DOM)
      let p = el; let hasLabel = false;
      for (let i = 0; i < 12 && p; i++) {
        const pt = txt(p).toLowerCase();
        if (/inscritos?|inscri[çc][ãa]o|inscri[çc][õo]es|subscriber/.test(pt)) { hasLabel = true; break; }
        p = p.parentElement || (p.getRootNode && p.getRootNode().host) || null;
      }
      candidates.push({ n, hasLabel });
    }
    candidates.sort((a, b) => (b.hasLabel - a.hasLabel) || (b.n - a.n));
    return candidates[0] ? candidates[0].n : null;
  }

  function post(slot, count) {
    const body = JSON.stringify({ slot, count, source: 'tampermonkey-studio', url: location.href });
    const gm = (typeof GM_xmlhttpRequest !== 'undefined') ? GM_xmlhttpRequest
              : (typeof GM !== 'undefined' && GM.xmlHttpRequest) ? GM.xmlHttpRequest : null;
    if (gm) {
      gm({ method: 'POST', url: APP_URL + '/count', data: body,
           headers: { 'Content-Type': 'application/json' }, onload: () => {}, onerror: () => {} });
    } else {
      fetch(APP_URL + '/count', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } }).catch(()=>{});
    }
  }

  function tick() {
    try {
      const slot = slotForCurrentChannel();
      if (!slot) return;
      const count = findCount();
      if (count) post(slot.slot, count);
    } catch (e) { /* silencio */ }
  }

  // Banner discreto no topo da pagina pra o usuario saber que esta funcionando
  function mountBanner() {
    if (document.getElementById('__seg_banner__')) return;
    const div = document.createElement('div');
    div.id = '__seg_banner__';
    div.style.cssText = 'position:fixed;bottom:8px;right:8px;background:#0a0a0f;color:#88aaff;font:600 12px Segoe UI,sans-serif;padding:8px 12px;border-radius:8px;border:1px solid #2266dd;z-index:99999;opacity:.85';
    div.textContent = 'Seguidores Tempo Real — coletor ativo';
    document.body.appendChild(div);
  }

  mountBanner();
  setTimeout(tick, 3000);
  setInterval(tick, 5000);
})();
`;
}

function startBridge({ getConfigSnapshot, onCount }) {
  return new Promise(async (resolve, reject) => {
    const port = await findFreePort();
    const server = http.createServer((req, res) => {
      const setCors = () => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      };
      setCors();
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

      const u = new URL(req.url, `http://127.0.0.1:${port}`);
      if (u.pathname === '/' || u.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, app: 'Seguidores Tempo Real', port }));
      }

      if (u.pathname === '/script.user.js') {
        const cfg = getConfigSnapshot();
        const slots = ['yt1', 'yt2']
          .filter(s => cfg[s] && cfg[s].identifier)
          .map(s => {
            const m = (cfg[s].identifier || '').match(/(UC[A-Za-z0-9_-]{20,})/);
            return { slot: s, channelId: m ? m[1] : cfg[s].identifier };
          })
          .filter(x => x.channelId.startsWith('UC'));
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        return res.end(genUserscript({ port, slots }));
      }

      if (u.pathname === '/count' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
        req.on('end', () => {
          try {
            const j = JSON.parse(body);
            if (j && typeof j.slot === 'string' && typeof j.count === 'number' && j.count >= 0 && j.count < 1e10) {
              onCount(j.slot, j.count, j.source || 'tampermonkey');
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ ok: true }));
            }
          } catch (_) {}
          res.writeHead(400);
          res.end('bad');
        });
        return;
      }

      res.writeHead(404); res.end();
    });
    server.listen(port, '127.0.0.1', () => resolve({ port, server }));
    server.once('error', reject);
  });
}

module.exports = { startBridge };
