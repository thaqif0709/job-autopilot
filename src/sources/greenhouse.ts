import { z } from "zod";
import type { Posting } from "../types.js";
import type { Http } from "./http.js";
import { htmlToText, decodeEntities } from "./html.js";

const BASE = "https://boards-api.greenhouse.io/v1/boards";

const JobSchema = z.object({
  id: z.number(),
  title: z.string(),
  absolute_url: z.string(),
  updated_at: z.string().nullish(),
  location: z.object({ name: z.string().nullish() }).nullish(),
  content: z.string().nullish(),
});
const ListSchema = z.object({ jobs: z.array(JobSchema) });

const QuestionSchema = z.object({
  label: z.string(),
  required: z.boolean().nullish(),
  description: z.string().nullish(),
  fields: z.array(z.object({ name: z.string(), type: z.string() })).default([]),
});
const DetailSchema = z.object({ questions: z.array(QuestionSchema).nullish() });

/** Fields every Greenhouse form has; these are filled from the profile, not drafted. */
const STANDARD_FIELDS = new Set(["first_name", "last_name", "email", "phone", "resume", "resume_text", "cover_letter", "cover_letter_text"]);

export async function fetchGreenhouse(http: Http, board: string, company: string): Promise<Posting[]> {
  const data = ListSchema.parse(await http.getJson(`${BASE}/${encodeURIComponent(board)}/jobs?content=true`));
  return data.jobs.map((j) => {
    const location = j.location?.name?.trim() ?? "";
    // Greenhouse returns the description HTML entity-escaped, so decode once before stripping tags.
    const description = htmlToText(decodeEntities(j.content ?? ""));
    return {
      source: "greenhouse",
      sourceId: String(j.id),
      board,
      company,
      title: j.title.trim(),
      location,
      remote: /remote/i.test(location) ? true : null,
      salaryText: null,
      description,
      applyUrl: j.absolute_url,
      postedAt: j.updated_at ?? null,
    };
  });
}

/** Custom screening questions on a Greenhouse form (standard contact and file fields left out). */
export async function fetchGreenhouseQuestions(http: Http, board: string, jobId: string): Promise<string[]> {
  const data = DetailSchema.parse(
    await http.getJson(`${BASE}/${encodeURIComponent(board)}/jobs/${encodeURIComponent(jobId)}?questions=true`),
  );
  return (data.questions ?? [])
    .filter((q) => !q.fields.every((f) => STANDARD_FIELDS.has(f.name)))
    .map((q) => q.label.trim());
}
