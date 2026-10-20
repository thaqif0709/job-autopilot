import type { Company } from "../config.js";
import { PostingSchema, type Posting } from "../types.js";
import { fetchGreenhouse } from "./greenhouse.js";
import type { Http } from "./http.js";
import { fetchLever } from "./lever.js";

export interface FetchResult {
  postings: Posting[];
  errors: { company: string; source: string; message: string }[];
}

/** Fetches every board in the list. One failing board is reported and skipped, never fatal. */
export async function fetchAll(http: Http, companies: Company[]): Promise<FetchResult> {
  const result: FetchResult = { postings: [], errors: [] };
  for (const c of companies) {
    const jobs: [string, () => Promise<Posting[]>][] = [];
    if (c.greenhouse) jobs.push(["greenhouse", () => fetchGreenhouse(http, c.greenhouse!, c.name)]);
    if (c.lever) jobs.push(["lever", () => fetchLever(http, c.lever!, c.name)]);
    for (const [source, run] of jobs) {
      try {
        for (const p of await run()) {
          const checked = PostingSchema.safeParse(p);
          if (checked.success) result.postings.push(checked.data);
          else result.errors.push({ company: c.name, source, message: `skipped "${p.title}": ${checked.error.issues[0]?.message}` });
        }
      } catch (e) {
        result.errors.push({ company: c.name, source, message: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return result;
}
