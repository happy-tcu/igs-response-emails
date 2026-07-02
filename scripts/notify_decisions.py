"""Email applicants that their Isomo Graduate Scholars decision is ready.

Sends a personalized, OUTCOME-FREE email (it never says selected/waitlisted/
declined) inviting the applicant to log in to the portal and view their
decision. Mirrors import_candidates.py: stdlib + python-dotenv, talks to
Supabase via the PostgREST API with the service-role key.

Targets published decisions that haven't been notified yet, then stamps
`notified_at` so re-runs don't double-send.

Env (.env at repo root):
    SUPABASE_URL                 https://xxxx.supabase.co
    SUPABASE_SERVICE_ROLE_KEY    service-role key (server-side only)
    RESEND_API_KEY               from resend.com
    PORTAL_URL                   https://decisions.isomo-rw.com   (where index.html is hosted)
    MAIL_FROM                    "Isomo Graduate Scholars <isomograduate@isomo.rw>"

Usage:
    python3 scripts/notify_decisions.py [--dry-run] [--resend] [--limit N]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from urllib import request as urlrequest
from urllib.error import HTTPError

from dotenv import load_dotenv


def api_get(url: str, key: str, path: str):
    req = urlrequest.Request(f"{url}/rest/v1/{path}", method="GET")
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {key}")
    with urlrequest.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def api_patch(url: str, key: str, path: str, body: dict):
    data = json.dumps(body).encode("utf-8")
    req = urlrequest.Request(f"{url}/rest/v1/{path}", data=data, method="PATCH")
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {key}")
    req.add_header("Content-Type", "application/json")
    req.add_header("Prefer", "return=minimal")
    with urlrequest.urlopen(req, timeout=60) as resp:
        return resp.status


def send_email(resend_key: str, mail_from: str, to: str, subject: str, html: str):
    body = json.dumps({"from": mail_from, "to": [to], "subject": subject, "html": html}).encode("utf-8")
    req = urlrequest.Request("https://api.resend.com/emails", data=body, method="POST")
    req.add_header("Authorization", f"Bearer {resend_key}")
    req.add_header("Content-Type", "application/json")
    with urlrequest.urlopen(req, timeout=60) as resp:
        return resp.status


def email_html(first_name: str, portal_url: str) -> str:
    # Deliberately says NOTHING about the outcome — just invites them in.
    return f"""\
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#14213a">
  <p style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#5a6a85">Isomo Graduate Scholars</p>
  <h2 style="color:#1a4fa0;margin:4px 0 16px">Your decision is ready, {first_name}</h2>
  <p style="font-size:15px;line-height:1.6">Thank you for applying to the Isomo Graduate Scholars Program. Your
  selection decision is now available in the applicant portal.</p>
  <p style="margin:24px 0">
    <a href="{portal_url}" style="background:#1a4fa0;color:#fff;text-decoration:none;font-weight:700;padding:13px 26px;border-radius:3px;display:inline-block">View my decision</a>
  </p>
  <p style="font-size:13px;color:#5a6a85;line-height:1.6">Sign in with this same email address. The link is personal to you — please don't share it.</p>
  <hr style="border:none;border-top:1px solid #d9e2f0;margin:24px 0"/>
  <p style="font-size:12px;color:#8a97ac">Isomo Graduate Scholars · Kigali, Rwanda · Broadening Access to Global Education<br/>
  In partnership with the Government of Rwanda &amp; the Mastercard Foundation</p>
</div>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="print who would be emailed; send nothing")
    ap.add_argument("--resend", action="store_true", help="include already-notified applicants")
    ap.add_argument("--limit", type=int, default=0, help="cap how many to send (0 = no cap)")
    args = ap.parse_args()

    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    portal_url = os.environ.get("PORTAL_URL", "").rstrip("/")
    if not args.dry_run:
        resend_key = os.environ["RESEND_API_KEY"]
        mail_from = os.environ["MAIL_FROM"]
        if not portal_url:
            print("PORTAL_URL is required to send emails."); sys.exit(1)

    # published decisions + the candidate's email/first_name (embedded resource)
    filt = "published=eq.true"
    if not args.resend:
        filt += "&notified_at=is.null"
    rows = api_get(url, key, f"decisions?{filt}&select=candidate_id,candidates(email,first_name)")

    targets = []
    for r in rows:
        c = r.get("candidates") or {}
        if c.get("email"):
            targets.append((r["candidate_id"], c["email"], c.get("first_name") or "there"))

    if args.limit:
        targets = targets[:args.limit]

    print(f"{len(targets)} applicant(s) to notify"
          + (" (resend mode)" if args.resend else "")
          + (" [DRY RUN]" if args.dry_run else ""))

    sent = 0
    for cid, email, first in targets:
        if args.dry_run:
            print(f"  would email {first} <{email}>")
            continue
        try:
            send_email(resend_key, mail_from, email,
                       f"Your Isomo Graduate Scholars decision is ready, {first}",
                       email_html(first, portal_url))
            api_patch(url, key, f"decisions?candidate_id=eq.{cid}", {"notified_at": "now()"})
            sent += 1
            print(f"  sent → {email}")
        except HTTPError as e:
            print(f"  FAILED {email}: HTTP {e.code} {e.read().decode('utf-8', 'ignore')[:200]}")
        except Exception as e:  # noqa: BLE001
            print(f"  FAILED {email}: {e}")

    if not args.dry_run:
        print(f"Done. {sent}/{len(targets)} sent.")


if __name__ == "__main__":
    main()
