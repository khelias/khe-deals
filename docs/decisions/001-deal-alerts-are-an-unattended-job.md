# ADR-001: Family deal alerts are an unattended job that takes requests from a Telegram chat

- **Status:** Accepted (2026-11-17)
- **Related:** [ADR-002](002-deal-alerts-call-the-claude-api-on-the-plans-api-credits.md) (replaces points 3 and 8), [estate ADR-001](https://github.com/khelias/khe-architecture/blob/main/decisions/001-repo-per-product.md) (the watch repo has no CI of its own), [estate ADR-007](https://github.com/khelias/khe-architecture/blob/main/decisions/007-automated-writers.md), [estate ADR-023](https://github.com/khelias/khe-architecture/blob/main/decisions/023-agent-pushes-where-its-session-allows.md) (stands), [estate ADR-027](https://github.com/khelias/khe-architecture/blob/main/decisions/027-attended-and-unattended-agent-tiers.md) (points 4-6 are the job's boundary), [estate ADR-037](https://github.com/khelias/khe-architecture/blob/main/decisions/037-childrens-stories-are-made-by-an-unattended-job.md) (the same kind of content writer), [estate ADR-039](https://github.com/khelias/khe-architecture/blob/main/decisions/039-family-deal-alerts-are-an-unattended-job.md) (where this was first recorded)

## Context

We want to hear about second-hand listings that fit a search before
someone else buys them: first desktop DDR5 memory for the homelab host,
which at the current shortage is cheaper inside a used PC than on its own,
then the family's other searches. Alert apps for this exist, but none
reads the Estonian Hinnavaatlus forum, where the computer parts are sold,
and judging "a PC whose memory is worth it once the rest is resold" needs
a model rather than a keyword.

The judging was to run on our Claude subscription, which costs nothing
more if the model runs only when there is something to judge. A job every
ten minutes needs the free Actions minutes of a public repo: the private
pool is spoken for by the trip atlas and the stories. Each of us talks to
the job in a private Telegram chat: alerts arrive there, and a plain
sentence there asks for a new search.

## Decision

1. **An unattended job under estate ADR-027 points 4-6 that takes requests
   from allowed chat users.** It runs in this public repo on GitHub-hosted
   runners. Collection runs every ten minutes with no model; Claude judges
   the waiting listings in a batch a few times a day and answers a
   free-text message in a job of its own per sender, which sees only that
   sender's watches. Only chat users listed in an environment secret are
   heard; anyone else is reported to us once.
2. **It writes two things: Telegram messages and the users' own watch
   files** (with their price and feedback lines) in the private data repo
   khe-deals-watches. It is a content writer like estate ADR-037 point 4,
   not the builder of estate ADR-027 point 7, so estate ADR-023 stands. A
   watch change is committed only after its owner confirms it with a
   command; the model proposes and never writes.
3. Replaced by [ADR-002](002-deal-alerts-call-the-claude-api-on-the-plans-api-credits.md)
   point 2: the model's one tool, run by our code.
4. **A public repo with encrypted job data.** The family's messages,
   watches and replies pass between jobs and sit in the Actions cache only
   sealed with AES-256-GCM under a key in the environments; logs print no
   listing, message or model text. Fork pull request runs need approval.
   The listings are public on the forum anyway.
5. **The watch repo has no CI of its own,** an exception to estate ADR-001:
   its files are data that this repo's code validates on every read and
   before every write, and its local check is that same validator.
   Fine-grained tokens limited to that repo read it and write it.
6. **agent-vm's sandbox allows the two Hinnavaatlus hosts** (estate ADR-027
   point 3), for fixtures and live runs of the collector.
7. **A new source joins only after its own terms and robots check**,
   recorded in the plan that adds it. Login-gated marketplaces stay out.
8. Replaced by [ADR-002](002-deal-alerts-call-the-claude-api-on-the-plans-api-credits.md)
   point 4: the second user's requests run on the API credits.

How the jobs fit together, the tokens and the fallback are in
[AGENTS.md](../../AGENTS.md).

## Alternatives considered

- **A ready alert app:** none covers the Hinnavaatlus forum, and the
  effective price of a bundle needs a judgement no keyword gives.
- **A private repo:** about 4300 runs a month would not fit the free
  private minutes, and GitHub Free has environment secrets only in public
  repos.
- **Watches in the estate's private documents repo:** it holds the house
  documentation, and a token cannot be scoped to a folder.
- **An always-on bot in the homelab:** answers at once, but a model
  reading strangers' text would run on the home network, which estate
  ADR-027 keeps out; a ten-minute answer is acceptable.
- **A runner egress allowlist:** an action of its own to pin and keep
  working, for what limiting the model's tools already prevents.

## Consequences

- An answer takes up to ten minutes, since nothing runs between the
  scheduled runs.
- A leaked read or write token exposes or changes the search list and
  nothing else.
- Fine-grained tokens expire, so reading the watches fails on a date we
  keep in the calendar; the job then sends its failure alert.
- GitHub disables a public repo's schedule after 60 days without activity;
  Renovate's pin updates keep it active.
- The job is a writer in the estate's register (estate ADR-007), with the
  fallback in [AGENTS.md](../../AGENTS.md) "Operating".

## References

- [Telegram Bot API](https://core.telegram.org/bots/api)
