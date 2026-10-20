import { describe, expect, it } from "vitest";
import { assemble, fixedAnswerKey } from "../src/draft/draft.js";
import { facts } from "./helpers.js";

describe("assemble", () => {
  it("moves unsupported sentences to gaps and keeps courtesy lines", () => {
    const d = assemble(
      {
        cvSummary: [
          { text: "Developer since 2021.", factIds: ["exp-current"] },
          { text: "Cut build time by 50%.", factIds: [] },
        ],
        cvOrder: ["auto-builds", "made-up", "exp-current"],
        coverLetter: [
          { sentences: [{ text: "Dear hiring team,", factIds: ["none"] }] },
          { sentences: [{ text: "I led a team of 20.", factIds: ["invented-fact"] }] },
        ],
        answers: [{ question: "Why us?", sentences: [{ text: "Your tools team fits my work.", factIds: ["auto-builds"] }] }],
      },
      facts,
      [{ question: "Are you authorised to work here?", answer: "Yes." }],
    );
    expect(d.cvSummary).toBe("Developer since 2021.");
    expect(d.cvOrder).toEqual(["auto-builds", "exp-current"]);
    expect(d.coverLetter).toBe("Dear hiring team,");
    expect(d.gaps).toEqual([
      { where: "CV summary", text: "Cut build time by 50%." },
      { where: "Cover letter, paragraph 2", text: "I led a team of 20." },
    ]);
    expect(d.answers).toEqual([
      { question: "Are you authorised to work here?", answer: "Yes.", fixed: true },
      { question: "Why us?", answer: "Your tools team fits my work.", fixed: false },
    ]);
  });
});

describe("fixedAnswerKey", () => {
  it("routes legal and pay questions to profile answers", () => {
    expect(fixedAnswerKey("Are you authorized to work in Malaysia?")).toBe("workAuthorisation");
    expect(fixedAnswerKey("Will you require visa sponsorship?")).toBe("workAuthorisation");
    expect(fixedAnswerKey("What are your salary expectations?")).toBe("salaryExpectation");
    expect(fixedAnswerKey("What is your notice period?")).toBe("noticePeriod");
    expect(fixedAnswerKey("Why do you want this job?")).toBeUndefined();
  });
});
