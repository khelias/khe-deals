# khe-deals

A family Telegram bot that watches second-hand listings and says when one
is worth a look. Each of us keeps a few saved searches; a run every ten
minutes reads the new sale topics on the
[Hinnavaatlus forum](https://foorum.hinnavaatlus.ee), keeps the ones whose
keywords fit, and a few times a day Claude judges them in one batch:
does it fit, what is it really, and what does it cost once the rest of a
bundle is resold. A fitting listing arrives in the chat with its picture
and four buttons; a plain sentence in the chat proposes a new search.

The first search is desktop DDR5 memory for the homelab host, which at the
current shortage is often cheaper inside a used PC than on its own.

It is a family tool, not a product: Claude runs on our own subscription
and nothing here is billed per call. The searches and everything the
family writes stay private: the searches live in a private repo, and
messages cross the workflow's jobs only encrypted
([estate ADR-039](https://github.com/khelias/khe-architecture/blob/main/decisions/039-family-deal-alerts-are-an-unattended-job.md)).

## Run

```sh
npm ci
npm run check
```

The workflow is `.github/workflows/deals.yml`; how its jobs fit together,
the local runs and the operating notes are in [`AGENTS.md`](AGENTS.md).

## Where it lives

GitHub Actions on GitHub-hosted runners, in this repo, on a schedule. The
searches are in the private `khelias/khe-deals-watches`.
