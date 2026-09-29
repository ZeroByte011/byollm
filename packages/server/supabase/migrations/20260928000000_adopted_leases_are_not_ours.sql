-- An adopted lease is not this site's to expire — B258 in SQL, BY-05.
--
-- `adopt` (src/supabase/index.ts) writes a relay's grant with
-- `lease_runner = null` and a `lease_expires_at` from the RELAY's clock. On
-- the cloud lane the device heartbeats the relay, not this database, so
-- nothing here ever renews that timestamp. `byollm_expire_due` step 1
-- requeued every `claimed|running` row past it anyway, and the device's
-- later `complete` found `state = queued` and was refused: every cloud-lane
-- job slower than one lease (60 s by default) lost its result, silently.
--
-- MemoryStore was fixed in B258 (`memory.ts`, `#expireDueSync`). This is the
-- same sweep, row for row:
--
--   1. Requeue a lapsed lease — only one THIS site issued (`lease_runner is
--      not null`). Direct-lane behaviour is unchanged.
--   2. Expire an adopted job (`lease_runner is null and lease_id is not
--      null`) that is past its deadline — `deadlineFor` in `records.ts`:
--      `coalesce(deadline_at, coalesce(claimable_at, now()) + ttl_ms)`. This
--      is the bound that replaces the lease clock, or a relay that went quiet
--      would leave the row `claimed` forever. It does not look at
--      `lease_expires_at` at all.
--   3. Expire `queued` rows past their TTL or deadline, as before.
--
-- Deleting a runner. `lease_runner` is `on delete set null`, and owners may
-- delete their runners (`byollm_runners_owner_delete`). Without more, a
-- deleted runner's claimed rows would take the adopted shape in (2) and wait
-- out their deadline instead of being requeued. So a runner's held jobs are
-- requeued BEFORE its row goes: a deleted runner cannot authenticate, so it
-- could never have completed them, and requeueing is what step 1 would have
-- done at the lapse anyway — only sooner. The RI action that nulls the column
-- is an AFTER trigger, so this one always runs first.

create or replace function byollm_expire_due()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  changed integer := 0;
  n integer;
begin
  -- 1. Reclaim lapsed leases this site issued. TTL clock restarts: the job
  --    has been worked on, not waiting.
  update byollm_jobs
     set state            = 'queued',
         lease_id         = null,
         lease_runner     = null,
         lease_expires_at = null,
         completed_by_lease_id = null,
         claimable_at     = now(),
         updated_at       = now()
   where state in ('claimed', 'running')
     and lease_runner is not null
     and lease_expires_at is not null
     and lease_expires_at <= now();
  get diagnostics n = row_count;
  changed := changed + n;

  -- 2. An adopted job still stops at its deadline.
  update byollm_jobs
     set state            = 'expired',
         lease_id         = null,
         lease_runner     = null,
         lease_expires_at = null,
         completed_by_lease_id = null,
         updated_at       = now()
   where state in ('claimed', 'running')
     and lease_runner is null
     and lease_id is not null
     and coalesce(
           deadline_at,
           coalesce(claimable_at, now()) + (ttl_ms || ' milliseconds')::interval
         ) <= now();
  get diagnostics n = row_count;
  changed := changed + n;

  -- 3. Expire what has genuinely sat unclaimed past its TTL, plus anything
  --    past its absolute deadline.
  update byollm_jobs
     set state            = 'expired',
         lease_id         = null,
         lease_runner     = null,
         lease_expires_at = null,
         completed_by_lease_id = null,
         updated_at       = now()
   where state = 'queued'
     and (
       (claimable_at is not null
         and claimable_at + (ttl_ms || ' milliseconds')::interval <= now())
       or (deadline_at is not null and deadline_at <= now())
     );
  get diagnostics n = row_count;
  changed := changed + n;

  return changed;
end;
$$;

revoke all on function byollm_expire_due() from public;
grant execute on function byollm_expire_due() to service_role;

create or replace function byollm_requeue_deleted_runner_jobs()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update byollm_jobs
     set state            = 'queued',
         lease_id         = null,
         lease_runner     = null,
         lease_expires_at = null,
         completed_by_lease_id = null,
         claimable_at     = now(),
         updated_at       = now()
   where lease_runner = old.id
     and state in ('claimed', 'running');
  return old;
end;
$$;

revoke all on function byollm_requeue_deleted_runner_jobs() from public;

create trigger byollm_runners_requeue_on_delete
  before delete on byollm_runners
  for each row
  execute function byollm_requeue_deleted_runner_jobs();
