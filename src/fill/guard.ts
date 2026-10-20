import type { Locator } from "playwright";

/**
 * The one place in the codebase allowed to click. Every click goes through `safeClick`, which
 * refuses anything that could send the application. A test fails if any other file under src/
 * calls click, press, submit or dispatchEvent.
 */
export class SubmitGuardError extends Error {}

/** True when activating this element could submit the form. */
export function looksLikeSubmit(el: Locator): Promise<boolean> {
  return el.evaluate((node) => {
    const e = node as HTMLElement;
    const type = (e.getAttribute("type") ?? "").toLowerCase();
    if (type === "submit" || type === "image") return true;
    // A <button> with no type submits its form.
    if (e.tagName === "BUTTON" && !e.hasAttribute("type") && e.closest("form")) return true;
    const words = [e.innerText, e.getAttribute("value"), e.getAttribute("aria-label"), e.getAttribute("title")].join(" ");
    return /\b(submit|apply|send)\b/i.test(words);
  });
}

export async function safeClick(el: Locator): Promise<void> {
  if (await looksLikeSubmit(el)) {
    throw new SubmitGuardError("Refused to click an element that could submit the application.");
  }
  await el.click();
}
