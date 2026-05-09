# Seguidores em Tempo Real

App desktop (Windows) que mostra a soma de seguidores de **2 contas YouTube + 2 Instagram + 2 TikTok** em tela cheia, atualizando em tempo real, e impede o computador de entrar em modo de espera/suspensão enquanto está aberto.

> Os dados do YouTube vêm direto do **YouTube Studio Analytics** (subscribers exato em tempo real). Instagram e TikTok são lidos das páginas de perfil das contas em que você logar.

---

## Como gerar o `.exe` para instalar no seu Nitro 5

Pré-requisito: **[Node.js 18+](https://nodejs.org/)** instalado no seu Windows (ou Mac/Linux para fazer o build).

```bash
# 1. Instalar dependências
npm install

# 2. Rodar em modo dev (testar antes do build)
npm start

# 3. Gerar o instalador .exe (NSIS) e a versão portable
npm run build
```

Depois do build, os instaladores estarão em **`dist/`**:

- `Seguidores Tempo Real Setup 1.0.0.exe` — instalador (cria atalho no menu iniciar e na área de trabalho)
- `Seguidores Tempo Real 1.0.0.exe` — versão portátil (não precisa instalar; só rodar)

> Se quiser apenas a portátil: `npm run build:portable`.

### Build a partir do Linux/Mac também funciona

`electron-builder` faz cross-compile do `.exe` a partir de qualquer SO desktop. Se preferir buildar no próprio Nitro 5 (Windows), instale o Node, baixe este repositório e rode os mesmos comandos.

---

## Como usar

1. Abra o app pela primeira vez → abre a tela de **Configuração**.
2. Para cada um dos 6 slots:
   - Cole o **Channel ID do YouTube** (`UCxtDy586BIg_d9NyFntEwmg`) ou link do canal.
   - Para Instagram/TikTok: digite `@usuario` ou cole o link do perfil.
   - Clique em **"Abrir login"** → abre uma janela do navegador da plataforma → faça login normalmente.
3. Repita para as 6 contas (cada slot tem **sessão isolada**, então YT 1 e YT 2 podem ser contas diferentes).
4. Clique em **"Iniciar contagem em tela cheia"**.

A janela vai para fullscreen mostrando:

```
SEGUIDORES EM TEMPO REAL
       1.234.567
       +124 desde o início
   [YT 1]  [YT 2]  [IG 1]  [IG 2]  [TT 1]  [TT 2]
```

### Atalhos

| Tecla | Ação |
|-------|------|
| `Esc` | Voltar para a tela de configuração |
| `F11` | Alternar fullscreen |
| `Ctrl+Q` | Sair do app |
| Mouse no rodapé | Mostra os botões "Config" e "Sair" |

### Modo "não dormir"

Enquanto o app estiver aberto, ele liga o `powerSaveBlocker` do Electron com a flag `prevent-display-sleep`. O Windows não vai apagar a tela nem suspender o sistema. Quando você fechar o app, o comportamento volta ao normal.

---

## Modelo de segurança

Você pediu para pensar na segurança porque vai logar suas redes sociais. Aqui está exatamente o que o app faz e **não faz**:

### O que o app faz

- **Roda 100% local.** Não tem servidor próprio, não envia nada para a internet além das requisições que você faria normalmente abrindo `youtube.com`, `instagram.com` e `tiktok.com` num navegador.
- **Login direto nas plataformas.** Quando você clica em "Abrir login", o app abre uma `BrowserWindow` apontando para a URL oficial de login (`accounts.google.com`, `instagram.com/accounts/login`, `tiktok.com/login`). Sua senha vai por **HTTPS direto para a plataforma** — nem o renderer do app, nem o preload, nem o main process têm acesso a ela.
- **Sessões isoladas por slot.** Cada um dos 6 slots usa uma `partition` separada do Electron (`persist:yt1`, `persist:yt2`, etc.). Cookies de um slot **não enxergam** os outros — você pode logar 2 contas YouTube diferentes sem conflito, e elas não podem se ver entre si.
- **Cookies criptografados pelo SO.** O Chromium (que o Electron usa) salva cookies criptografados usando **DPAPI no Windows**, atrelados ao seu usuário do Windows. Outro usuário do mesmo PC não consegue ler.
- **Botão "Sair / Limpar sessão"** em cada slot na tela de configuração — apaga cookies, cache de auth e cache local daquele slot.

### Hardening aplicado no código

- `contextIsolation: true` em todas as janelas (renderer não tem acesso direto a `require`/Node).
- `nodeIntegration: false` em todas as janelas.
- `sandbox: true` nas BrowserViews que carregam YouTube/IG/TikTok e nas janelas de login (mesmo se um site fosse comprometido, ele não escapa do sandbox do Chromium).
- `webSecurity: true`, `allowRunningInsecureContent: false`, `experimentalFeatures: false`.
- **Allowlist de domínios por plataforma**: o `BrowserView` de Instagram só aceita navegação para domínios `instagram.com`/`facebook.com`, o do YouTube só para `youtube.com`/`google.com`/CDN do YT, etc. Qualquer redirect ou popup para domínio fora da lista é **bloqueado** em `will-navigate`/`will-redirect`/`setWindowOpenHandler`.
- **Permissões negadas por padrão**: câmera, microfone, geolocalização, notificações, MIDI, USB, downloads — tudo bloqueado nas sessões do app.
- **Content-Security-Policy estrita** nos arquivos HTML locais: `default-src 'self'; connect-src 'none'; object-src 'none'; frame-ancestors 'none'`. Os HTMLs locais não conseguem fazer fetch para domínios externos nem carregar scripts de terceiros.
- **Validação de IPC**: todos os handlers IPC validam `slotId` contra a lista fixa de slots e `platform` contra a allowlist `[youtube, instagram, tiktok]`.
- **Sem DevTools em produção** (são bloqueados — só ligam com `npm run dev`).
- **`will-attach-webview`** sobrescreve qualquer tentativa de criar um `<webview>` com configurações inseguras.

### Quais dados ficam no PC

Em `%APPDATA%/seguidores-tempo-real/`:
- `accounts.json` — apelido + identificador público (channel ID / @username) das contas. **Não contém senhas nem tokens.**
- `Partitions/yt1/`, `Partitions/yt2/`, ... — diretórios do Chromium com cookies (criptografados), localStorage e cache de cada sessão.

### O que o app **não** faz

- Não tem analytics, telemetria, crash reporting, "phone home". Você pode bloquear no firewall qualquer conexão que não seja `*.youtube.com`, `*.google.com`, `*.instagram.com`, `*.facebook.com`, `*.tiktok.com` e ainda assim ele funciona.
- Não roda código baixado em runtime (sem auto-update injetado).
- Não toca em outros arquivos do seu PC fora de `%APPDATA%/seguidores-tempo-real/`.

### Recomendações de uso seguro

1. **Use senhas únicas** e **2FA** nas contas (boa prática geral, independente do app).
2. Se o notebook for compartilhado, **trave a sessão do Windows** quando se afastar — o login do app está atrelado ao seu usuário do Windows, mas alguém na sua sessão consegue abrir o app.
3. Antes de **descartar/vender o notebook**, abra o app, clique em "Sair / Limpar sessão" em cada slot, ou apague a pasta `%APPDATA%/seguidores-tempo-real/`.
4. **Não use em PCs com malware**. Nenhum app é mais seguro que o sistema operacional onde roda.
5. O código é todo aberto neste repositório — você (ou alguém de confiança) pode auditar `main.js`, `preload.js` e os arquivos em `src/`.

---

## Limitações conhecidas

- **Frequência de atualização real**:
  - **YouTube Studio**: a página fica aberta em background e o número é lido do DOM a cada 5s. Quando o YT Studio atualiza o subscriber count internamente, o app pega na próxima leitura → pode parecer "tempo real" porque o Studio é ativo.
  - **Instagram/TikTok**: o app recarrega a página de perfil a cada **60s** (não 5s). Se eu pedisse a cada 5s, IG e TT bloqueariam a sessão. Os 5s da tela só atualizam o display animado — o número novo só chega quando a página recarrega.
- **Selectors podem mudar**: YouTube Studio, Instagram e TikTok mudam o HTML/CSS de tempos em tempos. Os scrapers em `main.js` (`SCRAPE_SCRIPTS`) tentam vários seletores e fallback por regex. Se algum dia parar de pegar o número, abre uma issue ou edita os seletores.
- **Selo de "fabricante desconhecido" do Windows SmartScreen**: o `.exe` não está assinado com certificado de code-signing. Na primeira execução o Windows pode pedir confirmação ("mais informações" → "executar assim mesmo"). Para remover esse aviso seria preciso comprar um certificado EV (~$300/ano).

---

## Estrutura do projeto

```
/
├── package.json          # Configuração Electron + electron-builder
├── main.js               # Processo principal (Electron, scrapers, segurança)
├── preload.js            # Bridge IPC seguro (contextBridge)
├── src/
│   ├── setup/            # Tela de configuração das contas
│   │   ├── setup.html
│   │   ├── setup.css
│   │   └── setup.js
│   └── display/          # Tela fullscreen do contador
│       ├── display.html
│       ├── display.css
│       └── display.js
└── README.md
```

---

## Stack

- [Electron 32](https://www.electronjs.org/) (Chromium + Node.js)
- [electron-builder 25](https://www.electron.build/) (gera `.exe` NSIS + portable)
- HTML/CSS/JS puro no renderer (sem framework, sem build step)
