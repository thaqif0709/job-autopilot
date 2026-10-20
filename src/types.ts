import { z } from "zod";

export const SOURCES = ["greenhouse", "lever", "gmail"] as const;
export type Source = (typeof SOURCES)[number];

/** One job posting as every source adapter returns it. */
export const PostingSchema = z.object({
  source: z.enum(SOURCES),
  sourceId: z.string().min(1),
  /** Board token or slug, used later to fetch extra details such as screening questions. */
  board: z.string().min(1),
  company: z.string().min(1),
  title: z.string().min(1),
  location: z.string(),
  remote: z.boolean().nullable(),
  salaryText: z.string().nullable(),
  description: z.string(),
  applyUrl: z.string().url(),
  postedAt: z.string().nullable(),
});
export type Posting = z.infer<typeof PostingSchema>;

export const STATUSES = [
  "found",
  "dropped",
  "shortlisted",
  "drafted",
  "approved",
  "filled",
  "submitted",
  "replied",
  "closed",
] as const;
export type Status = (typeof STATUSES)[number];
