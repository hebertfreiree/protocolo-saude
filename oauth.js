// =============================================================================
// OAuth flow para YouTube via navegador EXTERNO (system browser).
// Resolve o erro "navegador não é seguro" do Google porque a janela de login
// roda no Chrome real do usuário, não dentro do Electron.
//
// Fluxo (RFC 8252 - OAuth 2.0 for Native Apps com PKCE + loopback redirect):
//   1. App gera code_verifier + code_challenge (PKCE)
//   2. App abre HTTP server local em 127.0.0.1:PORT
//   3. App abre URL de autorização no Chrome do usuário (shell.openExternal)
//   4. Usuário loga + autoriza no Chrome real
//   5. Google redireciona para http://127.0.0.1:PORT/?code=XXX
//   6. App captura code, troca por refresh_token
//   7. Salva refresh_token criptografado (electron safeStorage)
//
// Depois usa Analytics API para inscritos com mais precisão que o público.
// =============================================================================

const http = require('http');
const crypto = require('crypto');
const { shell, safeStorage } = require('electron');
const { net } = require('electron');
const path = require('path');
const fs = require('fs');

const TOKENS_DIR = (userDataPath) => path.join(userDataPath, 'oauth-tokens');
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly'
].join(' ');

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePKCE() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function startLoginFlow({ clientId, clientSecret, userDataPath }) {
  if (!clientId) throw new Error('OAuth Client ID não configurado.');

  const port = await pickFreePort();
  const redirectUri = `http://127.0.0.1:${port}`;
  const { verifier, challenge } = generatePKCE();
  const state = b64url(crypto.randomBytes(16));

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);

  // Spin up local server to receive callback
  const codePromise = new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      try { server.close(); } catch (_) {}
      reject(new Error('Timeout: login não foi concluído em 5 minutos'));
    }, 5 * 60 * 1000);

    const server = http.createServer((req, res) => {
      const u = new URL(req.url, redirectUri);
      const code = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      const recvState = u.searchParams.get('state');

      if (err) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>Erro ao logar: ${err}</h1><p>Pode fechar esta aba.</p>`);
        clearTimeout(timeoutId); server.close();
        return reject(new Error(err));
      }
      if (!code) {
        res.writeHead(400); res.end('Sem code'); return;
      }
      if (recvState !== state) {
        res.writeHead(400); res.end('State inválido (possível CSRF)');
        clearTimeout(timeoutId); server.close();
        return reject(new Error('state mismatch'));
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Login OK</title>
<style>body{background:#0a0a0f;color:#e8e8f0;font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}
.card{background:#11111a;border:1px solid #1f1f2e;border-radius:12px;padding:40px 60px;border-top:3px solid #66dd99}
h1{font-size:22px;margin-bottom:8px;color:#66dd99}p{color:#8088a0;font-size:14px}</style>
</head><body><div class="card"><h1>✓ Login realizado</h1><p>Pode fechar esta aba e voltar para o app.</p></div></body></html>`);
      clearTimeout(timeoutId);
      server.close();
      resolve(code);
    });
    server.listen(port, '127.0.0.1');
  });

  // Open in user's default browser (NOT Electron)
  await shell.openExternal(authUrl.toString());

  const code = await codePromise;

  // Exchange code for tokens
  const tokenRes = await net.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret || '',
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier
    }).toString()
  });
  if (!tokenRes.ok) {
    const errBody = await tokenRes.text();
    throw new Error(`Falha na troca de tokens (${tokenRes.status}): ${errBody.slice(0, 200)}`);
  }
  const tokens = await tokenRes.json();
  if (!tokens.refresh_token) {
    throw new Error('Google não retornou refresh_token. Revogue acesso em myaccount.google.com/permissions e tente de novo.');
  }
  return tokens;
}

function tokenPath(userDataPath, slotId) {
  return path.join(TOKENS_DIR(userDataPath), `${slotId}.bin`);
}

function saveTokens(userDataPath, slotId, tokens) {
  fs.mkdirSync(TOKENS_DIR(userDataPath), { recursive: true });
  const json = JSON.stringify({
    refresh_token: tokens.refresh_token,
    saved_at: Date.now()
  });
  let payload;
  if (safeStorage.isEncryptionAvailable()) {
    payload = safeStorage.encryptString(json);
  } else {
    payload = Buffer.from('PLAIN:' + json, 'utf-8');
  }
  fs.writeFileSync(tokenPath(userDataPath, slotId), payload);
}

function loadTokens(userDataPath, slotId) {
  const p = tokenPath(userDataPath, slotId);
  if (!fs.existsSync(p)) return null;
  const payload = fs.readFileSync(p);
  let json;
  try {
    if (payload.toString('utf-8').startsWith('PLAIN:')) {
      json = payload.toString('utf-8').slice(6);
    } else {
      json = safeStorage.decryptString(payload);
    }
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

function clearTokens(userDataPath, slotId) {
  const p = tokenPath(userDataPath, slotId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

async function refreshAccessToken({ clientId, clientSecret }, refreshToken) {
  const res = await net.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret || '',
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }).toString()
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`refresh falhou (${res.status}): ${t.slice(0, 200)}`);
  }
  return res.json();
}

const accessTokenCache = {}; // slotId -> { token, expiresAt }

async function getAccessToken(slotId, oauthCfg, userDataPath) {
  const cached = accessTokenCache[slotId];
  if (cached && cached.expiresAt > Date.now() + 30000) return cached.token;
  const tokens = loadTokens(userDataPath, slotId);
  if (!tokens || !tokens.refresh_token) throw new Error('Não logado nesta conta');
  const fresh = await refreshAccessToken(oauthCfg, tokens.refresh_token);
  accessTokenCache[slotId] = {
    token: fresh.access_token,
    expiresAt: Date.now() + (fresh.expires_in || 3600) * 1000
  };
  return fresh.access_token;
}

async function fetchYouTubeWithOAuth(slotId, oauthCfg, userDataPath, channelId) {
  const accessToken = await getAccessToken(slotId, oauthCfg, userDataPath);

  // 1) Channel snippet (creation date) + statistics (rounded fallback)
  const chRes = await net.fetch(
    `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${encodeURIComponent(channelId)}`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );
  if (!chRes.ok) throw new Error(`YT channels API ${chRes.status}`);
  const chData = await chRes.json();
  if (!chData.items || !chData.items[0]) throw new Error('Canal não encontrado');
  const item = chData.items[0];
  const baseCount = item.statistics ? parseInt(item.statistics.subscriberCount, 10) : null;
  const created = (item.snippet && item.snippet.publishedAt) || '2005-04-23';
  const startDate = created.slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  // 2) YouTube Analytics API: soma lifetime gains - losses.
  //    Para o DONO do canal, esses valores NÃO são arredondados.
  //    Total atual = total ganhos - total perdas (desde a criação).
  try {
    const aRes = await net.fetch(
      `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel%3D%3DMINE` +
      `&startDate=${startDate}&endDate=${today}` +
      `&metrics=subscribersGained,subscribersLost`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
    if (aRes.ok) {
      const a = await aRes.json();
      if (a.rows && a.rows[0]) {
        const gained = Number(a.rows[0][0]) || 0;
        const lost = Number(a.rows[0][1]) || 0;
        const exact = gained - lost;
        if (exact > 0) return { count: exact, source: 'yt-analytics-lifetime' };
      }
    } else {
      // Log mas não trava: cai no fallback do channels API
      try { console.error('Analytics API err:', aRes.status, (await aRes.text()).slice(0, 200)); } catch (_) {}
    }
  } catch (e) {
    console.error('Analytics fetch erro:', e && e.message);
  }

  // 3) Fallback: contagem arredondada do channels API
  if (baseCount != null) return { count: baseCount, source: 'yt-oauth-channels-rounded' };
  throw new Error('Sem dados do canal');
}

module.exports = {
  startLoginFlow,
  saveTokens,
  loadTokens,
  clearTokens,
  fetchYouTubeWithOAuth
};
