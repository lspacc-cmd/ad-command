-- Local semantics check for supabase/unapplied/meta-lead-deliveries.sql.
-- Throwaway database, superuser. Not for production.

\set ON_ERROR_STOP on

do $check$
declare
  token uuid;
  result text;
  attempt timestamptz;
begin
  select outcome, claim_token into result, token from public.claim_meta_lead_delivery('100');
  if result <> 'claimed' then raise exception 'new id was %', result; end if;

  select outcome into result from public.claim_meta_lead_delivery('100');
  if result <> 'in_flight' then raise exception 'second claim was %', result; end if;

  if public.note_mail_attempt('100', '00000000-0000-0000-0000-000000000000'::uuid) then
    raise exception 'wrong token recorded an attempt';
  end if;
  if not public.note_mail_attempt('100', token) then
    raise exception 'holder could not record an attempt';
  end if;

  if not public.complete_meta_lead_delivery(
    '100', token, 'retryable', 'dealersocket', '555', 'Sierra', null,
    'dealersocket-adf/v1/100', 'rejected:422:validation_error'
  ) then
    raise exception 'rejection was not recorded';
  end if;
  if (select mail_attempted_at from public.meta_lead_deliveries where leadgen_id = '100') is not null then
    raise exception 'definite rejection kept the attempt time';
  end if;

  select outcome, claim_token into result, token from public.claim_meta_lead_delivery('100');
  if result <> 'claimed' then raise exception 'rejected row claim was %', result; end if;
  if not public.note_mail_attempt('100', token) then
    raise exception 'reclaim could not record an attempt';
  end if;
  if not public.complete_meta_lead_delivery(
    '100', token, 'retryable', 'dealersocket', '555', 'Sierra', null,
    'dealersocket-adf/v1/100', 'ambiguous:unresolved'
  ) then
    raise exception 'ambiguous result was not recorded';
  end if;

  update public.meta_lead_deliveries
    set mail_attempted_at = now() - interval '25 hours'
    where leadgen_id = '100';
  select outcome into result from public.claim_meta_lead_delivery('100');
  if result <> 'needs_review' then raise exception 'expired ambiguous claim was %', result; end if;
  if (select status from public.meta_lead_deliveries where leadgen_id = '100') <> 'needs_review' then
    raise exception 'expired row was not left in needs_review';
  end if;
  if (select last_error from public.meta_lead_deliveries where leadgen_id = '100') <> 'idempotency_window_expired' then
    raise exception 'expired row has the wrong review reason';
  end if;
  select outcome into result from public.claim_meta_lead_delivery('100');
  if result <> 'needs_review' then raise exception 'needs_review became %', result; end if;

  select outcome, claim_token into result, token from public.claim_meta_lead_delivery('200');
  if result <> 'claimed' then raise exception '200 was %', result; end if;
  perform public.note_mail_attempt('200', token);
  update public.meta_lead_deliveries
    set mail_attempted_at = now() - interval '1 hour'
    where leadgen_id = '200';
  perform public.complete_meta_lead_delivery(
    '200', token, 'retryable', 'dealersocket', null, null, null,
    'dealersocket-adf/v1/200', 'ambiguous:unresolved'
  );
  select outcome, claim_token into result, token from public.claim_meta_lead_delivery('200');
  if result <> 'claimed' then raise exception 'in-window ambiguous claim was %', result; end if;
  select mail_attempted_at into attempt from public.meta_lead_deliveries where leadgen_id = '200';
  if attempt is null or attempt >= now() - interval '30 minutes' then
    raise exception 'reclaim refreshed the original attempt time';
  end if;

  select outcome, claim_token into result, token from public.claim_meta_lead_delivery('300');
  perform public.note_mail_attempt('300', token);
  update public.meta_lead_deliveries
    set claimed_at = now() - interval '5 minutes',
        mail_attempted_at = now() - interval '25 hours'
    where leadgen_id = '300';
  select outcome into result from public.claim_meta_lead_delivery('300');
  if result <> 'needs_review' then raise exception 'stale provider attempt was %', result; end if;

  select outcome, claim_token into result, token from public.claim_meta_lead_delivery('400');
  update public.meta_lead_deliveries
    set claimed_at = now() - interval '5 minutes'
    where leadgen_id = '400';
  select outcome, claim_token into result, token from public.claim_meta_lead_delivery('400');
  if result <> 'claimed' then raise exception 'stale unsent claim was %', result; end if;
  if not public.complete_meta_lead_delivery(
    '400', token, 'sent', 'dealersocket', null, null, 'provider_1',
    'dealersocket-adf/v1/400', null
  ) then
    raise exception 'sent completion failed';
  end if;
  select outcome into result from public.claim_meta_lead_delivery('400');
  if result <> 'already_settled' then raise exception 'sent row was %', result; end if;
  if (select status from public.meta_lead_deliveries where leadgen_id = '400') <> 'sent' then
    raise exception 'sent status changed';
  end if;
  if public.complete_meta_lead_delivery(
    '400', '00000000-0000-0000-0000-000000000000'::uuid, 'retryable', null, null, null, null, null, 'rejected:x'
  ) then
    raise exception 'wrong token changed a row';
  end if;

  select outcome into result from public.claim_meta_lead_delivery('401');
  if result <> 'claimed' then raise exception 'separate id was %', result; end if;
end
$check$;

\ir ../supabase/unapplied/seed-manual-leadgen-ids.EXAMPLE.sql

do $seed$
declare
  result text;
begin
  if (select count(*) from public.meta_lead_deliveries where disposition = 'manual_precutover') <> 0 then
    raise exception 'placeholder seed inserted a row';
  end if;

  insert into public.meta_lead_deliveries (
    leadgen_id, status, disposition, claim_token, claimed_at, last_error, updated_at
  )
  select id, 'sent', 'manual_precutover', gen_random_uuid(), now(), 'seeded before reconnect; do not deliver', now()
  from (values ('123456789012345')) as manual_ids(id)
  where manual_ids.id ~ '^[0-9]{1,32}$'
  on conflict (leadgen_id) do nothing;

  insert into public.meta_lead_deliveries (
    leadgen_id, status, disposition, claim_token, claimed_at, last_error, updated_at
  )
  select id, 'retryable', 'dealersocket', gen_random_uuid(), now(), 'ambiguous:unresolved', now()
  from (values ('123456789012345')) as manual_ids(id)
  on conflict (leadgen_id) do nothing;

  if (select status || ':' || disposition from public.meta_lead_deliveries where leadgen_id = '123456789012345')
     <> 'sent:manual_precutover' then
    raise exception 'numeric seed did not stay sent';
  end if;
  select outcome into result from public.claim_meta_lead_delivery('123456789012345');
  if result <> 'already_settled' then raise exception 'seeded id was %', result; end if;
end
$seed$;

do $priv$
declare
  result text;
begin
  begin
    execute 'set local role anon';
    perform * from public.claim_meta_lead_delivery('1');
    raise exception 'anon executed claim';
  exception
    when insufficient_privilege then
      execute 'reset role';
  end;

  execute 'set local role service_role';
  select outcome into result from public.claim_meta_lead_delivery('500');
  if result <> 'claimed' then raise exception 'service_role claim was %', result; end if;
  begin
    update public.meta_lead_deliveries set status = 'sent' where leadgen_id = '500';
    raise exception 'service_role updated the ledger directly';
  exception
    when insufficient_privilege then
      execute 'reset role';
  end;
end
$priv$;

do $bad$
begin
  begin
    perform * from public.claim_meta_lead_delivery('12/34');
    raise exception 'unsafe id was accepted';
  exception
    when others then
      if sqlerrm = 'unsafe id was accepted' then raise; end if;
  end;
  begin
    perform public.complete_meta_lead_delivery(
      '401', claim_token, 'claimed', null, null, null, null, null, null
    )
    from public.meta_lead_deliveries where leadgen_id = '401';
    raise exception 'invalid status was accepted';
  exception
    when others then
      if sqlerrm = 'invalid status was accepted' then raise; end if;
  end;
end
$bad$;
