// notify-decisions — emails each published applicant a ONE-CLICK link to their
// decision. The link is a Supabase magic link generated for that applicant's
// email and embedded in the email; clicking it logs them straight into the
// portal on their own decision. No outcome is revealed in the email.
//
// Safety: links are generated and sent one applicant at a time (no separate
// lists to misalign), each link is cryptographically bound to its email, and
// the run aborts before sending if the target set has duplicate emails.
//
// Deploy:  supabase functions deploy notify-decisions
// Secrets: supabase secrets set RESEND_API_KEY=... MAIL_FROM="..." PORTAL_URL=...
//          (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function emailHtml(firstName: string, link: string): string {
  return `
<div style="font-family:'Open Sans',-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#4a4b4c">
  <img src="https://igs-response-emails.vercel.app/portal/b2r-logo.png" alt="Bridge2Rwanda" height="32" style="height:32px;width:auto;margin-bottom:18px"/>
  <p style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#7a7c7e;margin:0">Isomo Graduate Scholars</p>
  <h2 style="color:#4a4b4c;margin:4px 0 16px">Your decision is ready, ${firstName}</h2>
  <p style="font-size:15px;line-height:1.6">Thank you for applying to the Isomo Graduate Scholars Program.
  Your selection decision is now available — click below to view it.</p>
  <p style="margin:24px 0">
    <a href="${link}" style="background:#4a4b4c;color:#fff;text-decoration:none;font-weight:700;padding:13px 26px;border-radius:3px;display:inline-block">View my decision</a>
  </p>
  <p style="font-size:13px;color:#7a7c7e;line-height:1.6">This link is personal to you and can only be used once — please don't share or forward it.</p>
  <hr style="border:none;border-top:1px solid #e3e5e1;margin:24px 0"/>
  <p style="font-size:12px;color:#9aa09a">Isomo Graduate Scholars · Kigali, Rwanda · Broadening Access to Global Education<br/>
  A Bridge2Rwanda program, in partnership with the Government of Rwanda &amp; the Mastercard Foundation</p>
</div>`;
}

async function sendEmail(key: string, from: string, to: string, firstName: string, link: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `Your Isomo Graduate Scholars decision is ready, ${firstName}`,
      html: emailHtml(firstName, link),
    }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${await res.text()}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    const MAIL_FROM = Deno.env.get("MAIL_FROM");
    const PORTAL_URL = Deno.env.get("PORTAL_URL");
    if (!RESEND_API_KEY || !MAIL_FROM || !PORTAL_URL) {
      return json(500, { error: "missing RESEND_API_KEY / MAIL_FROM / PORTAL_URL secrets" });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    // 1. The caller must be an admin reviewer.
    const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    const callerEmail = userData?.user?.email?.toLowerCase();
    if (userErr || !callerEmail) return json(401, { error: "not authenticated" });
    const { data: rev } = await admin.from("reviewers").select("role").eq("email", callerEmail).maybeSingle();
    if (!rev || rev.role !== "admin") return json(403, { error: "admin only" });

    const body = await req.json().catch(() => ({}));
    const resend = !!body?.resend;

    // 2. Targets: published decisions, with the candidate's email + first name.
    let query = admin
      .from("decisions")
      .select("candidate_id, notified_at, candidates(email, first_name)")
      .eq("published", true);
    if (!resend) query = query.is("notified_at", null);
    const { data: rawRows, error: qErr } = await query;
    if (qErr) return json(500, { error: qErr.message });
    const rows = rawRows ?? [];

    const targets = rows
      .map((r: any) => ({
        candidate_id: r.candidate_id as string,
        email: ((r.candidates?.email ?? "") as string).trim().toLowerCase(),
        first_name: (r.candidates?.first_name ?? "there") as string,
      }))
      .filter((t) => t.email);
    const blanksSkipped = rows.length - targets.length;

    // 3. PRE-FLIGHT: a duplicate email would let one link open two decisions. Abort.
    const seen = new Map<string, number>();
    targets.forEach((t) => seen.set(t.email, (seen.get(t.email) ?? 0) + 1));
    const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([e]) => e);
    if (duplicates.length) {
      return json(400, { error: "duplicate emails in target set — nothing sent", duplicates });
    }

    // 4. Generate + send, one applicant at a time.
    let sent = 0;
    const failures: { email: string; error: string }[] = [];
    for (const t of targets) {
      try {
        // ensure an auth identity exists for this email (idempotent, pre-confirmed)
        await admin.auth.admin.createUser({ email: t.email, email_confirm: true }).catch(() => {});
        const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
          type: "magiclink",
          email: t.email,
          options: { redirectTo: PORTAL_URL },
        });
        const link = linkData?.properties?.action_link;
        if (linkErr || !link) throw new Error(linkErr?.message ?? "no action_link");
        await sendEmail(RESEND_API_KEY, MAIL_FROM, t.email, t.first_name, link);
        await admin.from("decisions").update({ notified_at: new Date().toISOString() }).eq("candidate_id", t.candidate_id);
        sent++;
      } catch (e) {
        failures.push({ email: t.email, error: String(e) });
      }
    }

    return json(200, { sent, failed: failures.length, blanks_skipped: blanksSkipped, failures });
  } catch (e) {
    return json(500, { error: String(e) });
  }
});
