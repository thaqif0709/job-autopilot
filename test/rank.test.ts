import { describe, expect, it } from "vitest";
import { applyRules } from "../src/rank/rules.js";
import { buildScorePrompt, weightedTotal, type ScoreOutput } from "../src/rank/score.js";
import { profile } from "./helpers.js";

const job = { title: "Software Engineer, Internal Tools", location: "Kuala Lumpur", remote: null, description: "Build apps." };

describe("rules", () => {
  it("keeps a matching job", () => {
    expect(applyRules(job, profile())).toEqual({ drop: null, flags: [] });
  });
  it("drops blocked titles and other locations, but keeps remote jobs", () => {
    expect(applyRules({ ...job, title: "Senior Sales Engineer" }, profile()).drop).toMatch(/blocked/);
    expect(applyRules({ ...job, location: "Singapore" }, profile()).drop).toMatch(/not in your list/);
    expect(applyRules({ ...job, location: "Singapore", remote: true }, profile()).drop).toBeNull();
    expect(applyRules({ ...job, location: "Remote - APAC" }, profile({ acceptRemote: false })).drop).toMatch(/not in your list/);
  });
  it("flags support-duty language", () => {
    const r = applyRules({ ...job, description: "You build it, you run it. Join our 24/7 On-Call rotation." }, profile());
    expect(r.flags).toEqual(["you build it, you run it", "24/7", "on-call"]);
  });
});

const out = (scores: number[]): ScoreOutput => {
  const [roleFit, supportBoundary, skills, pay, practicalities] = scores.map((score) => ({ score, reason: "r" }));
  return { roleFit: roleFit!, supportBoundary: supportBoundary!, skills: skills!, pay: pay!, practicalities: practicalities!, summary: "s" };
};

describe("weightedTotal", () => {
  const w = profile().weights;
  it("maps all fives to 100 and all zeros to 0", () => {
    expect(weightedTotal(out([5, 5, 5, 5, 5]), w)).toBe(100);
    expect(weightedTotal(out([0, 0, 0, 0, 0]), w)).toBe(0);
  });
  it("weights role fit most and clamps out-of-range scores", () => {
    expect(weightedTotal(out([5, 0, 0, 0, 0]), w)).toBe(35);
    expect(weightedTotal(out([9, -2, 0, 0, 0]), w)).toBe(35);
  });
});

describe("score prompt", () => {
  it("includes flags and recent ratings", () => {
    const prompt = buildScorePrompt(
      { company: "Co", title: "Dev", location: "", salaryText: null, description: "Body", flags: ["on-call"] },
      profile(),
      [{ company: "Old", title: "SRE", rating: "bad", note: "on-call heavy" }],
    );
    expect(prompt).toContain("Flagged phrases: on-call");
    expect(prompt).toContain("bad: SRE at Old (on-call heavy)");
    expect(prompt).toContain("Pay target: not given");
  });
});
