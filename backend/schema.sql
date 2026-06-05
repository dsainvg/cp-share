-- ============================================================
-- CP Share — D1 Schema
-- Run: wrangler d1 execute cp-share-db --file=schema.sql
-- ============================================================

-- ── Users ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER  PRIMARY KEY AUTOINCREMENT,
  auth_key   TEXT     NOT NULL UNIQUE,
  username   TEXT     NOT NULL DEFAULT '',
  role       TEXT     NOT NULL DEFAULT 'user'    CHECK (role IN ('user', 'admin')),
  status     TEXT     NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved')),
  created_at DATETIME NOT NULL DEFAULT (datetime('now'))
);

-- Migration for existing databases (safe to run, ignored if column already exists)
-- Run manually if upgrading: wrangler d1 execute cpques_db --command="ALTER TABLE users ADD COLUMN username TEXT NOT NULL DEFAULT ''" --remote

-- ── Posts ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS posts (
  id              INTEGER  PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER  NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title           TEXT     NOT NULL,
  body            TEXT     NOT NULL,
  code_content    TEXT,
  language        TEXT,
  link            TEXT,
  problem_type    TEXT     NOT NULL DEFAULT 'other' CHECK (problem_type IN ('leetcode', 'atcoder-cf', 'other')),
  expected_input  TEXT,
  expected_output TEXT,
  created_at      DATETIME NOT NULL DEFAULT (datetime('now'))
);

-- Migration for existing databases:
-- wrangler d1 execute cpques_db --command="ALTER TABLE posts ADD COLUMN link TEXT" --remote
-- wrangler d1 execute cpques_db --command="ALTER TABLE posts ADD COLUMN problem_type TEXT NOT NULL DEFAULT 'other'" --remote
-- wrangler d1 execute cpques_db --command="ALTER TABLE posts ADD COLUMN expected_input TEXT" --remote
-- wrangler d1 execute cpques_db --command="ALTER TABLE posts ADD COLUMN expected_output TEXT" --remote

CREATE INDEX IF NOT EXISTS idx_posts_user_id    ON posts (user_id);
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts (created_at DESC);

-- ── Comments ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comments (
  id           INTEGER  PRIMARY KEY AUTOINCREMENT,
  post_id      INTEGER  NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  user_id      INTEGER  NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  body         TEXT     NOT NULL,
  code_content TEXT,
  language     TEXT,
  created_at   DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_comments_post_id    ON comments (post_id);
CREATE INDEX IF NOT EXISTS idx_comments_created_at ON comments (created_at DESC);
