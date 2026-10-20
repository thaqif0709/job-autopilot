import fs from "node:fs";
import path from "node:path";
import type { Browser } from "playwright";
import type { Profile } from "../config.js";

/** The approved draft as the form filler uses it, read back from the Markdown files you edited. */
export interface ApprovedDraft {
  cvSummary: string;
  cvEntries: string[];
  coverLetter: string;
  answers: { question: string; answer: string }[];
}

export function readApprovedDraft(dir: string): ApprovedDraft {
  const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");
  const cv = read("cv-summary.md");
  const [head = "", order = ""] = cv.split(/^## Suggested order of CV entries\s*$/m);
  const cvSummary = head.replace(/^# .*$/m, "").trim();
  const cvEntries = order
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);
  const answers = read("answers.md")
    .split(/^## /m)
    .slice(1)
    .map((block) => {
      const [first = "", ...rest] = block.split("\n");
      return { question: first.replace(/ \(from profile\.yaml\)$/, "").trim(), answer: rest.join("\n").trim() };
    })
    .filter((a) => a.question && a.answer);
  return { cvSummary, cvEntries, coverLetter: read("cover-letter.md").trim(), answers };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const paragraphs = (s: string) =>
  s
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");

const STYLE = `
  @page { size: A4; margin: 18mm 20mm; }
  body { font-family: "Helvetica Neue", Arial, sans-serif; font-size: 10.5pt; line-height: 1.45; color: #1a1a1a; }
  h1 { font-size: 20pt; margin: 0 0 2pt; }
  h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid #ccc; padding-bottom: 2pt; margin: 14pt 0 6pt; }
  .contact { color: #555; margin-bottom: 8pt; }
  ul { padding-left: 14pt; margin: 0; } li { margin-bottom: 4pt; }
  p { margin: 0 0 8pt; }`;

function contactLine(profile: Profile) {
  return [profile.email, profile.phone, ...Object.values(profile.links)].filter(Boolean).map(esc).join(" · ");
}

export function cvHtml(profile: Profile, d: ApprovedDraft): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>
<h1>${esc(profile.name)}</h1>
<div class="contact">${contactLine(profile)}</div>
<h2>Summary</h2>
${paragraphs(d.cvSummary)}
<h2>Experience and projects</h2>
<ul>${d.cvEntries.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>
</body></html>`;
}

export function coverLetterHtml(profile: Profile, d: ApprovedDraft): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>
<h1>${esc(profile.name)}</h1>
<div class="contact">${contactLine(profile)}</div>
${paragraphs(d.coverLetter)}
</body></html>`;
}

/** Renders the CV and cover letter to PDF next to the drafts, with a headless browser. */
export async function renderPdfs(browser: Browser, dir: string, profile: Profile, d: ApprovedDraft) {
  const page = await browser.newPage();
  try {
    const files = { cv: path.join(dir, "cv.pdf"), coverLetter: path.join(dir, "cover-letter.pdf") };
    await page.setContent(cvHtml(profile, d), { waitUntil: "load" });
    await page.pdf({ path: files.cv, format: "A4", printBackground: true });
    await page.setContent(coverLetterHtml(profile, d), { waitUntil: "load" });
    await page.pdf({ path: files.coverLetter, format: "A4", printBackground: true });
    return files;
  } finally {
    await page.close();
  }
}
