const SENIORITY = new Set(["senior", "sr", "junior", "jr", "lead", "principal", "staff", "mid", "level", "i", "ii", "iii", "iv"]);

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

/** "Senior Software Engineer, Internal Tools (Remote)" and "Software Engineer - Internal Tools" clean to the same title. */
export const cleanTitle = (title: string) => words(title).filter((w) => !SENIORITY.has(w)).join(" ");

const slug = (s: string) => words(s).join("-");

/** The first part of a location ("Kuala Lumpur, Malaysia" → "kuala-lumpur"). */
const city = (location: string) => slug(location.split(/[,;/|]/)[0] ?? "");

export const dedupeKey = (company: string, title: string, location: string) =>
  `${slug(company)}|${cleanTitle(title)}|${city(location)}`;
