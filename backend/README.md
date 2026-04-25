# ContextLens — Backend Proxy

FastAPI proxy on `http://localhost:8080` that intercepts Claude Code's `POST /v1/messages` calls, classifies the messages array into sections, counts tokens, optionally holds for user approval, then forwards to Anthropic and streams the SSE response back. Pushes section data and Gemma flags over WebSocket to the VS Code extension.

See [../BACKEND_PLAN.md](../BACKEND_PLAN.md) for the full spec and [../contextlens-prd.md](../contextlens-prd.md) for the PRD.

## Prerequisites

- **Python 3.12 or 3.13.** `tiktoken` does not yet ship wheels for Python 3.14, so the venv must be on 3.12/3.13. The repo's existing `backend/venv` was built with 3.12.
- **(Optional) Ollama + `gemma4:e4b` model** for redundancy flagging. The proxy starts and works without it — Gemma flags simply never arrive.
- An Anthropic API key in your environment (`ANTHROPIC_API_KEY`) or set up inside Claude Code. The proxy never reads the key — it forwards whatever Claude Code sends in the `x-api-key` / `Authorization` headers.

## Setup

From the repo root:

```bash
cd backend

# (Only if you need to recreate the venv)
rm -rf venv
python3.12 -m venv venv

source venv/bin/activate
pip install -r requirements.txt

cp .env.example .env   # defaults are fine; edit if you want a custom port
```

## Run

```bash
cd backend
source venv/bin/activate
uvicorn main:app --host 127.0.0.1 --port 8080 --reload
```

Startup log will say `gemma_available=True` or `gemma_available=False`. Either is fine.

## Point Claude Code at the proxy

Either of:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8080
claude
```

…or in VS Code `settings.json`:

```json
{
  "claudeCode.environmentVariables": [
    { "name": "ANTHROPIC_BASE_URL", "value": "http://localhost:8080" }
  ]
}
```

## Verification

### 1. Direct request through the proxy (no extension)

```bash
curl -N -X POST http://localhost:8080/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":100,"messages":[{"role":"user","content":"say hi"}]}'
```

You should see a normal SSE stream of Claude's response.

### 2. WebSocket section data

```bash
brew install websocat   # if not installed
websocat ws://localhost:8080/ws
```

Then re-run the curl from step 1. You should see a `new_request` JSON message arrive in `websocat` before the SSE stream starts.

### 3. Hold-and-approve flow

In `websocat`:

```json
{"type":"mode_change","mode":"ask_permission"}
```

Run the curl from step 1 again — it will hang. In `websocat`, copy the `requestId` from the `new_request` payload and send:

```json
{"type":"approve","requestId":"<paste-id-here>"}
```

The curl should then complete.

### 4. Gemma flags (optional)

With Ollama running and `gemma4:e4b` pulled, you should see a `gemma_flags` message ~2–8s after `new_request`. With Ollama stopped, the proxy still works — only the startup warning is logged.

## Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_UPSTREAM_URL` | `https://api.anthropic.com` | Where to forward `/v1/messages` and other paths |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama HTTP endpoint |
| `OLLAMA_MODEL` | `gemma4:e4b` | Model tag used for flagging and suggestions |
| `PROXY_PORT` | `8080` | Documented for the launcher; uvicorn is invoked with `--port` directly |
| `LOG_LEVEL` | `INFO` | Standard Python logging level |
