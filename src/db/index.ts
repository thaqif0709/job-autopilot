import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Posting, Status } from "../types.js";
import { dedupeKey } from "../sources/dedupe.js";
import { SCHEMA } from "./schema.js";

export type Db = Database.Database;

export interface JobRow {
  id: number;
  dedupe_key: string;
  company: string;
  title: string;
  location: string;
  remote: number | null;
  salary_text: string | null;
  description: string;
  apply_url: string;
  source: Posting["source"];
  source_id: string;
  board: string;
  posted_at: string | null;
  status: Status;
  drop_reason: string | null;
  flags: string;
  first_seen: string;
  last_seen: string;
}

export interface ScoreRow {
  job_id: number;
  total: number;
  criteria: string;
  summary: string;
  model: string;
  profile_hash: string;
  scored_at: string;
}

const now = () => new Date().toISOString();

/** Opens (and creates if needed) the database. Pass ":memory:" in tests. */
export function openDb(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

/**
 * Inserts a new posting or refreshes an existing one. A posting already seen from another source
 * (for example an alert email for a Greenhouse job) merges into the same job.
 */
export function upsertPosting(db: Db, p: Posting): { id: number; isNew: boolean } {
  const key = dedupeKey(p.company, p.title, p.location);
  const ts = now();
  return db.transaction(() => {
    // A posting retitled on its board keeps its source id, so it still finds its job.
    const existing = (db.prepare("SELECT id FROM jobs WHERE dedupe_key = ?").get(key) ??
      db.prepare("SELECT job_id AS id FROM job_sources WHERE source = ? AND source_id = ?").get(p.source, p.sourceId)) as
      | { id: number }
      | undefined;
    let id: number;
    if (existing) {
      id = existing.id;
      const linked = db
        .prepare("INSERT OR IGNORE INTO job_sources (job_id, source, source_id, apply_url) VALUES (?, ?, ?, ?)")
        .run(id, p.source, p.sourceId, p.applyUrl).changes;
      // A second source for the same job adds its text rather than replacing it, so nothing
      // either posting says (an on-call line, a pay range) is lost.
      db.prepare(
        `UPDATE jobs SET last_seen = ?, salary_text = COALESCE(salary_text, ?),
           description = CASE WHEN ? = 1 AND instr(description, ?) = 0
             THEN description || char(10) || char(10) || 'Also posted on ' || ? || ':' || char(10) || ? ELSE description END
         WHERE id = ?`,
      ).run(ts, p.salaryText, linked, p.description, p.source, p.description, id);
    } else {
      const info = db
        .prepare(
          `INSERT INTO jobs (dedupe_key, company, title, location, remote, salary_text, description, apply_url,
             source, source_id, board, posted_at, first_seen, last_seen)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          key,
          p.company,
          p.title,
          p.location,
          p.remote === null ? null : Number(p.remote),
          p.salaryText,
          p.description,
          p.applyUrl,
          p.source,
          p.sourceId,
          p.board,
          p.postedAt,
          ts,
          ts,
        );
      id = Number(info.lastInsertRowid);
      db.prepare("INSERT INTO job_sources (job_id, source, source_id, apply_url) VALUES (?, ?, ?, ?)").run(
        id,
        p.source,
        p.sourceId,
        p.applyUrl,
      );
      logEvent(db, id, null, "found");
    }
    return { id, isNew: !existing };
  })();
}

export function getJob(db: Db, id: number): JobRow {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
  if (!row) throw new Error(`No job with id ${id}`);
  return row;
}

export function getScore(db: Db, id: number): ScoreRow | undefined {
  return db.prepare("SELECT * FROM scores WHERE job_id = ?").get(id) as ScoreRow | undefined;
}

function logEvent(db: Db, jobId: number, from: Status | null, to: Status, note?: string) {
  db.prepare("INSERT INTO events (job_id, from_status, to_status, note, at) VALUES (?, ?, ?, ?, ?)").run(
    jobId,
    from,
    to,
    note ?? null,
    now(),
  );
}

/** Moves a job to a new status and records the change. */
export function setStatus(db: Db, jobId: number, to: Status, note?: string) {
  const job = getJob(db, jobId);
  if (job.status === to) return;
  db.transaction(() => {
    db.prepare("UPDATE jobs SET status = ? WHERE id = ?").run(to, jobId);
    logEvent(db, jobId, job.status, to, note);
  })();
}

export function setRuleResult(db: Db, jobId: number, dropReason: string | null, flags: string[]) {
  db.prepare("UPDATE jobs SET drop_reason = ?, flags = ? WHERE id = ?").run(dropReason, JSON.stringify(flags), jobId);
  const job = getJob(db, jobId);
  if (dropReason && job.status === "found") setStatus(db, jobId, "dropped", dropReason);
}

export function saveScore(db: Db, row: Omit<ScoreRow, "scored_at">) {
  db.prepare(
    `INSERT INTO scores (job_id, total, criteria, summary, model, profile_hash, scored_at)
     VALUES (@job_id, @total, @criteria, @summary, @model, @profile_hash, @scored_at)
     ON CONFLICT (job_id) DO UPDATE SET total = excluded.total, criteria = excluded.criteria,
       summary = excluded.summary, model = excluded.model, profile_hash = excluded.profile_hash,
       scored_at = excluded.scored_at`,
  ).run({ ...row, scored_at: now() });
}

export function addFeedback(db: Db, jobId: number, rating: "good" | "bad", note?: string) {
  getJob(db, jobId);
  db.prepare("INSERT INTO feedback (job_id, rating, note, created_at) VALUES (?, ?, ?, ?)").run(
    jobId,
    rating,
    note ?? null,
    now(),
  );
}

export function recentFeedback(db: Db, limit = 8) {
  return db
    .prepare(
      `SELECT j.company, j.title, f.rating, f.note FROM feedback f JOIN jobs j ON j.id = f.job_id
       ORDER BY f.id DESC LIMIT ?`,
    )
    .all(limit) as { company: string; title: string; rating: "good" | "bad"; note: string | null }[];
}

export interface DraftRow {
  job_id: number;
  dir: string;
  model: string;
  gaps: number;
  created_at: string;
  approved_at: string | null;
  approved_hash: string | null;
}

export function saveDraft(db: Db, jobId: number, dir: string, model: string, gaps: number) {
  db.prepare(
    `INSERT INTO drafts (job_id, dir, model, gaps, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (job_id) DO UPDATE SET dir = excluded.dir, model = excluded.model, gaps = excluded.gaps,
       created_at = excluded.created_at, approved_at = NULL, approved_hash = NULL`,
  ).run(jobId, dir, model, gaps, now());
}

export function getDraft(db: Db, jobId: number): DraftRow | undefined {
  return db.prepare("SELECT * FROM drafts WHERE job_id = ?").get(jobId) as DraftRow | undefined;
}

export function markApproved(db: Db, jobId: number, hash: string) {
  db.prepare("UPDATE drafts SET approved_at = ?, approved_hash = ? WHERE job_id = ?").run(now(), hash, jobId);
}
