import { describe, expect, it } from "vitest";
import { fetchGreenhouse, fetchGreenhouseQuestions } from "../src/sources/greenhouse.js";
import { fetchAll } from "../src/sources/index.js";
import { fetchLever } from "../src/sources/lever.js";
import { cleanTitle, dedupeKey } from "../src/sources/dedupe.js";
import { htmlToText } from "../src/sources/html.js";
import { fakeHttp, fixture, GH_LIST, GH_QUESTIONS, LEVER_LIST } from "./helpers.js";

describe("greenhouse", () => {
  it("normalises postings and decodes the escaped description", async () => {
    const jobs = await fetchGreenhouse(fakeHttp({ [GH_LIST]: fixture("greenhouse-jobs.json") }), "exampleco", "Example Co");
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      source: "greenhouse",
      sourceId: "4012345",
      title: "Senior Software Engineer, Internal Tools",
      location: "Kuala Lumpur, Malaysia",
      remote: null,
    });
    expect(jobs[0]!.description).toBe("Build tools for our ops team.\n- TypeScript & Node\n- Join the on-call rotation");
    expect(jobs[1]!.remote).toBe(true);
  });

  it("keeps only custom screening questions", async () => {
    const qs = await fetchGreenhouseQuestions(fakeHttp({ [GH_QUESTIONS]: fixture("greenhouse-questions.json") }), "exampleco", "4012345");
    expect(qs).toEqual(["Why do you want to build internal tools?", "Are you authorised to work in Malaysia?"]);
  });
});

describe("lever", () => {
  it("normalises postings, lists and salary", async () => {
    const [job] = await fetchLever(fakeHttp({ [LEVER_LIST]: fixture("lever-postings.json") }), "anotherco", "Another Co");
    expect(job).toMatchObject({ source: "lever", title: "Software Engineer - Internal Tools", location: "Kuala Lumpur", remote: null });
    expect(job!.salaryText).toBe("MYR 10,000–14,000 per month salary");
    expect(job!.description).toContain("What you'll do\n- Build internal apps");
  });
});

describe("fetchAll", () => {
  it("reports a failing board and keeps the others", async () => {
    const http = fakeHttp({ [LEVER_LIST]: fixture("lever-postings.json") });
    const r = await fetchAll(http, [
      { name: "Example Co", greenhouse: "exampleco" },
      { name: "Another Co", lever: "anotherco" },
    ]);
    expect(r.postings).toHaveLength(1);
    expect(r.errors).toEqual([{ company: "Example Co", source: "greenhouse", message: `GET ${GH_LIST} returned 404` }]);
  });
});

describe("dedupe", () => {
  it("matches the same job across sources and seniority wording", () => {
    expect(cleanTitle("Senior Software Engineer, Internal Tools (Remote)")).toBe("software engineer internal tools");
    expect(dedupeKey("Example Co", "Sr. Software Engineer - Internal Tools", "Kuala Lumpur, Malaysia")).toBe(
      dedupeKey("example co", "Software Engineer, Internal Tools", "Kuala Lumpur"),
    );
    expect(dedupeKey("Example Co", "Software Engineer", "Kuala Lumpur")).not.toBe(dedupeKey("Example Co", "Software Engineer", "Penang"));
  });
});

describe("htmlToText", () => {
  it("keeps paragraphs and list items readable", () => {
    expect(htmlToText("<p>One&nbsp;two</p><ul><li>a</li><li>b</li></ul><script>x()</script>")).toBe("One two\n- a\n- b");
  });
});
