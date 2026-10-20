#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { Command, InvalidArgumentError } from "commander";
import { chromium } from "playwright";
import { loadCompanies, loadFacts, loadProfile } from "./config.js";
import { addFeedback, getDraft, getJob, getScore, openDb, setStatus } from "./db/index.js";
import { claudeLlm, draftModel, scoreModel } from "./llm.js";
import { fillForm, findBlocker } from "./fill/filler.js";
import { prepareFill, screenshotPath } from "./fill/index.js";
import { approve, runDraft, runFetch, runRank } from "./pipeline.js";
import { CRITERIA, type ScoreOutput } from "./rank/score.js";
import { cachedResolver } from "./sources/email.js";
import { emailPostings, gmailLogin, readGmail } from "./sources/gmail.js";
import { cachedHttp } from "./sources/http.js";
import { formatTable, listJobs, statusCounts } from "./track/board.js";
import { STATUSES, type Status } from "./types.js";
import { paths } from "./paths.js";

const p = paths();
const db = () => openDb(p.db);
const http = () => cachedHttp(p.cache);

const int = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError("expected a whole number");
  return n;
};
const status = (v: string) => {
  if (!(STATUSES as readonly string[]).includes(v)) throw new InvalidArgumentError(`one of: ${STATUSES.join(", ")}`);
  return v as Status;
};

const program = new Command()
  .name("jobs")
  .description("Find, rank and draft job applications. It never submits anything: you do.");

program
  .command("fetch")
  .description("Fetch postings from the boards in config/companies.yaml and from LinkedIn and Jobstreet alert emails")
  .option("--eml <files...>", "also read job alerts from these saved .eml files")
  .option("--no-gmail", "skip Gmail even when it is set up in .env")
  .option("--days <n>", "how many days of Gmail to read", int, 14)
  .action(async (o: { eml?: string[]; gmail: boolean; days: number }) => {
    const emails: { name: string; raw: Buffer }[] = (o.eml ?? []).map((f) => ({ name: path.basename(f), raw: fs.readFileSync(f) }));
    const login = o.gmail ? gmailLogin() : null;
    if (login) {
      const raw = await readGmail(login, o.days);
      emails.push(...raw.map((r, i) => ({ name: `Gmail message ${i + 1}`, raw: r })));
    }
    const fromEmail = emails.length ? await emailPostings(emails, cachedResolver(p.redirects)) : undefined;
    // Boards are optional once alert emails are coming in.
    const companies = fromEmail && !fs.existsSync(p.companies) ? { companies: [] } : loadCompanies(p.companies);
    const r = await runFetch(db(), http(), companies, loadProfile(p.profile), fromEmail);
    if (fromEmail) console.log(`Read ${fromEmail.read} emails and found ${fromEmail.postings.length} job cards in them.`);
    else if (o.gmail) console.log("Gmail is not set up, so only the boards were read (see README: Gmail job alerts).");
    console.log(`Seen ${r.seen} postings: ${r.added} new, ${r.dropped} of them dropped by your rules.`);
    for (const e of r.errors) console.warn(`  ${e.company} (${e.source}): ${e.message}`);
    if (r.added - r.dropped > 0) console.log("Next: jobs rank");
  });

program
  .command("rank")
  .description("Score open jobs against your profile (only new jobs, or all after a profile change)")
  .option("--all", "re-score every open job")
  .option("--limit <n>", "score at most n jobs this run (each one is a model call)", int, 50)
  .action(async (o: { all?: boolean; limit: number }) => {
    const r = await runRank(db(), claudeLlm(), scoreModel(), loadProfile(p.profile), {
      ...o,
      onProgress: (m) => console.log(m),
    });
    console.log(`Scored ${r.scored}.${r.remaining ? ` ${r.remaining} left for the next run.` : ""}`);
    for (const f of r.failed) console.warn(`  #${f.id}: ${f.message}`);
    if (r.scored) console.log("Next: jobs list");
  });

program
  .command("list")
  .description("Show jobs, best score first")
  .option("--status <status>", "only this status", status)
  .option("--min <score>", "only scores at or above this", int)
  .option("--limit <n>", "how many rows", int, 30)
  .action((o: { status?: Status; min?: number; limit: number }) => console.log(formatTable(listJobs(db(), o))));

program
  .command("show <id>")
  .description("Show one job with its score breakdown")
  .action((id: string) => {
    const d = db();
    const j = getJob(d, int(id));
    const s = getScore(d, j.id);
    console.log(`#${j.id} ${j.title} at ${j.company}\n${j.location || "location not stated"} · ${j.status}\n${j.apply_url}`);
    if (j.salary_text) console.log(`Pay: ${j.salary_text}`);
    if (j.drop_reason) console.log(`Dropped: ${j.drop_reason}`);
    const flags = JSON.parse(j.flags) as string[];
    if (flags.length) console.log(`Flagged phrases: ${flags.join("; ")}`);
    if (s) {
      const c = JSON.parse(s.criteria) as ScoreOutput;
      console.log(`\nScore ${s.total}/100 (${s.model})\n${s.summary}`);
      for (const k of CRITERIA) console.log(`  ${k.padEnd(16)} ${c[k].score}/5  ${c[k].reason}`);
    }
    const draft = getDraft(d, j.id);
    if (draft) console.log(`\nDrafts: ${draft.dir}${draft.approved_at ? ` (approved ${draft.approved_at})` : ""}`);
  });

program
  .command("shortlist <ids...>")
  .description("Mark jobs you want to apply to")
  .action((ids: string[]) => {
    const d = db();
    for (const id of ids) setStatus(d, int(id), "shortlisted");
    console.log(`Shortlisted ${ids.join(", ")}. Next: jobs draft <id>`);
  });

program
  .command("close <ids...>")
  .description("Close jobs you are not pursuing")
  .action((ids: string[]) => {
    const d = db();
    for (const id of ids) setStatus(d, int(id), "closed");
  });

program
  .command("rate <id> <rating> [note...]")
  .description("Rate a job good or bad; recent ratings guide future scoring")
  .action((id: string, rating: string, note: string[]) => {
    if (rating !== "good" && rating !== "bad") throw new InvalidArgumentError("rating is good or bad");
    addFeedback(db(), int(id), rating, note.join(" ") || undefined);
  });

program
  .command("draft <id>")
  .description("Draft the CV summary, cover letter and screening answers for a shortlisted job")
  .action(async (id: string) => {
    const r = await runDraft(db(), claudeLlm(), http(), draftModel(), p.out, int(id), loadProfile(p.profile), loadFacts(p.facts));
    console.log(`Drafts written to ${r.dir} (${r.questions} screening question(s)).`);
    console.log(r.gaps ? `${r.gaps} gap(s) need you: see gaps.md.` : "No gaps.");
    console.log(`Edit the files, then: jobs approve ${id}`);
  });

program
  .command("approve <id>")
  .description("Lock the edited drafts as the version to use")
  .option("--force", "approve even if gaps.md still lists gaps")
  .action((id: string, o: { force?: boolean }) => {
    const r = approve(db(), int(id), o);
    console.log(`Approved the drafts in ${r.dir}.`);
  });

// Set JOBS_CHROMIUM to use an installed Chrome or Chromium instead of Playwright's own download.
const executablePath = () => process.env.JOBS_CHROMIUM || undefined;

program
  .command("fill <id>")
  .description("Open the application form, fill it from the approved drafts, and leave Submit to you")
  .action(async (id: string) => {
    const d = db();
    const jobId = int(id);
    const pdfBrowser = await chromium.launch({ executablePath: executablePath() });
    const prepared = await prepareFill(d, jobId, loadProfile(p.profile), pdfBrowser).finally(() => pdfBrowser.close());
    const context = await chromium.launchPersistentContext(p.browserProfile, { headless: false, executablePath: executablePath(), viewport: null });
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(prepared.plan.url, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => undefined);
      const blocker = await findBlocker(page);
      if (blocker) {
        console.log(`Stopped: ${blocker}. Deal with it in the browser, then run: jobs fill ${jobId}`);
        await rl.question("Press Enter to close the browser. ");
        return;
      }
      const r = await fillForm(page, prepared.plan);
      await page.screenshot({ path: screenshotPath(prepared.dir, "filled"), fullPage: true });
      setStatus(d, jobId, "filled");
      console.log(`Filled: ${r.filled.join(", ") || "nothing"}`);
      for (const m of r.missing) console.log(`  Needs you: ${m.name} (${m.reason})`);
      if (r.requiredEmpty.length) console.log(`  Required and still empty: ${r.requiredEmpty.join("; ")}`);
      console.log("\nFields that need you are outlined in orange. Check the whole form, then click Submit yourself.");
      const answer = await rl.question("When the confirmation page shows, press Enter to save it. Type q to close without marking it submitted. ");
      if (answer.trim().toLowerCase() !== "q") {
        await page.screenshot({ path: screenshotPath(prepared.dir, "confirmation"), fullPage: true });
        setStatus(d, jobId, "submitted", "confirmation screenshot saved");
        console.log(`Marked submitted. Confirmation saved to ${screenshotPath(prepared.dir, "confirmation")}.`);
      }
    } finally {
      rl.close();
      await context.close();
    }
  });

for (const [name, to, about] of [
  ["submitted", "submitted", "Mark a job as submitted (when you applied outside jobs fill)"],
  ["replied", "replied", "Mark that the employer replied"],
] as const) {
  program
    .command(`${name} <id> [note...]`)
    .description(about)
    .action((id: string, note: string[]) => setStatus(db(), int(id), to, note.join(" ") || undefined));
}

program
  .command("board")
  .description("Count jobs at each status")
  .action(() => {
    const counts = statusCounts(db());
    for (const s of STATUSES) console.log(`${s.padEnd(12)} ${counts[s]}`);
  });

program.parseAsync().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
