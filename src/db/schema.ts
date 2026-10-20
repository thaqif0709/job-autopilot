/** Applied on every open; each statement is idempotent. Add new tables or columns at the end. */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id           INTEGER PRIMARY KEY,
  dedupe_key   TEXT NOT NULL UNIQUE,
  company      TEXT NOT NULL,
  title        TEXT NOT NULL,
  location     TEXT NOT NULL,
  remote       INTEGER,
  salary_text  TEXT,
  description  TEXT NOT NULL,
  apply_url    TEXT NOT NULL,
  source       TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  board        TEXT NOT NULL,
  posted_at    TEXT,
  status       TEXT NOT NULL DEFAULT 'found',
  drop_reason  TEXT,
  flags        TEXT NOT NULL DEFAULT '[]',
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_sources (
  job_id     INTEGER NOT NULL REFERENCES jobs(id),
  source     TEXT NOT NULL,
  source_id  TEXT NOT NULL,
  apply_url  TEXT NOT NULL,
  UNIQUE (source, source_id)
);

CREATE TABLE IF NOT EXISTS scores (
  job_id        INTEGER PRIMARY KEY REFERENCES jobs(id),
  total         INTEGER NOT NULL,
  criteria      TEXT NOT NULL,
  summary       TEXT NOT NULL,
  model         TEXT NOT NULL,
  profile_hash  TEXT NOT NULL,
  scored_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY,
  job_id      INTEGER NOT NULL REFERENCES jobs(id),
  rating      TEXT NOT NULL CHECK (rating IN ('good', 'bad')),
  note        TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drafts (
  job_id         INTEGER PRIMARY KEY REFERENCES jobs(id),
  dir            TEXT NOT NULL,
  model          TEXT NOT NULL,
  gaps           INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  approved_at    TEXT,
  approved_hash  TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY,
  job_id       INTEGER NOT NULL REFERENCES jobs(id),
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  note         TEXT,
  at           TEXT NOT NULL
);
`;
