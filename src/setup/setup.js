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
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

function renderSlot(meta) {
  const data = config[meta.id] || { platform: meta.platform, identifier: '', label: '' };
  config[meta.id] = data;

  const card = el('div', { class: `slot ${meta.cls}` });
  const head = el('div', { class: 'slot-h' },
    el('h2', {}, meta.label),
    el('span', { class: `slot-status ${data.identifier ? 'ok' : 'empty'}` }, data.identifier ? 'configurado' : 'vazio')
  );

  const labelField = el('div', { class: 'field' },
    el('label', {}, 'Apelido (opcional)'),
    el('input', {
      type: 'text',
      value: data.label || '',
      placeholder: meta.label,
      oninput: (e) => { data.label = e.target.value; }
    })
  );

  const idField = el('div', { class: 'field' },
    el('label', {}, meta.platform === 'youtube' ? 'Channel ID ou link' : 'Usuário ou link do perfil'),
    el('input', {
      type: 'text',
      value: data.identifier || '',
      placeholder: PLACEHOLDERS[meta.platform],
      oninput: (e) => {
        data.identifier = e.target.value.trim();
        head.querySelector('.slot-status').className = `slot-status ${data.identifier ? 'ok' : 'empty'}`;
        head.querySelector('.slot-status').textContent = data.identifier ? 'configurado' : 'vazio';
      }
    })
  );

  const actions = el('div', { class: 'slot-actions' },
    el('button', {
      onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Abrindo login…';
        try {
          await window.api.loginAccount(meta.id, meta.platform);
          btn.textContent = 'Login feito ✓';
          btn.className = 'success';
        } catch (err) {
          btn.textContent = 'Falhou — tentar de novo';
        } finally {
          btn.disabled = false;
        }
      }
    }, `Abrir login (${meta.platform})`),
    el('button', {
      class: 'danger',
      onclick: async (e) => {
        if (!confirm(`Apagar a sessão deste slot (${meta.label})?`)) return;
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Limpando…';
        await window.api.logoutAccount(meta.id);
        btn.textContent = 'Sessão apagada';
        setTimeout(() => { btn.textContent = 'Sair / Limpar sessão'; btn.disabled = false; }, 1500);
      }
    }, 'Sair / Limpar sessão')
  );

  card.appendChild(head);
  card.appendChild(labelField);
  card.appendChild(idField);
  card.appendChild(actions);
  return card;
}

async function init() {
  const stored = await window.api.getConfig();
  config = { ...stored };
  grid.innerHTML = '';
  SLOTS.forEach(s => grid.appendChild(renderSlot(s)));

  document.getElementById('btn-start').addEventListener('click', async () => {
    for (const slot of SLOTS) {
      const data = config[slot.id];
      if (data) data.platform = slot.platform;
    }
    config.__autoStart = true;
    await window.api.saveConfig(config);
    await window.api.startDisplay(config);
  });
}

init();
