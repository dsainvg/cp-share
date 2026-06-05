// ============================================================
// backend/src/index.ts — Hono app entry point
// ============================================================
import { Hono } from "hono";
import { cors } from "hono/cors";
import type {
  User,
  Post,
  Comment,
  PostWithComments,
  RegisterRequest,
  RegisterResponse,
  CreatePostRequest,
  CreateCommentRequest,
  FeedResponse,
  ApiError,
} from "@cp-share/shared";

// ── Cloudflare Worker environment bindings ────────────────────
export interface Env {
  DB: D1Database;
  ADMIN_SECRET: string;
}

// ── Hono context variables ────────────────────────────────────
type Variables = {
  user: User;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Global middleware ─────────────────────────────────────────
app.use("*", cors({ origin: "*" }));

// ── Helper: typed JSON response ───────────────────────────────
function ok<T>(data: T, status: 200 | 201 = 200) {
  return Response.json(data, { status });
}
function err(message: string, status: 400 | 403 | 404 | 409 | 500 = 400): Response {
  return Response.json({ ok: false, error: message } satisfies ApiError, { status });
}

// ── POST /register ────────────────────────────────────────────
app.post("/register", async (c) => {
  const body = await c.req.json<RegisterRequest>().catch(() => null);
  if (!body?.auth_key) return err("auth_key is required");

  const existing = await c.env.DB.prepare(
    "SELECT id FROM users WHERE auth_key = ?"
  )
    .bind(body.auth_key)
    .first<{ id: number }>();

  if (existing) return err("auth_key already registered", 409);

  await c.env.DB.prepare(
    "INSERT INTO users (auth_key, role, status) VALUES (?, 'user', 'pending')"
  )
    .bind(body.auth_key)
    .run();

  return ok<RegisterResponse>(
    { ok: true, message: "Registered — awaiting approval" },
    201
  );
});

// ── Auth middleware (all routes below) ────────────────────────
app.use("*", async (c, next) => {
  // Skip public & admin routes (admin has its own guard)
  const path = new URL(c.req.url).pathname;
  if (path === "/register" || path.startsWith("/admin")) return next();

  const header = c.req.header("Authorization") ?? "";
  const authKey = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!authKey) return err("Missing Authorization header", 403);

  const user = await c.env.DB.prepare(
    "SELECT * FROM users WHERE auth_key = ?"
  )
    .bind(authKey)
    .first<User>();

  if (!user) return err("Unknown auth key", 403);
  if (user.status !== "approved") return err("Account pending approval", 403);

  c.set("user", user);
  return next();
});

// ── GET /posts ────────────────────────────────────────────────
app.get("/posts", async (c) => {
  const posts = (
    await c.env.DB.prepare(
      "SELECT * FROM posts ORDER BY created_at DESC LIMIT 100"
    ).all<Post>()
  ).results;

  const comments = (
    await c.env.DB.prepare(
      "SELECT * FROM comments ORDER BY created_at ASC"
    ).all<Comment>()
  ).results;

  const commentsByPost = new Map<number, Comment[]>();
  for (const comment of comments) {
    const list = commentsByPost.get(comment.post_id) ?? [];
    list.push(comment);
    commentsByPost.set(comment.post_id, list);
  }

  const feed: PostWithComments[] = posts.map((p) => ({
    ...p,
    comments: commentsByPost.get(p.id) ?? [],
  }));

  return ok<FeedResponse>({ posts: feed });
});

// ── POST /posts ───────────────────────────────────────────────
app.post("/posts", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<CreatePostRequest>().catch(() => null);
  if (!body?.title || !body?.body) return err("title and body are required");

  const result = await c.env.DB.prepare(
    `INSERT INTO posts (user_id, title, body, code_content, language)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(
      user.id,
      body.title,
      body.body,
      body.code_content ?? null,
      body.language ?? null
    )
    .run();

  const post = await c.env.DB.prepare("SELECT * FROM posts WHERE id = ?")
    .bind(result.meta.last_row_id)
    .first<Post>();

  return ok<Post>(post!, 201);
});

// ── POST /comments ────────────────────────────────────────────
app.post("/comments", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<CreateCommentRequest>().catch(() => null);
  if (!body?.post_id || !body?.body) return err("post_id and body are required");

  // Verify post exists
  const post = await c.env.DB.prepare("SELECT id FROM posts WHERE id = ?")
    .bind(body.post_id)
    .first<{ id: number }>();
  if (!post) return err("Post not found", 404);

  const result = await c.env.DB.prepare(
    `INSERT INTO comments (post_id, user_id, body, code_content, language)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(
      body.post_id,
      user.id,
      body.body,
      body.code_content ?? null,
      body.language ?? null
    )
    .run();

  const comment = await c.env.DB.prepare("SELECT * FROM comments WHERE id = ?")
    .bind(result.meta.last_row_id)
    .first<Comment>();

  return ok<Comment>(comment!, 201);
});

// ── Admin middleware ──────────────────────────────────────────
const adminGuard = async (
  c: Parameters<Parameters<typeof app.use>[1]>[0],
  next: () => Promise<void>
) => {
  const secret = c.req.header("X-Admin-Secret");
  if (!secret || secret !== c.env.ADMIN_SECRET) {
    return err("Forbidden", 403);
  }
  return next();
};

app.use("/admin/*", adminGuard);

// ── GET /admin/users — HTML dashboard ────────────────────────
app.get("/admin/users", async (c) => {
  const users = (
    await c.env.DB.prepare(
      "SELECT * FROM users ORDER BY status ASC, created_at DESC"
    ).all<User>()
  ).results;

  const rows = users
    .map(
      (u) => `
      <tr class="${u.status === "pending" ? "pending" : "approved"}">
        <td>${u.id}</td>
        <td><code>${u.auth_key.slice(0, 8)}…</code></td>
        <td>${u.role}</td>
        <td><span class="badge ${u.status}">${u.status}</span></td>
        <td>${u.created_at}</td>
        <td>
          ${
            u.status === "pending"
              ? `<button onclick="approve(${u.id})">Approve</button>`
              : "—"
          }
        </td>
      </tr>`
    )
    .join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>CP Share — Admin</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;padding:2rem}
    h1{font-size:1.5rem;margin-bottom:1.5rem;color:#7c3aed}
    table{width:100%;border-collapse:collapse;background:#1e293b;border-radius:.5rem;overflow:hidden}
    th,td{padding:.75rem 1rem;text-align:left;border-bottom:1px solid #334155;font-size:.875rem}
    th{background:#1e3a5f;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.05em}
    tr.pending td{color:#fbbf24}
    tr.approved td{color:#34d399}
    .badge{padding:.2rem .6rem;border-radius:9999px;font-size:.75rem;font-weight:700}
    .badge.pending{background:#78350f;color:#fcd34d}
    .badge.approved{background:#064e3b;color:#6ee7b7}
    button{background:#7c3aed;color:#fff;border:none;padding:.4rem .9rem;border-radius:.35rem;cursor:pointer;font-size:.8rem}
    button:hover{background:#6d28d9}
    code{background:#0f172a;padding:.1rem .3rem;border-radius:.25rem}
  </style>
</head>
<body>
  <h1>CP Share — User Management</h1>
  <table>
    <thead>
      <tr>
        <th>ID</th><th>Auth Key</th><th>Role</th><th>Status</th>
        <th>Created</th><th>Action</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <script>
    const SECRET = prompt("Enter admin secret:");
    async function approve(id) {
      const res = await fetch("/admin/approve/" + id, {
        method: "POST",
        headers: { "X-Admin-Secret": SECRET }
      });
      if (res.ok) location.reload();
      else alert("Failed: " + (await res.json()).error);
    }
  </script>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
});

// ── POST /admin/approve/:id ───────────────────────────────────
app.post("/admin/approve/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (Number.isNaN(id)) return err("Invalid id");

  const user = await c.env.DB.prepare("SELECT id FROM users WHERE id = ?")
    .bind(id)
    .first<{ id: number }>();
  if (!user) return err("User not found", 404);

  await c.env.DB.prepare("UPDATE users SET status = 'approved' WHERE id = ?")
    .bind(id)
    .run();

  return ok({ ok: true, message: `User ${id} approved` });
});

// ── 404 catch-all ─────────────────────────────────────────────
app.notFound((c) => err(`Route not found: ${c.req.path}`, 404));

export default app;
