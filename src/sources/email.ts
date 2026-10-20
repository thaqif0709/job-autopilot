import fs from "node:fs";
import path from "node:path";
import { simpleParser } from "mailparser";
import { hashOf } from "../config.js";
import type { Posting } from "../types.js";
import { decodeEntities } from "./html.js";

export type AlertSite = "linkedin" | "jobstreet";

/** One job card read from an alert email, before its link is resolved. */
export interface AlertJob {
  site: AlertSite;
  /** The site's own job id when the link carries it (LinkedIn does, Jobstreet hides it behind a tracked link). */
  id: string | null;
  title: string;
  company: string;
  location: string;
  remote: boolean | null;
  salaryText: string | null;
  /** Bullet points and badges shown on the card. */
  highlights: string[];
  url: string;
  receivedAt: string | null;
}

interface Line {
  text: string;
  links: string[];
}

const tidy = (s: string) =>
  s
    .replace(/[͏­​-‍⁠﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Flattens email HTML into one line per table cell or block, keeping the links found on each line. */
export function emailLines(html: string): Line[] {
  const marked = html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<a\b[^>]*?\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => `${inner}\u0001${href}\u0002`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|td|tr|li|h[1-6]|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return marked
    .split("\n")
    .map((raw) => {
      const links: string[] = [];
      const text = raw.replace(/\u0001([^\u0002]*)\u0002/g, (_, href: string) => {
        links.push(decodeEntities(href));
        return " ";
      });
      return { text: tidy(decodeEntities(text)), links };
    })
    .filter((l) => l.text || l.links.length);
}

const SALARY = /\b(RM|MYR|SGD|USD|S\$|\$)\s?\d/i;
const WORKPLACE = /\s*\((on-site|onsite|hybrid|remote)\)\s*$/i;
const VIEW_JOB = /^view job$/i;

/** The link-free lines after a card's title, up to the next line that has a link. */
function cardBody(lines: Line[], from: number): Line[] {
  const body: Line[] = [];
  for (let i = from; i < lines.length && body.length < 10; i++) {
    const l = lines[i]!;
    if (l.links.length) break;
    if (l.text) body.push(l);
  }
  return body;
}

function card(site: AlertSite, id: string | null, title: string, body: Line[], url: string, receivedAt: string | null): AlertJob | null {
  const [company, place, ...rest] = body.map((l) => l.text);
  if (!company || !place) return null;
  const workplace = WORKPLACE.exec(place)?.[1]?.toLowerCase();
  const salaryText = rest.find((t) => SALARY.test(t)) ?? null;
  return {
    site,
    id,
    title,
    company,
    location: place.replace(WORKPLACE, ""),
    remote: workplace === "remote" ? true : workplace ? false : /remote/i.test(place) ? true : null,
    salaryText,
    highlights: rest.filter((t) => t !== salaryText),
    url,
    receivedAt,
  };
}

const LINKEDIN_JOB = /linkedin\.com\/(?:comm\/)?jobs\/view\/(\d+)/;

/** LinkedIn cards: a title linking to /jobs/view/<id>, then company and location lines. */
function linkedinJobs(lines: Line[], receivedAt: string | null): AlertJob[] {
  const jobs = new Map<string, AlertJob>();
  lines.forEach((l, i) => {
    const id = l.links.map((u) => LINKEDIN_JOB.exec(u)?.[1]).find(Boolean);
    if (!id || !l.text || VIEW_JOB.test(l.text) || jobs.has(id)) return;
    const job = card("linkedin", id, l.text, cardBody(lines, i + 1), `https://www.linkedin.com/jobs/view/${id}/`, receivedAt);
    if (job) jobs.set(id, job);
  });
  return [...jobs.values()];
}

/** Jobstreet cards: a linked title, company, location and bullets, closed by a "View job" link. */
function jobstreetJobs(lines: Line[], receivedAt: string | null): AlertJob[] {
  const jobs: AlertJob[] = [];
  lines.forEach((l, i) => {
    if (!l.text || !l.links.length || VIEW_JOB.test(l.text)) return;
    const body = cardBody(lines, i + 1);
    const next = lines[i + 1 + body.length];
    if (!next || !VIEW_JOB.test(next.text)) return;
    const job = card("jobstreet", null, l.text, body, next.links[0] ?? l.links[0]!, receivedAt);
    if (job) jobs.push(job);
  });
  return jobs;
}

/** Reads the job cards out of a LinkedIn or Jobstreet email. Other emails, and emails without job cards, give none. */
export async function parseAlertEmail(raw: Buffer | string): Promise<AlertJob[]> {
  const mail = await simpleParser(raw);
  const from = mail.from?.value.map((a) => a.address?.toLowerCase() ?? "").join(" ") ?? "";
  const html = typeof mail.html === "string" ? mail.html : null;
  if (!html) return [];
  const receivedAt = mail.date?.toISOString() ?? null;
  if (/linkedin\.com\b/.test(from)) return linkedinJobs(emailLines(html), receivedAt);
  if (/jobstreet\.com\b/.test(from)) return jobstreetJobs(emailLines(html), receivedAt);
  return [];
}

/** Follows a tracked link to where it ends up, or null when it can't be followed. */
export type Resolver = (url: string) => Promise<string | null>;

/**
 * Follows redirects without loading the final page, remembering each answer in a file so that a
 * tracked link from an email is only followed once, however many times the email is read.
 */
export function cachedResolver(cacheFile: string, fetchImpl: typeof fetch = fetch): Resolver {
  let cache: Record<string, string | null> | null = null;
  const load = () => (cache ??= fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : {});
  return async (url) => {
    const known = load();
    if (url in known) return known[url] ?? null;
    let current = url;
    let final: string | null = null;
    try {
      for (let hop = 0; hop < 5; hop++) {
        const res = await fetchImpl(current, { method: "HEAD", redirect: "manual", headers: { "user-agent": "job-autopilot (personal use)" } });
        const next = res.headers.get("location");
        if (res.status < 300 || res.status >= 400 || !next) {
          final = res.ok ? current : null;
          break;
        }
        current = new URL(next, current).toString();
        final = current;
      }
    } catch {
      final = null;
    }
    known[url] = final;
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(known));
    return final;
  };
}

const JOBSTREET_JOB = /^(https:\/\/[a-z.]*jobstreet\.com(?:\.[a-z]+)?)\/(?:[a-z-]+\/)?job\/(\d+)/;

/** Turns alert cards into postings, following Jobstreet's tracked links to find each job's real id and page. */
export async function alertPostings(jobs: AlertJob[], resolve: Resolver): Promise<Posting[]> {
  const out: Posting[] = [];
  for (const j of jobs) {
    let { id, url } = j;
    if (j.site === "jobstreet") {
      const hit = JOBSTREET_JOB.exec((await resolve(url)) ?? "");
      if (hit) {
        id = hit[2]!;
        url = `${hit[1]}/job/${id}`;
      }
    }
    const description = [
      ...j.highlights.map((h) => `- ${h}`),
      "",
      `Found in a ${j.site === "linkedin" ? "LinkedIn" : "Jobstreet"} email. The full description is on the job page.`,
    ].join("\n").trim();
    out.push({
      source: "gmail",
      sourceId: `${j.site}:${id ?? hashOf(j.title, j.company, j.location)}`,
      board: j.site,
      company: j.company,
      title: j.title,
      location: j.location,
      remote: j.remote,
      salaryText: j.salaryText,
      description,
      applyUrl: url,
      postedAt: j.receivedAt,
    });
  }
  return out;
}
