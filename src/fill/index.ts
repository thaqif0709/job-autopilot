import path from "node:path";
import type { Browser } from "playwright";
import type { Profile } from "../config.js";
import { getDraft, getJob, type Db } from "../db/index.js";
import { draftHash } from "../draft/draft.js";
import { readApprovedDraft, renderPdfs } from "./documents.js";
import { planFor, type SitePlan } from "./sites.js";

export interface PreparedFill {
  dir: string;
  plan: SitePlan;
}

/**
 * Checks the job is approved and its drafts are unchanged since approval, renders the CV and
 * cover letter PDFs, and returns the plan of fields to fill.
 */
export async function prepareFill(db: Db, jobId: number, profile: Profile, pdfBrowser: Browser): Promise<PreparedFill> {
  const job = getJob(db, jobId);
  if (!["approved", "filled"].includes(job.status)) {
    throw new Error(`Job #${jobId} is "${job.status}". Approve its drafts first with: jobs approve ${jobId}`);
  }
  const draft = getDraft(db, jobId);
  if (!draft?.approved_hash) throw new Error(`Job #${jobId} has no approved drafts.`);
  if (draftHash(draft.dir) !== draft.approved_hash) {
    throw new Error(`The drafts in ${draft.dir} changed after you approved them. Run: jobs approve ${jobId}`);
  }
  const approved = readApprovedDraft(draft.dir);
  const docs = await renderPdfs(pdfBrowser, draft.dir, profile, approved);
  return { dir: draft.dir, plan: planFor(job, profile, approved, docs) };
}

export const screenshotPath = (dir: string, name: "filled" | "confirmation") => path.join(dir, `${name}.png`);
