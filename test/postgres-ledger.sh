#!/bin/bash
# Throwaway local Postgres check. Does not use Supabase or any live credential.
set -euo pipefail
cd "$(dirname "$0")/.."
DB="ad_command_ledger_$$"
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "drop database if exists ${DB};"
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "create database ${DB};"
sudo -u postgres psql -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end $$;
SQL
sudo -u postgres psql -d "$DB" -v ON_ERROR_STOP=1 -f supabase/unapplied/meta-lead-deliveries.sql
sudo -u postgres psql -d "$DB" -v ON_ERROR_STOP=1 -f test/postgres-ledger.sql

sudo -u postgres psql -d "$DB" -v ON_ERROR_STOP=1 -c "select outcome from public.claim_meta_lead_delivery('901');" > /tmp/ledger-a.txt &
sudo -u postgres psql -d "$DB" -v ON_ERROR_STOP=1 -c "select outcome from public.claim_meta_lead_delivery('901');" > /tmp/ledger-b.txt &
wait
python3 - <<'PY'
from pathlib import Path
text = Path("/tmp/ledger-a.txt").read_text() + Path("/tmp/ledger-b.txt").read_text()
if text.count("claimed") != 1 or text.count("in_flight") != 1:
    raise SystemExit(f"concurrent claims were not one winner and one waiter:\n{text}")
PY

sudo -u postgres psql -v ON_ERROR_STOP=1 -c "drop database if exists ${DB};"
echo "local postgres ledger checks passed"
