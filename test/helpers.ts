import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { ProfileSchema, type Facts, type Profile } from "../src/config.js";
import type { Llm, StructuredRequest } from "../src/llm.js";
import type { Http } from "../src/sources/http.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const fixture = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(here, "fixtures", name), "utf8"));

/** Serves fixtures by URL; any other URL fails, so tests never reach the network. */
export function fakeHttp(routes: Record<string, unknown>): Http & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getJson(url) {
      calls.push(url);
      if (!(url in routes)) throw new Error(`GET ${url} returned 404`);
      return routes[url];
    },
  };
}

/** Returns canned replies in order and records each request. */
export function fakeLlm(replies: unknown[]): Llm & { requests: StructuredRequest<z.ZodType>[] } {
  const requests: StructuredRequest<z.ZodType>[] = [];
  return {
    requests,
    async structured(req) {
      requests.push(req);
      const next = replies.shift();
      if (next === undefined) throw new Error("fakeLlm ran out of replies");
      if (next instanceof Error) throw next;
      return { data: req.schema.parse(next), model: req.model };
    },
  };
}

export const profile = (overrides: Partial<Profile["targets"]> = {}): Profile =>
  ProfileSchema.parse({
    name: "Test Person",
    email: "test@example.com",
    stack: ["TypeScript", "Node.js"],
    targets: { titles: ["Internal Tools Engineer"], blockTitles: ["Sales Engineer"], locations: ["Kuala Lumpur"], ...overrides },
    fixedAnswers: { workAuthorisation: "Yes, Malaysian citizen." },
  });

export const facts: Facts = {
  facts: [
    { id: "exp-current", kind: "cv", text: "Developer at Example Ltd since 2021." },
    { id: "auto-builds", kind: "cv", text: "Built build automations used by a team of 8." },
  ],
};

export const GH_LIST = "https://boards-api.greenhouse.io/v1/boards/exampleco/jobs?content=true";
export const GH_QUESTIONS = "https://boards-api.greenhouse.io/v1/boards/exampleco/jobs/4012345?questions=true";
export const LEVER_LIST = "https://api.lever.co/v0/postings/anotherco?mode=json";
