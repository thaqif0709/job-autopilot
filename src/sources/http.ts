import fs from "node:fs";
import path from "node:path";
import { hashOf } from "../config.js";

export interface Http {
  getJson(url: string): Promise<unknown>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A polite JSON client: responses are cached on disk for a day and live requests are spaced out,
 * so a daily run makes about one request per company board.
 */
export function cachedHttp(cacheDir: string, opts: { delayMs?: number; maxAgeMs?: number; fetchImpl?: typeof fetch } = {}): Http {
  const { delayMs = 1000, maxAgeMs = DAY_MS, fetchImpl = fetch } = opts;
  let last = 0;
  return {
    async getJson(url) {
      const file = path.join(cacheDir, `${hashOf(url)}.json`);
      if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < maxAgeMs) {
        return JSON.parse(fs.readFileSync(file, "utf8"));
      }
      const wait = last + delayMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      const res = await fetchImpl(url, { headers: { accept: "application/json", "user-agent": "job-autopilot (personal use)" } });
      if (!res.ok) throw new Error(`GET ${url} returned ${res.status}`);
      const body = await res.json();
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(body));
      return body;
    },
  };
}
