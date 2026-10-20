import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDraft, getJob, getScore, openDb, setStatus, upsertPosting, type Db } from "../src/db/index.js";
import { approve, runDraft, runFetch, runRank } from "../src/pipeline.js";
import { listJobs, statusCounts } from "../src/track/board.js";
import { facts, fakeHttp, fakeLlm, fixture, GH_LIST, GH_QUESTIONS, LEVER_LIST, profile } from "./helpers.js";

const companies = {
  companies: [
    { name: "Example Co", greenhouse: "exampleco" },
    // Same company on a second board, so its internal-tools posting should merge with the Greenhouse one.
    { name: "Example Co", lever: "anotherco" },
  ],
};
const http = () =>
  fakeHttp({
    [GH_LIST]: fixture("greenhouse-jobs.json"),
    [GH_QUESTIONS]: fixture("greenhouse-questions.json"),
    [LEVER_LIST]: fixture("lever-postings.json"),
  });
const score = (n: number) => {
  const c = { score: n, reason: "quoted" };
  return { roleFit: c, supportBoundary: c, skills: c, pay: c, practicalities: c, summary: `scored ${n}` };
};

let db: Db;
let out: string;
beforeEach(() => {
  db = openDb(":memory:");
  out = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-out-"));
});
afterEach(() => fs.rmSync(out, { recursive: true, force: true }));

describe("pipeline", () => {
  it("fetches, merges duplicates and applies the rules", async () => {
    const r = await runFetch(db, http(), companies, profile());
    expect(r).toMatchObject({ seen: 3, added: 2, dropped: 1, errors: [] });
    const merged = getJob(db, 1);
    expect(merged.flags).toBe('["on-call"]');
    expect(merged.description).toContain("Join the on-call rotation");
    expect(merged.description).toContain("Also posted on lever:\nWe automate workflows");
    expect(merged.salary_text).toBe("MYR 10,000–14,000 per month salary");
    expect(getJob(db, 2)).toMatchObject({ status: "dropped", drop_reason: 'title matches blocked "Sales Engineer"' });

    const again = await runFetch(db, http(), companies, profile());
    expect(again.added).toBe(0);
  });

  it("scores once, and again only when the profile changes", async () => {
    await runFetch(db, http(), companies, profile());
    const llm = fakeLlm([score(4), score(2)]);
    expect(await runRank(db, llm, "m", profile())).toMatchObject({ scored: 1, failed: [] });
    expect(getScore(db, 1)).toMatchObject({ total: 80, summary: "scored 4", model: "m" });
    expect(llm.requests[0]!.prompt).toContain("Flagged phrases: on-call");

    expect((await runRank(db, llm, "m", profile())).scored).toBe(0);
    const changed = profile({ titles: ["Automation Engineer"] });
    expect((await runRank(db, llm, "m", changed)).scored).toBe(1);
    expect(getScore(db, 1)!.total).toBe(40);
  });

  it("re-opens a dropped job when the rule that dropped it is removed", async () => {
    await runFetch(db, http(), companies, profile());
    await runRank(db, fakeLlm([score(3), score(3)]), "m", profile({ blockTitles: [] }));
    expect(getJob(db, 2).status).toBe("found");
    expect(getScore(db, 2)).toBeDefined();
  });

  it("keeps a retitled posting on its job", () => {
    const p = { source: "lever" as const, sourceId: "x", board: "b", company: "C", title: "Dev", location: "KL", remote: null, salaryText: null, description: "d", applyUrl: "https://example.com/x", postedAt: null };
    expect(upsertPosting(db, p)).toEqual({ id: 1, isNew: true });
    expect(upsertPosting(db, { ...p, title: "Platform Dev" })).toEqual({ id: 1, isNew: false });
  });

  it("records a model failure without stopping the run", async () => {
    upsertPosting(db, { source: "lever", sourceId: "x", board: "b", company: "C", title: "Dev", location: "Kuala Lumpur", remote: null, salaryText: null, description: "d", applyUrl: "https://example.com/x", postedAt: null });
    upsertPosting(db, { source: "lever", sourceId: "y", board: "b", company: "C", title: "Dev two", location: "Kuala Lumpur", remote: null, salaryText: null, description: "d", applyUrl: "https://example.com/y", postedAt: null });
    const r = await runRank(db, fakeLlm([new Error("declined"), score(5)]), "m", profile());
    expect(r).toEqual({ scored: 1, failed: [{ id: 1, message: "declined" }], remaining: 0 });
  });

  it("drafts a shortlisted job, then approves only once gaps are handled", async () => {
    await runFetch(db, http(), companies, profile());
    await expect(runDraft(db, fakeLlm([]), http(), "m", out, 1, profile(), facts)).rejects.toThrow(/Shortlist it first/);
    setStatus(db, 1, "shortlisted");

    const llm = fakeLlm([
      {
        cvSummary: [{ text: "Developer since 2021.", factIds: ["exp-current"] }],
        cvOrder: ["auto-builds", "exp-current"],
        coverLetter: [{ sentences: [{ text: "I halved deploy time.", factIds: [] }] }],
        answers: [{ question: "Why do you want to build internal tools?", sentences: [{ text: "I already do.", factIds: ["auto-builds"] }] }],
      },
    ]);
    const r = await runDraft(db, llm, http(), "m", out, 1, profile(), facts);
    expect(r).toMatchObject({ gaps: 1, questions: 2 });
    // The authorisation question is answered from the profile, so only one question reaches the model.
    expect(llm.requests[0]!.prompt).toContain("1. Why do you want to build internal tools?");
    expect(llm.requests[0]!.prompt).not.toContain("authorised");
    const answers = fs.readFileSync(path.join(r.dir, "answers.md"), "utf8");
    expect(answers).toContain("## Are you authorised to work in Malaysia? (from profile.yaml)\n\nYes, Malaysian citizen.");
    expect(getJob(db, 1).status).toBe("drafted");

    expect(() => approve(db, 1)).toThrow(/1 gap/);
    fs.writeFileSync(path.join(r.dir, "gaps.md"), "# Gaps\n\nHandled.\n");
    const a = approve(db, 1);
    expect(getDraft(db, 1)!.approved_hash).toBe(a.hash);
    expect(getJob(db, 1).status).toBe("approved");
    expect(statusCounts(db)).toMatchObject({ approved: 1, dropped: 1 });
  });

  it("lists open jobs best score first", async () => {
    await runFetch(db, http(), companies, profile());
    await runRank(db, fakeLlm([score(1), score(5)]), "m", profile({ blockTitles: [] }));
    expect(listJobs(db).map((r) => [r.id, r.total])).toEqual([
      [2, 100],
      [1, 20],
    ]);
  });
});
