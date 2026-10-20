import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getJob, openDb } from "../src/db/index.js";
import { runFetch } from "../src/pipeline.js";
import { alertPostings, cachedResolver, parseAlertEmail } from "../src/sources/email.js";
import { emailPostings, gmailLogin } from "../src/sources/gmail.js";
import { fakeHttp, profile } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const eml = (name: string) => fs.readFileSync(path.join(here, "fixtures", name));
const noRedirects = async () => null;

describe("alert emails", () => {
  it("reads LinkedIn job cards with their job ids and workplace", async () => {
    const jobs = await parseAlertEmail(eml("linkedin-jobs.eml"));
    expect(jobs.map((j) => [j.id, j.title, j.company, j.location, j.remote])).toEqual([
      ["4329280827", "Management Trainees", "Public Bank", "Sitiawan", false],
      ["4398100745", "Business Analyst, Credit Operations Division", "Public Bank", "WP. Kuala Lumpur", false],
    ]);
    expect(jobs[0]!.url).toBe("https://www.linkedin.com/jobs/view/4329280827/");
    expect(jobs[0]!.receivedAt).toBe("2026-04-27T06:26:22.000Z");
  });

  it("reads a Jobstreet card with its highlights", async () => {
    const [job, ...rest] = await parseAlertEmail(eml("jobstreet-recommendation.eml"));
    expect(rest).toHaveLength(0);
    expect(job).toMatchObject({
      site: "jobstreet",
      id: null,
      title: "Software Engineer / Java Developer (Fresh Graduates welcome to apply)",
      company: "PROTECH DIGITAL SDN. BHD.",
      location: "Petaling Jaya, Selangor",
      highlights: ["Great Job Exposure and Career Development", "Learn from Expert in Solving Problem Creatively", "Flexible Working Hours"],
    });
    expect(job!.url).toMatch(/^https:\/\/url\.recs\.jobstreet\.com\//);
  });

  it("finds nothing in emails from anyone else", async () => {
    const other = "From: News <news@example.com>\r\nSubject: Hi\r\nContent-Type: text/html\r\n\r\n<a href='https://www.linkedin.com/jobs/view/1/'>Job</a>";
    expect(await parseAlertEmail(other)).toEqual([]);
  });

  it("uses Jobstreet's real job page when the tracked link resolves", async () => {
    const jobs = await parseAlertEmail(eml("jobstreet-recommendation.eml"));
    const [p] = await alertPostings(jobs, async () => "https://my.jobstreet.com/job/79112233?ref=recs");
    expect(p).toMatchObject({ source: "gmail", board: "jobstreet", sourceId: "jobstreet:79112233", applyUrl: "https://my.jobstreet.com/job/79112233" });
    expect(p!.description).toContain("- Flexible Working Hours");
  });

  it("keeps the tracked link and a stable id when it doesn't resolve", async () => {
    const jobs = await parseAlertEmail(eml("jobstreet-recommendation.eml"));
    const [a] = await alertPostings(jobs, noRedirects);
    const [b] = await alertPostings(jobs, noRedirects);
    expect(a!.sourceId).toMatch(/^jobstreet:[0-9a-f]{16}$/);
    expect(a!.sourceId).toBe(b!.sourceId);
    expect(a!.applyUrl).toBe(jobs[0]!.url);
  });

  it("follows each tracked link once and remembers where it went", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-redirects-"));
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(url);
      return url.includes("url.recs")
        ? new Response(null, { status: 302, headers: { location: "https://my.jobstreet.com/job/1" } })
        : new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      const file = path.join(dir, "redirects.json");
      expect(await cachedResolver(file, fakeFetch)("https://url.recs.jobstreet.com/a")).toBe("https://my.jobstreet.com/job/1");
      expect(await cachedResolver(file, fakeFetch)("https://url.recs.jobstreet.com/a")).toBe("https://my.jobstreet.com/job/1");
      expect(calls).toEqual(["https://url.recs.jobstreet.com/a", "https://my.jobstreet.com/job/1"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores email jobs and runs the same rules on them", async () => {
    const db = openDb(":memory:");
    const fromEmail = await emailPostings(
      [
        { name: "a", raw: eml("linkedin-jobs.eml") },
        { name: "b", raw: eml("jobstreet-recommendation.eml") },
        { name: "broken", raw: Buffer.from("not an email") },
      ],
      noRedirects,
    );
    expect(fromEmail.errors).toEqual([]);
    const r = await runFetch(db, fakeHttp({}), { companies: [] }, profile(), fromEmail);
    // Only the Kuala Lumpur job is in the test profile's locations.
    expect(r).toMatchObject({ seen: 3, added: 3, dropped: 2 });
    expect(getJob(db, 2)).toMatchObject({ title: "Business Analyst, Credit Operations Division", status: "found", source: "gmail" });
    expect(getJob(db, 1).drop_reason).toBe('location "Sitiawan" is not in your list');

    const again = await runFetch(db, fakeHttp({}), { companies: [] }, profile(), fromEmail);
    expect(again.added).toBe(0);
  });

  it("is set up only with both Gmail values", () => {
    expect(gmailLogin({ GMAIL_USER: "a@gmail.com" })).toBeNull();
    expect(gmailLogin({ GMAIL_USER: "a@gmail.com", GMAIL_APP_PASSWORD: "abcd efgh ijkl mnop" })).toEqual({ user: "a@gmail.com", appPassword: "abcdefghijklmnop" });
  });
});
