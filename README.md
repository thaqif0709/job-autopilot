# job-autopilot

A local command-line tool that finds jobs, ranks them against your profile, and drafts your CV summary, cover letter and screening answers. **It never submits anything.** You review every draft and click Submit yourself.

Design: [Job Finder and Ranker: Design](https://claude.ai/code/artifact/d0a55878-d5cd-45ae-bade-fe6b01ac0ebf).

## Status

Built: fetch from Greenhouse and Lever, rule filter, Claude scoring, drafting, approve, CV and cover letter PDFs, form filling that stops before Submit, and status tracking.
Not built yet: reading job-alert emails through Gmail.

## Setup

Needs Node 22 or newer and an Anthropic API key.

```sh
npm install
npx playwright install chromium                       # the browser used for forms and PDFs
cp .env.example .env                                   # add ANTHROPIC_API_KEY
cp config/companies.example.yaml config/companies.yaml # the boards to watch
mkdir -p profile
cp config/profile.example.yaml profile/profile.yaml    # targets, pay, weights
cp config/facts.example.yaml profile/facts.yaml        # the only facts drafts may use
```

`profile/`, `out/`, `data/`, `config/companies.yaml` and `.env` are git-ignored, so your CV, pay and contact details stay on your machine.

## Daily use

```sh
npm run jobs -- fetch            # pull postings, merge duplicates, apply your drop rules
npm run jobs -- rank             # score new jobs 0–100 (up to 50 per run; --limit to change)
npm run jobs -- list             # best first; "!" marks on-call or support-duty language
npm run jobs -- show 12          # score breakdown with a quoted reason per criterion
npm run jobs -- rate 12 bad "on-call heavy"   # recent ratings steer future scoring
npm run jobs -- shortlist 12
npm run jobs -- draft 12         # writes out/12/*.md
# edit out/12/*.md, deal with out/12/gaps.md
npm run jobs -- approve 12
npm run jobs -- fill 12          # opens the form, fills it, waits while you check it and click Submit
npm run jobs -- replied 12 "phone screen on Friday"
npm run jobs -- board            # how many jobs at each status
```

After `npm run build`, the same commands run as `node dist/cli.js <command>`, or as `jobs <command>` once linked with `npm link`.

## How it works

| Stage | What happens | Code |
| --- | --- | --- |
| Fetch | Public Greenhouse and Lever job-board JSON, cached for a day, one request a second. Postings with the same company, cleaned title and city merge into one job, keeping each source's text. | `src/sources/` |
| Rank, pass 1 | Drops blocked titles and locations you ruled out; flags phrases like "on-call" and "24/7". No model call. | `src/rank/rules.ts` |
| Rank, pass 2 | Claude scores five criteria 0–5 with a quoted reason each; your weights fold them into 0–100. Jobs are re-scored only when your profile or the rubric changes. | `src/rank/score.ts`, `src/rank/rubric.ts` |
| Draft | One Claude call writes the CV summary, cover letter and answers. Each sentence cites the fact ids it relies on; a sentence without a valid fact goes to `gaps.md` instead of the draft. Work authorisation, salary and notice-period questions are answered from `fixedAnswers` in your profile, never generated. | `src/draft/` |
| Approve | Refuses while `gaps.md` still lists gaps, then records a hash of the drafts so later steps use exactly that version. | `src/pipeline.ts` |
| Fill | Refuses if the drafts changed since approval. Renders `cv.pdf` and `cover-letter.pdf`, opens the Greenhouse or Lever form in a visible browser, fills contact fields, files, links and your answers, and outlines in orange what it couldn't fill. It stops at a sign-in wall or a visible CAPTCHA. It never clicks Submit: the only code allowed to click is `src/fill/guard.ts`, which refuses anything that could send the form, and a test fails if any other file clicks, presses keys or submits. When you have submitted, press Enter in the terminal to save the confirmation page and mark the job submitted. | `src/fill/` |

The browser keeps its own profile in `data/browser-profile`, so any site you sign in to for applications stays separate from your everyday browser. Set `JOBS_CHROMIUM` to use an installed Chrome instead of Playwright's download.

Both model steps use `claude-opus-5-5` (scoring at low effort, drafting at medium). Set `JOBS_SCORE_MODEL` or `JOBS_DRAFT_MODEL` in `.env` to use another model. If the model declines a request, the API retries it on its default fallback model.

## Development

```sh
npm test            # vitest, against saved board responses and sample forms in test/fixtures; no network, no model calls
npm run typecheck
npm run build
```
