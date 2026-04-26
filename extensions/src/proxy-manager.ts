import * as vscode from "vscode";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as net from "net";

export class ProxyManager {
  private proc: ChildProcessWithoutNullStreams | null = null;

  constructor(private readonly output: vscode.OutputChannel) {}

  get running(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  async start(port: number): Promise<void> {
    if (this.running) return;

    const cfg = vscode.workspace.getConfiguration("autonomy");
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspace) {
      throw new Error("Autonomy needs an open workspace folder.");
    }

    const backendDir =
      cfg.get<string>("backendDir") || path.join(workspace, "backend");
    if (!fs.existsSync(path.join(backendDir, "main.py"))) {
      throw new Error(`backend/main.py not found in ${backendDir}.`);
    }

    const venvPython = path.join(backendDir, "venv", "bin", "python");
    const python =
      cfg.get<string>("pythonPath") ||
      (fs.existsSync(venvPython) ? venvPython : "python3");

    this.output.appendLine(
      `[proxy] starting: ${python} -m uvicorn main:app --port ${port} (cwd=${backendDir})`,
    );

    this.proc = spawn(
      python,
      ["-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", String(port)],
      { cwd: backendDir },
    );

    this.proc.stdout.on("data", (b) => this.output.append(`[proxy] ${b}`));
    this.proc.stderr.on("data", (b) => this.output.append(`[proxy] ${b}`));
    this.proc.on("exit", (code, signal) => {
      this.output.appendLine(`[proxy] exited code=${code} signal=${signal}`);
      this.proc = null;
    });

    await waitForPort("127.0.0.1", port, 15000).catch((err) => {
      this.stop();
      throw new Error(
        `Proxy did not become ready on port ${port}: ${(err as Error).message}. ` +
          `Check the Autonomy output channel for uvicorn logs.`,
      );
    });

    this.output.appendLine(`[proxy] ready on 127.0.0.1:${port}`);
  }

  async stop(): Promise<void> {
    const p = this.proc;
    if (!p) return;
    this.proc = null;
    p.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          p.kill("SIGKILL");
        } catch {}
        resolve();
      }, 2000);
      p.on("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.createConnection({ host, port });
      sock.once("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() > deadline) {
          reject(new Error("timeout"));
        } else {
          setTimeout(tryOnce, 200);
        }
      });
    };
    tryOnce();
  });
}
