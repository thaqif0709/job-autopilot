import { ImapFlow } from "imapflow";
import type { FetchResult } from "./index.js";
import { alertPostings, parseAlertEmail, type Resolver } from "./email.js";

export interface GmailLogin {
  user: string;
  /** A Google app password, not the account password. */
  appPassword: string;
}

/** Gmail is set up when both values are in .env. */
export function gmailLogin(env: NodeJS.ProcessEnv = process.env): GmailLogin | null {
  const user = env.GMAIL_USER?.trim();
  const appPassword = env.GMAIL_APP_PASSWORD?.replace(/\s+/g, "");
  return user && appPassword ? { user, appPassword } : null;
}

export const gmailQuery = (days: number) => `from:(linkedin.com OR jobstreet.com) newer_than:${days}d`;

/**
 * Downloads recent LinkedIn and Jobstreet emails. The mailbox is opened read-only, so nothing is
 * marked as read, moved or deleted.
 */
export async function readGmail(login: GmailLogin, days: number, max = 200): Promise<Buffer[]> {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: login.user, pass: login.appPassword },
    logger: false,
  });
  await client.connect();
  try {
    const boxes = await client.list();
    // "All Mail" also holds archived alerts; its name depends on the account's language.
    const box = boxes.find((b) => b.specialUse === "\\All")?.path ?? "INBOX";
    const lock = await client.getMailboxLock(box, { readOnly: true });
    try {
      const uids = (await client.search({ gmraw: gmailQuery(days) }, { uid: true })) || [];
      const newest = uids.slice(-max);
      if (!newest.length) return [];
      const out: Buffer[] = [];
      for await (const msg of client.fetch(newest, { source: true }, { uid: true })) {
        if (msg.source) out.push(msg.source);
      }
      return out;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

/** Reads job cards out of each email. An email that can't be read is reported and skipped. */
export async function emailPostings(emails: { name: string; raw: Buffer }[], resolve: Resolver): Promise<FetchResult & { read: number }> {
  const result: FetchResult & { read: number } = { postings: [], errors: [], read: emails.length };
  for (const e of emails) {
    try {
      result.postings.push(...(await alertPostings(await parseAlertEmail(e.raw), resolve)));
    } catch (err) {
      result.errors.push({ company: e.name, source: "gmail", message: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
