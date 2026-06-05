// ============================================================
// extension/src/extension.ts — VS Code Extension Entry Point
// ============================================================
import * as vscode from "vscode";
import * as crypto from "crypto";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import type { RegisterRequest } from "@cp-share/shared";
import { SidebarProvider } from "./SidebarProvider";
import { CommunityCodeProvider } from "./CommunityCodeProvider";

const API_BASE = "https://api.cpshare.dsainvg.me";

// How often (ms) to poll for approval while status is pending
const POLL_INTERVAL_MS = 30_000;

// ── Activate ──────────────────────────────────────────────────
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // ── 1. Status bar item ──────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBar.command = "cp-share.openSidebar";
  context.subscriptions.push(statusBar);
  setStatusBar(statusBar, "loading");
  statusBar.show();

  // ── 2. Auth lifecycle: ensure auth key exists ───────────────
  let authKey = context.globalState.get<string>("cp-share.authKey");

  if (!authKey) {
    authKey = crypto.randomUUID();
    await context.globalState.update("cp-share.authKey", authKey);

    setStatusBar(statusBar, "registering");

    try {
      const body: RegisterRequest = { auth_key: authKey };
      const res = await fetch(`${API_BASE}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json() as { ok: boolean; message?: string; error?: string };

      if (data.ok) {
        vscode.window.showInformationMessage(
          "CP Share: ✅ Registered! Waiting for admin approval before you can post."
        );
        setStatusBar(statusBar, "pending");
      } else {
        vscode.window.showWarningMessage(`CP Share: ${data.error ?? "Registration failed"}`);
        setStatusBar(statusBar, "error");
      }
    } catch (e) {
      vscode.window.showErrorMessage(`CP Share: Could not reach API — ${String(e)}`);
      setStatusBar(statusBar, "error");
    }
  }

  // ── 3. Virtual document provider ────────────────────────────
  const communityCodeProvider = new CommunityCodeProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      CommunityCodeProvider.SCHEME,
      communityCodeProvider
    )
  );

  // ── 4. Sidebar webview provider ─────────────────────────────
  const sidebarProvider = new SidebarProvider(
    context.extensionUri,
    authKey,
    communityCodeProvider
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("cp-share.sidebarView", sidebarProvider)
  );

  // ── 5. Approval polling — checks every 30s while pending ────
  // Stops automatically once the user is approved.
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const checkApproval = async (): Promise<boolean> => {
    try {
      const res = await fetch(`${API_BASE}/posts`, {
        headers: { Authorization: `Bearer ${authKey}` },
      });

      if (res.ok) {
        // 200 → approved!
        clearInterval(pollTimer);
        setStatusBar(statusBar, "approved");
        vscode.window.showInformationMessage(
          "CP Share: 🎉 Your account has been approved! Welcome to the community."
        );
        sidebarProvider.notifyApproved();
        return true;
      }

      const data = await res.json() as { error?: string };
      if (res.status === 403 && data.error?.includes("pending")) {
        setStatusBar(statusBar, "pending");
        sidebarProvider.notifyPending();
      } else {
        setStatusBar(statusBar, "error");
      }
    } catch {
      setStatusBar(statusBar, "error");
    }
    return false;
  };

  // Run once immediately, then start polling if not yet approved
  const alreadyApproved = await checkApproval();
  if (!alreadyApproved) {
    pollTimer = setInterval(checkApproval, POLL_INTERVAL_MS);
    context.subscriptions.push({ dispose: () => clearInterval(pollTimer) });
  }

  // ── 6. Command: open sidebar ─────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("cp-share.openSidebar", () => {
      vscode.commands.executeCommand("cp-share.sidebarView.focus");
    })
  );

  // ── 7. Command: Run Code Locally ─────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cp-share.runCodeLocally",
      async (payload: { code: string; language: string }) => {
        await runCodeLocally(payload.code, payload.language);
      }
    )
  );

  // ── 8. Command: Open Code as Virtual Document ─────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cp-share.openCodeDoc",
      async (payload: { id: string | number; code: string; language: string }) => {
        const ext = languageToExtension(payload.language);
        const docName = `comment-${payload.id}${ext}`;
        communityCodeProvider.setContent(docName, payload.code);
        const uri = vscode.Uri.parse(`${CommunityCodeProvider.SCHEME}:${docName}`);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
      }
    )
  );

  // ── 9. Command: Attach Current File to Draft ──────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("cp-share.attachFile", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("CP Share: No active text editor.");
        return;
      }
      sidebarProvider.postMessage({
        type: "FILE_ATTACHED",
        payload: { code: editor.document.getText(), language: editor.document.languageId },
      });
    })
  );
}

// ── Deactivate ────────────────────────────────────────────────
export function deactivate(): void { /* nothing to clean up */ }

// ── Status bar helper ─────────────────────────────────────────
type StatusState = "loading" | "registering" | "pending" | "approved" | "error";

function setStatusBar(bar: vscode.StatusBarItem, state: StatusState): void {
  const states: Record<StatusState, { text: string; tooltip: string; color?: string }> = {
    loading:      { text: "$(sync~spin) CP Share",    tooltip: "CP Share: Connecting…" },
    registering:  { text: "$(sync~spin) CP Share",    tooltip: "CP Share: Registering…" },
    pending:      { text: "$(clock) CP Share: Pending", tooltip: "CP Share: Awaiting admin approval. Checking every 30s…", color: new vscode.ThemeColor("statusBarItem.warningBackground") as unknown as string },
    approved:     { text: "$(check) CP Share",        tooltip: "CP Share: Active — click to open feed" },
    error:        { text: "$(warning) CP Share",      tooltip: "CP Share: API unreachable", color: new vscode.ThemeColor("statusBarItem.errorBackground") as unknown as string },
  };
  const s = states[state];
  bar.text = s.text;
  bar.tooltip = s.tooltip;
  bar.backgroundColor = s.color
    ? new vscode.ThemeColor(
        state === "pending"
          ? "statusBarItem.warningBackground"
          : "statusBarItem.errorBackground"
      )
    : undefined;
}

// ── runCodeLocally ────────────────────────────────────────────
async function runCodeLocally(code: string, language: string): Promise<void> {
  const ext = languageToExtension(language);
  const tmpDir = os.tmpdir();
  const baseName = `cp-share-run-${Date.now()}`;
  const srcFile = path.join(tmpDir, `${baseName}${ext}`);
  fs.writeFileSync(srcFile, code, "utf8");

  const terminal = vscode.window.createTerminal({ name: `CP Share — ${language}` });
  terminal.show(true);

  const lang = language.toLowerCase();

  if (lang === "python" || lang === "python3") {
    terminal.sendText(`python "${srcFile}"`); return;
  }
  if (lang === "cpp" || lang === "c++" || lang === "c") {
    const outFile = path.join(tmpDir, process.platform === "win32" ? `${baseName}.exe` : baseName);
    terminal.sendText(`g++ "${srcFile}" -o "${outFile}" -std=c++17 && "${outFile}"`); return;
  }
  if (lang === "javascript" || lang === "js") {
    terminal.sendText(`node "${srcFile}"`); return;
  }
  if (lang === "typescript" || lang === "ts") {
    terminal.sendText(`ts-node "${srcFile}"`); return;
  }
  if (lang === "shell" || lang === "bash" || lang === "sh") {
    terminal.sendText(`bash "${srcFile}"`); return;
  }

  vscode.window.showWarningMessage(
    `CP Share: No runner for "${language}". File at: ${srcFile}`
  );
  terminal.sendText(`# Unsupported language: ${language}\n# File: "${srcFile}"`);
}

function languageToExtension(language: string): string {
  const map: Record<string, string> = {
    python: ".py", python3: ".py",
    cpp: ".cpp", "c++": ".cpp", c: ".c",
    javascript: ".js", js: ".js",
    typescript: ".ts", ts: ".ts",
    shell: ".sh", bash: ".sh", sh: ".sh",
    rust: ".rs", go: ".go", java: ".java", ruby: ".rb",
  };
  return map[language.toLowerCase()] ?? ".txt";
}
