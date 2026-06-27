# IGS Response Emails — Decision & Response Portal

The decisions-and-communications layer for the **Isomo Graduate Scholars**
selection. The grading is done elsewhere (the
[`igsconsole`](https://github.com/happy-tcu/igsconsole) committee platform, where
reviewers score candidates). This project takes that grading output, lets an
admissions admin set the **final** decision, **publish** it, and **notify**
applicants with a one-click email that lands them on a portal showing their own
animated decision — where selected scholars can accept or decline.

It shares the **same Supabase database** as the grading platform but is a
**separate codebase**. The database (with RLS + security-definer RPCs) is the
only seam between the two.

```
igsconsole (grading)          shared Supabase DB            this repo
  reviewers score      ─►   candidates · ballots   ─►   admin/  set→publish→notify
  → vote tallies            decisions (new)              portal/ applicant views decision
                            RLS + RPCs = the contract    notify-decisions edge fn
```

## Two surfaces, both static (no build step)

| Path | Who | What |
|---|---|---|
| `admin/index.html` | Admissions admins | Sign in (Google), see the worklist with the grading signal, set each decision, **Publish**, **Notify** |
| `portal/index.html` | Applicants | One-click email link logs them straight into their own animated decision; accept/decline |

Both are single static pages using the Supabase JS client from a CDN. Copy each
folder's `config.example.js` → `config.js` and add your Supabase URL + anon key.

## The rest

| Path | What it is |
|---|---|
| `db/14_decisions_and_portal.sql` | The shared-DB layer: `decisions` table, RLS, the `my_decision` / `respond_to_decision` RPCs, the `v_decision_worklist` view, and `seed_decisions_from_ballots()` / `publish_decisions()` helpers. Run once against the shared Supabase project. |
| `supabase/functions/notify-decisions/` | Edge Function that generates a one-click magic link per applicant and emails it via Resend |
| `scripts/notify_decisions.py` | CLI fallback for the notifier (two-step link) |
| `PORTAL.md` | Full setup + per-round runbook |

## Security in one paragraph

The notification email carries a single-use magic link **generated for one
applicant's email** and embedded in the message — clicking logs them straight in,
no pasting. Links are generated and sent one applicant at a time (no lists to
misalign), and the sender **aborts** if it finds duplicate emails. Applicants have
**no read access** to the `decisions` table; they only reach their outcome through
a `security definer` function that returns their own row, only once published, and
only safe fields. The admin actions and the edge function are gated to **admin
reviewers**. The email never reveals the outcome.

## Why it shares the DB but not the codebase

`igsconsole` is a **grading platform** — its job is scoring candidates, and it
should stay that. Deciding outcomes and emailing applicants is a different
responsibility, so it lives here. The two meet only at the database: this app
**reads** the grading output (`v_decision_worklist`) and **writes** its own
`decisions`. Neither app imports the other's code.

## Deploy

See **[PORTAL.md](./PORTAL.md)** for the step-by-step.
