import fs from "node:fs";
import path from "node:path";
import { hashOf, type Facts, type Profile } from "../config.js";
import type { Llm } from "../llm.js";
import { buildDraftPrompt, DRAFT_SYSTEM, DraftSchema, type DraftOutput, type DraftSentence } from "./prompt.js";

/** Questions with legal or contractual weight: answered from profile.yaml, never by the model. */
const FIXED: { key: keyof Profile["fixedAnswers"]; pattern: RegExp }[] = [
  { key: "workAuthorisation", pattern: /authori[sz]|visa|work permit|right to work|sponsor/i },
  { key: "salaryExpectation", pattern: /salary|compensation|pay expectation|expected pay|remuneration/i },
  { key: "noticePeriod", pattern: /notice period|start date|when can you start|availability to start/i },
];

export function fixedAnswerKey(question: string) {
  return FIXED.find((f) => f.pattern.test(question))?.key;
}

export interface Gap {
  where: string;
  text: string;
}

export interface Draft {
  cvSummary: string;
  cvOrder: string[];
  coverLetter: string;
  answers: { question: string; answer: string; fixed: boolean }[];
  gaps: Gap[];
}

/**
 * Keeps only sentences backed by a known fact (or marked "none" for courtesy lines) and moves
 * every other sentence to the gaps list.
 */
export function assemble(out: DraftOutput, facts: Facts, fixedAnswers: { question: string; answer: string }[]): Draft {
  const known = new Set(facts.facts.map((f) => f.id));
  const gaps: Gap[] = [];
  const keep = (where: string, sentences: DraftSentence[]) =>
    sentences
      .filter((s) => {
        const ok = s.factIds.length > 0 && s.factIds.every((id) => id === "none" || known.has(id));
        if (!ok) gaps.push({ where, text: s.text.trim() });
        return ok;
      })
      .map((s) => s.text.trim())
      .join(" ");

  const cvSummary = keep("CV summary", out.cvSummary);
  const coverLetter = out.coverLetter
    .map((p, i) => keep(`Cover letter, paragraph ${i + 1}`, p.sentences))
    .filter(Boolean)
    .join("\n\n");
  const answers = [
    ...fixedAnswers.map((a) => ({ ...a, fixed: true })),
    ...out.answers.map((a) => ({ question: a.question, answer: keep(`Answer: ${a.question}`, a.sentences), fixed: false })),
  ];
  return { cvSummary, cvOrder: out.cvOrder.filter((id) => known.has(id)), coverLetter, answers, gaps };
}

export async function generateDraft(
  llm: Llm,
  model: string,
  job: { company: string; title: string; description: string },
  profile: Profile,
  facts: Facts,
  questions: string[],
) {
  const fixed: { question: string; answer: string }[] = [];
  const open: string[] = [];
  for (const q of questions) {
    const key = fixedAnswerKey(q);
    if (!key) open.push(q);
    else fixed.push({ question: q, answer: profile.fixedAnswers[key] ?? "TODO: add this to fixedAnswers in profile.yaml" });
  }
  const { data, model: servedBy } = await llm.structured({
    model,
    effort: "medium",
    system: DRAFT_SYSTEM,
    prompt: buildDraftPrompt(job, facts, open),
    schema: DraftSchema,
  });
  return { draft: assemble(data, facts, fixed), raw: data, model: servedBy };
}

export const DRAFT_FILES = ["cv-summary.md", "cover-letter.md", "answers.md"] as const;

export function writeDraft(dir: string, job: { company: string; title: string }, d: Draft, raw: DraftOutput, facts: Facts) {
  fs.mkdirSync(dir, { recursive: true });
  const byId = new Map(facts.facts.map((f) => [f.id, f]));
  const cvOrder = d.cvOrder.map((id) => `- ${byId.get(id)?.text ?? id}`).join("\n");
  fs.writeFileSync(
    path.join(dir, "cv-summary.md"),
    `# CV summary: ${job.title} at ${job.company}\n\n${d.cvSummary}\n\n## Suggested order of CV entries\n\n${cvOrder}\n`,
  );
  fs.writeFileSync(path.join(dir, "cover-letter.md"), `${d.coverLetter}\n`);
  const answers = d.answers.length
    ? d.answers.map((a) => `## ${a.question}${a.fixed ? " (from profile.yaml)" : ""}\n\n${a.answer}\n`).join("\n")
    : "No screening questions were found for this job.\n";
  fs.writeFileSync(path.join(dir, "answers.md"), answers);
  const gaps = d.gaps.length
    ? `# Gaps\n\nThese sentences had no supporting fact, so they were left out of the drafts. Add the fact to profile/facts.yaml and run \`jobs draft\` again, or write it into the draft yourself. Delete each line once it is handled.\n\n${d.gaps.map((g) => `- ${g.where}: ${g.text}`).join("\n")}\n`
    : "# Gaps\n\nNone.\n";
  fs.writeFileSync(path.join(dir, "gaps.md"), gaps);
  fs.writeFileSync(path.join(dir, "draft.json"), `${JSON.stringify(raw, null, 2)}\n`);
}

/** Gap lines still left in gaps.md. */
export function openGaps(dir: string): string[] {
  const file = path.join(dir, "gaps.md");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("- "));
}

/** Hash of the draft files as they stand, recorded on approve so later steps use exactly that version. */
export function draftHash(dir: string): string {
  return hashOf(DRAFT_FILES.map((f) => fs.readFileSync(path.join(dir, f), "utf8")));
}
