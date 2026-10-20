import type { Profile } from "../config.js";
import type { ApprovedDraft } from "./documents.js";

export type Target = { css: string } | { label: string };

export interface FieldPlan {
  /** What the field is, as shown in the terminal. */
  name: string;
  target: Target;
  value: string;
  kind: "text" | "file";
}

export interface SitePlan {
  url: string;
  fields: FieldPlan[];
}

export interface FillJob {
  source: string;
  board: string;
  source_id: string;
  apply_url: string;
}

export interface Documents {
  cv: string;
  coverLetter: string;
}

function names(profile: Profile) {
  const [first = "", ...rest] = profile.name.trim().split(/\s+/);
  return { first: profile.firstName ?? first, last: profile.lastName ?? rest.join(" ") };
}

function link(profile: Profile, ...keys: string[]): string | undefined {
  const entries = Object.entries(profile.links);
  for (const k of keys) {
    const hit = entries.find(([name]) => name.toLowerCase() === k);
    if (hit?.[1]) return hit[1];
  }
  return undefined;
}

const text = (name: string, target: Target, value: string | undefined): FieldPlan[] =>
  value ? [{ name, target, value, kind: "text" }] : [];

const answers = (d: ApprovedDraft): FieldPlan[] =>
  d.answers.map((a) => ({ name: a.question, target: { label: a.question }, value: a.answer, kind: "text" }));

function greenhouse(job: FillJob, profile: Profile, d: ApprovedDraft, docs: Documents): SitePlan {
  const n = names(profile);
  return {
    // The hosted board page always carries the form, even when the company's own careers page embeds it.
    url: `https://job-boards.greenhouse.io/${encodeURIComponent(job.board)}/jobs/${encodeURIComponent(job.source_id)}`,
    fields: [
      ...text("First name", { css: "#first_name" }, n.first),
      ...text("Last name", { css: "#last_name" }, n.last),
      ...text("Email", { css: "#email" }, profile.email),
      ...text("Phone", { css: "#phone" }, profile.phone),
      { name: "CV", target: { css: "input[type=file]#resume" }, value: docs.cv, kind: "file" },
      { name: "Cover letter", target: { css: "input[type=file]#cover_letter" }, value: docs.coverLetter, kind: "file" },
      ...text("LinkedIn", { label: "LinkedIn" }, link(profile, "linkedin")),
      ...text("GitHub", { label: "GitHub" }, link(profile, "github")),
      ...text("Website", { label: "Website" }, link(profile, "portfolio", "website")),
      ...answers(d),
    ],
  };
}

function lever(job: FillJob, profile: Profile, d: ApprovedDraft, docs: Documents): SitePlan {
  return {
    url: `${job.apply_url.replace(/\/+$/, "")}/apply`,
    fields: [
      { name: "CV", target: { css: 'input[type=file][name="resume"]' }, value: docs.cv, kind: "file" },
      ...text("Full name", { css: 'input[name="name"]' }, profile.name),
      ...text("Email", { css: 'input[name="email"]' }, profile.email),
      ...text("Phone", { css: 'input[name="phone"]' }, profile.phone),
      ...text("LinkedIn", { css: 'input[name="urls[LinkedIn]"]' }, link(profile, "linkedin")),
      ...text("GitHub", { css: 'input[name="urls[GitHub]"]' }, link(profile, "github")),
      ...text("Portfolio", { css: 'input[name="urls[Portfolio]"]' }, link(profile, "portfolio", "website")),
      ...text("Cover letter", { css: 'textarea[name="comments"]' }, d.coverLetter),
      ...answers(d),
    ],
  };
}

export function planFor(job: FillJob, profile: Profile, d: ApprovedDraft, docs: Documents): SitePlan {
  if (job.source === "greenhouse") return greenhouse(job, profile, d, docs);
  if (job.source === "lever") return lever(job, profile, d, docs);
  if (job.source === "gmail") {
    const site = job.board === "linkedin" ? "LinkedIn" : "Jobstreet";
    throw new Error(
      `Form filling supports Greenhouse and Lever jobs, so apply on ${site} yourself: ${job.apply_url}\n` +
        `Your CV and cover letter are ready at ${docs.cv} and ${docs.coverLetter}. Afterwards run: jobs submitted <id>`,
    );
  }
  throw new Error(`Form filling supports Greenhouse and Lever jobs; this one came from ${job.source}.`);
}
