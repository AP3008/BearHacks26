# Autonomy

Autonomy gives Claude Code a live context control panel inside VS Code.

It runs a local proxy between Claude Code and Anthropic, visualizes each request as token-sized sections, and lets you inspect, delete, edit, or approve context before it is sent upstream.

## What It Does

- Visualizes Claude Code's active context window as an interactive bar chart.
- Breaks requests into system prompts, tool definitions, user messages, assistant replies, tool calls, tool outputs, images, and thinking blocks.
- Shows live token and estimated cost totals for the current request.
- Lets you delete sections from the request context.
- Lets you edit text sections in a Monaco-powered editor.
- Supports an approval mode so requests wait for your review before reaching Anthropic.
- Supports a one-shot pause mode that holds only the next top-level prompt.
- Bridges to an optional local Gemma model through Ollama for smart redundancy and low-value-context flagging.
- Automatically starts and stops the local FastAPI proxy when the panel opens and VS Code shuts down.

## How It Works

```text
Claude Code -> http://localhost:8080 -> Autonomy FastAPI proxy -> Anthropic
                         |
                         v
                VS Code webview panel
```

Claude Code sends Anthropic API traffic to the local proxy by using `ANTHROPIC_BASE_URL=http://localhost:8080`. The proxy classifies and token-counts the request, sends a structured snapshot to the VS Code extension over WebSocket, then either forwards the request immediately or waits for approval depending on the selected mode.

## Requirements

- VS Code 1.85 or newer
- Node.js 18 or newer
- Python 3.12 or 3.13
- Claude Code
- Optional: Ollama with `gemma4:e4b` for smart flagging

## Setup

From the repository root, install and build each part:

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

cd ../frontend
npm install
npm run build

cd ../extensions
npm install
npm run compile
```

Then open the Command Palette and run:

```text
Autonomy: Open Panel
```

By default, opening the panel starts the backend proxy on port `8080`.

When installed from a packaged VSIX, Autonomy uses the bundled backend and webview files, so it works from any VS Code workspace. On first launch it creates a Python virtual environment in VS Code's extension storage and installs the bundled backend requirements there.

## Point Claude Code At Autonomy

In the terminal where you run Claude Code:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8080
claude
```

You can also configure this through Claude Code's VS Code settings:

```json
{
  "claudeCode.environmentVariables": [
    { "name": "ANTHROPIC_BASE_URL", "value": "http://localhost:8080" }
  ]
}
```

## Commands

| Command | Description |
| --- | --- |
| `Autonomy: Open Panel` | Opens the Autonomy context panel and starts the proxy if auto-start is enabled. |
| `Autonomy: Restart Backend Proxy` | Stops and restarts the local FastAPI proxy. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `autonomy.proxyPort` | `8080` | Port used by the local FastAPI proxy. |
| `autonomy.autoStartProxy` | `true` | Start the proxy automatically when the panel opens. |
| `autonomy.backendDir` | bundled backend | Absolute path to a development `backend/` override. |
| `autonomy.pythonPath` | auto-detect | Python interpreter used to run `uvicorn`. |
| `autonomy.webviewDistDir` | bundled webview | Absolute path to a development React build override. |

## Modes

**Auto-send** forwards Claude Code requests immediately while still showing the latest context in the panel. Deletions and edits are committed to the proxy's canonical context as you make them.

**Ask permission** holds each main Claude Code request until you click **Send**. Any deletions or edits you make before sending are applied to that request.

**Pause** holds only the next top-level prompt, then returns to the previous behavior.

## Optional Gemma Flagging

Autonomy works without Ollama. If Ollama and the configured Gemma model are available, the panel can flag redundant or low-value sections and show suggested replacements in the editor.

```bash
ollama pull gemma4:e4b
```

The backend reads these optional environment variables:

| Variable | Default |
| --- | --- |
| `OLLAMA_HOST` | `http://localhost:11434` |
| `OLLAMA_MODEL` | `gemma4:e4b` |

## Troubleshooting

If the panel opens but shows no request, confirm Claude Code is running with:

```bash
echo $ANTHROPIC_BASE_URL
```

It should print `http://localhost:8080`.

If the proxy fails to start, open the **Autonomy** output channel in VS Code and check the backend logs. The most common causes are missing Python dependencies, the wrong `backend/` path, or port `8080` already being in use.

If the webview cannot load, rebuild the frontend with `npm run build` in `frontend/`, or set `autonomy.webviewDistDir` to the absolute path of `frontend/dist`.
