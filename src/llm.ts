import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";

export type Effort = "low" | "medium" | "high";

export interface StructuredRequest<S extends z.ZodType> {
  model: string;
  effort: Effort;
  system: string;
  prompt: string;
  schema: S;
  maxTokens?: number;
}

/** The one thing the pipeline needs from a model: a prompt in, schema-checked JSON out. Tests pass a fake. */
export interface Llm {
  structured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<{ data: z.infer<S>; model: string }>;
}

export const DEFAULT_MODEL = "claude-opus-5-5";
export const scoreModel = () => process.env.JOBS_SCORE_MODEL || DEFAULT_MODEL;
export const draftModel = () => process.env.JOBS_DRAFT_MODEL || DEFAULT_MODEL;

export class ModelOutputError extends Error {}

export function claudeLlm(client = new Anthropic()): Llm {
  return {
    async structured(req) {
      const res = await client.beta.messages.parse({
        model: req.model,
        max_tokens: req.maxTokens ?? 16000,
        // If the model declines for policy reasons, the API retries on its default fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: req.system,
        messages: [{ role: "user", content: req.prompt }],
        output_config: { effort: req.effort, format: betaZodOutputFormat(req.schema) },
      });
      if (res.stop_reason === "refusal") {
        throw new ModelOutputError(`The model declined this request (${res.stop_details?.category ?? "no category"}).`);
      }
      if (res.stop_reason === "max_tokens") throw new ModelOutputError("The model ran out of output tokens.");
      if (res.parsed_output == null) throw new ModelOutputError("The model's reply did not match the expected format.");
      return { data: res.parsed_output, model: res.model };
    },
  };
}
