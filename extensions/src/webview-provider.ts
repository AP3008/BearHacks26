import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

// Loads the Vite-built React app (frontend/dist) into a WebviewPanel. We
// rewrite asset paths via webview.asWebviewUri() and inject a CSP nonce so
// Vite's emitted <script> survives VS Code's strict webview security model.
export class WebviewProvider {
  private panel: vscode.WebviewPanel | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {}

  show(): vscode.WebviewPanel {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return this.panel;
    }

    const distDir = this.resolveDistDir();
    if (!distDir) {
      throw new Error(
        "Autonomy: could not find frontend/dist. Run `npm run build` in frontend/ " +
          "or set autonomy.webviewDistDir.",
      );
    }

    this.panel = vscode.window.createWebviewPanel(
      "autonomy",
      "Autonomy",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(distDir)],
      },
    );

    this.panel.webview.html = this.renderHtml(this.panel.webview, distDir);
    this.panel.onDidDispose(() => {
      this.panel = null;
    });

    return this.panel;
  }

  private resolveDistDir(): string | null {
    const cfg = vscode.workspace.getConfiguration("autonomy");
    const explicit = cfg.get<string>("webviewDistDir");
    if (explicit && fs.existsSync(path.join(explicit, "index.html"))) return explicit;

    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspace) {
      const guess = path.join(workspace, "frontend", "dist");
      if (fs.existsSync(path.join(guess, "index.html"))) return guess;
    }
    return null;
  }

  private renderHtml(webview: vscode.Webview, distDir: string): string {
    const indexPath = path.join(distDir, "index.html");
    let html = fs.readFileSync(indexPath, "utf8");

    // Vite emits absolute root-relative paths like "/assets/foo.js" by default.
    // We told Vite to use base="./" so those become "./assets/...". Either way,
    // rewrite every src/href that points into the dist directory through
    // asWebviewUri so the webview can fetch them.
    html = html.replace(
      /(src|href)="(\.\/|\/)?(assets\/[^"]+|[^"]+\.(?:js|css|svg|png|ico|woff2?))"/g,
      (_match, attr, _prefix, asset) => {
        const onDisk = vscode.Uri.file(path.join(distDir, asset));
        return `${attr}="${webview.asWebviewUri(onDisk)}"`;
      },
    );

    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net`,
      `font-src ${webview.cspSource} https://fonts.gstatic.com https://cdn.jsdelivr.net data:`,
      `script-src 'nonce-${nonce}' https://cdn.jsdelivr.net`,
      `connect-src ${webview.cspSource} https://cdn.jsdelivr.net`,
      `worker-src ${webview.cspSource} blob:`,
    ].join("; ");

    // Add nonce to every <script> tag Vite emitted.
    html = html.replace(/<script /g, `<script nonce="${nonce}" `);

    // Inject the CSP meta as the first child of <head>.
    html = html.replace(
      /<head>/,
      `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`,
    );

    return html;
  }
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
