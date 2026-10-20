import { z } from "zod";
import type { Profile } from "../config.js";
import type { Llm } from "../llm.js";
import { RUBRIC } from "./rubric.js";

const Criterion = z.object({ score: z.number().int(), reason: z.string() });
export const ScoreSchema = z.object({
  roleFit: Criterion,
  supportBoundary: Criterion,
  skills: Criterion,
  pay: Criterion,
  practicalities: Criterion,
  summary: z.string(),
});
export type ScoreOutput = z.infer<typeof ScoreSchema>;
export const CRITERIA = ["roleFit", "supportBoundary", "skills", "pay", "practicalities"] as const;

export interface ScoreInput {
  company: string;
  title: string;
  location: string;
  salaryText: string | null;
  description: string;
  flags: string[];
}

export interface Rating {
  company: string;
  title: string;
  rating: "good" | "bad";
  note: string | null;
}

/** Folds the 0–5 criterion scores into a 0–100 total using the profile's weights. */
export function weightedTotal(out: ScoreOutput, weights: Profile["weights"]): number {
  const sum = CRITERIA.reduce((acc, c) => acc + weights[c], 0);
  if (sum <= 0) return 0;
  const raw = CRITERIA.reduce((acc, c) => acc + (Math.min(5, Math.max(0, out[c].score)) / 5) * weights[c], 0);
  return Math.round((raw / sum) * 100);
}

export function buildScorePrompt(job: ScoreInput, profile: Profile, ratings: Rating[]): string {
  const t = profile.targets;
  const salary = t.salary ? `${t.salary.currency} ${t.salary.min}–${t.salary.max} per ${t.salary.period}` : "not given";
  const lines = [
    "<candidate>",
    `Target titles: ${t.titles.join("; ") || "not given"}`,
    `Stack: ${profile.stack.join(", ") || "not given"}`,
    `Locations: ${t.locations.join("; ") || "any"}${t.acceptRemote ? " (remote is fine)" : ""}`,
    `Pay target: ${salary}`,
    "</candidate>",
  ];
  if (ratings.length) {
    lines.push("<recent_ratings>", ...ratings.map((r) => `${r.rating}: ${r.title} at ${r.company}${r.note ? ` (${r.note})` : ""}`), "</recent_ratings>");
  }
  lines.push(
    "<posting>",
    `Company: ${job.company}`,
    `Title: ${job.title}`,
    `Location: ${job.location || "not stated"}`,
    `Posted pay: ${job.salaryText ?? "not stated"}`,
    `Flagged phrases: ${job.flags.length ? job.flags.join("; ") : "none"}`,
    "",
    job.description.slice(0, 20000),
    "</posting>",
  );
  return lines.join("\n");
}

export async function scoreJob(llm: Llm, model: string, job: ScoreInput, profile: Profile, ratings: Rating[]) {
  const { data, model: servedBy } = await llm.structured({
    model,
    effort: "low",
    system: RUBRIC,
    prompt: buildScorePrompt(job, profile, ratings),
    schema: ScoreSchema,
    maxTokens: 4000,
  });
  return { output: data, total: weightedTotal(data, profile.weights), model: servedBy };
}
