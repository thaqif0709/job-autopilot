import type { Db } from "../db/index.js";
import { STATUSES, type Status } from "../types.js";

export interface ListRow {
  id: number;
  company: string;
  title: string;
  location: string;
  status: Status;
  total: number | null;
  summary: string | null;
  flags: string;
}

export function listJobs(db: Db, opts: { status?: Status; min?: number; limit?: number } = {}): ListRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.status) {
    where.push("j.status = ?");
    args.push(opts.status);
  } else {
    where.push("j.status NOT IN ('dropped', 'closed')");
  }
  if (opts.min !== undefined) {
    where.push("s.total >= ?");
    args.push(opts.min);
  }
  args.push(opts.limit ?? 30);
  return db
    .prepare(
      `SELECT j.id, j.company, j.title, j.location, j.status, s.total, s.summary, j.flags
       FROM jobs j LEFT JOIN scores s ON s.job_id = j.id
       WHERE ${where.join(" AND ")}
       ORDER BY s.total IS NULL, s.total DESC, j.id DESC LIMIT ?`,
    )
    .all(...args) as ListRow[];
}

export function statusCounts(db: Db): Record<Status, number> {
  const rows = db.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").all() as { status: Status; n: number }[];
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  for (const r of rows) counts[r.status] = r.n;
  return counts;
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function formatTable(rows: ListRow[]): string {
  if (!rows.length) return "No jobs to show.";
  const lines = rows.map((r) => {
    const score = r.total === null ? "  -" : String(r.total).padStart(3);
    const flag = (JSON.parse(r.flags) as string[]).length ? " !" : "  ";
    return `${String(r.id).padStart(5)} ${score}${flag} ${r.status.padEnd(11)} ${cut(`${r.title} · ${r.company}`, 60).padEnd(60)} ${cut(r.location, 24)}`;
  });
  return [`   id score  status      ${"job".padEnd(60)} location`, ...lines, "", "! = on-call or support-duty language found in the posting"].join("\n");
}
