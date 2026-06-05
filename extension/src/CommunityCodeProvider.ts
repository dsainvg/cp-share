// ============================================================
// extension/src/CommunityCodeProvider.ts
//
// TextDocumentContentProvider for the "community-code" scheme.
//
// Usage:
//   const uri = vscode.Uri.parse("community-code:comment-42.cpp");
//   const doc = await vscode.workspace.openTextDocument(uri);
//   await vscode.window.showTextDocument(doc);
//
// VS Code automatically treats custom-scheme documents as
// read-only — no additional flag is required.
// ============================================================
import * as vscode from "vscode";

export class CommunityCodeProvider implements vscode.TextDocumentContentProvider {
  // The URI scheme this provider handles.
  static readonly SCHEME = "community-code";

  // In-memory content store: docName → source string.
  // Keys look like "comment-42.cpp", "post-7.py", etc.
  private readonly _store = new Map<string, string>();

  // Fires whenever stored content changes, causing VS Code to
  // re-request provideTextDocumentContent for the given URI.
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange: vscode.Event<vscode.Uri> = this._onDidChange.event;

  /**
   * Called by VS Code when it needs the document content for a URI.
   * @param uri  e.g. community-code:comment-42.cpp
   * @returns    The stored source string, or a placeholder message.
   */
  provideTextDocumentContent(uri: vscode.Uri): string {
    const key = uri.path; // "comment-42.cpp"
    const content = this._store.get(key);
    if (content !== undefined) return content;

    // Friendly placeholder if the key is unknown
    return `// CP Share: No content found for "${key}"\n// Try reopening the code block from the sidebar.`;
  }

  /**
   * Store (or update) the source code for a given document key.
   * Fires the onDidChange event so any open editor refreshes.
   */
  setContent(docName: string, code: string): void {
    this._store.set(docName, code);
    this._onDidChange.fire(
      vscode.Uri.parse(`${CommunityCodeProvider.SCHEME}:${docName}`)
    );
  }

  /**
   * Remove a stored entry (optional cleanup).
   */
  deleteContent(docName: string): void {
    this._store.delete(docName);
  }
}
