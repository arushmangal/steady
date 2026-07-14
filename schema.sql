-- Steady — D1 schema
-- Run with: wrangler d1 execute steady --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS categories (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  parent_id          INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  todoist_project_id TEXT,             -- overrides ancestor/global default when set
  archived           INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS topics (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT NOT NULL,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),

  -- Category (optional; arbitrary-depth tree via categories.parent_id)
  category_id     INTEGER REFERENCES categories(id) ON DELETE SET NULL,

  -- SM-2 state
  ef              REAL NOT NULL DEFAULT 2.5,   -- easiness factor, floor 1.3
  interval_days   INTEGER NOT NULL DEFAULT 0,
  repetitions     INTEGER NOT NULL DEFAULT 0,
  next_due        TEXT NOT NULL,               -- ISO date, e.g. 2026-07-15
  last_reviewed   TEXT,

  -- Todoist link
  todoist_task_id    TEXT,
  todoist_project_id TEXT,             -- overrides category/ancestor/global default when set

  archived        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reviews (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id        INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  reviewed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  quality         INTEGER NOT NULL,            -- 0-5 recall rating
  ef_before       REAL NOT NULL,
  ef_after        REAL NOT NULL,
  interval_before INTEGER NOT NULL,
  interval_after  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_topics_next_due ON topics(next_due);
CREATE INDEX IF NOT EXISTS idx_topics_category_id ON topics(category_id);
CREATE INDEX IF NOT EXISTS idx_categories_parent_id ON categories(parent_id);
CREATE INDEX IF NOT EXISTS idx_reviews_topic_id ON reviews(topic_id);
CREATE INDEX IF NOT EXISTS idx_reviews_reviewed_at ON reviews(reviewed_at);
