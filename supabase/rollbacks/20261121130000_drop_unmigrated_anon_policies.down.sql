-- Rollback for 20261121130000_drop_unmigrated_anon_policies.sql
--
-- Intentionally empty. The dropped policies were never part of a migration,
-- production never had them, and no code in this repo depends on them.
-- Recreating them would reopen every tenant's rows to the public anon key.
--
-- If an outside tool (for example a support-agent prototype) needs this
-- data, give it its own server-side path with the service role, scoped to
-- one tenant, instead of an anon policy.
SELECT 1;
