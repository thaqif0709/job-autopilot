import fs from "node:fs";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { z } from "zod";

export const CompaniesSchema = z.object({
  companies: z
    .array(
      z
        .object({
          name: z.string().min(1),
          greenhouse: z.string().min(1).optional(),
          lever: z.string().min(1).optional(),
        })
        .refine((c) => c.greenhouse || c.lever, { message: "each company needs a greenhouse or lever board" }),
    )
    .default([]),
});
export type Companies = z.infer<typeof CompaniesSchema>;
export type Company = Companies["companies"][number];

const Score = z.number().min(0);

export const ProfileSchema = z.object({
  name: z.string(),
  email: z.string(),
  phone: z.string().default(""),
  links: z.record(z.string(), z.string()).default({}),
  stack: z.array(z.string()).default([]),
  targets: z.object({
    titles: z.array(z.string()).default([]),
    blockTitles: z.array(z.string()).default([]),
    /** Empty means any location. Matched as a case-insensitive substring of the posting's location. */
    locations: z.array(z.string()).default([]),
    acceptRemote: z.boolean().default(true),
    salary: z
      .object({
        currency: z.string(),
        min: z.number(),
        max: z.number(),
        period: z.enum(["month", "year"]).default("month"),
      })
      .optional(),
  }),
  supportFlags: z
    .array(z.string())
    .default([
      "you build it, you run it",
      "own the entire lifecycle",
      "24/7",
      "on-call",
      "on call",
      "incident response",
      "after-hours",
      "after hours",
      "pager",
    ]),
  weights: z
    .object({
      roleFit: Score.default(35),
      supportBoundary: Score.default(25),
      skills: Score.default(20),
      pay: Score.default(10),
      practicalities: Score.default(10),
    })
    .default({ roleFit: 35, supportBoundary: 25, skills: 20, pay: 10, practicalities: 10 }),
  /** Answers with legal or contractual weight. These are copied verbatim and never generated. */
  fixedAnswers: z
    .object({
      workAuthorisation: z.string().optional(),
      salaryExpectation: z.string().optional(),
      noticePeriod: z.string().optional(),
    })
    .default({}),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const FactsSchema = z.object({
  facts: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9-]+$/, "fact ids are lower-case letters, digits and dashes"),
        kind: z.string(),
        text: z.string().min(1),
      }),
    )
    .min(1),
});
export type Facts = z.infer<typeof FactsSchema>;

function loadYaml<T>(file: string, schema: z.ZodType<T>, hint: string): T {
  if (!fs.existsSync(file)) throw new Error(`Missing ${file}. ${hint}`);
  const result = schema.safeParse(parse(fs.readFileSync(file, "utf8")) ?? {});
  if (!result.success) throw new Error(`${file} is not valid:\n${z.prettifyError(result.error)}`);
  return result.data;
}

export const loadCompanies = (file: string) =>
  loadYaml(file, CompaniesSchema, "Copy config/companies.example.yaml to config/companies.yaml and list your target companies.");
export const loadProfile = (file: string) =>
  loadYaml(file, ProfileSchema, "Copy config/profile.example.yaml to profile/profile.yaml and fill it in.");
export const loadFacts = (file: string) =>
  loadYaml(file, FactsSchema, "Copy config/facts.example.yaml to profile/facts.yaml and fill it in.");

export const hashOf = (...parts: unknown[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
