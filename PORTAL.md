# Decision & Response Portal — setup & runbook

Two static surfaces on the **same Supabase project** as the grading platform
([`igsconsole`](https://github.com/happy-tcu/igsconsole)): an **admin** page
where admissions admins set/publish/notify decisions, and an **applicant**
portal where applicants view their own decision via a one-click email link.

```
admin/index.html   set status → Publish → Notify ─►  notify-decisions edge fn
                   (reads v_decision_worklist)        one-click email
portal/index.html  applicant clicks link ─────────►  shows THEIR decision
```

## Pieces

| File | What it is |
|---|---|
| `db/14_decisions_and_portal.sql` | `decisions` table, RLS, the `my_decision()` / `respond_to_decision()` RPCs, the `v_decision_worklist` view, and `seed_decisions_from_ballots()` / `publish_decisions()` helpers |
| `admin/index.html` | Admin console — set status, suggest-from-votes, publish, notify (static page, Google sign-in, admin-only) |
| `portal/index.html` | The applicant portal — single static page (Supabase via CDN, **no build step**) |
| `*/config.example.js` | Copy to `config.js` in each folder; add your Supabase URL + anon key |
| `supabase/functions/notify-decisions/` | Edge Function: generates a one-click magic link per applicant and emails it via Resend |
| `scripts/notify_decisions.py` | CLI fallback for the notifier (two-step link) |

## Security model

- The notification email carries a **one-click magic link generated for that one
  applicant's email** (single-use, expiring). Clicking logs them straight into
  the portal on their own decision — no pasting.
- Links are generated **and** sent one applicant at a time, so there are no two
  lists to misalign. The notifier **aborts before sending** if the target set has
  any duplicate emails (which could otherwise let one link open two decisions).
- Applicants have **no RLS read policy** on `decisions`. They can't query the
  table. They only call `my_decision()`, a `security definer` function returning
  **only their own row, only if published**, and only safe fields (first name,
  status, cohort, orientation, their own response). Grading data and other
  applicants' outcomes stay sealed.
- The admin page, the set/publish/notify RPCs, and the Edge Function are all gated
  to **admin reviewers** (`is_admin()`), enforced server-side.
- The email **never reveals the outcome** — it's just a doorway.

## One-time setup

1. **Run the migration.** Supabase → SQL Editor → paste `db/14_decisions_and_portal.sql` → Run.
2. **Enable email auth.** Supabase → Authentication → Providers → enable **Email**
   (magic link, for applicants). Google stays on (for admins, same as the grading platform).
3. **Allowlist both URLs.** Supabase → Authentication → URL Configuration →
   **Redirect URLs** → add the admin URL and the portal URL
   (`https://igs-response-emails.vercel.app/admin/`,
   `https://igs-response-emails.vercel.app/portal/`).
4. **Configure each page.** In `admin/` and `portal/`:
   `cp config.example.js config.js` and fill in `SUPABASE_URL` + the **anon** key.
5. **Deploy the Edge Function and its secrets:**
   ```bash
   supabase functions deploy notify-decisions
   supabase secrets set \
     RESEND_API_KEY=...                              # from resend.com (verify your sending domain first)
     MAIL_FROM="Isomo Graduate Scholars <isomograduate@isomo.rw>" \
     PORTAL_URL=https://igs-response-emails.vercel.app/portal/
   ```
   (`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.)
   The function can also be deployed from the Supabase dashboard's Functions editor.
6. **Host the static pages.** Deploy `admin/` and `portal/` to any static host
   (Vercel / Netlify / Cloudflare Pages / a bucket). Each folder ships its
   `index.html` + `config.js`.

## Each decision round (all from the admin page — no SQL, no SSH)

Open **admin/** and sign in (admins only):

1. **Set outcomes.** Click **Suggest from votes** to seed a starting status for
   every voted-on candidate from the committee's ballots (never overwrites a
   status you've set), then adjust any row's dropdown. Or set each manually.
2. **Publish decided** — makes every status-set decision live in the portal.
3. **Notify applicants** — emails each published applicant their one-click link.
   Already-notified applicants are skipped; it refuses to send if it finds
   duplicate emails.

The summary row tracks selected / waitlisted / not-selected / published /
notified / viewed / accepted / declined as responses come in.

> Tune the suggestion rule inside `seed_decisions_from_ballots()` to match
> Isomo's actual selection policy. The current default: selected when
> `yes + strong_maybe` outweigh `maybe + no`; not-selected when `no` outweighs
> the positives; waitlisted otherwise.

## Local preview

`python3 -m http.server` from inside `admin/` or `portal/`. `file://` won't work —
the OAuth / magic-link redirects need a real http(s) origin.

## CLI fallback

`scripts/notify_decisions.py` works if you ever want to notify outside the admin
page. Note it sends a *two-step* link (applicant requests their own magic link at
the portal) rather than the one-click link the Edge Function embeds. Needs the
same values in repo-root `.env` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`RESEND_API_KEY`, `PORTAL_URL`, `MAIL_FROM`).
