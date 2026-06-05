// ============================================================
// @cp-share/shared — canonical type definitions
// All packages import from here; never duplicate these types.
// ============================================================

// ── DB row shapes (mirrors schema.sql exactly) ───────────────

export type UserRole = "user" | "admin";
export type UserStatus = "pending" | "approved";

export interface User {
  id: number;
  auth_key: string;
  role: UserRole;
  status: UserStatus;
  created_at: string; // ISO-8601
}

export interface Post {
  id: number;
  user_id: number;
  title: string;
  body: string;
  code_content: string | null;
  language: string | null;
  created_at: string;
}

export interface Comment {
  id: number;
  post_id: number;
  user_id: number;
  body: string;
  code_content: string | null;
  language: string | null;
  created_at: string;
}

// ── API payload shapes ───────────────────────────────────────

/** POST /register */
export interface RegisterRequest {
  auth_key: string;
}

export interface RegisterResponse {
  ok: boolean;
  message: string;
}

/** POST /posts */
export interface CreatePostRequest {
  title: string;
  body: string;
  code_content?: string;
  language?: string;
}

/** POST /comments */
export interface CreateCommentRequest {
  post_id: number;
  body: string;
  code_content?: string;
  language?: string;
}

/** GET /posts — each post comes with its comments hydrated */
export interface PostWithComments extends Post {
  comments: Comment[];
}

export interface FeedResponse {
  posts: PostWithComments[];
}

/** Generic API error */
export interface ApiError {
  ok: false;
  error: string;
}

// ── Webview ↔ Extension message protocol ────────────────────

export type WebviewToExtensionMessage =
  | { type: "ATTACH_FILE" }
  | { type: "RUN_CODE"; payload: { code: string; language: string } }
  | { type: "OPEN_CODE_DOC"; payload: { id: number | string; code: string; language: string } }
  | { type: "CREATE_POST"; payload: CreatePostRequest }
  | { type: "CREATE_COMMENT"; payload: CreateCommentRequest }
  | { type: "REFRESH_FEED" };

export type ExtensionToWebviewMessage =
  | { type: "FEED_DATA"; payload: FeedResponse }
  | { type: "FILE_ATTACHED"; payload: { code: string; language: string } }
  | { type: "ERROR"; payload: { message: string } }
  | { type: "PENDING_APPROVAL" }
  | { type: "POST_CREATED"; payload: Post }
  | { type: "COMMENT_CREATED"; payload: Comment };
