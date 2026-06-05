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

export interface Env { DB: D1Database; ADMIN_SECRET: string; }
type Variables = { user: User };

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use("*", cors({ origin: "*" }));

function ok<T>(data: T, status: 200 | 201 = 200) { return Response.json(data, { status }); }
function err(message: string, status: 400 | 403 | 404 | 409 | 500 = 400): Response {
  return Response.json({ ok: false, error: message } satisfies ApiError, { status });
}

// ── POST /register ────────────────────────────────────────────
app.post("/register", async (c) => {
  const body = await c.req.json<RegisterRequest>().catch(() => null);
  if (!body?.auth_key) return err("auth_key is required");
  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE auth_key = ?").bind(body.auth_key).first<{ id: number }>();
  if (existing) return err("auth_key already registered", 409);
  await c.env.DB.prepare("INSERT INTO users (auth_key, role, status) VALUES (?, 'user', 'pending')").bind(body.auth_key).run();
  return ok<RegisterResponse>({ ok: true, message: "Registered — awaiting approval" }, 201);
});

// ── Auth middleware ───────────────────────────────────────────
app.use("*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === "/register" || path.startsWith("/admin")) return next();
  const header = c.req.header("Authorization") ?? "";
  const authKey = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!authKey) return err("Missing Authorization header", 403);
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE auth_key = ?").bind(authKey).first<User>();
  if (!user) return err("Unknown auth key", 403);
  if (user.status !== "approved") return err("Account pending approval", 403);
  c.set("user", user);
  return next();
});

// ── GET /posts ────────────────────────────────────────────────
app.get("/posts", async (c) => {
  const posts = (await c.env.DB.prepare("SELECT * FROM posts ORDER BY created_at DESC LIMIT 100").all<Post>()).results;
  const comments = (await c.env.DB.prepare("SELECT * FROM comments ORDER BY created_at ASC").all<Comment>()).results;
  const commentsByPost = new Map<number, Comment[]>();
  for (const comment of comments) {
    const list = commentsByPost.get(comment.post_id) ?? [];
    list.push(comment);
    commentsByPost.set(comment.post_id, list);
  }
  const feed: PostWithComments[] = posts.map((p) => ({ ...p, comments: commentsByPost.get(p.id) ?? [] }));
  return ok<FeedResponse>({ posts: feed });
});

// ── POST /posts ───────────────────────────────────────────────
app.post("/posts", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<CreatePostRequest>().catch(() => null);
  if (!body?.title || !body?.body) return err("title and body are required");
  const result = await c.env.DB.prepare("INSERT INTO posts (user_id, title, body, code_content, language) VALUES (?, ?, ?, ?, ?)")
    .bind(user.id, body.title, body.body, body.code_content ?? null, body.language ?? null).run();
  const post = await c.env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(result.meta.last_row_id).first<Post>();
  return ok<Post>(post!, 201);
});

// ── POST /comments ────────────────────────────────────────────
app.post("/comments", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<CreateCommentRequest>().catch(() => null);
  if (!body?.post_id || !body?.body) return err("post_id and body are required");
  const post = await c.env.DB.prepare("SELECT id FROM posts WHERE id = ?").bind(body.post_id).first<{ id: number }>();
  if (!post) return err("Post not found", 404);
  const result = await c.env.DB.prepare("INSERT INTO comments (post_id, user_id, body, code_content, language) VALUES (?, ?, ?, ?, ?)")
    .bind(body.post_id, user.id, body.body, body.code_content ?? null, body.language ?? null).run();
  const comment = await c.env.DB.prepare("SELECT * FROM comments WHERE id = ?").bind(result.meta.last_row_id).first<Comment>();
  return ok<Comment>(comment!, 201);
});

// ── Admin secret helper ───────────────────────────────────────
function checkAdminSecret(c: Parameters<Parameters<typeof app.use>[1]>[0], fromQuery = false): boolean {
  const secret = fromQuery ? (c.req.query("secret") ?? "") : (c.req.header("X-Admin-Secret") ?? "");
  return secret !== "" && secret === c.env.ADMIN_SECRET;
}

// ── GET /admin/users — Login + Dashboard ─────────────────────
// Visit: https://api.cpshare.dsainvg.me/admin/users
app.get("/admin/users", async (c) => {
  const wrongPassword = c.req.query("secret") !== undefined && !checkAdminSecret(c, true);

  // ── Login page ──────────────────────────────────────────────
  if (!checkAdminSecret(c, true)) {
    return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>CP Share Admin</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#060818;--surface:rgba(255,255,255,.04);--border:rgba(255,255,255,.08);--accent:#7c3aed;--glow:rgba(124,58,237,.35);--text:#f1f5f9;--muted:#94a3b8;--danger:#f87171}
body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;overflow:hidden}
.bg{position:fixed;inset:0;pointer-events:none;z-index:0}
.orb{position:absolute;border-radius:50%;filter:blur(80px);opacity:.35;animation:drift 10s ease-in-out infinite alternate}
.o1{width:500px;height:500px;background:#4c1d95;top:-150px;left:-100px}
.o2{width:400px;height:400px;background:#1e1b4b;bottom:-100px;right:-80px;animation-delay:-4s}
.o3{width:300px;height:300px;background:#312e81;top:40%;left:60%;animation-delay:-2s}
@keyframes drift{from{transform:translate(0,0) scale(1)}to{transform:translate(30px,20px) scale(1.05)}}
.card{position:relative;z-index:1;background:var(--surface);border:1px solid var(--border);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-radius:1.25rem;padding:2.5rem 2rem;width:100%;max-width:380px;box-shadow:0 0 60px var(--glow),0 25px 50px rgba(0,0,0,.5);animation:up .4s cubic-bezier(.16,1,.3,1)}
@keyframes up{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:translateY(0)}}
.logo{display:flex;align-items:center;gap:.6rem;margin-bottom:1.75rem}
.hex{font-size:1.8rem;filter:drop-shadow(0 0 8px var(--accent))}
.name{font-size:1.1rem;font-weight:700;background:linear-gradient(135deg,#a78bfa,#7c3aed);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.tag{font-size:.7rem;color:var(--muted);font-weight:500;letter-spacing:.08em;text-transform:uppercase;margin-left:auto;border:1px solid var(--border);padding:.15rem .45rem;border-radius:.25rem}
h1{font-size:1.3rem;font-weight:700;margin-bottom:.35rem}
.sub{font-size:.85rem;color:var(--muted);margin-bottom:1.75rem}
.field{display:flex;flex-direction:column;gap:.45rem;margin-bottom:1rem}
label{font-size:.78rem;font-weight:600;color:var(--muted);letter-spacing:.04em;text-transform:uppercase}
.iw{position:relative}
.ii{position:absolute;left:.75rem;top:50%;transform:translateY(-50%);font-size:.9rem;pointer-events:none}
input[type=password]{width:100%;padding:.65rem .75rem .65rem 2.25rem;background:rgba(255,255,255,.05);border:1px solid var(--border);border-radius:.5rem;color:var(--text);font-family:inherit;font-size:.9rem;outline:none;transition:border-color .2s,box-shadow .2s}
input[type=password]:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--glow)}
.alert{display:${wrongPassword ? "flex" : "none"};align-items:center;gap:.4rem;background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.3);color:var(--danger);font-size:.8rem;padding:.5rem .75rem;border-radius:.4rem;margin-bottom:1rem}
.btn{width:100%;padding:.7rem;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;border:none;border-radius:.5rem;font-family:inherit;font-size:.9rem;font-weight:600;cursor:pointer;transition:opacity .15s,transform .1s,box-shadow .2s;box-shadow:0 4px 20px var(--glow)}
.btn:hover{opacity:.9;box-shadow:0 6px 28px var(--glow)}.btn:active{transform:scale(.98)}
.foot{margin-top:1.25rem;text-align:center;font-size:.75rem;color:var(--muted)}
</style>
</head>
<body>
<div class="bg"><div class="orb o1"></div><div class="orb o2"></div><div class="orb o3"></div></div>
<div class="card">
  <div class="logo"><span class="hex">⬡</span><span class="name">CP Share</span><span class="tag">Admin</span></div>
  <h1>Welcome back</h1>
  <p class="sub">Enter your admin secret to access the dashboard.</p>
  <div class="alert">⚠&nbsp; Incorrect secret — try again.</div>
  <form method="GET" action="/admin/users">
    <div class="field">
      <label>Admin Secret</label>
      <div class="iw"><span class="ii">🔑</span>
        <input type="password" name="secret" placeholder="Enter secret…" required autofocus autocomplete="current-password"/>
      </div>
    </div>
    <button type="submit" class="btn">Sign in to Dashboard →</button>
  </form>
  <div class="foot">CP Share Admin Panel · Secured</div>
</div>
</body></html>`, { status: 401, headers: { "Content-Type": "text/html;charset=UTF-8" } });
  }

  // ── Dashboard ────────────────────────────────────────────────
  const secret = c.req.query("secret")!;
  const users = (await c.env.DB.prepare("SELECT * FROM users ORDER BY created_at DESC").all<User>()).results;
  const total    = users.length;
  const pending  = users.filter(u => u.status === "pending").length;
  const approved = users.filter(u => u.status === "approved").length;

  const rows = users.map(u => `
<tr id="row-${u.id}">
  <td><span class="uid">#${u.id}</span></td>
  <td><code class="key">${u.auth_key.slice(0, 12)}…</code></td>
  <td><span class="role-badge">${u.role}</span></td>
  <td><span class="badge ${u.status}">${u.status === "pending" ? "⏳ Pending" : "✅ Approved"}</span></td>
  <td class="date-cell">${new Date(u.created_at).toLocaleString("en-IN",{dateStyle:"medium",timeStyle:"short"})}</td>
  <td>${u.status === "pending" ? `<button class="approve-btn" onclick="approve(${u.id},this)">Approve</button>` : `<span class="done-tag">Active</span>`}</td>
</tr>`).join("");

  return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>CP Share — Admin Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#060818;--s1:#0f1629;--s2:#141d35;--border:rgba(255,255,255,.07);--accent:#7c3aed;--al:#a78bfa;--glow:rgba(124,58,237,.25);--text:#f1f5f9;--muted:#64748b;--pen:#fbbf24;--apr:#34d399;--err:#f87171}
body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
.layout{display:flex;min-height:100vh}

/* Sidebar */
.sidebar{width:220px;background:var(--s1);border-right:1px solid var(--border);display:flex;flex-direction:column;padding:1.5rem 1rem;position:fixed;top:0;left:0;bottom:0;z-index:10}
.brand{display:flex;align-items:center;gap:.5rem;padding:.25rem .5rem;margin-bottom:2rem}
.brand-hex{font-size:1.6rem;filter:drop-shadow(0 0 6px var(--accent))}
.brand-name{font-size:1rem;font-weight:700;background:linear-gradient(135deg,#a78bfa,#7c3aed);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.nav-lbl{font-size:.65rem;font-weight:600;color:var(--muted);letter-spacing:.1em;text-transform:uppercase;padding:0 .5rem;margin-bottom:.5rem}
.nav-item{display:flex;align-items:center;gap:.6rem;padding:.55rem .75rem;border-radius:.5rem;font-size:.875rem;font-weight:500;color:var(--muted);text-decoration:none;transition:background .15s,color .15s;cursor:default}
.nav-item.active{background:rgba(124,58,237,.12);color:var(--al)}
.sfoot{margin-top:auto;padding:.75rem .5rem 0;border-top:1px solid var(--border)}
.logout{display:flex;align-items:center;gap:.5rem;font-size:.8rem;color:var(--muted);text-decoration:none;padding:.4rem .5rem;border-radius:.35rem;transition:color .15s}
.logout:hover{color:var(--err)}

/* Main */
.main{margin-left:220px;flex:1;padding:2rem 2.5rem}
.topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:2rem}
.page-title{font-size:1.4rem;font-weight:700}
.page-sub{font-size:.85rem;color:var(--muted);margin-top:.2rem}
.refresh-btn{display:flex;align-items:center;gap:.4rem;background:var(--s2);border:1px solid var(--border);color:var(--text);padding:.45rem .9rem;border-radius:.5rem;font-size:.8rem;font-family:inherit;cursor:pointer;transition:background .15s,border-color .15s}
.refresh-btn:hover{background:rgba(124,58,237,.15);border-color:var(--accent)}

/* Stat cards */
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin-bottom:2rem}
.stat{background:var(--s1);border:1px solid var(--border);border-radius:.75rem;padding:1.25rem 1.5rem;position:relative;overflow:hidden;animation:fadeIn .3s ease both}
.stat::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;border-radius:1px 1px 0 0}
.stat.total::before{background:linear-gradient(90deg,#7c3aed,#a78bfa)}
.stat.pend::before{background:linear-gradient(90deg,#d97706,#fbbf24)}
.stat.appr::before{background:linear-gradient(90deg,#059669,#34d399)}
.stat-lbl{font-size:.75rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:.4rem}
.stat-val{font-size:2rem;font-weight:700}
.stat.total .stat-val{color:var(--al)}.stat.pend .stat-val{color:var(--pen)}.stat.appr .stat-val{color:var(--apr)}
.stat-icon{position:absolute;right:1rem;top:50%;transform:translateY(-50%);font-size:2rem;opacity:.12}

/* Table card */
.tcard{background:var(--s1);border:1px solid var(--border);border-radius:.75rem;overflow:hidden;animation:fadeIn .4s ease .1s both}
.thead-row{display:flex;align-items:center;justify-content:space-between;padding:1rem 1.5rem;border-bottom:1px solid var(--border)}
.tcard-title{font-size:.9rem;font-weight:600}
.search{padding:.35rem .75rem;background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:.4rem;color:var(--text);font-family:inherit;font-size:.8rem;outline:none;width:180px;transition:border-color .15s}
.search:focus{border-color:var(--accent)}
table{width:100%;border-collapse:collapse}
thead th{background:rgba(255,255,255,.03);padding:.65rem 1.25rem;text-align:left;font-size:.7rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--border)}
tbody tr{border-bottom:1px solid var(--border);transition:background .15s;animation:rowIn .25s ease both}
tbody tr:last-child{border-bottom:none}
tbody tr:hover{background:rgba(255,255,255,.02)}
td{padding:.75rem 1.25rem;font-size:.85rem;vertical-align:middle}
.uid{font-family:monospace;font-size:.8rem;color:var(--muted)}
.key{font-family:'Courier New',monospace;font-size:.78rem;background:rgba(255,255,255,.06);padding:.15rem .4rem;border-radius:.3rem}
.role-badge{font-size:.7rem;font-weight:600;padding:.2rem .55rem;border-radius:.3rem;background:rgba(124,58,237,.15);color:var(--al);text-transform:uppercase;letter-spacing:.05em}
.badge{display:inline-flex;align-items:center;gap:.25rem;font-size:.75rem;font-weight:600;padding:.25rem .65rem;border-radius:9999px}
.badge.pending{background:rgba(251,191,36,.12);color:var(--pen);border:1px solid rgba(251,191,36,.3)}
.badge.approved{background:rgba(52,211,153,.12);color:var(--apr);border:1px solid rgba(52,211,153,.3)}
.date-cell{font-size:.78rem;color:var(--muted)}
.approve-btn{background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;border:none;padding:.35rem .85rem;border-radius:.4rem;font-family:inherit;font-size:.78rem;font-weight:600;cursor:pointer;transition:opacity .15s,transform .1s;box-shadow:0 2px 8px var(--glow)}
.approve-btn:hover{opacity:.85}.approve-btn:active{transform:scale(.96)}.approve-btn:disabled{opacity:.5;cursor:not-allowed}
.done-tag{font-size:.78rem;color:var(--muted)}
.empty{text-align:center;padding:3rem;color:var(--muted);font-size:.9rem}

/* Toast */
.toast{position:fixed;bottom:1.5rem;right:1.5rem;background:#1e293b;border:1px solid var(--border);border-radius:.6rem;padding:.75rem 1.25rem;font-size:.85rem;box-shadow:0 8px 32px rgba(0,0,0,.4);transform:translateY(80px);opacity:0;transition:all .3s cubic-bezier(.16,1,.3,1);z-index:100}
.toast.show{transform:translateY(0);opacity:1}
.toast.success{border-color:rgba(52,211,153,.4);color:var(--apr)}
.toast.error{border-color:rgba(248,113,113,.4);color:var(--err)}

@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes rowIn{from{opacity:0;transform:translateX(-6px)}to{opacity:1}}
</style>
</head>
<body>
<div class="layout">
  <aside class="sidebar">
    <div class="brand"><span class="brand-hex">⬡</span><span class="brand-name">CP Share</span></div>
    <div class="nav-lbl">Management</div>
    <span class="nav-item active">👥&nbsp; Users</span>
    <div class="sfoot"><a class="logout" href="/admin/users">🚪&nbsp; Sign out</a></div>
  </aside>

  <main class="main">
    <div class="topbar">
      <div><div class="page-title">User Management</div><div class="page-sub">Review and approve registered users</div></div>
      <button class="refresh-btn" onclick="location.reload()">↻&nbsp; Refresh</button>
    </div>

    <div class="stats">
      <div class="stat total"><div class="stat-lbl">Total Users</div><div class="stat-val">${total}</div><div class="stat-icon">👤</div></div>
      <div class="stat pend"><div class="stat-lbl">Pending</div><div class="stat-val" id="cnt-pend">${pending}</div><div class="stat-icon">⏳</div></div>
      <div class="stat appr"><div class="stat-lbl">Approved</div><div class="stat-val" id="cnt-appr">${approved}</div><div class="stat-icon">✅</div></div>
    </div>

    <div class="tcard">
      <div class="thead-row">
        <span class="tcard-title">All Users</span>
        <input class="search" type="text" placeholder="🔍  Search…" oninput="filterTable(this.value)"/>
      </div>
      <table id="utbl">
        <thead><tr><th>ID</th><th>Auth Key</th><th>Role</th><th>Status</th><th>Registered</th><th>Action</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="6" class="empty">No users yet.</td></tr>`}</tbody>
      </table>
    </div>
  </main>
</div>
<div class="toast" id="toast"></div>
<script>
const SECRET='${secret.replace(/\\/g,"\\\\").replace(/'/g,"\\'")}';
async function approve(id,btn){
  btn.disabled=true;btn.textContent='Approving…';
  try{
    const res=await fetch('/admin/approve/'+id,{method:'POST',headers:{'X-Admin-Secret':SECRET}});
    const data=await res.json();
    if(res.ok){
      const row=document.getElementById('row-'+id);
      row.querySelector('.badge').className='badge approved';
      row.querySelector('.badge').textContent='✅ Approved';
      btn.parentElement.innerHTML='<span class="done-tag">Active</span>';
      document.getElementById('cnt-pend').textContent=Math.max(0,+document.getElementById('cnt-pend').textContent-1);
      document.getElementById('cnt-appr').textContent=+document.getElementById('cnt-appr').textContent+1;
      toast('✅ User #'+id+' approved!','success');
    }else{btn.disabled=false;btn.textContent='Approve';toast('Error: '+(data.error||'Unknown'),'error');}
  }catch(e){btn.disabled=false;btn.textContent='Approve';toast('Network error','error');}
}
function filterTable(q){
  document.querySelectorAll('#utbl tbody tr').forEach(r=>{r.style.display=r.textContent.toLowerCase().includes(q.toLowerCase())?'':'none';});
}
function toast(msg,type='success'){
  const t=document.getElementById('toast');
  t.textContent=msg;t.className='toast '+type;t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),3000);
}
</script>
</body></html>`, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
});

// ── POST /admin/approve/:id ───────────────────────────────────
app.post("/admin/approve/:id", async (c) => {
  if (!checkAdminSecret(c, false)) return err("Forbidden", 403);
  const id = Number(c.req.param("id"));
  if (Number.isNaN(id)) return err("Invalid id");
  const user = await c.env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(id).first<{ id: number }>();
  if (!user) return err("User not found", 404);
  await c.env.DB.prepare("UPDATE users SET status = 'approved' WHERE id = ?").bind(id).run();
  return ok({ ok: true, message: `User ${id} approved` });
});

// ── 404 ───────────────────────────────────────────────────────
app.notFound((c) => err(`Route not found: ${c.req.path}`, 404));

export default app;
