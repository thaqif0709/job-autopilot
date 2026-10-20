import { z } from "zod";
import type { Posting } from "../types.js";
import type { Http } from "./http.js";
import { htmlToText } from "./html.js";

const PostingSchema = z.object({
  id: z.string(),
  text: z.string(),
  hostedUrl: z.string(),
  createdAt: z.number().nullish(),
  workplaceType: z.string().nullish(),
  categories: z.object({ location: z.string().nullish(), allLocations: z.array(z.string()).nullish() }).nullish(),
  descriptionPlain: z.string().nullish(),
  additionalPlain: z.string().nullish(),
  lists: z.array(z.object({ text: z.string(), content: z.string() })).nullish(),
  salaryRange: z
    .object({ min: z.number(), max: z.number(), currency: z.string(), interval: z.string().nullish() })
    .nullish(),
});

function salary(r: z.infer<typeof PostingSchema>["salaryRange"]): string | null {
  if (!r) return null;
  const interval = r.interval ? ` ${r.interval.replace(/-/g, " ")}` : "";
  return `${r.currency} ${r.min.toLocaleString("en")}–${r.max.toLocaleString("en")}${interval}`;
}

export async function fetchLever(http: Http, board: string, company: string): Promise<Posting[]> {
  const data = z.array(PostingSchema).parse(await http.getJson(`https://api.lever.co/v0/postings/${encodeURIComponent(board)}?mode=json`));
  return data.map((p) => {
    const location = p.categories?.location?.trim() ?? p.categories?.allLocations?.join(", ") ?? "";
    const lists = (p.lists ?? []).map((l) => `${l.text}\n${htmlToText(l.content)}`);
    const description = [p.descriptionPlain, ...lists, p.additionalPlain]
      .filter((s): s is string => Boolean(s && s.trim()))
      .map((s) => s.trim())
      .join("\n\n");
    const workplace = p.workplaceType?.toLowerCase();
    return {
      source: "lever",
      sourceId: p.id,
      board,
      company,
      title: p.text.trim(),
      location,
      remote: workplace === "remote" ? true : workplace === "onsite" ? false : /remote/i.test(location) ? true : null,
      salaryText: salary(p.salaryRange),
      description,
      applyUrl: p.hostedUrl,
      postedAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
    };
  });
}
