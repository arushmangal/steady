-- Steady — D1 schema
-- Run with: wrangler d1 execute steady --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS topics (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT NOT NULL,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),

  -- SM-2 state
  ef              REAL NOT NULL DEFAULT 2.5,   -- easiness factor, floor 1.3
  interval_days   INTEGER NOT NULL DEFAULT 0,
  repetitions     INTEGER NOT NULL DEFAULT 0,
  next_due        TEXT NOT NULL,               -- ISO date, e.g. 2026-07-15
  last_reviewed   TEXT,

  -- Todoist link
  todoist_task_id    TEXT,
  todoist_project_id TEXT,             -- overrides TODOIST_PROJECT_ID when set

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
CREATE INDEX IF NOT EXISTS idx_reviews_topic_id ON reviews(topic_id);
CREATE INDEX IF NOT EXISTS idx_reviews_reviewed_at ON reviews(reviewed_at);
