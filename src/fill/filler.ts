import type { Locator, Page } from "playwright";
import { safeClick } from "./guard.js";
import type { FieldPlan, SitePlan, Target } from "./sites.js";

export interface FillResult {
  filled: string[];
  /** Planned fields that could not be filled, with the reason. */
  missing: { name: string; reason: string }[];
  /** Required fields on the page still empty after filling. */
  requiredEmpty: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Picks the option that matches an answer such as "Yes, Malaysian citizen." → "Yes". */
export function chooseOption(options: string[], answer: string): string | undefined {
  const a = norm(answer);
  const clean = options.map((o) => ({ o, n: norm(o) })).filter((x) => x.n && !/^(select|choose|--)/.test(x.n));
  return (
    clean.find((x) => x.n === a)?.o ??
    clean.filter((x) => new RegExp(`^${escapeRe(x.n)}\\b`).test(a)).sort((x, y) => y.n.length - x.n.length)[0]?.o ??
    clean.find((x) => a.includes(x.n))?.o
  );
}

async function locate(page: Page, target: Target): Promise<Locator | null> {
  const loc = "css" in target ? page.locator(target.css) : page.getByLabel(target.label, { exact: false });
  return (await loc.count()) ? loc.first() : null;
}

type Shape = { tag: string; type: string; role: string };

async function fillOne(page: Page, el: Locator, f: FieldPlan): Promise<string | null> {
  if (f.kind === "file") {
    await el.setInputFiles(f.value);
    return null;
  }
  const shape: Shape = await el.evaluate((n) => ({
    tag: n.tagName,
    type: (n.getAttribute("type") ?? "").toLowerCase(),
    role: (n.getAttribute("role") ?? "").toLowerCase(),
  }));
  if (shape.tag === "SELECT") {
    const options = await el.locator("option").allTextContents();
    const pick = chooseOption(options, f.value);
    if (!pick) return "no option matches the answer";
    await el.selectOption({ label: pick });
    return null;
  }
  if (shape.role === "combobox") {
    await el.fill(f.value.split(/[,.]/)[0] ?? f.value);
    const options = page.getByRole("option");
    const texts = await options.allTextContents();
    const pick = chooseOption(texts, f.value);
    if (!pick) {
      await el.fill("");
      return "no option matches the answer";
    }
    await safeClick(options.filter({ hasText: pick }).first());
    return null;
  }
  if (["checkbox", "radio", "hidden", "file", "submit", "button"].includes(shape.type)) return `a ${shape.type} field needs you`;
  await el.fill(f.value);
  return null;
}

/** Fills what it can and marks the rest on the page. It never submits. */
export async function fillForm(page: Page, plan: SitePlan): Promise<FillResult> {
  const result: FillResult = { filled: [], missing: [], requiredEmpty: [] };
  for (const f of plan.fields) {
    const el = await locate(page, f.target);
    if (!el) {
      result.missing.push({ name: f.name, reason: "not on this form" });
      continue;
    }
    try {
      const problem = await fillOne(page, el, f);
      if (problem) {
        result.missing.push({ name: f.name, reason: problem });
        await el.evaluate((n) => ((n as HTMLElement).style.outline = "3px solid #e8a400"));
      } else {
        result.filled.push(f.name);
      }
    } catch (e) {
      result.missing.push({ name: f.name, reason: e instanceof Error ? e.message.split("\n")[0]! : String(e) });
    }
  }
  result.requiredEmpty = await page.evaluate(() => {
    const out: string[] = [];
    const fields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      "input[required], textarea[required], select[required], [aria-required=true]",
    );
    for (const el of fields) {
      if (el.type === "hidden" || el.offsetParent === null) continue;
      const empty = el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") ? !el.checked : !el.value;
      if (!empty) continue;
      el.style.outline = "3px solid #e8a400";
      const label = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent) || el.getAttribute("aria-label") || el.name;
      const clean = (label ?? "").replace(/\s+/g, " ").trim();
      if (clean) out.push(clean);
    }
    return [...new Set(out)];
  });
  return result;
}

/** Reasons the tool must stop and leave the page to you: a sign-in wall or a visible CAPTCHA challenge. */
export async function findBlocker(page: Page): Promise<string | null> {
  if (await page.locator("input[type=password]:visible").count()) return "the page asks you to sign in";
  const challenge = page.locator('iframe[title*="challenge" i]:visible, iframe[src*="hcaptcha"]:visible');
  if (await challenge.count()) return "the page shows a CAPTCHA";
  return null;
}
