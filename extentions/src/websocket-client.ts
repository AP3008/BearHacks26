import * as vscode from "vscode";
import WebSocket from "ws";

// Bridges the FastAPI proxy WebSocket (ws://localhost:<port>/ws) and the
// React webview's postMessage channel. Each direction is a verbatim JSON pass-
// through — the contracts in PRD §9 are owned by the proxy and the React app.
export class WebSocketBridge implements vscode.Disposable {
  private ws: WebSocket | null = null;
  private webview: vscode.Webview | null = null;
  private webviewSub: vscode.Disposable | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private readonly port: number,
    private readonly output: vscode.OutputChannel,
  ) {
    this.connect();
  }

  attachWebview(webview: vscode.Webview) {
    if (this.webview === webview) return;
    this.webviewSub?.dispose();
    this.webview = webview;
    this.webviewSub = webview.onDidReceiveMessage((msg) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(msg));
      } else {
        this.output.appendLine("[ws] dropped outbound: socket not open");
      }
    });
    // Force a fresh snapshot on attach. If the WS is already open, the proxy
    // only auto-snapshots on the connect handshake — without this, opening
    // the panel a second time leaves the chart blank until the next API call.
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.cycleConnection("re-attach: requesting fresh snapshot");
    }
  }

  detachWebview() {
    this.webviewSub?.dispose();
    this.webviewSub = null;
    this.webview = null;
  }

  private cycleConnection(reason: string) {
    this.output.appendLine(`[ws] cycling: ${reason}`);
    try {
      this.ws?.close();
    } catch {
      // already closed
    }
    // The "close" handler will schedule a reconnect.
  }

  private connect() {
    if (this.disposed) return;
    const url = `ws://127.0.0.1:${this.port}/ws`;
    this.output.appendLine(`[ws] connecting to ${url}`);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => this.output.appendLine("[ws] open"));
    ws.on("message", (raw) => {
      const text = raw.toString();
      try {
        const data = JSON.parse(text);
        this.webview?.postMessage(data);
      } catch {
        this.output.appendLine(`[ws] non-JSON message: ${text.slice(0, 120)}`);
      }
    });
    ws.on("close", () => {
      this.output.appendLine("[ws] closed");
      this.scheduleReconnect();
    });
    ws.on("error", (err) => {
      this.output.appendLine(`[ws] error: ${err.message}`);
    });
  }

  private scheduleReconnect() {
    if (this.disposed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1500);
  }

  dispose() {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.webviewSub?.dispose();
    this.ws?.close();
    this.ws = null;
  }
}
