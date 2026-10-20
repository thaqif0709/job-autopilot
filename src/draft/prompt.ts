import { z } from "zod";
import type { Facts } from "../config.js";

const Sentence = z.object({ text: z.string(), factIds: z.array(z.string()) });
export const DraftSchema = z.object({
  cvSummary: z.array(Sentence),
  /** Fact ids of CV entries, most relevant to this job first. */
  cvOrder: z.array(z.string()),
  coverLetter: z.array(z.object({ sentences: z.array(Sentence) })),
  answers: z.array(z.object({ question: z.string(), sentences: z.array(Sentence) })),
});
export type DraftOutput = z.infer<typeof DraftSchema>;
export type DraftSentence = z.infer<typeof Sentence>;

export const DRAFT_SYSTEM = `You draft job application material for one candidate. Every sentence you write must be supported by the candidate's facts, and you list the ids of the facts each sentence relies on.

Rules:
- Use only the facts given. Never invent employers, dates, numbers, results, users or production use. A project marked as a prototype stays a prototype.
- If a sentence the posting calls for cannot be supported, still write it as you would want it, and give it an empty factIds list. Those sentences are shown to the candidate as gaps to fill, never sent.
- A sentence that only addresses the employer or the role (a greeting, why this company, a closing line) needs no fact; give it the id "none".
- cvSummary: two or three sentences for the top of the CV, aimed at this role.
- cvOrder: the ids of the CV-type facts, most relevant to this posting first.
- coverLetter: three or four short paragraphs, about 250 words in all, plain and specific. No clichés such as "I am thrilled".
- answers: one entry per question listed, in the same order, each answered in two to four sentences.`;

export function buildDraftPrompt(
  job: { company: string; title: string; description: string },
  facts: Facts,
  questions: string[],
): string {
  return [
    "<facts>",
    ...facts.facts.map((f) => `[${f.id}] (${f.kind}) ${f.text}`),
    "</facts>",
    "<posting>",
    `Company: ${job.company}`,
    `Title: ${job.title}`,
    "",
    job.description.slice(0, 20000),
    "</posting>",
    "<questions>",
    ...(questions.length ? questions.map((q, i) => `${i + 1}. ${q}`) : ["none"]),
    "</questions>",
  ].join("\n");
}
