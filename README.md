<p align="center">
  <img width=350px, src="./assets/Autonomy.png"/>
  <h1 align="center">Autonomy</h1>
</p>

**Autonomy** is a VS Code extension that intercepts every Claude Code API call in real time, letting you visualize the full context window as an interactive bar chart, delete or edit individual message sections, and optionally hold requests for your approval before they reach Anthropic.

Built for BearHacks 2026.

---

## How it works

```
Claude Code  →  localhost:8080 (FastAPI proxy)  →  api.anthropic.com
                        ↕ WebSocket
               VS Code Extension (Autonomy panel)
```

The proxy sits between Claude Code and Anthropic. Every request is classified into typed sections (system prompt, tool definitions, conversation turns, tool calls/outputs, images, thinking blocks), token-counted, and streamed to the VS Code webview over WebSocket. You can delete or edit sections before they are forwarded. An optional local Gemma model (via Ollama) highlights redundant or low-value content.

---

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | 18+ (LTS recommended) |
| Python | 3.12 or 3.13 |
| VS Code | 1.85+ |
| Ollama *(optional)* | latest — for AI flagging |

---

## Local installation (VS Code)

### 1. Clone the repo

```bash
git clone <repo-url>
cd Bearhacks26
```

### 2. Set up the backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

The defaults work out of the box. If you have a Backboard.io account add those keys; everything else is optional.

```
ANTHROPIC_UPSTREAM_URL=https://api.anthropic.com
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=gemma4:e4b
PROXY_PORT=8080
```

### 3. (Optional) Pull the Gemma model for AI flagging

```bash
ollama pull gemma4:e4b
```

Skip this if you don't have Ollama — the extension works fine without it.

### 4. Build the frontend

```bash
cd ../frontend
npm install
npm run build
```

This produces `frontend/dist/` which the extension serves as a webview.

### 5. Install extension dependencies and compile

```bash
cd ../extensions
npm install
npm run compile
```

### 6. Launch the extension in VS Code

You have two options — pick **A** for quick development or **B** to install Autonomy permanently in your main VS Code.

#### Option A — Run in dev mode (Extension Development Host)

Best for hacking on the code: changes recompile and reload quickly.

1. Open the `extensions/` folder in VS Code:
   ```bash
   code extensions/
   ```
2. Press **F5** (or go to **Run → Start Debugging**).  
   This launches an **Extension Development Host** — a second VS Code window with Autonomy loaded. The extension only exists inside this dev window.

#### Option B — Install globally as a `.vsix` (recommended for daily use)

This packages the extension and installs it into your real VS Code so it's available in every window, every project, every time you launch VS Code.

1. Install the VS Code extension packager (one-time, global):
   ```bash
   npm install -g @vscode/vsce
   ```

2. Build the `.vsix` from the `extensions/` directory:
   ```bash
   cd extensions
   npm run compile
   vsce package --allow-missing-repository
   ```
   This produces `autonomy-0.0.1.vsix` in the `extensions/` folder.

   > If `vsce` complains about `"private": true` in `package.json`, open [extensions/package.json](extensions/package.json) and either remove that line or change it to `"private": false`, then re-run.

3. Install the `.vsix` into VS Code — pick whichever you prefer:

   **Via the CLI:**
   ```bash
   code --install-extension autonomy-0.0.1.vsix
   ```

   **Via the VS Code UI:**
   - Open the **Extensions** sidebar (`Cmd+Shift+X` / `Ctrl+Shift+X`)
   - Click the **`…`** menu in the top-right of the sidebar
   - Choose **`Install from VSIX…`** and pick `autonomy-0.0.1.vsix`

4. Reload VS Code (`Cmd+Shift+P` → **`Developer: Reload Window`**). Autonomy is now installed permanently.

   To upgrade later, rebuild the `.vsix` and re-run `code --install-extension`. To remove it, find **Autonomy** in the Extensions sidebar and click **Uninstall**.

### 7. Open the Autonomy panel

In whichever VS Code window has Autonomy loaded (the Extension Development Host for Option A, or any window for Option B):

- Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
- Run **`Autonomy: Open Panel`**

The panel opens beside your editor and the proxy starts automatically on port 8080.

> **Note for Option B:** the extension still expects the `backend/` and `frontend/dist/` folders to live inside your currently open workspace. If you want Autonomy available across arbitrary projects, set absolute paths in your VS Code user settings — see [Extension settings](#extension-settings) below.

### 8. Point Claude Code at the proxy

In every terminal where you run Claude Code, set:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8080
claude
```

Or add it to your shell profile (`~/.zshrc` / `~/.bashrc`) so it's always active:

```bash
echo 'export ANTHROPIC_BASE_URL=http://localhost:8080' >> ~/.zshrc
source ~/.zshrc
```

---

## Extension settings

All settings live under **`autonomy.*`** in VS Code settings (`Cmd+,`):

| Setting | Default | Description |
|---|---|---|
| `autonomy.proxyPort` | `8080` | Port the FastAPI proxy listens on |
| `autonomy.autoStartProxy` | `true` | Auto-start the proxy when the panel opens |
| `autonomy.backendDir` | *(auto)* | Absolute path to `backend/` — leave blank to auto-detect |
| `autonomy.pythonPath` | *(auto)* | Python interpreter path — defaults to `backend/venv/bin/python` |
| `autonomy.webviewDistDir` | *(auto)* | Path to built React app — defaults to `frontend/dist` |

---

## Running the backend manually (optional)

If you prefer to run the proxy yourself rather than letting the extension manage it:

```bash
cd backend
source venv/bin/activate
uvicorn main:app --host 127.0.0.1 --port 8080 --reload
```

Then in the extension settings set `autonomy.autoStartProxy` to `false`.

---

## Development workflow

### Frontend hot-reload

```bash
cd frontend
npm run dev
```

Open `http://localhost:5173?mock=1` to use the mock harness without a live proxy.

### Recompile the extension

```bash
cd extensions
npm run watch   # auto-recompile on save
```

Then press **Cmd+Shift+F5** in VS Code to reload the Extension Development Host.

### Restart the proxy

Command Palette → **`Autonomy: Restart Backend Proxy`**

---

## Project structure

```
Bearhacks26/
├── backend/          FastAPI proxy — intercepts, classifies, gates requests
│   ├── main.py       App entry point + WebSocket endpoint
│   ├── interceptor.py  POST /v1/messages handler
│   ├── classifier.py   Section classification
│   ├── gating.py       Hold/approve/cancel state machine
│   ├── gemma/          Ollama integration for AI flagging
│   └── backboard/      Optional RAG memory system
├── frontend/         React + Vite webview
│   └── src/
│       ├── App.tsx         Root component
│       ├── components/     BarChart, EditorPanel, StatusBar, …
│       └── hooks/          useWebSocket, useSelection, useUndo
└── extensions/       VS Code extension
    └── src/
        ├── extension.ts        Activation + commands
        ├── proxy-manager.ts    Spawns/kills uvicorn
        ├── webview-provider.ts Serves frontend/dist in a panel
        └── websocket-client.ts Bridges extension ↔ proxy
```

---

## Tech stack

**Backend** — Python 3.12, FastAPI, uvicorn, httpx, tiktoken, websockets, pydantic, Ollama SDK  
**Frontend** — React 19, TypeScript, Vite, Monaco Editor, Recharts, Motion  
**Extension** — VS Code Extension API, TypeScript, ws
