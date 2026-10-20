import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDraft, openDb, saveDraft, setStatus, upsertPosting, markApproved, type Db } from "../src/db/index.js";
import { draftHash } from "../src/draft/draft.js";
import { coverLetterHtml, cvHtml, readApprovedDraft, renderPdfs, type ApprovedDraft } from "../src/fill/documents.js";
import { chooseOption, fillForm, findBlocker } from "../src/fill/filler.js";
import { looksLikeSubmit, safeClick, SubmitGuardError } from "../src/fill/guard.js";
import { prepareFill } from "../src/fill/index.js";
import { planFor } from "../src/fill/sites.js";
import { ProfileSchema } from "../src/config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const formUrl = (name: string) => pathToFileURL(path.join(here, "fixtures", name)).href;

const profile = ProfileSchema.parse({
  name: "Ahmad Thaqif bin Example",
  firstName: "Ahmad Thaqif",
  lastName: "bin Example",
  email: "test@example.com",
  phone: "+60 12 345 6789",
  links: { LinkedIn: "https://www.linkedin.com/in/test", github: "https://github.com/test" },
  targets: {},
});
const approved: ApprovedDraft = {
  cvSummary: "Developer since 2021 who builds internal tools.",
  cvEntries: ["Developer at Example Ltd since 2021.", "Built build automations used by a team of 8."],
  coverLetter: "Dear hiring team,\n\nI build tools for colleagues.",
  answers: [
    { question: "Why do you want to build internal tools?", answer: "I already do." },
    { question: "Are you authorised to work in Malaysia?", answer: "Yes, Malaysian citizen." },
  ],
};

let browser: Browser;
let tmp: string;
beforeAll(async () => {
  browser = await chromium.launch({ executablePath: process.env.JOBS_CHROMIUM || undefined });
});
afterAll(async () => browser?.close());
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-fill-"));
});

const docs = () => {
  const cv = path.join(tmp, "cv.pdf");
  const coverLetter = path.join(tmp, "cover-letter.pdf");
  fs.writeFileSync(cv, "%PDF-1.4 test");
  fs.writeFileSync(coverLetter, "%PDF-1.4 test");
  return { cv, coverLetter };
};

describe("submit guard", () => {
  it("recognises anything that could send the form", async () => {
    const page = await browser.newPage();
    await page.setContent(`<form>
      <button id=a>Next</button><button id=b type=button>Add another</button><input id=c type=submit value=Go>
      <a id=d href="#">Apply now</a><span id=e role=option>Yes</span></form>`);
    const check = (id: string) => looksLikeSubmit(page.locator(`#${id}`));
    expect(await check("a")).toBe(true); // a bare <button> in a form submits it
    expect(await check("b")).toBe(false);
    expect(await check("c")).toBe(true);
    expect(await check("d")).toBe(true);
    expect(await check("e")).toBe(false);
    await expect(safeClick(page.locator("#c"))).rejects.toBeInstanceOf(SubmitGuardError);
    await page.close();
  });

  it("is the only code that clicks, presses keys or submits", () => {
    const src = path.join(here, "..", "src");
    const files = fs.readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
    const offenders = files
      .filter((f) => path.basename(f) !== "guard.ts")
      .filter((f) => /\.(click|dblclick|tap|press|pressSequentially|submit|requestSubmit|dispatchEvent)\(|keyboard\.|mouse\./.test(fs.readFileSync(path.join(src, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("chooseOption", () => {
  it("matches answers to option labels", () => {
    expect(chooseOption(["Select...", "Yes", "No"], "Yes, Malaysian citizen.")).toBe("Yes");
    expect(chooseOption(["Select...", "Yes", "No"], "no")).toBe("No");
    expect(chooseOption(["1 month", "2 months", "3 months"], "My notice period is 2 months")).toBe("2 months");
    expect(chooseOption(["Yes", "No"], "Maybe later")).toBeUndefined();
  });
});

describe("fillForm", () => {
  it("fills a Greenhouse form, leaves the rest outlined, and never submits", async () => {
    const page = await browser.newPage();
    const plan = planFor({ source: "greenhouse", board: "exampleco", source_id: "1", apply_url: "x" }, profile, approved, docs());
    expect(plan.url).toBe("https://job-boards.greenhouse.io/exampleco/jobs/1");
    await page.goto(formUrl("greenhouse-form.html"));
    const r = await fillForm(page, plan);

    expect(await page.inputValue("#first_name")).toBe("Ahmad Thaqif");
    expect(await page.inputValue("#last_name")).toBe("bin Example");
    expect(await page.inputValue("#question_1")).toBe("https://www.linkedin.com/in/test");
    expect(await page.inputValue("#question_2")).toBe("I already do.");
    expect(await page.locator("#question_3").evaluate((s: HTMLSelectElement) => s.selectedOptions[0]?.text)).toBe("Yes");
    expect(await page.locator("#resume").evaluate((i: HTMLInputElement) => i.files?.[0]?.name)).toBe("cv.pdf");
    expect(r.missing).toEqual([
      { name: "GitHub", reason: "not on this form" },
    ]);
    expect(r.requiredEmpty).toEqual(["I agree to the privacy notice *"]);
    expect(await page.evaluate(() => [(window as any).submits ?? 0, (window as any).clicks ?? 0])).toEqual([0, 0]);
    await page.close();
  });

  it("fills a Lever form with the cover letter as text", async () => {
    const page = await browser.newPage();
    const plan = planFor(
      { source: "lever", board: "anotherco", source_id: "abc", apply_url: "https://jobs.lever.co/anotherco/abc/" },
      profile,
      approved,
      docs(),
    );
    expect(plan.url).toBe("https://jobs.lever.co/anotherco/abc/apply");
    await page.goto(formUrl("lever-form.html"));
    const r = await fillForm(page, plan);
    expect(await page.inputValue('input[name="name"]')).toBe("Ahmad Thaqif bin Example");
    expect(await page.inputValue('input[name="urls[GitHub]"]')).toBe("https://github.com/test");
    expect(await page.inputValue('textarea[name="comments"]')).toBe(approved.coverLetter);
    expect(r.missing.map((m) => m.name)).toEqual(["Why do you want to build internal tools?", "Are you authorised to work in Malaysia?"]);
    expect(await page.evaluate(() => (window as any).submits ?? 0)).toBe(0);
    await page.close();
  });
});

describe("findBlocker", () => {
  it("stops on a sign-in wall", async () => {
    const page = await browser.newPage();
    await page.setContent("<input type=password>");
    expect(await findBlocker(page)).toMatch(/sign in/);
    await page.setContent("<input type=text>");
    expect(await findBlocker(page)).toBeNull();
    await page.close();
  });
});

describe("documents", () => {
  it("escapes text and renders both PDFs", async () => {
    expect(cvHtml({ ...profile, name: "A <b>" }, approved)).toContain("A &#60;b&#62;");
    expect(coverLetterHtml(profile, approved)).toContain("<p>I build tools for colleagues.</p>");
    const files = await renderPdfs(browser, tmp, profile, approved);
    expect(fs.readFileSync(files.cv).subarray(0, 5).toString()).toBe("%PDF-");
    expect(fs.statSync(files.coverLetter).size).toBeGreaterThan(1000);
  });

  it("reads back the Markdown drafts you edited", () => {
    fs.writeFileSync(path.join(tmp, "cv-summary.md"), "# CV summary: Dev at Co\n\nEdited summary.\n\n## Suggested order of CV entries\n\n- First\n- Second\n");
    fs.writeFileSync(path.join(tmp, "cover-letter.md"), "Letter.\n");
    fs.writeFileSync(path.join(tmp, "answers.md"), "## Q one (from profile.yaml)\n\nA one\n\n## Q two\n\nA two\nline two\n");
    expect(readApprovedDraft(tmp)).toEqual({
      cvSummary: "Edited summary.",
      cvEntries: ["First", "Second"],
      coverLetter: "Letter.",
      answers: [
        { question: "Q one", answer: "A one" },
        { question: "Q two", answer: "A two\nline two" },
      ],
    });
  });
});

describe("prepareFill", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(":memory:");
    upsertPosting(db, { source: "lever", sourceId: "abc", board: "anotherco", company: "C", title: "Dev", location: "KL", remote: null, salaryText: null, description: "d", applyUrl: "https://jobs.lever.co/anotherco/abc", postedAt: null });
    fs.writeFileSync(path.join(tmp, "cv-summary.md"), "# CV\n\nSummary.\n\n## Suggested order of CV entries\n\n- One\n");
    fs.writeFileSync(path.join(tmp, "cover-letter.md"), "Letter.\n");
    fs.writeFileSync(path.join(tmp, "answers.md"), "No screening questions were found for this job.\n");
    saveDraft(db, 1, tmp, "m", 0);
  });

  it("refuses jobs that are not approved", async () => {
    await expect(prepareFill(db, 1, profile, browser)).rejects.toThrow(/Approve its drafts first/);
  });

  it("refuses drafts edited after approval, then renders PDFs once re-approved", async () => {
    setStatus(db, 1, "approved");
    markApproved(db, 1, draftHash(tmp));
    fs.appendFileSync(path.join(tmp, "cover-letter.md"), "One more line.\n");
    await expect(prepareFill(db, 1, profile, browser)).rejects.toThrow(/changed after you approved/);

    markApproved(db, 1, draftHash(tmp));
    const prepared = await prepareFill(db, 1, profile, browser);
    expect(prepared.plan.url).toBe("https://jobs.lever.co/anotherco/abc/apply");
    expect(fs.existsSync(path.join(tmp, "cv.pdf"))).toBe(true);
    expect(getDraft(db, 1)?.approved_hash).toBeTruthy();
  });
});
