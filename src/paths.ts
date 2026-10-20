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
    out: path.join(root, "out"),
  };
}
export type Paths = ReturnType<typeof paths>;
