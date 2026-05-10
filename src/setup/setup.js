const SLOTS = [
  { id: 'yt1', label: 'YouTube — Conta 1', platform: 'youtube', cls: 'slot-yt' },
  { id: 'yt2', label: 'YouTube — Conta 2', platform: 'youtube', cls: 'slot-yt' },
  { id: 'ig1', label: 'Instagram — Conta 1', platform: 'instagram', cls: 'slot-ig' },
  { id: 'ig2', label: 'Instagram — Conta 2', platform: 'instagram', cls: 'slot-ig' },
  { id: 'tt1', label: 'TikTok — Conta 1', platform: 'tiktok', cls: 'slot-tt' },
  { id: 'tt2', label: 'TikTok — Conta 2', platform: 'tiktok', cls: 'slot-tt' }
];

const PLACEHOLDERS = {
  youtube: 'UCxtDy586BIg_d9NyFntEwmg ou link do canal',
  instagram: '@usuario  ou  https://instagram.com/usuario',
  tiktok: '@usuario  ou  https://tiktok.com/@usuario'
};

const grid = document.getElementById('grid');
let config = {};

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

function format(n) { return new Intl.NumberFormat('pt-BR').format(n); }

function renderSlot(meta) {
  const data = config[meta.id] || { platform: meta.platform, identifier: '', label: '' };
  data.platform = meta.platform;
  config[meta.id] = data;

  const card = el('div', { class: `slot ${meta.cls}` });
  const status = el('span', { class: `slot-status ${data.identifier ? 'ok' : 'empty'}` }, data.identifier ? 'configurado' : 'vazio');
  const head = el('div', { class: 'slot-h' }, el('h2', {}, meta.label), status);

  const labelField = el('div', { class: 'field' },
    el('label', {}, 'Apelido (aparece na tela cheia)'),
    el('input', { type: 'text', value: data.label || '', placeholder: meta.label,
      oninput: (e) => { data.label = e.target.value; } })
  );

  const idField = el('div', { class: 'field' },
    el('label', {}, meta.platform === 'youtube' ? 'Channel ID (UC...) ou link' : 'Usuário (@) ou link do perfil'),
    el('input', { type: 'text', value: data.identifier || '', placeholder: PLACEHOLDERS[meta.platform],
      oninput: (e) => {
        data.identifier = e.target.value.trim();
        status.className = `slot-status ${data.identifier ? 'ok' : 'empty'}`;
        status.textContent = data.identifier ? 'configurado' : 'vazio';
      } })
  );

  const testResult = el('div', { class: 'test-result' });

  const inputs = card; // captured for clearing
  const studioState = el('div', { class: 'oauth-state' });
  const studioBtn = meta.platform === 'youtube' ? el('button', {
    class: 'primary',
    onclick: async (e) => {
      const btn = e.currentTarget;
      const status = await window.api.studioStatus(meta.id);
      if (status.ok) {
        if (!confirm(`Desconectar Studio (cookies) deste slot (${meta.label})?`)) return;
        await window.api.studioClear(meta.id);
        studioState.textContent = '';
        studioState.className = 'oauth-state';
        btn.textContent = 'Conectar Studio (Chrome)';
        return;
      }
      if (!data.identifier) {
        alert('Preencha o Channel ID antes (campo acima).');
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Importando cookies do Chrome…';
      studioState.className = 'oauth-state info';
      studioState.textContent = 'Lendo Cookies do Chrome (precisa estar logado em studio.youtube.com)…';
      await window.api.saveConfig(config);
      const r = await window.api.studioImport(meta.id);
      btn.disabled = false;
      if (r.ok) {
        studioState.className = 'oauth-state ok';
        const tc = (r.testCount != null)
          ? ` Test = ${format(r.testCount)} inscritos (endpoint: ${r.testAttempt || '?'}, campo: ${r.testHint || '?'}).`
          : '';
        studioState.textContent = `✓ Cookies importados de ${r.browser} (${r.cookieCount}).${tc}`;
        btn.textContent = 'Desconectar Studio (cookies)';
      } else {
        studioState.className = 'oauth-state err';
        studioState.innerHTML = `✗ ${r.error} <a href="#" id="open-debug-${meta.id}" class="link">Abrir pasta de debug</a>`;
        const link = studioState.querySelector(`#open-debug-${meta.id}`);
        if (link) link.addEventListener('click', (ev) => { ev.preventDefault(); window.api.studioOpenDebug(meta.id); });
        btn.textContent = 'Conectar Studio (Chrome)';
      }
    }
  }, 'Conectar Studio (Chrome)') : null;

  const oauthState = el('div', { class: 'oauth-state' });
  const oauthBtn = meta.platform === 'youtube' ? el('button', {
    onclick: async (e) => {
      const btn = e.currentTarget;
      const status = await window.api.oauthStatus(meta.id);
      if (status.ok) {
        if (!confirm(`Desconectar Google deste slot (${meta.label})?`)) return;
        await window.api.oauthLogout(meta.id);
        oauthState.textContent = '';
        oauthState.className = 'oauth-state';
        btn.textContent = 'Conectar Google';
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Aguardando login no Chrome…';
      oauthState.className = 'oauth-state info';
      oauthState.textContent = 'Abra a aba que apareceu no seu navegador e autorize.';
      const r = await window.api.oauthLogin(meta.id);
      btn.disabled = false;
      if (r.ok) {
        oauthState.className = 'oauth-state ok';
        oauthState.textContent = '✓ Google conectado — agora a contagem usa a Analytics API';
        btn.textContent = 'Desconectar Google';
      } else {
        oauthState.className = 'oauth-state err';
        oauthState.textContent = `✗ ${r.error}`;
        btn.textContent = 'Conectar Google';
      }
    }
  }, 'Conectar Google') : null;

  const actions = el('div', { class: 'slot-actions' },
    el('button', {
      onclick: async (e) => {
        const btn = e.currentTarget;
        if (!data.identifier) {
          testResult.className = 'test-result err';
          testResult.textContent = 'Preencha o campo antes de testar.';
          return;
        }
        btn.disabled = true;
        btn.textContent = 'Testando…';
        testResult.className = 'test-result';
        testResult.textContent = '';
        await window.api.saveConfig(config);
        const r = await window.api.testSlot(meta.id);
        if (r.ok) {
          testResult.className = 'test-result ok';
          testResult.textContent = `✓ ${format(r.count)} seguidores  (fonte: ${r.source})`;
        } else {
          testResult.className = 'test-result err';
          testResult.textContent = `✗ ${r.error}`;
        }
        btn.disabled = false;
        btn.textContent = 'Testar';
      }
    }, 'Testar'),
    studioBtn,
    oauthBtn,
    el('button', {
      class: 'danger',
      onclick: async () => {
        if (data.identifier && !confirm(`Limpar este slot (${meta.label})?`)) return;
        data.identifier = '';
        data.label = '';
        const inputEls = inputs.querySelectorAll('input');
        inputEls.forEach(i => { i.value = ''; });
        status.className = 'slot-status empty';
        status.textContent = 'vazio';
        testResult.className = 'test-result';
        testResult.textContent = '';
        if (meta.platform === 'youtube') {
          await window.api.oauthLogout(meta.id);
          await window.api.studioClear(meta.id);
        }
        await window.api.clearSlotState(meta.id);
        await window.api.saveConfig(config);
      }
    }, 'Limpar')
  );

  if (meta.platform === 'youtube') {
    window.api.studioStatus(meta.id).then(s => {
      if (s.ok && studioBtn) {
        studioBtn.textContent = 'Desconectar Studio (cookies)';
        studioState.className = 'oauth-state ok';
        const since = s.savedAt ? ` (importado ${new Date(s.savedAt).toLocaleString('pt-BR')})` : '';
        studioState.textContent = `✓ Studio conectado via cookies do Chrome${since}`;
      }
    });
    window.api.oauthStatus(meta.id).then(s => {
      if (s.ok && oauthBtn) {
        oauthBtn.textContent = 'Desconectar Google';
        oauthState.className = 'oauth-state ok';
        oauthState.textContent = '✓ Google conectado';
      }
    });
  }

  card.appendChild(head);
  card.appendChild(labelField);
  card.appendChild(idField);
  card.appendChild(actions);
  if (studioBtn) card.appendChild(studioState);
  if (oauthBtn) card.appendChild(oauthState);
  card.appendChild(testResult);
  return card;
}

async function init() {
  const stored = await window.api.getConfig();
  config = { ...stored };
  grid.innerHTML = '';
  SLOTS.forEach(s => grid.appendChild(renderSlot(s)));

  // OAuth credentials section
  const oauthCfg = await window.api.oauthGetCfg();
  if (oauthCfg) {
    document.getElementById('oauth-clientid').value = oauthCfg.clientId || '';
    if (oauthCfg.hasSecret) document.getElementById('oauth-secret').placeholder = '••••••••• (salvo)';
  }
  document.getElementById('oauth-save').addEventListener('click', async () => {
    const clientId = document.getElementById('oauth-clientid').value.trim();
    const clientSecret = document.getElementById('oauth-secret').value.trim();
    if (!clientId) { alert('Cole o Client ID antes de salvar.'); return; }
    const r = await window.api.oauthSaveCfg({ clientId, clientSecret });
    if (r.ok) {
      const btn = document.getElementById('oauth-save');
      btn.textContent = 'Salvo ✓';
      setTimeout(() => { btn.textContent = 'Salvar credenciais'; }, 1500);
    } else {
      alert(r.error);
    }
  });
  document.getElementById('oauth-help').addEventListener('click', (e) => {
    e.preventDefault();
    const c = document.getElementById('oauth-help-content');
    c.hidden = !c.hidden;
  });

  document.getElementById('btn-start').addEventListener('click', async () => {
    config.__autoStart = true;
    await window.api.saveConfig(config);
    await window.api.startDisplay(config);
  });

  document.getElementById('btn-clear-all').addEventListener('click', async () => {
    if (!confirm('Apagar a configuração de TODOS os slots? Isso não desfaz.')) return;
    for (const slot of SLOTS) {
      config[slot.id] = { platform: slot.platform, identifier: '', label: '' };
      await window.api.clearSlotState(slot.id);
      if (slot.platform === 'youtube') {
        await window.api.oauthLogout(slot.id);
        await window.api.studioClear(slot.id);
      }
    }
    config.__autoStart = false;
    await window.api.saveConfig(config);
    grid.innerHTML = '';
    SLOTS.forEach(s => grid.appendChild(renderSlot(s)));
  });
}

init();
