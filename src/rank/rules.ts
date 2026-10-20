import type { Profile } from "../config.js";

export interface RuleResult {
  /** Why the job is dropped before any model call, or null to keep it. */
  drop: string | null;
  /** Support-boundary phrases found in the posting, passed on to the scorer. */
  flags: string[];
}

interface RuleInput {
  title: string;
  location: string;
  remote: boolean | null;
  description: string;
}

const contains = (haystack: string, needle: string) => haystack.toLowerCase().includes(needle.toLowerCase());

/** Pass 1: cheap checks that drop obvious misses and flag on-call language. No model call. */
export function applyRules(job: RuleInput, profile: Profile): RuleResult {
  const blocked = profile.targets.blockTitles.find((t) => contains(job.title, t));
  const flags = profile.supportFlags.filter((f) => contains(`${job.title}\n${job.description}`, f));
  if (blocked) return { drop: `title matches blocked "${blocked}"`, flags };

  const { locations, acceptRemote } = profile.targets;
  const remoteOk = acceptRemote && (job.remote === true || contains(job.location, "remote"));
  if (locations.length && !remoteOk && !locations.some((l) => contains(job.location, l))) {
    return { drop: `location "${job.location || "unknown"}" is not in your list`, flags };
  }
  return { drop: null, flags };
}
