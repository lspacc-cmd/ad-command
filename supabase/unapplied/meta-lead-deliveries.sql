-- UNAPPLIED. Do not run this from CI, and do not move it into supabase/migrations
-- unless a person intends the Supabase CLI to apply it.
--
-- Apply in the Supabase SQL editor, as the database owner, BEFORE deploying the
-- webhook code that calls these functions.
--
-- The table stores Meta leadgen ids and delivery state only. It has no contact
-- columns. Row level security is on and there are no policies. The two functions
-- are security definer, with a fixed search_path, and only service_role may
-- execute them. service_role can read the ledger and cannot insert, update, or
-- delete it directly.
--
-- An ambiguous provider attempt stores mail_attempted_at before the call.
-- A later claim at or after 24 hours does not send again. It marks the row
-- needs_review. A definite provider rejection clears that timestamp so a later
-- retry can still send. RESEND_IDEMPOTENCY_WINDOW_MS in app/lib/lead-delivery.ts
-- is the same 24 hour window.

create extension if not exists pgcrypto;

create table if not exists public.meta_lead_deliveries (
  leadgen_id text primary key,
  status text not null check (status in ('claimed', 'sent', 'suppressed', 'retryable', 'needs_review')),
  disposition text check (disposition is null or disposition in ('dealersocket', 'recruiting', 'manual_precutover')),
  form_id text,
  form_name text,
  claim_token uuid not null,
  claimed_at timestamptz not null default now(),
  resend_id text,
  idempotency_key text,
  last_error text,
  mail_attempted_at timestamptz,
  updated_at timestamptz not null default now()
);

comment on table public.meta_lead_deliveries is
  'Delivery ledger for Meta leadgen ids. No contact fields.';

alter table public.meta_lead_deliveries enable row level security;

revoke all on table public.meta_lead_deliveries from public, anon, authenticated, service_role;
grant select on table public.meta_lead_deliveries to service_role;

create or replace function public.claim_meta_lead_delivery(p_leadgen_id text)
returns table (
  outcome text,
  claim_token uuid,
  status text,
  resend_id text,
  last_error text
)
language plpgsql
security definer
set search_path = public
as $function$
declare
  inserted_token uuid;
  existing public.meta_lead_deliveries%rowtype;
  new_token uuid;
begin
  if p_leadgen_id is null or p_leadgen_id !~ '^[0-9]{1,32}$' then
    raise exception 'invalid leadgen_id';
  end if;

  insert into public.meta_lead_deliveries as d (leadgen_id, status, claim_token, claimed_at, updated_at)
  values (p_leadgen_id, 'claimed', gen_random_uuid(), now(), now())
  on conflict (leadgen_id) do nothing
  returning d.claim_token into inserted_token;

  if inserted_token is not null then
    outcome := 'claimed';
    claim_token := inserted_token;
    status := 'claimed';
    resend_id := null;
    return next;
    return;
  end if;

  select * into existing
  from public.meta_lead_deliveries
  where leadgen_id = p_leadgen_id
  for update;

  if not found then
    raise exception 'delivery row missing';
  end if;

  if existing.status in ('sent', 'suppressed') then
    outcome := 'already_settled';
    claim_token := existing.claim_token;
    status := existing.status;
    resend_id := existing.resend_id;
    return next;
    return;
  end if;

  if existing.status = 'needs_review' then
    outcome := 'needs_review';
    claim_token := existing.claim_token;
    status := existing.status;
    resend_id := existing.resend_id;
    last_error := existing.last_error;
    return next;
    return;
  end if;

  -- Ambiguous attempts are not resent once Resend's 24 hour key has expired.
  -- A missing attempt time on an ambiguous row also fails closed.
  if existing.status = 'retryable'
     and coalesce(existing.last_error, '') like 'ambiguous:%'
     and (
       existing.mail_attempted_at is null
       or existing.mail_attempted_at <= now() - interval '24 hours'
     ) then
    update public.meta_lead_deliveries as ledger
      set status = 'needs_review',
          last_error = 'idempotency_window_expired',
          updated_at = now()
      where ledger.leadgen_id = p_leadgen_id
        and ledger.claim_token = existing.claim_token
        and ledger.status = 'retryable'
      returning ledger.claim_token into inserted_token;

    if inserted_token is not null then
      outcome := 'needs_review';
      claim_token := inserted_token;
      status := 'needs_review';
      resend_id := existing.resend_id;
      last_error := 'idempotency_window_expired';
      return next;
      return;
    end if;
  end if;

  -- A claim that already called the provider and then went stale is the same
  -- ambiguity. After 24 hours it is manual review, not another send.
  if existing.status = 'claimed'
     and existing.claimed_at < now() - interval '2 minutes'
     and existing.mail_attempted_at is not null
     and existing.mail_attempted_at <= now() - interval '24 hours' then
    update public.meta_lead_deliveries as ledger
      set status = 'needs_review',
          last_error = 'idempotency_window_expired',
          updated_at = now()
      where ledger.leadgen_id = p_leadgen_id
        and ledger.claim_token = existing.claim_token
        and ledger.status = 'claimed'
      returning ledger.claim_token into inserted_token;

    if inserted_token is not null then
      outcome := 'needs_review';
      claim_token := inserted_token;
      status := 'needs_review';
      resend_id := existing.resend_id;
      last_error := 'idempotency_window_expired';
      return next;
      return;
    end if;
  end if;

  -- Same 2 minute lease as CLAIM_LEASE_MS in app/lib/lead-delivery.ts.
  -- mail_attempted_at is intentionally left unchanged.
  if existing.status = 'retryable'
     or (existing.status = 'claimed' and existing.claimed_at < now() - interval '2 minutes') then
    new_token := gen_random_uuid();
    update public.meta_lead_deliveries as ledger
      set status = 'claimed',
          claim_token = new_token,
          claimed_at = now(),
          updated_at = now(),
          last_error = null
      where ledger.leadgen_id = p_leadgen_id
        and ledger.claim_token = existing.claim_token
      returning ledger.claim_token into inserted_token;

    if inserted_token is not null then
      outcome := 'claimed';
      claim_token := inserted_token;
      status := 'claimed';
      resend_id := existing.resend_id;
      return next;
      return;
    end if;
  end if;

  outcome := 'in_flight';
  claim_token := existing.claim_token;
  status := existing.status;
  resend_id := existing.resend_id;
  return next;
end;
$function$;

create or replace function public.complete_meta_lead_delivery(
  p_leadgen_id text,
  p_claim_token uuid,
  p_status text,
  p_disposition text,
  p_form_id text,
  p_form_name text,
  p_resend_id text,
  p_idempotency_key text,
  p_last_error text
) returns boolean
language plpgsql
security definer
set search_path = public
as $function$
declare
  updated_count integer;
begin
  if p_status not in ('sent', 'suppressed', 'retryable', 'needs_review') then
    raise exception 'invalid status';
  end if;
  if p_disposition is not null and p_disposition not in ('dealersocket', 'recruiting', 'manual_precutover') then
    raise exception 'invalid disposition';
  end if;

  update public.meta_lead_deliveries
    set status = p_status,
        disposition = p_disposition,
        form_id = p_form_id,
        form_name = p_form_name,
        resend_id = coalesce(p_resend_id, resend_id),
        idempotency_key = p_idempotency_key,
        last_error = left(coalesce(p_last_error, ''), 500),
        mail_attempted_at = case
          when p_status = 'retryable' and coalesce(p_last_error, '') like 'rejected:%' then null
          else mail_attempted_at
        end,
        updated_at = now()
    where leadgen_id = p_leadgen_id
      and claim_token = p_claim_token
      and status = 'claimed';

  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$function$;

create or replace function public.note_mail_attempt(
  p_leadgen_id text,
  p_claim_token uuid
) returns boolean
language plpgsql
security definer
set search_path = public
as $function$
declare
  updated_count integer;
begin
  update public.meta_lead_deliveries
    set mail_attempted_at = coalesce(mail_attempted_at, now()),
        updated_at = now()
    where leadgen_id = p_leadgen_id
      and claim_token = p_claim_token
      and status = 'claimed';

  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$function$;

revoke all on function public.claim_meta_lead_delivery(text) from public, anon, authenticated;
revoke all on function public.complete_meta_lead_delivery(text, uuid, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.note_mail_attempt(text, uuid) from public, anon, authenticated;
grant execute on function public.claim_meta_lead_delivery(text) to service_role;
grant execute on function public.complete_meta_lead_delivery(text, uuid, text, text, text, text, text, text, text) to service_role;
grant execute on function public.note_mail_attempt(text, uuid) to service_role;
