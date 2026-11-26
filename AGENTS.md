# khe-deals

Workspace-wide rules (push, review, docs, estate ADRs) are in [khe-workspace
`AGENTS.md`](https://github.com/khelias/khe-workspace/blob/main/AGENTS.md).

The family deal alerts: an unattended job in GitHub Actions under
[ADR-001](docs/decisions/001-deal-alerts-are-an-unattended-job.md),
with its model calls under
[ADR-002](docs/decisions/002-deal-alerts-call-the-claude-api-on-the-plans-api-credits.md),
this repo's decisions in `docs/decisions/`, inside
[estate ADR-027](https://github.com/khelias/khe-architecture/blob/main/decisions/027-attended-and-unattended-agent-tiers.md)
points 4-6. It is a writer in the register (estate ADR-007); its envelope
is ADR-001, and its fallback is under "Operating" below and in the header of
`deals.yml`.

## Commands

- `npm ci`, then `npm run check`: eslint, `tsc --noEmit`, `node --test`.
  The workspace commit gate runs it; CI runs it and actionlint as `ci`, the
  required check on `main`.
- `npm run check:watches <dir>`: validates a directory of watch files, e.g.
  `../khe-deals-watches/watches`. The only check khe-deals-watches has.
- Local runs from a checkout with `STATE_KEY` set (any 32 bytes in base64
  for a local state): `node src/collect.ts --data ../khe-deals-watches
  --no-telegram --any-hour` reads the live forum into `work/` and `state/`;
  `node src/act.ts --dry-run` prints what act would send and write, with
  hand-written `work/verdicts-<owner>.sealed` and
  `work/answers-<owner>.sealed` (`node src/box.ts seal <in> <out>`).
  `--no-telegram` reads no messages, so to see command answers and
  proposals, open `work/act.sealed`, add events and `talkSenders`, and seal
  it again. `TELEGRAM_CHATS` is needed by act, dry run included;
  `PII_RULES` (the workspace's `.claude/hooks/pii-rules.toml`) turns the
  gitleaks scan on in a dry run. `node src/agent.ts judge|talk <owner>`
  with `ANTHROPIC_API_KEY` set runs a model job on an opened input
  (`work/judge-input.json`, `work/<owner>/input.json`) and spends credits.
  On agent-vm the sandbox allows the two Hinnavaatlus hosts, and Node's
  `fetch` reaches them through the sandbox proxy only with
  `NODE_USE_ENV_PROXY=1`.

## Code

TypeScript run by Node 26's type stripping: `erasableSyntaxOnly`, so no
enums, namespaces or parameter properties, and imports name the `.ts`
file. No runtime dependencies (built-in `fetch`, `node:crypto`,
`node:test`). TypeScript is two packages on purpose: `@typescript/native`
(TS 7) supplies `tsc`, and `typescript` is aliased to
`@typescript/typescript6` because typescript-eslint does not support TS 7
yet, so a plain Renovate bump of `typescript` to 7 breaks lint.

- `src/collect.ts`: the run every ten minutes, no model. Telegram
  updates, the forum (`src/sources/`), the keyword prefilter
  (`src/prefilter.ts`), and the outputs that decide which jobs run.
- `src/act.ts`: every write, no model. Alerts, commands, answers,
  proposals, button presses, the weekly overview, price and feedback
  lines in khe-deals-watches, the failure alert. Every text it sends is in
  `src/messages.ts`.
- `src/agent.ts`: the judge and talk jobs' tool loop on the Claude API
  (model, caps, the `fetch_page` allowlist); `src/claude.ts`: the
  streamed Messages API client with its retries; `src/http.ts`: the
  spaced, capped fetch both the collector and `fetch_page` use.
- `src/verdicts.ts`: the schemas of the two model files, as checks and as
  the JSON schemas sent for structured output; `src/scan.ts`
  strips links off the two Hinnavaatlus hosts and runs gitleaks.
- `src/state.ts` (capped lists), `src/box.ts` (AES-256-GCM sealing),
  `src/time.ts` (Tallinn hours, judge slots, the overview week),
  `src/watches.ts` (the watch schema), `src/work.ts` (what passes between
  jobs).
- `.github/agent/judge.md` and `talk.md`: the prompts, sent as the
  system prompt.

A source is a module behind `Source` in `src/sources/source.ts`; a new one
joins only with its own terms and robots check, recorded in its plan
(ADR-001 point 7). The Hinnavaatlus module reads the guest SmartFeed and
the first list page of each forum with an unseen item, so a quiet run
makes one request; the requests per run are capped at ten, two seconds
apart, User-Agent `khe-deals/0.1`. The forum table (ids, names, what each
holds) is in `src/sources/hinnavaatlus.ts` and nowhere else in code.

## The workflow

`deals.yml` runs at minute 3 of every ten from 03 to 21 UTC; the exact
collection hours (06-23 Tallinn) and the judge slots (the first run from
07, 12, 17 and 21) are kept in code. Jobs:

- `collect` (environment `collect`: `WATCHES_READ_TOKEN`,
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHATS`, `STATE_KEY`): restores the newest
  `state-*` cache entry, reads, and saves the state itself when nothing
  else runs.
- `judge` and `talk` (environment `agent`: `ANTHROPIC_API_KEY`,
  `STATE_KEY`): `src/agent.ts` calls the Claude API with the opened input
  in the request and one tool, `fetch_page`, which our code runs only for
  a forum topic linked in that input or the hinnavaatlus.ee price search;
  no GitHub token, the key only in that step. A model that fails writes no
  file, so the job fails and act counts it. Both run once per owner, the
  judges one at a time, and open only that owner's input,
  so one family member's watches and messages never share a model context
  with the other's; act counts a judge's verdicts only on its own owner's
  watches.
- `act` (environment `telegram`: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHATS`,
  `WATCHES_WRITE_TOKEN`, `STATE_KEY`): checks and writes, then saves the
  state; it records each send and command in the state before making it,
  and on "Re-run failed jobs" starts from the state its earlier attempt
  saved.
- `failed`: tells the operator, at most once a day.

All three environments are limited to `main`. `TELEGRAM_CHATS` is
`{"operator": "<chat id>", "partner": "<chat id>"}`; owners are keys,
never names.

Logs are public: no step prints listing, message or model text, and an
error prints its own message only (`src/log.ts`). Keep it so.

`workflow_dispatch` with `dry_run` (the default) prints counts instead of
sending; `dry_run=false` is a normal run at any hour, and the first one
seeds the state (everything seen, nothing alerted).

## Operating

- **Adding a watch by hand:** write `watches/<owner>-<slug>.json` in
  khe-deals-watches (fields in its `AGENTS.md`), run `npm run
  check:watches` on it here, commit and push there. The bot reads it at the
  next run.
- **Tokens expire:** the two fine-grained watch tokens have an expiry date
  in the operator's calendar; when one lapses, collect or act fails and the
  failure alert arrives. Make a new token with the same scope and replace
  the secret.
- **The Claude API key** belongs to the `khe-deals` workspace of the
  Console organization that receives the plan's monthly API credits; the
  workspace's monthly spend limit caps the bot, and its Cost page shows
  what the jobs spend (each job also logs its token counts). A leaked key
  is revoked there and a new one set as `ANTHROPIC_API_KEY` in the `agent`
  environment. When the credits or the limit run out, the judge and talk
  jobs fail with `credits` or `limit` in their log line until the next
  credits or month.
- **Renovate** opens pull requests and merges nothing itself: the
  workflow's jobs hold the bot and watch tokens and the Claude API key,
  so an action update is read and merged by hand like any workflow diff.
- **The 60-day rule:** GitHub disables a public repo's schedule after 60
  days without activity, and emails the owner first. Merging Renovate's
  pull requests keeps it active; if it stops anyway, enable the workflow
  again in the Actions tab.
- **Fallback:** disable the workflow; revoke the bot in BotFather, the
  Claude API key in its Console workspace and both watch tokens; revert
  watch commits in khe-deals-watches.
