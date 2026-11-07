-- UNAPPLIED EXAMPLE. Do not run this file as-is.
--
-- Purpose: if Meta redelivers the inquiries that were already entered in
-- DealerSocket by hand, mark those leadgen ids as already sent BEFORE
-- resubscribing the Page leadgen field.
--
-- Paste leadgen ids only. Do not add names, emails, phone numbers, or ad text.
-- Apply only after supabase/unapplied/meta-lead-deliveries.sql has been applied,
-- in the Supabase SQL editor as the database owner. The service role cannot
-- insert into this table. The placeholder below is not numeric, so running this
-- file unchanged inserts nothing.
-- on conflict do nothing, so this cannot downgrade a live sent or suppressed row.

insert into public.meta_lead_deliveries (
  leadgen_id,
  status,
  disposition,
  claim_token,
  claimed_at,
  last_error,
  updated_at
)
select
  id,
  'sent',
  'manual_precutover',
  gen_random_uuid(),
  now(),
  'seeded before reconnect; do not deliver',
  now()
from (
  values
    ('PASTE_LEADGEN_ID')
) as manual_ids(id)
where manual_ids.id ~ '^[0-9]{1,32}$'
on conflict (leadgen_id) do nothing;
