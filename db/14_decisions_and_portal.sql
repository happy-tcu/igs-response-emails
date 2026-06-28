-- IGS — applicant decision portal
-- Adds a `decisions` layer on top of the committee's candidates/ballots, plus
-- the security-definer RPCs the public applicant portal uses.
--
-- Run this in the Supabase SQL editor (Project → SQL → New query), AFTER the
-- earlier numbered migrations. Safe to re-run (idempotent).

-- This migration is purely ADDITIVE. It relies on two helpers already defined
-- by the grading platform's earlier migrations and does NOT redefine them:
--   • is_reviewer()  (schema.sql)         — caller is a whitelisted reviewer
--   • is_admin()     (06_admin_policies)  — caller is an admin reviewer
-- Both are security-definer lookups against `reviewers`.

-- ── decisions — one per candidate, the applicant-facing outcome ─────────
create table if not exists decisions (
  candidate_id  uuid primary key references candidates(id) on delete cascade,
  status        text check (status in ('selected','waitlisted','not_selected')),
  cohort        text default '2026 Cohort',
  orientation   text,                       -- e.g. 'July 2026'
  published     boolean not null default false,
  published_at  timestamptz,
  notified_at   timestamptz,                -- set by notify_decisions.py
  viewed_at     timestamptz,                -- first time the applicant opened it
  response      text check (response in ('accepted','declined')),
  responded_at  timestamptz,
  decided_by    text references reviewers(email) on delete set null,
  updated_at    timestamptz default now()
);

create index if not exists decisions_status_idx on decisions (status);

-- keep updated_at fresh
create or replace function touch_decisions() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists decisions_touch on decisions;
create trigger decisions_touch before update on decisions
  for each row execute function touch_decisions();

-- ── Row-Level Security ──────────────────────────────────────────────────
-- NOTE: applicants get NO direct policy on this table. They cannot SELECT it
-- at all. They only ever reach their decision through the security-definer
-- RPCs below, which return a minimal, own-row-only, published-only result.
-- This keeps all committee data (and other applicants' outcomes) sealed.
alter table decisions enable row level security;

drop policy if exists "reviewers read decisions" on decisions;
create policy "reviewers read decisions" on decisions
  for select using (is_reviewer());

drop policy if exists "admins insert decisions" on decisions;
create policy "admins insert decisions" on decisions
  for insert with check (is_admin());

drop policy if exists "admins update decisions" on decisions;
create policy "admins update decisions" on decisions
  for update using (is_admin()) with check (is_admin());

drop policy if exists "admins delete decisions" on decisions;
create policy "admins delete decisions" on decisions
  for delete using (is_admin());

-- ════════════════════════════════════════════════════════════════════════
-- APPLICANT-FACING RPCs  (the only surface the public portal touches)
-- ════════════════════════════════════════════════════════════════════════

-- my_decision(): returns the calling applicant's published decision, joined
-- with their first name and program info. Empty result if the email isn't a
-- candidate, or the decision isn't published — so non-applicants and
-- pre-publish states leak nothing. Also stamps viewed_at on first open.
create or replace function my_decision()
returns table (
  first_name   text,
  status       text,
  cohort       text,
  orientation  text,
  response     text,
  responded_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
begin
  -- mark as viewed the first time they open it
  update decisions d
     set viewed_at = coalesce(d.viewed_at, now())
    from candidates c
   where d.candidate_id = c.id
     and lower(c.email) = v_email
     and d.published = true;

  return query
    select c.first_name, d.status, d.cohort, d.orientation, d.response, d.responded_at
      from decisions d
      join candidates c on c.id = d.candidate_id
     where lower(c.email) = v_email
       and d.published = true;
end;
$$;

-- respond_to_decision(): a selected applicant accepts or declines their place.
create or replace function respond_to_decision(p_choice text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email  text := lower(auth.jwt() ->> 'email');
  v_status text;
begin
  if p_choice not in ('accepted','declined') then
    raise exception 'invalid choice: %', p_choice;
  end if;

  select d.status into v_status
    from decisions d
    join candidates c on c.id = d.candidate_id
   where lower(c.email) = v_email
     and d.published = true
   for update of d;

  if v_status is null then
    raise exception 'no published decision for this account';
  end if;
  if v_status <> 'selected' then
    raise exception 'only selected scholars can respond';
  end if;

  update decisions d
     set response = p_choice, responded_at = now()
    from candidates c
   where d.candidate_id = c.id
     and lower(c.email) = v_email;

  return p_choice;
end;
$$;

-- only logged-in users may call these; the functions themselves enforce
-- own-row + published gating.
grant execute on function my_decision()                to authenticated;
grant execute on function respond_to_decision(text)    to authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- COMMITTEE-FACING helpers (reviewers/admins only)
-- ════════════════════════════════════════════════════════════════════════

-- Worklist: every candidate with their ballot tally and current decision, so
-- admins can set outcomes. security_invoker = RLS of the base tables applies,
-- so only whitelisted reviewers ever see rows.
create or replace view v_decision_worklist
with (security_invoker = true) as
  select
    c.id            as candidate_id,
    c.first_name,
    c.last_name,
    c.email,
    c.intended_degree,
    c.intended_field,
    count(b.*) filter (where b.decision = 'yes')          as yes_votes,
    count(b.*) filter (where b.decision = 'strong_maybe') as strong_maybe_votes,
    count(b.*) filter (where b.decision = 'maybe')        as maybe_votes,
    count(b.*) filter (where b.decision = 'no')           as no_votes,
    round(avg(b.score), 1)                                as avg_score,
    d.status,
    d.published,
    d.notified_at,
    d.viewed_at,
    d.response,
    d.responded_at
  from candidates c
  left join ballots   b on b.candidate_id = c.id
  left join decisions d on d.candidate_id = c.id
  group by c.id, d.status, d.published, d.notified_at, d.viewed_at, d.response, d.responded_at;

-- reviewers reach the worklist through PostgREST; security_invoker + the base
-- tables' RLS mean non-reviewers still see zero rows.
grant select on v_decision_worklist to authenticated;

-- Publish every decision that has a status set but isn't live yet.
create or replace function publish_decisions()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if not is_admin() then
    raise exception 'admin only';
  end if;

  update decisions
     set published = true,
         published_at = coalesce(published_at, now())
   where status is not null
     and published = false;

  get diagnostics n = row_count;
  return n;
end;
$$;

grant execute on function publish_decisions()               to authenticated;
