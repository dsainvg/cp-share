# CP Share ⬡

CP Share is a premium, real-time code-sharing and testing companion sidebar for Competitive Programmers. Share solutions, discuss approaches, and run test cases directly inside VS Code.

## Features

### 1. Real-Time Solution Feed
*   **Instant Sharing**: Share code snippets along with titles, formatted descriptions, and languages.
*   **Comments & Code replies**: Discuss solutions and attach alternative code files directly in responses.
*   **Context Retention**: The sidebar keeps its state (scrolling, input fields, code drafts) when switching between sidebar panels (Explorer, Git, Search) in VS Code.

### 2. Built-In Local Test Runner
Run and verify solutions locally in the background without leaving your editor:
*   **Standard competitive programming mode**: Supports standard stdin/stdout test cases (AtCoder, Codeforces, etc.).
*   **LeetCode mode**:
    *   **Python Solutions**: Automatically instantiates the `Solution` class, inspects it for public methods, parses multi-line stdin inputs as JSON types, and asserts outputs.
    *   **C++ Solutions**: Compile and test locally (requires a `main()` function or standard I/O structure).
*   **JSON Structural Matcher**: Intelligently matches execution output with expected output regardless of whitespace formatting (e.g. `[0,1]` vs `[0, 1]`).

### 3. Integrated Links
*   Attach problem links directly to your posts.
*   Safe external link opening that integrates directly with VS Code's browser redirection shell.

---

## Installation

1. Open VS Code.
2. Go to the Extensions panel (`Ctrl+Shift+X`).
3. Click the `...` menu in the top-right corner.
4. Select **Install from VSIX...**
5. Select the packaged `.vsix` file.

---

## Supported Languages

*   Python (`.py`)
*   C++ (`.cpp`)
*   C (`.c`)
*   JavaScript (`.js`)
*   TypeScript (`.ts`)

---

## License

This extension is licensed under the [MIT License](LICENSE).
