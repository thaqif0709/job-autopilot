import path from "node:path";
import { hashOf, type Companies, type Facts, type Profile } from "./config.js";
import {
  getDraft,
  getJob,
  getScore,
  markApproved,
  recentFeedback,
  saveDraft,
  saveScore,
  setRuleResult,
  setStatus,
  upsertPosting,
  type Db,
  type JobRow,
} from "./db/index.js";
import { draftHash, generateDraft, openGaps, writeDraft } from "./draft/draft.js";
import type { Llm } from "./llm.js";
import { applyRules } from "./rank/rules.js";
import { RUBRIC } from "./rank/rubric.js";
import { scoreJob } from "./rank/score.js";
import { fetchGreenhouseQuestions } from "./sources/greenhouse.js";
import type { Http } from "./sources/http.js";
import { fetchAll, type FetchResult } from "./sources/index.js";

const ruleInput = (j: JobRow) => ({ title: j.title, location: j.location, remote: j.remote === null ? null : j.remote === 1, description: j.description });

/** Stage 1: fetch every board, add any postings read from alert emails, store new ones, and run the pass-1 rules on them. */
export async function runFetch(db: Db, http: Http, companies: Companies, profile: Profile, fromEmail?: FetchResult) {
  const boards = await fetchAll(http, companies.companies);
  const postings = [...boards.postings, ...(fromEmail?.postings ?? [])];
  const errors = [...boards.errors, ...(fromEmail?.errors ?? [])];
  let added = 0;
  let dropped = 0;
  for (const p of postings) {
    const { id, isNew } = upsertPosting(db, p);
    if (!isNew) continue;
    added++;
    const rules = applyRules(ruleInput(getJob(db, id)), profile);
    setRuleResult(db, id, rules.drop, rules.flags);
    if (rules.drop) dropped++;
  }
  return { seen: postings.length, added, dropped, errors };
}

export const profileHash = (profile: Profile) => hashOf(profile, RUBRIC);

/** Stage 2: score open jobs that have no score yet, or whose score came from an older profile or rubric. */
export async function runRank(
  db: Db,
  llm: Llm,
  model: string,
  profile: Profile,
  opts: { all?: boolean; limit?: number; onProgress?: (msg: string) => void } = {},
) {
  const hash = profileHash(profile);
  // Rules are re-applied first, so a profile change also updates what is dropped.
  const open = db.prepare("SELECT * FROM jobs WHERE status IN ('found', 'dropped', 'shortlisted') ORDER BY id").all() as JobRow[];
  for (const j of open) {
    const rules = applyRules(ruleInput(j), profile);
    db.prepare("UPDATE jobs SET drop_reason = ?, flags = ? WHERE id = ?").run(rules.drop, JSON.stringify(rules.flags), j.id);
    if (rules.drop && j.status === "found") setStatus(db, j.id, "dropped", rules.drop);
    if (!rules.drop && j.status === "dropped" && j.drop_reason) setStatus(db, j.id, "found", "no longer matches a drop rule");
  }

  const todo = (db.prepare("SELECT * FROM jobs WHERE status IN ('found', 'shortlisted') ORDER BY id").all() as JobRow[]).filter(
    (j) => opts.all || getScore(db, j.id)?.profile_hash !== hash,
  );
  const ratings = recentFeedback(db);
  const batch = opts.limit ? todo.slice(0, opts.limit) : todo;
  let scored = 0;
  const failed: { id: number; message: string }[] = [];
  for (const j of batch) {
    opts.onProgress?.(`Scoring #${j.id} ${j.title} at ${j.company}`);
    try {
      const r = await scoreJob(
        llm,
        model,
        { company: j.company, title: j.title, location: j.location, salaryText: j.salary_text, description: j.description, flags: JSON.parse(j.flags) as string[] },
        profile,
        ratings,
      );
      saveScore(db, {
        job_id: j.id,
        total: r.total,
        criteria: JSON.stringify(r.output),
        summary: r.output.summary,
        model: r.model,
        profile_hash: hash,
      });
      scored++;
    } catch (e) {
      failed.push({ id: j.id, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return { scored, failed, remaining: todo.length - batch.length };
}

/** Stage 3: draft the CV summary, cover letter and screening answers for one job. */
export async function runDraft(
  db: Db,
  llm: Llm,
  http: Http,
  model: string,
  outDir: string,
  jobId: number,
  profile: Profile,
  facts: Facts,
) {
  const job = getJob(db, jobId);
  if (!["shortlisted", "drafted", "approved"].includes(job.status)) {
    throw new Error(`Job #${jobId} is "${job.status}". Shortlist it first with: jobs shortlist ${jobId}`);
  }
  const questions = job.source === "greenhouse" ? await fetchGreenhouseQuestions(http, job.board, job.source_id) : [];
  const { draft, raw, model: servedBy } = await generateDraft(llm, model, job, profile, facts, questions);
  const dir = path.join(outDir, String(jobId));
  writeDraft(dir, job, draft, raw, facts);
  saveDraft(db, jobId, dir, servedBy, draft.gaps.length);
  setStatus(db, jobId, "drafted");
  return { dir, gaps: draft.gaps.length, questions: questions.length };
}

/** Locks the current draft files as the version later steps will use. Refuses while gaps.md still lists gaps. */
export function approve(db: Db, jobId: number, opts: { force?: boolean } = {}) {
  const draft = getDraft(db, jobId);
  if (!draft) throw new Error(`Job #${jobId} has no draft yet. Run: jobs draft ${jobId}`);
  const gaps = openGaps(draft.dir);
  if (gaps.length && !opts.force) {
    throw new Error(`${gaps.length} gap(s) still listed in ${path.join(draft.dir, "gaps.md")}. Handle them and delete the lines, or pass --force.`);
  }
  const hash = draftHash(draft.dir);
  markApproved(db, jobId, hash);
  setStatus(db, jobId, "approved");
  return { dir: draft.dir, hash };
}
