import path from "node:path";

/** Every path is relative to the folder the CLI runs in, so personal data never lands inside node_modules or dist. */
export function paths(root = process.cwd()) {
  return {
    root,
    companies: path.join(root, "config", "companies.yaml"),
    profile: path.join(root, "profile", "profile.yaml"),
    facts: path.join(root, "profile", "facts.yaml"),
    db: path.join(root, "data", "jobs.db"),
    cache: path.join(root, "data", "cache"),
    /** Where each tracked link from an alert email ended up, so it is followed only once. */
    redirects: path.join(root, "data", "cache", "redirects.json"),
    /** A separate browser profile, so sign-ins you make for applications stay out of your everyday browser. */
    browserProfile: path.join(root, "data", "browser-profile"),
    out: path.join(root, "out"),
  };
}
export type Paths = ReturnType<typeof paths>;
