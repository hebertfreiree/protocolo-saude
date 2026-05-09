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
    }, 'Testar')
  );

  card.appendChild(head);
  card.appendChild(labelField);
  card.appendChild(idField);
  card.appendChild(actions);
  card.appendChild(testResult);
  return card;
}

async function init() {
  const stored = await window.api.getConfig();
  config = { ...stored };
  grid.innerHTML = '';
  SLOTS.forEach(s => grid.appendChild(renderSlot(s)));

  document.getElementById('btn-start').addEventListener('click', async () => {
    config.__autoStart = true;
    await window.api.saveConfig(config);
    await window.api.startDisplay(config);
  });
}

init();
