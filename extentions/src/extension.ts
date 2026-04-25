import * as vscode from "vscode";
import { ProxyManager } from "./proxy-manager";
import { WebviewProvider } from "./webview-provider";
import { WebSocketBridge } from "./websocket-client";

let proxyManager: ProxyManager | null = null;
let bridge: WebSocketBridge | null = null;
let provider: WebviewProvider | null = null;
let output: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("ContextLens");
  context.subscriptions.push(output);

  proxyManager = new ProxyManager(output);
  provider = new WebviewProvider(context, output);

  const openCmd = vscode.commands.registerCommand("contextlens.open", async () => {
    const port = vscode.workspace
      .getConfiguration("contextlens")
      .get<number>("proxyPort", 8080);

    const autoStart = vscode.workspace
      .getConfiguration("contextlens")
      .get<boolean>("autoStartProxy", true);

    if (autoStart && proxyManager && !proxyManager.running) {
      try {
        await proxyManager.start(port);
      } catch (err) {
        vscode.window.showErrorMessage(
          `ContextLens: failed to start proxy — ${(err as Error).message}. ` +
            `You can disable auto-start in Settings and run uvicorn yourself.`,
        );
      }
    }

    const panel = provider!.show();

    if (!bridge) {
      bridge = new WebSocketBridge(port, output);
      context.subscriptions.push(bridge);
    }
    bridge.attachWebview(panel.webview);
  });

  const restartCmd = vscode.commands.registerCommand(
    "contextlens.restartProxy",
    async () => {
      if (!proxyManager) return;
      const port = vscode.workspace
        .getConfiguration("contextlens")
        .get<number>("proxyPort", 8080);
      await proxyManager.stop();
      await proxyManager.start(port);
      vscode.window.showInformationMessage("ContextLens: proxy restarted.");
    },
  );

  context.subscriptions.push(openCmd, restartCmd);
}

export async function deactivate() {
  await bridge?.dispose();
  await proxyManager?.stop();
}
