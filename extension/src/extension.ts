// ============================================================
// extension/src/extension.ts — VS Code Extension Entry Point
// ============================================================
import * as vscode from "vscode";
import * as crypto from "crypto";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import type { RegisterRequest } from "@cp-share/shared";
import { spawn } from "child_process";
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
    authKey ?? "",
    communityCodeProvider
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("cp-share.sidebarView", sidebarProvider)
  );

  // ── 5. Approval polling — checks every 30s while pending ────
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const startApprovalPolling = (key: string) => {
    if (pollTimer) {
      clearInterval(pollTimer);
    }

    const checkApproval = async (): Promise<boolean> => {
      try {
        const res = await fetch(`${API_BASE}/posts`, {
          headers: { Authorization: `Bearer ${key}` },
        });

        if (res.ok) {
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

    checkApproval(); // Run once immediately
    pollTimer = setInterval(checkApproval, POLL_INTERVAL_MS);
    context.subscriptions.push({ dispose: () => clearInterval(pollTimer) });
  };

  const registerUser = async (): Promise<string | null> => {
    let username = await vscode.window.showInputBox({
      title: "CP Share: Choose a Username",
      prompt: "Enter a username to register with CP Share. Others will see this when you share or comment.",
      placeHolder: "e.g., alice123",
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value.trim().length < 2) {
          return "Username must be at least 2 characters long.";
        }
        if (value.trim().length > 32) {
          return "Username must be at most 32 characters long.";
        }
        return null;
      }
    });

    if (username === undefined) {
      vscode.window.showWarningMessage("CP Share: Registration cancelled.");
      return null;
    }

    const trimmedUsername = username.trim();
    const tempAuthKey = crypto.randomUUID();
    setStatusBar(statusBar, "registering");

    try {
      const body: RegisterRequest = { auth_key: tempAuthKey, username: trimmedUsername };
      const res = await fetch(`${API_BASE}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json() as { ok: boolean; message?: string; error?: string };

      if (res.ok && data.ok) {
        await context.globalState.update("cp-share.authKey", tempAuthKey);
        authKey = tempAuthKey;
        vscode.window.showInformationMessage(
          `CP Share: ✅ Registered as "${trimmedUsername}"! Waiting for admin approval.`
        );
        setStatusBar(statusBar, "pending");
        sidebarProvider.updateAuthKey(tempAuthKey);
        startApprovalPolling(tempAuthKey);
        return tempAuthKey;
      } else {
        vscode.window.showErrorMessage(`CP Share: ${data.error ?? "Registration failed"}`);
        setStatusBar(statusBar, "error");
        return null;
      }
    } catch (e) {
      vscode.window.showErrorMessage(`CP Share: Could not reach API — ${String(e)}`);
      setStatusBar(statusBar, "error");
      return null;
    }
  };

  if (authKey) {
    startApprovalPolling(authKey);
  } else {
    // If not registered yet, configure status bar to show registration prompt on click
    statusBar.text = "$(key) CP Share: Register";
    statusBar.tooltip = "CP Share: Click to register a username";
    statusBar.command = "cp-share.register";
  }

  // ── 6. Command: Register User ────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("cp-share.register", async () => {
      if (context.globalState.get<string>("cp-share.authKey")) {
        vscode.window.showInformationMessage("CP Share: Already registered.");
        return;
      }
      await registerUser();
    })
  );

  // ── 6b. Command: open sidebar ─────────────────────────────────
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

  // ── 7b. Command: Test Code Locally in Background ──────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cp-share.testCode",
      async (payload: {
        code: string;
        language: string;
        expected_input: string | null;
        expected_output: string | null;
        problem_type: "leetcode" | "atcoder-cf" | "other";
      }) => {
        return await testCodeLocally(payload);
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

async function testCodeLocally(payload: {
  code: string;
  language: string;
  expected_input: string | null;
  expected_output: string | null;
  problem_type: "leetcode" | "atcoder-cf" | "other";
}): Promise<{ passed: boolean; actual_output?: string; error?: string; compile_error?: string }> {
  const { code, language, expected_input, expected_output, problem_type } = payload;
  const lang = language.toLowerCase();
  const ext = languageToExtension(language);
  const tmpDir = os.tmpdir();
  const baseName = `cp-share-test-${Date.now()}`;
  const srcFile = path.join(tmpDir, `${baseName}${ext}`);

  // 1. Write the code to temp file
  let finalCode = code;
  if (problem_type === "leetcode" && (lang === "python" || lang === "python3" || lang === "py")) {
    // Append the Python LeetCode Solution wrapper
    finalCode = code + `

# ── Dynamic LeetCode test runner wrapper ─────────────────────
import sys
import json

if __name__ == '__main__':
    try:
        if 'Solution' not in globals():
            print("Error: class Solution not found in your code.", file=sys.stderr)
            sys.exit(1)
        sol = Solution()
        methods = [m for m in dir(sol) if not m.startswith('_') and callable(getattr(sol, m))]
        if not methods:
            print("Error: no public method found in class Solution.", file=sys.stderr)
            sys.exit(1)
        method_name = methods[0]
        method = getattr(sol, method_name)
        
        inputs = []
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                inputs.append(json.loads(line))
            except json.JSONDecodeError:
                inputs.append(line)
        
        res = method(*inputs)
        print(json.dumps(res))
    except Exception as e:
        print(f"Runtime Error: {e}", file=sys.stderr)
        sys.exit(1)
`;
  } else if (problem_type === "leetcode" && (lang === "cpp" || lang === "c++" || lang === "c")) {
    // Check for main function in C++ LeetCode
    if (!code.includes("main(") && !code.includes("main (")) {
      return {
        passed: false,
        compile_error: "LeetCode C++ Solutions require a main() function for local testing. Please write a main() that reads inputs and prints the result, or use standard I/O (Codeforces/AtCoder style).",
      };
    }
  }

  fs.writeFileSync(srcFile, finalCode, "utf8");

  // 2. Set up compilation and run parameters
  let runCmd = "";
  let runArgs: string[] = [];
  let isCompiled = false;
  let compileCmd = "";
  let compileArgs: string[] = [];
  const outFile = path.join(tmpDir, process.platform === "win32" ? `${baseName}.exe` : baseName);

  if (lang === "python" || lang === "python3" || lang === "py") {
    runCmd = process.platform === "win32" ? "python" : "python3";
    runArgs = [srcFile];
  } else if (lang === "cpp" || lang === "c++" || lang === "c") {
    isCompiled = true;
    compileCmd = "g++";
    compileArgs = [srcFile, "-o", outFile, "-std=c++17"];
    runCmd = outFile;
    runArgs = [];
  } else if (lang === "javascript" || lang === "js") {
    runCmd = "node";
    runArgs = [srcFile];
  } else if (lang === "typescript" || lang === "ts") {
    runCmd = "ts-node";
    runArgs = [srcFile];
  } else {
    return { passed: false, error: `Testing not supported for language: ${language}` };
  }

  // 3. Compile if necessary
  if (isCompiled) {
    try {
      const compileRes = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const cp = spawn(compileCmd, compileArgs);
        let stderr = "";
        cp.stderr.on("data", (d) => { stderr += d.toString(); });
        cp.on("close", (c) => resolve({ code: c, stderr }));
      });

      if (compileRes.code !== 0) {
        try { fs.unlinkSync(srcFile); } catch {}
        return { passed: false, compile_error: compileRes.stderr || "Compilation failed." };
      }
    } catch (err) {
      return { passed: false, compile_error: `Compile error: ${String(err)}` };
    }
  }

  // 4. Execute with input
  try {
    const inputData = expected_input ?? "";
    const execRes = await new Promise<{ stdout: string; stderr: string; code: number | null; error?: string }>((resolve) => {
      let stdout = "";
      let stderr = "";
      let killed = false;

      const cp = spawn(runCmd, runArgs);

      const timer = setTimeout(() => {
        cp.kill();
        killed = true;
        resolve({ stdout, stderr, code: null, error: "Time Limit Exceeded (5s timeout)" });
      }, 5000);

      cp.stdout.on("data", (d) => { stdout += d.toString(); });
      cp.stderr.on("data", (d) => { stderr += d.toString(); });

      cp.on("close", (c) => {
        clearTimeout(timer);
        if (!killed) resolve({ stdout, stderr, code: c });
      });

      if (inputData) {
        cp.stdin.write(inputData);
      }
      cp.stdin.end();
    });

    // Clean up temp files
    try { fs.unlinkSync(srcFile); } catch {}
    if (isCompiled) { try { fs.unlinkSync(outFile); } catch {} }

    if (execRes.error) {
      return { passed: false, error: execRes.error };
    }

    if (execRes.code !== 0) {
      return { passed: false, error: execRes.stderr || `Runtime Error: Exit code ${execRes.code}` };
    }

    // 5. Compare outputs
    const actualClean = cleanOutput(execRes.stdout);
    const expectedClean = cleanOutput(expected_output ?? "");

    let passed = false;
    if (actualClean === expectedClean) {
      passed = true;
    } else {
      try {
        const actualJson = JSON.parse(actualClean);
        const expectedJson = JSON.parse(expectedClean);
        if (jsonEquals(actualJson, expectedJson)) {
          passed = true;
        }
      } catch {
        // Fallback to string mismatch
      }
    }

    if (passed) {
      return { passed: true, actual_output: execRes.stdout };
    } else {
      return {
        passed: false,
        actual_output: execRes.stdout,
        error: `Output mismatch.`,
      };
    }
  } catch (err) {
    try { fs.unlinkSync(srcFile); } catch {}
    if (isCompiled) { try { fs.unlinkSync(outFile); } catch {} }
    return { passed: false, error: `Execution error: ${String(err)}` };
  }
}

function cleanOutput(str: string): string {
  return str
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(line => line.trimEnd())
    .join("\n")
    .trim();
}

function jsonEquals(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === "object") {
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!jsonEquals(a[i], b[i])) return false;
      }
      return true;
    } else {
      if (Array.isArray(b)) return false;
      const keysA = Object.keys(a);
      const keysB = Object.keys(b);
      if (keysA.length !== keysB.length) return false;
      for (const k of keysA) {
        if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
        if (!jsonEquals(a[k], b[k])) return false;
      }
      return true;
    }
  }
  return false;
}
