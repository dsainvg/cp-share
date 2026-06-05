// ============================================================
// extension/src/SidebarProvider.ts — WebviewViewProvider
// ============================================================
import * as vscode from "vscode";
import type {
  PostWithComments,
  FeedResponse,
  CreatePostRequest,
  CreateCommentRequest,
  WebviewToExtensionMessage,
  ExtensionToWebviewMessage,
} from "@cp-share/shared";
import { CommunityCodeProvider } from "./CommunityCodeProvider";

const API_BASE = "https://api.cpshare.dsainvg.me";

export class SidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _authKey: string;
  private readonly _codeProvider: CommunityCodeProvider;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    authKey: string,
    codeProvider: CommunityCodeProvider
  ) {
    this._authKey = authKey;
    this._codeProvider = codeProvider;
  }

  updateAuthKey(authKey: string): void {
    this._authKey = authKey;
    if (this._view) {
      this._view.webview.html = this._buildHtml(this._view.webview);
      this._fetchAndPostFeed();
    }
  }

  // ── VS Code calls this when the view becomes visible ─────────
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void | Thenable<void> {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._buildHtml(webviewView.webview);

    // Listen for messages from the Webview
    webviewView.webview.onDidReceiveMessage(
      (msg: WebviewToExtensionMessage) => this._handleMessage(msg)
    );

    // Auto-load feed when view opens
    if (this._authKey) {
      this._fetchAndPostFeed();
    }
  }

  /** Send a typed message from the extension to the webview. */
  postMessage(msg: ExtensionToWebviewMessage): void {
    this._view?.webview.postMessage(msg);
  }

  /** Called by extension.ts polling when user is still pending. */
  notifyPending(): void {
    this.postMessage({ type: "PENDING_APPROVAL" });
  }

  /** Called by extension.ts polling when approval is detected. */
  notifyApproved(): void {
    // Transition the webview from pending screen → live feed
    this._fetchAndPostFeed();
  }

  // ── Message handler ───────────────────────────────────────────
  private async _handleMessage(msg: WebviewToExtensionMessage): Promise<void> {
    switch (msg.type) {
      case "TRIGGER_REGISTER":
        vscode.commands.executeCommand("cp-share.register");
        break;

      case "REFRESH_FEED":
        await this._fetchAndPostFeed();
        break;

      case "CREATE_POST":
        await this._createPost(msg.payload);
        break;

      case "CREATE_COMMENT":
        await this._createComment(msg.payload);
        break;

      case "DELETE_POST":
        await this._deletePost(msg.payload.post_id);
        break;

      case "TEST_CODE": {
        const result = await vscode.commands.executeCommand("cp-share.testCode", msg.payload);
        this.postMessage({ type: "TEST_RESULT", payload: result as any });
        break;
      }

      case "ATTACH_FILE":
        // Delegate to the registered command so it can access the active editor
        vscode.commands.executeCommand("cp-share.attachFile");
        break;

      case "RUN_CODE":
        vscode.commands.executeCommand("cp-share.runCodeLocally", msg.payload);
        break;

      case "OPEN_CODE_DOC":
        vscode.commands.executeCommand("cp-share.openCodeDoc", msg.payload);
        break;
    }
  }

  // ── API helpers ───────────────────────────────────────────────
  private _headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this._authKey}`,
    };
  }

  private async _fetchAndPostFeed(): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/posts`, {
        headers: this._headers(),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        // Distinguish pending-approval 403 from other errors
        if (res.status === 403 && data.error?.includes("pending")) {
          this.postMessage({ type: "PENDING_APPROVAL" });
        } else {
          this.postMessage({ type: "ERROR", payload: { message: data.error ?? "Failed to load feed" } });
        }
        return;
      }
      const data = await res.json() as FeedResponse;
      this.postMessage({ type: "FEED_DATA", payload: data });
    } catch (e) {
      this.postMessage({ type: "ERROR", payload: { message: String(e) } });
    }
  }

  private async _createPost(body: CreatePostRequest): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/posts`, {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify(body),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) {
        this.postMessage({ type: "ERROR", payload: { message: data.error ?? "Failed to create post" } });
        return;
      }
      // Refresh the full feed to reflect the new post
      await this._fetchAndPostFeed();
    } catch (e) {
      this.postMessage({ type: "ERROR", payload: { message: String(e) } });
    }
  }

  private async _createComment(body: CreateCommentRequest): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/comments`, {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify(body),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) {
        this.postMessage({ type: "ERROR", payload: { message: data.error ?? "Failed to post comment" } });
        return;
      }
      await this._fetchAndPostFeed();
    } catch (e) {
      this.postMessage({ type: "ERROR", payload: { message: String(e) } });
    }
  }

  private async _deletePost(postId: number): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/posts/${postId}`, {
        method: "DELETE",
        headers: this._headers(),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) {
        this.postMessage({ type: "ERROR", payload: { message: data.error ?? "Failed to delete post" } });
        return;
      }
      vscode.window.showInformationMessage("CP Share: Post deleted successfully.");
      await this._fetchAndPostFeed();
    } catch (e) {
      this.postMessage({ type: "ERROR", payload: { message: String(e) } });
    }
  }

  // ── Webview HTML ──────────────────────────────────────────────
  private _buildHtml(webview: vscode.Webview): string {
    // CSP nonce for inline scripts (security best-practice)
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 style-src 'unsafe-inline';
                 script-src 'nonce-${nonce}';" />
  <title>CP Share</title>
  <style>
    /* ── Reset & tokens ─────────────────────────────────── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --accent: #7c3aed;
      --accent-light: #a78bfa;
      --surface: var(--vscode-editorWidget-background, #1e1e2e);
      --border: var(--vscode-widget-border, #334155);
      --muted: var(--vscode-descriptionForeground, #94a3b8);
      --danger: #f87171;
      --success: #34d399;
      --radius: 6px;
      --font: var(--vscode-font-family, system-ui, sans-serif);
      --font-mono: var(--vscode-editor-font-family, 'Courier New', monospace);
    }
    body {
      font-family: var(--font);
      font-size: 13px;
      background: var(--bg);
      color: var(--fg);
      line-height: 1.5;
      padding: 0 8px 12px;
    }

    /* ── Toolbar ─────────────────────────────────────────── */
    .toolbar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 0;
      border-bottom: 1px solid var(--border);
      margin-bottom: 10px;
    }
    .toolbar h1 {
      font-size: 13px;
      font-weight: 700;
      color: var(--accent-light);
      flex: 1;
      letter-spacing: .03em;
    }
    .icon-btn {
      background: none;
      border: none;
      color: var(--muted);
      cursor: pointer;
      padding: 3px 5px;
      border-radius: var(--radius);
      font-size: 14px;
      display: flex;
      align-items: center;
      transition: color .15s, background .15s;
    }
    .icon-btn:hover { color: var(--fg); background: var(--border); }

    /* ── Error banner ────────────────────────────────────── */
    #error-banner {
      display: none;
      background: #450a0a;
      color: var(--danger);
      padding: 6px 10px;
      border-radius: var(--radius);
      margin-bottom: 8px;
      font-size: 12px;
    }
    #error-banner.visible { display: block; }

    /* ── Create post form ────────────────────────────────── */
    .form-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 10px;
      margin-bottom: 12px;
    }
    .form-card details summary {
      cursor: pointer;
      font-weight: 600;
      color: var(--accent-light);
      list-style: none;
      display: flex;
      align-items: center;
      gap: 6px;
      user-select: none;
    }
    .form-card details[open] summary { margin-bottom: 8px; }
    .form-row { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
    input, textarea, select {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      color: var(--fg);
      font-family: var(--font);
      font-size: 12px;
      padding: 5px 8px;
      outline: none;
      resize: vertical;
      transition: border-color .15s;
    }
    input:focus, textarea:focus, select:focus { border-color: var(--accent); }
    textarea { min-height: 60px; }
    .code-area { font-family: var(--font-mono); font-size: 11px; min-height: 80px; }

    /* ── Attach strip ────────────────────────────────────── */
    .attach-strip {
      display: flex;
      align-items: center;
      gap: 6px;
      background: #1e1b4b;
      border: 1px solid var(--accent);
      border-radius: var(--radius);
      padding: 5px 8px;
      font-size: 11px;
    }
    .attach-strip span { flex: 1; color: var(--accent-light); font-style: italic; }
    .attach-strip button { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 14px; }

    /* ── Buttons ─────────────────────────────────────────── */
    .btn {
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: var(--radius);
      padding: 5px 12px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      transition: background .15s, transform .08s;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .btn:hover { background: #6d28d9; }
    .btn:active { transform: scale(.97); }
    .btn-sm { padding: 3px 8px; font-size: 11px; }
    .btn-ghost {
      background: none;
      color: var(--muted);
      border: 1px solid var(--border);
    }
    .btn-ghost:hover { background: var(--border); color: var(--fg); }

    /* ── Feed ────────────────────────────────────────────── */
    #feed { display: flex; flex-direction: column; gap: 10px; }
    .post-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
      animation: fadeIn .2s ease;
    }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; } }
    .post-header {
      padding: 8px 10px 6px;
      display: flex;
      align-items: flex-start;
      gap: 8px;
    }
    .post-meta { flex: 1; }
    .post-title {
      font-weight: 700;
      font-size: 12.5px;
      color: var(--fg);
      margin-bottom: 1px;
    }
    .post-info { font-size: 10.5px; color: var(--muted); }
    .post-body { padding: 0 10px 6px; font-size: 12px; line-height: 1.6; }
    .code-block {
      margin: 6px 10px;
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 4px;
      overflow: hidden;
    }
    .code-block-header {
      display: flex;
      align-items: center;
      padding: 3px 8px;
      background: #161b22;
      gap: 6px;
    }
    .lang-badge {
      font-size: 10px;
      font-family: var(--font-mono);
      color: #79c0ff;
      font-weight: 600;
    }
    .code-actions { margin-left: auto; display: flex; gap: 4px; }
    .code-btn {
      background: none;
      border: 1px solid #30363d;
      color: #8b949e;
      border-radius: 3px;
      font-size: 10px;
      padding: 1px 6px;
      cursor: pointer;
      transition: all .15s;
    }
    .code-btn:hover { background: #21262d; color: #e6edf3; }
    pre {
      padding: 8px;
      overflow-x: auto;
      font-family: var(--font-mono);
      font-size: 11px;
      line-height: 1.6;
      color: #e6edf3;
      margin: 0;
      white-space: pre;
    }

    /* ── Comments ────────────────────────────────────────── */
    .comments-section { border-top: 1px solid var(--border); }
    .comment {
      padding: 6px 10px;
      border-bottom: 1px solid var(--border);
      font-size: 11.5px;
    }
    .comment:last-child { border-bottom: none; }
    .comment-meta { color: var(--muted); font-size: 10.5px; margin-bottom: 2px; }
    .comment-body { line-height: 1.5; }

    /* ── Comment form ────────────────────────────────────── */
    .comment-form {
      padding: 6px 10px 8px;
      display: flex;
      flex-direction: column;
      gap: 5px;
      border-top: 1px solid var(--border);
    }
    .comment-form textarea { min-height: 45px; }

    /* ── Loading ─────────────────────────────────────────── */
    .loading {
      text-align: center;
      color: var(--muted);
      padding: 24px;
      font-size: 12px;
    }
    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin .7s linear infinite;
      margin-right: 6px;
      vertical-align: middle;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .empty-state {
      text-align: center;
      color: var(--muted);
      padding: 32px 16px;
      font-size: 12px;
    }
    .empty-state .emoji { font-size: 28px; margin-bottom: 8px; }

    /* ── Pending approval screen ─────────────────────────── */
    #pending-screen {
      display: none;
      flex-direction: column;
      align-items: center;
      text-align: center;
      padding: 32px 16px;
      gap: 12px;
      animation: fadeIn .3s ease;
    }
    #pending-screen.visible { display: flex; }
    .pending-clock {
      font-size: 40px;
      animation: pulse 2s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { transform: scale(1);   opacity: 1; }
      50%       { transform: scale(1.12); opacity: .7; }
    }
    .pending-title {
      font-size: 13px;
      font-weight: 700;
      color: var(--accent-light);
    }
    .pending-sub {
      font-size: 11.5px;
      color: var(--muted);
      line-height: 1.6;
      max-width: 200px;
    }
    .pending-key {
      font-family: var(--font-mono);
      font-size: 10px;
      background: #1e1b4b;
      border: 1px solid var(--accent);
      color: var(--accent-light);
      padding: 4px 10px;
      border-radius: 4px;
      word-break: break-all;
      max-width: 100%;
    }
    .pending-dot-row {
      display: flex;
      gap: 5px;
      align-items: center;
    }
    .dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--accent);
      animation: dotBounce 1.2s ease-in-out infinite;
    }
    .dot:nth-child(2) { animation-delay: .2s; }
    .dot:nth-child(3) { animation-delay: .4s; }
    @keyframes dotBounce {
      0%, 80%, 100% { transform: scale(0.6); opacity: .4; }
      40%           { transform: scale(1);   opacity: 1; }
    }
    #register-screen {
      display: none;
      flex-direction: column;
      align-items: center;
      text-align: center;
      padding: 32px 16px;
      gap: 12px;
      animation: fadeIn .3s ease;
    }
    #register-screen.visible { display: flex; }
    .brand-logo {
      font-size: 48px;
      color: var(--accent-light);
      filter: drop-shadow(0 0 8px var(--accent));
      margin-bottom: 8px;
    }
    .icon-btn { border: none; background: none; cursor: pointer; color: var(--muted); }
  </style>
</head>
<body data-auth-key-hint="${this._authKey}">

<!-- ── Toolbar ──────────────────────────────────────────────── -->
<div class="toolbar">
  <h1>⬡ CP Share</h1>
  <button class="icon-btn" id="btn-attach" title="Attach current file">📎</button>
  <button class="icon-btn" id="btn-refresh" title="Refresh feed">↻</button>
</div>

<!-- ── Error banner ─────────────────────────────────────────── -->
<div id="error-banner" role="alert"></div>

<!-- ── Create Post form ─────────────────────────────────────── -->
<div class="form-card">
  <details id="new-post-details">
    <summary>＋ New Post</summary>
    <div class="form-row">
      <input type="text" id="post-title" placeholder="Title…" />
      <textarea id="post-body" placeholder="What are you sharing?"></textarea>
      
      <div style="display:flex;gap:6px;align-items:center">
        <input type="text" id="post-link" placeholder="Problem Link (optional)…" style="flex:1;min-width:0" />
        <select id="post-problem-type" style="width:110px">
          <option value="other">Other</option>
          <option value="leetcode">LeetCode</option>
          <option value="atcoder-cf">AtCoder/CF</option>
        </select>
      </div>

      <div style="display:flex;gap:6px">
        <textarea id="post-expected-input" placeholder="Expected Input (optional)…" style="flex:1;min-height:35px;height:35px"></textarea>
        <textarea id="post-expected-output" placeholder="Expected Output (optional)…" style="flex:1;min-height:35px;height:35px"></textarea>
      </div>

      <div id="post-attach-strip" style="display:none" class="attach-strip">
        <span id="post-attach-label">File attached</span>
        <button id="post-attach-clear" title="Remove attachment">✕</button>
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        <select id="post-lang" style="flex:1">
          <option value="">No code attachment</option>
          ${langOptions()}
        </select>
        <button class="btn btn-sm btn-ghost" id="btn-post-attach">📎 File</button>
      </div>
      <textarea id="post-code" class="code-area" placeholder="Code (optional)…" style="display:none"></textarea>
      <button class="btn btn-sm" id="btn-submit-post">Publish</button>
    </div>
  </details>
</div>

<!-- ── Register screen ─────────────────────────────── -->
<div id="register-screen">
  <div class="brand-logo">⬡</div>
  <div class="pending-title">Welcome to CP Share</div>
  <div class="pending-sub">
    Share competitive programming solutions with your team instantly. Choose a username to register.
  </div>
  <button class="btn" id="btn-register-trigger">Register Username</button>
</div>

<!-- ── Pending approval screen ─────────────────────────────── -->
<div id="pending-screen">
  <div class="pending-clock">⏳</div>
  <div class="pending-title">Waiting for approval</div>
  <div class="pending-sub">
    Your account is registered. An admin will approve you shortly.
    Checking automatically every 30 seconds.
  </div>
  <div class="pending-dot-row">
    <div class="dot"></div>
    <div class="dot"></div>
    <div class="dot"></div>
  </div>
  <div class="pending-sub" style="margin-top:4px">Share this key with the admin:</div>
  <div class="pending-key" id="pending-key-display">…</div>
</div>

<!-- ── Feed ─────────────────────────────────────────────────── -->
<div id="feed">
  <div class="loading"><span class="spinner"></span>Loading feed…</div>
</div>

<script nonce="${nonce}">
  // ── VS Code API ─────────────────────────────────────────────
  const vscode = acquireVsCodeApi();
  function postMsg(msg) { vscode.postMessage(msg); }

  // ── State ───────────────────────────────────────────────────
  let attachedCode = null;
  let attachedLang = null;
  let _currentPosts = [];
  let activeTestTarget = null;

  // ── Toolbar ─────────────────────────────────────────────────
  document.getElementById('btn-refresh').addEventListener('click', () => {
    postMsg({ type: 'REFRESH_FEED' });
  });
  document.getElementById('btn-attach').addEventListener('click', () => {
    postMsg({ type: 'ATTACH_FILE' });
  });

  // ── Post form ───────────────────────────────────────────────
  const postLang = document.getElementById('post-lang');
  const postCode = document.getElementById('post-code');
  postLang.addEventListener('change', () => {
    postCode.style.display = postLang.value ? 'block' : 'none';
  });

  document.getElementById('btn-post-attach').addEventListener('click', () => {
    postMsg({ type: 'ATTACH_FILE' });
  });

  document.getElementById('post-attach-clear').addEventListener('click', () => {
    attachedCode = null;
    attachedLang = null;
    document.getElementById('post-attach-strip').style.display = 'none';
    postCode.value = '';
    postLang.value = '';
    postCode.style.display = 'none';
  });

  document.getElementById('btn-submit-post').addEventListener('click', () => {
    const title = document.getElementById('post-title').value.trim();
    const body  = document.getElementById('post-body').value.trim();
    if (!title || !body) { showError('Title and body are required.'); return; }

    const code = attachedCode ?? (postCode.value.trim() || undefined);
    const lang = attachedLang ?? (postLang.value || undefined);
    const link = document.getElementById('post-link').value.trim() || undefined;
    const problem_type = document.getElementById('post-problem-type').value;
    const expected_input = document.getElementById('post-expected-input').value || undefined;
    const expected_output = document.getElementById('post-expected-output').value || undefined;

    postMsg({ 
      type: 'CREATE_POST', 
      payload: { 
        title, 
        body, 
        code_content: code, 
        language: lang,
        link,
        problem_type,
        expected_input,
        expected_output
      } 
    });
    document.getElementById('post-title').value = '';
    document.getElementById('post-body').value = '';
    document.getElementById('post-link').value = '';
    document.getElementById('post-problem-type').value = 'other';
    document.getElementById('post-expected-input').value = '';
    document.getElementById('post-expected-output').value = '';
    postCode.value = '';
    postLang.value = '';
    postCode.style.display = 'none';
    attachedCode = null; attachedLang = null;
    document.getElementById('post-attach-strip').style.display = 'none';
    document.getElementById('new-post-details').removeAttribute('open');
  });

  // ── Feed rendering ───────────────────────────────────────────
  function renderFeed(posts) {
    const feed = document.getElementById('feed');
    if (!posts.length) {
      feed.innerHTML = '<div class="empty-state"><div class="emoji">📭</div>No posts yet. Be the first!</div>';
      return;
    }
    feed.innerHTML = posts.map(renderPost).join('');
    attachCommentHandlers(posts);
  }

  function escape(str) {
    return String(str ?? '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function renderCode(id, code, lang, prefix, post = null) {
    if (!code) return '';
    const idStr = prefix + '-' + id;
    
    let testBtn = '';
    if (prefix === 'post' && post && (post.expected_input || post.expected_output)) {
      testBtn = '<button class="code-btn test-btn" data-post-id="' + post.id + '">🧪 Test</button>';
    }
    
    return '<div class="code-block" id="code-block-' + idStr + '">' +
      '<div class="code-block-header">' +
        '<span class="lang-badge">' + escape(lang || 'text') + '</span>' +
        '<div class="code-actions">' +
          testBtn +
          '<button class="code-btn" onclick="openDoc(\'' + idStr + '\', ' + JSON.stringify(code) + ', \'' + escape(lang || '') + '\')">Open</button>' +
          '<button class="code-btn" onclick="runCode(' + JSON.stringify(code) + ', \'' + escape(lang || '') + '\')">▶ Run</button>' +
        '</div>' +
      '</div>' +
      '<pre>' + escape(code) + '</pre>' +
      '<div class="test-result-panel" id="test-panel-' + idStr + '" style="display:none;padding:6px 10px;border-top:1px solid #30363d;font-size:11px"></div>' +
    '</div>';
  }

  function renderPost(post) {
    const comments = (post.comments || []).map(c => 
      '<div class="comment">' +
        '<div class="comment-meta">' + escape(c.author_username || 'User #' + c.user_id) + ' · ' + formatDate(c.created_at) + '</div>' +
        '<div class="comment-body">' + escape(c.body) + '</div>' +
        renderCode(c.id, c.code_content, c.language, 'comment') +
      '</div>'
    ).join('');

    const deleteBtn = post.is_owner 
      ? '<button class="icon-btn delete-post-btn" data-post-id="' + post.id + '" title="Delete Post" style="color:var(--danger)">🗑️</button>'
      : '';

    const linkHtml = post.link 
      ? '<a href="' + escape(post.link) + '" target="_blank" style="color:var(--accent-light);text-decoration:none;margin-left:6px">🔗 Link</a>'
      : '';

    return '<div class="post-card" data-post-id="' + post.id + '">' +
      '<div class="post-header">' +
        '<div class="post-meta">' +
          '<div class="post-title">' + escape(post.title) + '</div>' +
          '<div class="post-info">' + escape(post.author_username || 'User #' + post.user_id) + ' · ' + formatDate(post.created_at) + linkHtml + '</div>' +
        '</div>' +
        deleteBtn +
      '</div>' +
      '<div class="post-body">' + escape(post.body) + '</div>' +
      renderCode(post.id, post.code_content, post.language, 'post', post) +
      '<div class="comments-section">' +
        comments +
        '<div class="comment-form">' +
          '<textarea class="comment-textarea" data-post-id="' + post.id + '" placeholder="Write a comment…"></textarea>' +
          '<div class="attach-strip comment-attach-strip" data-post-id="' + post.id + '" style="display:none">' +
            '<span class="comment-attach-label">File attached</span>' +
            '<button class="comment-attach-clear" data-post-id="' + post.id + '">✕</button>' +
          '</div>' +
          '<div style="display:flex;gap:5px">' +
            '<select class="comment-lang" data-post-id="' + post.id + '" style="flex:1">' +
              '<option value="">No code</option>' +
              langOptionsHTML() +
            '</select>' +
            '<button class="btn btn-sm btn-ghost comment-attach-btn" data-post-id="' + post.id + '">📎</button>' +
            '<button class="btn btn-sm comment-submit-btn" data-post-id="' + post.id + '">Reply</button>' +
          '</div>' +
          '<textarea class="comment-code-area code-area" data-post-id="' + post.id + '" placeholder="Code (optional)…" style="display:none"></textarea>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function attachCommentHandlers(posts) {
    document.querySelectorAll('.delete-post-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const pid = Number(btn.dataset.postId);
        if (confirm('Are you sure you want to delete this post and all its comments?')) {
          postMsg({ type: 'DELETE_POST', payload: { post_id: pid } });
        }
      });
    });

    document.querySelectorAll('.test-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const pid = Number(btn.dataset.postId);
        const post = _currentPosts.find(p => p.id === pid);
        if (post) {
          testCode(pid, post.code_content, post.language);
        }
      });
    });

    document.querySelectorAll('.comment-lang').forEach(sel => {
      sel.addEventListener('change', e => {
        const pid = e.target.dataset.postId;
        const codeArea = document.querySelector('.comment-code-area[data-post-id="' + pid + '"]');
        if (codeArea) codeArea.style.display = sel.value ? 'block' : 'none';
      });
    });

    document.querySelectorAll('.comment-attach-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _pendingAttachTarget = { type: 'comment', postId: btn.dataset.postId };
        postMsg({ type: 'ATTACH_FILE' });
      });
    });

    document.querySelectorAll('.comment-attach-clear').forEach(btn => {
      btn.addEventListener('click', () => {
        const pid = btn.dataset.postId;
        delete _commentAttachments[pid];
        const strip = document.querySelector('.comment-attach-strip[data-post-id="' + pid + '"]');
        if (strip) strip.style.display = 'none';
        const codeArea = document.querySelector('.comment-code-area[data-post-id="' + pid + '"]');
        if (codeArea) { codeArea.value = ''; codeArea.style.display = 'none'; }
        const lang = document.querySelector('.comment-lang[data-post-id="' + pid + '"]');
        if (lang) lang.value = '';
      });
    });

    document.querySelectorAll('.comment-submit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const pid = Number(btn.dataset.postId);
        const textarea = document.querySelector('.comment-textarea[data-post-id="' + pid + '"]');
        const langSel  = document.querySelector('.comment-lang[data-post-id="' + pid + '"]');
        const codeArea = document.querySelector('.comment-code-area[data-post-id="' + pid + '"]');
        const body = textarea?.value.trim();
        if (!body) return;

        const attachment = _commentAttachments[String(pid)];
        const code = attachment?.code ?? (codeArea?.value.trim() || undefined);
        const lang = attachment?.language ?? (langSel?.value || undefined);

        postMsg({
          type: 'CREATE_COMMENT',
          payload: { post_id: pid, body, code_content: code, language: lang }
        });
        if (textarea) textarea.value = '';
        if (codeArea) { codeArea.value = ''; codeArea.style.display = 'none'; }
        if (langSel) langSel.value = '';
        delete _commentAttachments[String(pid)];
        const strip = document.querySelector('.comment-attach-strip[data-post-id="' + pid + '"]');
        if (strip) strip.style.display = 'none';
      });
    });
  }

  // ── Attachment tracking ──────────────────────────────────────
  let _pendingAttachTarget = null;
  const _commentAttachments = {};

  // ── Code actions ─────────────────────────────────────────────
  function openDoc(id, code, language) {
    postMsg({ type: 'OPEN_CODE_DOC', payload: { id, code, language } });
  }
  function runCode(code, language) {
    postMsg({ type: 'RUN_CODE', payload: { code, language } });
  }
  function testCode(postId, code, language) {
    const post = _currentPosts.find(p => p.id === postId);
    if (!post) return;
    
    const idStr = 'post-' + postId;
    const panel = document.getElementById('test-panel-' + idStr);
    panel.style.display = 'block';
    panel.innerHTML = '<span style="color:var(--muted)">⌛ Testing Solution...</span>';
    
    activeTestTarget = { idStr, postId };
    
    postMsg({
      type: 'TEST_CODE',
      payload: {
        code,
        language,
        expected_input: post.expected_input,
        expected_output: post.expected_output,
        problem_type: post.problem_type || 'other'
      }
    });
  }

  // ── Utilities ────────────────────────────────────────────────
  function formatDate(iso) {
    try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }); }
    catch { return iso; }
  }
  function showError(msg) {
    const el = document.getElementById('error-banner');
    el.textContent = msg;
    el.classList.add('visible');
    setTimeout(() => el.classList.remove('visible'), 4000);
  }
  function langOptionsHTML() {
    return ['python','cpp','javascript','typescript','c','rust','go','java','ruby','shell','bash']
      .map(l => '<option value="' + l + '">' + l + '</option>').join('');
  }

  // ── Registration & UI state helpers ───────────────────────────
  function showRegisterScreen() {
    document.getElementById('register-screen').classList.add('visible');
    document.getElementById('pending-screen').classList.remove('visible');
    document.getElementById('feed').style.display = 'none';
    document.querySelector('.form-card').style.display = 'none';
    document.getElementById('btn-attach').style.display = 'none';
  }
  function showPendingScreen() {
    document.getElementById('register-screen').classList.remove('visible');
    document.getElementById('pending-screen').classList.add('visible');
    document.getElementById('feed').style.display = 'none';
    document.querySelector('.form-card').style.display = 'none';
    document.getElementById('btn-attach').style.display = 'none';
  }
  function showFeedScreen() {
    document.getElementById('register-screen').classList.remove('visible');
    document.getElementById('pending-screen').classList.remove('visible');
    document.getElementById('feed').style.display = 'flex';
    document.querySelector('.form-card').style.display = 'block';
    document.getElementById('btn-attach').style.display = '';
  }

  document.getElementById('btn-register-trigger').addEventListener('click', () => {
    postMsg({ type: 'TRIGGER_REGISTER' });
  });

  const hasAuthKey = document.body.dataset.authKeyHint !== '';
  if (!hasAuthKey) {
    showRegisterScreen();
  }

  // ── Extension → Webview messages ────────────────────────────
  window.addEventListener('message', event => {
    const msg = event.data;
    switch (msg.type) {
      case 'FEED_DATA':
        showFeedScreen();
        _currentPosts = msg.payload.posts;
        renderFeed(msg.payload.posts);
        break;
      case 'TEST_RESULT': {
        if (!activeTestTarget) break;
        const { idStr, postId } = activeTestTarget;
        const panel = document.getElementById('test-panel-' + idStr);
        const res = msg.payload;
        
        if (res.passed) {
          panel.innerHTML = 
            '<div style="color:var(--success);font-weight:bold;display:flex;align-items:center;gap:4px">' +
              '<span>✅ Test Passed!</span>' +
            '</div>' +
            '<pre style="background:rgba(52,211,153,0.05);border:1px solid rgba(52,211,153,0.2);padding:6px;margin-top:4px;max-height:100px;font-size:10px;white-space:pre-wrap;word-break:break-all">' + escape(res.actual_output ?? '') + '</pre>';
        } else if (res.compile_error) {
          panel.innerHTML = 
            '<div style="color:var(--danger);font-weight:bold">⚠️ Compile Error</div>' +
            '<pre style="background:rgba(248,113,113,0.05);border:1px solid rgba(248,113,113,0.2);padding:6px;margin-top:4px;max-height:150px;color:var(--danger);font-size:10px;white-space:pre-wrap;word-break:break-all">' + escape(res.compile_error) + '</pre>';
        } else {
          const post = _currentPosts.find(p => p.id === postId);
          const expected = post ? (post.expected_output || '') : '';
          panel.innerHTML = 
            '<div style="color:var(--danger);font-weight:bold">❌ Test Failed</div>' +
            '<div style="color:var(--muted);margin-top:2px;font-size:10.5px">' + escape(res.error || 'Output mismatch.') + '</div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:4px">' +
              '<div>' +
                '<div style="color:var(--muted);font-size:9.5px;text-transform:uppercase;font-weight:600">Expected:</div>' +
                '<pre style="border:1px solid var(--border);padding:4px;max-height:80px;font-size:9.5px;white-space:pre-wrap;word-break:break-all">' + escape(expected) + '</pre>' +
              '</div>' +
              '<div>' +
                '<div style="color:var(--muted);font-size:9.5px;text-transform:uppercase;font-weight:600">Got:</div>' +
                '<pre style="border:1px solid rgba(248,113,113,0.2);background:rgba(248,113,113,0.03);padding:4px;max-height:80px;font-size:9.5px;white-space:pre-wrap;word-break:break-all">' + escape(res.actual_output ?? '') + '</pre>' +
              '</div>' +
            '</div>';
        }
        activeTestTarget = null;
        break;
      }
      case 'PENDING_APPROVAL':
        showPendingScreen();
        break;
      case 'FILE_ATTACHED': {
        const { code, language } = msg.payload;
        if (_pendingAttachTarget && _pendingAttachTarget.type === 'comment') {
          const pid = _pendingAttachTarget.postId;
          _commentAttachments[pid] = { code, language };
          const strip = document.querySelector('.comment-attach-strip[data-post-id="' + pid + '"]');
          if (strip) { strip.style.display = 'flex'; }
          const label = document.querySelector('.comment-attach-strip[data-post-id="' + pid + '"] .comment-attach-label');
          if (label) label.textContent = language + ' file attached';
          const codeArea = document.querySelector('.comment-code-area[data-post-id="' + pid + '"]');
          if (codeArea) { codeArea.value = code; codeArea.style.display = 'block'; }
          const langSel = document.querySelector('.comment-lang[data-post-id="' + pid + '"]');
          if (langSel) langSel.value = language;
        } else {
          // Attach to new post form
          attachedCode = code;
          attachedLang = language;
          const strip = document.getElementById('post-attach-strip');
          strip.style.display = 'flex';
          document.getElementById('post-attach-label').textContent = language + ' file attached';
          postCode.value = code;
          postCode.style.display = 'block';
          postLang.value = language;
        }
        _pendingAttachTarget = null;
        break;
      }
      case 'ERROR':
        showError(msg.payload.message);
        break;
    }
  });

  // Show auth key in pending screen so user can share it with admin
  // (injected as a data attribute on the body to avoid exposing it in HTML source)
  const keyDisplay = document.getElementById('pending-key-display');
  if (keyDisplay && document.body.dataset.authKeyHint) {
    keyDisplay.textContent = document.body.dataset.authKeyHint;
  }
</script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function langOptions(): string {
  return ["python", "cpp", "javascript", "typescript", "c", "rust", "go", "java", "ruby", "shell", "bash"]
    .map((l) => `<option value="${l}">${l}</option>`)
    .join("\n          ");
}
