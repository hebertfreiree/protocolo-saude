// =============================================================================
// chrome-cookies.js
// Lê e descriptografa cookies do Chrome no Windows.
//
// Como o Chrome v80+ guarda cookies no Windows:
//   - Local State (JSON) -> contém master key encriptada com DPAPI do usuário
//   - Cookies (SQLite)  -> cada cookie tem encrypted_value que é AES-256-GCM
//                          encriptado com a master key (12 bytes IV + ct + 16 tag,
//                          prefixo "v10" ou "v11")
//
// Tudo roda 100% local na máquina do usuário com o seu próprio acesso DPAPI.
// =============================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

function chromeUserDataDir() {
  // %LOCALAPPDATA%\Google\Chrome\User Data
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error('LOCALAPPDATA não disponível (rodando fora do Windows?)');
  return path.join(localAppData, 'Google', 'Chrome', 'User Data');
}

function edgeUserDataDir() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return null;
  return path.join(localAppData, 'Microsoft', 'Edge', 'User Data');
}

function dpapiDecryptViaPowerShell(encryptedBuf) {
  // Escreve o buffer encriptado em arquivo temp, chama PowerShell pra desencriptar,
  // lê o resultado. Evita escapes complicados de base64/stdin.
  const tmpDir = os.tmpdir();
  const inFile = path.join(tmpDir, `dpapi-in-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  const outFile = path.join(tmpDir, `dpapi-out-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  fs.writeFileSync(inFile, encryptedBuf);

  const ps = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$inp = [System.IO.File]::ReadAllBytes($args[0])
$out = [System.Security.Cryptography.ProtectedData]::Unprotect($inp,$null,'CurrentUser')
[System.IO.File]::WriteAllBytes($args[1],$out)
`;

  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps, inFile, outFile],
      { windowsHide: true, timeout: 15000 },
      (err, stdout, stderr) => {
        try { fs.unlinkSync(inFile); } catch (_) {}
        if (err) {
          try { fs.unlinkSync(outFile); } catch (_) {}
          return reject(new Error(`DPAPI falhou: ${stderr || err.message}`));
        }
        try {
          const buf = fs.readFileSync(outFile);
          fs.unlinkSync(outFile);
          resolve(buf);
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

async function readMasterKey(userDataDir) {
  const localStatePath = path.join(userDataDir, 'Local State');
  if (!fs.existsSync(localStatePath)) {
    throw new Error(`Arquivo "Local State" do Chrome não encontrado em ${localStatePath}`);
  }
  const raw = fs.readFileSync(localStatePath, 'utf-8');
  const json = JSON.parse(raw);
  const encB64 = json && json.os_crypt && json.os_crypt.encrypted_key;
  if (!encB64) throw new Error('Master key não encontrada no Local State');
  const enc = Buffer.from(encB64, 'base64');
  // Strip "DPAPI" magic prefix (5 bytes)
  if (enc.slice(0, 5).toString('ascii') !== 'DPAPI') {
    throw new Error('Formato de master key inesperado (sem prefixo DPAPI)');
  }
  const dpapiBlob = enc.slice(5);
  const masterKey = await dpapiDecryptViaPowerShell(dpapiBlob);
  if (masterKey.length !== 32) {
    throw new Error(`Master key com tamanho inesperado (${masterKey.length} bytes; esperado 32)`);
  }
  return masterKey;
}

function decryptCookieValue(encryptedValue, masterKey) {
  if (!encryptedValue || encryptedValue.length === 0) return '';
  const prefix = encryptedValue.slice(0, 3).toString('ascii');
  if (prefix !== 'v10' && prefix !== 'v11') {
    // Cookie no formato antigo (DPAPI direto) — pula
    return null;
  }
  if (encryptedValue.length < 3 + 12 + 16) return null;
  const iv = encryptedValue.slice(3, 15);
  const ciphertext = encryptedValue.slice(15, encryptedValue.length - 16);
  const tag = encryptedValue.slice(encryptedValue.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  // Chrome v24+ adiciona 32 bytes de SHA-256(host_key) no começo do plaintext
  // pra cookies "app-bound encrypted". Se não bater, o valor é direto.
  // Heurística: se os primeiros 32 bytes não forem ASCII, descartar.
  if (out.length > 32) {
    let printableHead = true;
    for (let i = 0; i < 32; i++) {
      const c = out[i];
      if (c < 0x20 || c > 0x7e) { printableHead = false; break; }
    }
    if (!printableHead) {
      return out.slice(32).toString('utf-8');
    }
  }
  return out.toString('utf-8');
}

let _SQL = null;
async function getSql() {
  if (_SQL) return _SQL;
  const initSqlJs = require('sql.js');
  // Localiza o .wasm desempacotado pelo electron-builder (asarUnpack)
  let wasmDir = null;
  const candidates = [
    path.join(__dirname, 'node_modules', 'sql.js', 'dist'),
    path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules', 'sql.js', 'dist'),
    path.join(process.resourcesPath || '', 'app', 'node_modules', 'sql.js', 'dist')
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'sql-wasm.wasm'))) { wasmDir = c; break; }
  }
  _SQL = await initSqlJs({
    locateFile: (f) => wasmDir ? path.join(wasmDir, f) : f
  });
  return _SQL;
}

async function readCookiesDb(cookiesPath, masterKey, hostFilter) {
  const SQL = await getSql();
  // Copia o DB pra evitar lock se o Chrome estiver aberto
  const tmpDb = path.join(os.tmpdir(), `cookies-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  fs.copyFileSync(cookiesPath, tmpDb);
  try {
    const data = fs.readFileSync(tmpDb);
    const db = new SQL.Database(new Uint8Array(data));
    // Schema do Chrome: tabela "cookies" com colunas
    //   host_key, name, encrypted_value, path, expires_utc, is_secure, is_httponly, ...
    const stmt = db.prepare(
      `SELECT host_key, name, encrypted_value, path, expires_utc, is_secure, is_httponly
       FROM cookies WHERE ${hostFilter}`
    );
    const cookies = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      let encVal = row.encrypted_value;
      // sql.js retorna BLOB como Uint8Array
      if (encVal instanceof Uint8Array) encVal = Buffer.from(encVal);
      else if (typeof encVal === 'string') encVal = Buffer.from(encVal, 'binary');
      try {
        const decrypted = decryptCookieValue(encVal, masterKey);
        if (decrypted !== null && decrypted !== '') {
          cookies.push({
            host: row.host_key,
            name: row.name,
            value: decrypted,
            path: row.path,
            secure: !!row.is_secure,
            httpOnly: !!row.is_httponly,
            expiresUtc: Number(row.expires_utc) || 0
          });
        }
      } catch (e) {
        // skip cookies que não conseguimos descriptografar
      }
    }
    stmt.free();
    db.close();
    return cookies;
  } finally {
    try { fs.unlinkSync(tmpDb); } catch (_) {}
  }
}

async function readBrowserCookiesForYouTube() {
  const errors = [];
  // 1) Tenta Chrome primeiro
  try {
    const dir = chromeUserDataDir();
    const masterKey = await readMasterKey(dir);
    // Chrome 96+ usa Default/Network/Cookies. Versões antigas usam Default/Cookies.
    const candidates = [
      path.join(dir, 'Default', 'Network', 'Cookies'),
      path.join(dir, 'Default', 'Cookies')
    ];
    let cookiesPath = candidates.find(p => fs.existsSync(p));
    if (!cookiesPath) throw new Error('Arquivo Cookies do Chrome não encontrado');
    const hostFilter = `host_key='.youtube.com' OR host_key='.google.com' OR host_key='accounts.google.com' OR host_key='studio.youtube.com' OR host_key LIKE '%.youtube.com' OR host_key LIKE '%.google.com'`;
    const cookies = await readCookiesDb(cookiesPath, masterKey, hostFilter);
    if (cookies.length === 0) throw new Error('Nenhum cookie do YouTube encontrado no Chrome (faça login em studio.youtube.com primeiro)');
    return { browser: 'chrome', cookies };
  } catch (e) {
    errors.push(`Chrome: ${e.message}`);
  }
  // 2) Tenta Edge como fallback (também é Chromium)
  try {
    const dir = edgeUserDataDir();
    if (!dir) throw new Error('Edge não disponível');
    const masterKey = await readMasterKey(dir);
    const candidates = [
      path.join(dir, 'Default', 'Network', 'Cookies'),
      path.join(dir, 'Default', 'Cookies')
    ];
    let cookiesPath = candidates.find(p => fs.existsSync(p));
    if (!cookiesPath) throw new Error('Arquivo Cookies do Edge não encontrado');
    const hostFilter = `host_key='.youtube.com' OR host_key='.google.com' OR host_key='accounts.google.com' OR host_key='studio.youtube.com' OR host_key LIKE '%.youtube.com' OR host_key LIKE '%.google.com'`;
    const cookies = await readCookiesDb(cookiesPath, masterKey, hostFilter);
    if (cookies.length === 0) throw new Error('Nenhum cookie do YouTube encontrado no Edge');
    return { browser: 'edge', cookies };
  } catch (e) {
    errors.push(`Edge: ${e.message}`);
  }
  throw new Error(`Não consegui ler cookies (${errors.join(' | ')})`);
}

module.exports = {
  readBrowserCookiesForYouTube,
  // exportados pra teste:
  decryptCookieValue
};
