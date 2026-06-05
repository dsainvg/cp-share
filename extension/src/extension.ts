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

// ── Activate ──────────────────────────────────────────────────
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // ── 1. Auth lifecycle: ensure auth key exists ───────────────
  let authKey = context.globalState.get<string>("cp-share.authKey");

  if (!authKey) {
    authKey = crypto.randomUUID();
    await context.globalState.update("cp-share.authKey", authKey);

    // Register with backend
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
          "CP Share: Registered! Your account is pending admin approval."
        );
      } else {
        vscode.window.showWarningMessage(`CP Share: ${data.error ?? "Registration failed"}`);
      }
    } catch (e) {
      vscode.window.showErrorMessage(`CP Share: Could not reach API — ${String(e)}`);
    }
  }

  // ── 2. Virtual document provider (community-code:// scheme) ─
  const communityCodeProvider = new CommunityCodeProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      CommunityCodeProvider.SCHEME,
      communityCodeProvider
    )
  );

  // ── 3. Sidebar webview provider ─────────────────────────────
  const sidebarProvider = new SidebarProvider(
    context.extensionUri,
    authKey,
    communityCodeProvider
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("cp-share.sidebarView", sidebarProvider)
  );

  // ── 4. Command: Run Code Locally ─────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cp-share.runCodeLocally",
      async (payload: { code: string; language: string }) => {
        await runCodeLocally(payload.code, payload.language);
      }
    )
  );

  // ── 5. Command: Open Code as Virtual Document ─────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cp-share.openCodeDoc",
      async (payload: { id: string | number; code: string; language: string }) => {
        const ext = languageToExtension(payload.language);
        const docName = `comment-${payload.id}${ext}`;

        // Store code in provider before opening
        communityCodeProvider.setContent(docName, payload.code);

        const uri = vscode.Uri.parse(
          `${CommunityCodeProvider.SCHEME}:${docName}`
        );
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, {
          preview: true,
          preserveFocus: false,
          // VS Code enforces read-only for custom scheme URIs — no extra flag needed
        });
      }
    )
  );

  // ── 6. Command: Attach Current File to Draft ──────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("cp-share.attachFile", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("CP Share: No active text editor.");
        return;
      }
      const code = editor.document.getText();
      const language = editor.document.languageId;
      sidebarProvider.postMessage({
        type: "FILE_ATTACHED",
        payload: { code, language },
      });
    })
  );
}

// ── Deactivate ────────────────────────────────────────────────
export function deactivate(): void {
  /* nothing to clean up */
}

// ── Helpers ───────────────────────────────────────────────────

/**
 * Writes code to a temp file and runs it in a VS Code terminal.
 *
 * Supported languages:
 *   - python / python3   → `python <file>`
 *   - cpp / c++          → `g++ <file> -o <out> && <out>` (or .exe on Windows)
 *   - javascript / js    → `node <file>`
 *   - typescript / ts    → `ts-node <file>`
 *   - shell / bash / sh  → `bash <file>`
 */
async function runCodeLocally(code: string, language: string): Promise<void> {
  const ext = languageToExtension(language);
  const tmpDir = os.tmpdir();
  const baseName = `cp-share-run-${Date.now()}`;
  const srcFile = path.join(tmpDir, `${baseName}${ext}`);

  // Write source file
  fs.writeFileSync(srcFile, code, "utf8");

  const terminal = vscode.window.createTerminal({ name: `CP Share — ${language}` });
  terminal.show(true /* preserveFocus */);

  const lang = language.toLowerCase();

  if (lang === "python" || lang === "python3") {
    terminal.sendText(`python "${srcFile}"`);
    return;
  }

  if (lang === "cpp" || lang === "c++" || lang === "c") {
    const outFile = path.join(
      tmpDir,
      process.platform === "win32" ? `${baseName}.exe` : baseName
    );
    const runCmd =
      process.platform === "win32" ? `"${outFile}"` : `"${outFile}"`;
    terminal.sendText(
      `g++ "${srcFile}" -o "${outFile}" -std=c++17 && ${runCmd}`
    );
    return;
  }

  if (lang === "javascript" || lang === "js") {
    terminal.sendText(`node "${srcFile}"`);
    return;
  }

  if (lang === "typescript" || lang === "ts") {
    terminal.sendText(`ts-node "${srcFile}"`);
    return;
  }

  if (lang === "shell" || lang === "bash" || lang === "sh") {
    terminal.sendText(`bash "${srcFile}"`);
    return;
  }

  // Fallback: show file path, let user run manually
  vscode.window.showWarningMessage(
    `CP Share: No runner for language "${language}". File written to ${srcFile}`
  );
  terminal.sendText(`# Unsupported language: ${language}\n# File: "${srcFile}"`);
}

function languageToExtension(language: string): string {
  const map: Record<string, string> = {
    python: ".py",
    python3: ".py",
    cpp: ".cpp",
    "c++": ".cpp",
    c: ".c",
    javascript: ".js",
    js: ".js",
    typescript: ".ts",
    ts: ".ts",
    shell: ".sh",
    bash: ".sh",
    sh: ".sh",
    rust: ".rs",
    go: ".go",
    java: ".java",
    ruby: ".rb",
  };
  return map[language.toLowerCase()] ?? ".txt";
}
