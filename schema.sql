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
  todoist_task_id    TEXT,             -- the CURRENT cycle's outstanding revision task, if pushed
  todoist_project_id TEXT,             -- overrides category/ancestor/global default when set

  -- Permanent, write-once provenance for topics created via the inbound
  -- Todoist import (a task labelled STEADY_IMPORT_LABEL). Deliberately
  -- separate from todoist_task_id above: that column is the current
  -- cycle's outstanding *revision* task and starts NULL on import, so
  -- pushToTodoist's "already pushed, skip" guard doesn't confuse the
  -- original capture task for the topic's first real revision task.
  source_todoist_task_id TEXT,

  archived        INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_source_todoist_task_id
  ON topics(source_todoist_task_id) WHERE source_todoist_task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS reviews (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id        INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  reviewed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  quality         INTEGER NOT NULL,            -- 0-5 recall rating
  ef_before       REAL NOT NULL,
  ef_after        REAL NOT NULL,
  interval_before INTEGER NOT NULL,
  interval_after  INTEGER NOT NULL,

  -- Undo support (nullable — rows recorded before this feature existed have
  -- these as NULL, which is how the undo route tells "too old to undo"
  -- apart from a topic's legitimate first-ever review, where
  -- last_reviewed_before is also NULL but for a real reason)
  repetitions_before   INTEGER,
  next_due_before      TEXT,
  last_reviewed_before TEXT
);

CREATE INDEX IF NOT EXISTS idx_topics_next_due ON topics(next_due);
CREATE INDEX IF NOT EXISTS idx_topics_category_id ON topics(category_id);
CREATE INDEX IF NOT EXISTS idx_categories_parent_id ON categories(parent_id);
CREATE INDEX IF NOT EXISTS idx_reviews_topic_id ON reviews(topic_id);
CREATE INDEX IF NOT EXISTS idx_reviews_reviewed_at ON reviews(reviewed_at);

-- One row per cron-driven Todoist operation per run, so a silent failure
-- (like the REST v2 decommission this project already hit once) shows up
-- in the UI instead of only in a console.error nobody's watching.
CREATE TABLE IF NOT EXISTS sync_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at     TEXT NOT NULL DEFAULT (datetime('now')),
  operation  TEXT NOT NULL,              -- 'push' | 'import' | 'completion_sync'
  ok         INTEGER NOT NULL,           -- did the operation run without throwing
  succeeded  INTEGER NOT NULL DEFAULT 0, -- per-item success count within the run
  failed     INTEGER NOT NULL DEFAULT 0,
  detail     TEXT                        -- last error message, if any
);
CREATE INDEX IF NOT EXISTS idx_sync_log_operation_id ON sync_log(operation, id);
