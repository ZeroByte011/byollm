---
"@byollm/server": patch
---

The Supabase adapter stops losing cloud-lane jobs that run longer than one
lease. Migration `20260928000000_adopted_leases_are_not_ours.sql` replaces
`byollm_expire_due`: a lapsed lease is requeued only if this site issued it
(`lease_runner is not null`), and a relay-adopted job instead expires at its
deadline, exactly as MemoryStore has since B258. It also requeues a runner's
held jobs when the runner is deleted, so those rows are not mistaken for
adopted ones. Apply it to your project (`supabase db push`). The cloud-lane
store cases in `the-cloud-lane-keeps-a-long-job.test.ts` now run against
Postgres in CI as well as against MemoryStore.
