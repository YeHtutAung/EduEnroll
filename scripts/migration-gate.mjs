#!/usr/bin/env node
// migration-gate.mjs — apply ONE named migration file to the LOCAL database
// inside a rolled-back transaction, then run the catalog assertions (Plan v18
// Phase 0b-G). Deployment-order step 3's mechanical gate: prose review missed
// a finalizer whose INSERT could not parse (plan v8); execution caught it.
//
// Mechanically local-only, enforced BEFORE any connection (Plan v18 Files
// table contract):
//   - target host is hard-coded localhost; there is NO DATABASE_URL/env
//     fallback and NO --linked mode — a linked-project fallback is how a
//     "local" tool touches production;
//   - the migration path must resolve inside supabase/migrations/;
//   - exactly one migration may be named;
//   - connection strings and credentials are never printed.
//
// Usage: node scripts/migration-gate.mjs supabase/migrations/<file>.sql

import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Hard-coded local target. Deliberately NOT configurable: no flag, no env.
const LOCAL_HOST = "127.0.0.1";
const LOCAL_PORT = 54322;

export function validateArgs(argv, cwd) {
  const args = argv.filter((a) => a !== "--");
  if (args.some((a) => a.startsWith("--"))) {
    // No flags at all — specifically no --linked, no --url, no escape hatch.
    throw new Error(`unknown flag: ${args.find((a) => a.startsWith("--"))}`);
  }
  if (args.length !== 1) {
    throw new Error(`exactly one migration file must be named, got ${args.length}`);
  }
  const target = args[0];
  // Refuse anything that even looks like a connection string BEFORE touching
  // the filesystem — a hosted-looking URL must fail with no connection
  // attempt and no path resolution side effects.
  if (/^[a-z]+:\/\//i.test(target) || target.includes("@")) {
    throw new Error("argument must be a migration file path, not a URL");
  }
  const abs = resolve(cwd, target);
  const migrationsDir = resolve(cwd, "supabase", "migrations") + sep;
  if (!abs.startsWith(migrationsDir)) {
    throw new Error("migration path must resolve inside supabase/migrations/");
  }
  if (!abs.endsWith(".sql")) {
    throw new Error("migration must be a .sql file");
  }
  return abs;
}

const CATALOG_ASSERTIONS = `
do $assert$
declare
  n int;
begin
  -- Row-contract constraints present on payments
  select count(*) into n from pg_constraint
   where conrelid = 'public.payments'::regclass
     and conname in ('payments_attempt_seq_chk','payments_integration_flow_chk',
                     'payments_attempt_flow_chk','payments_attempt_is_stripe_chk',
                     'payments_provider_ids_are_stripe_chk','payments_flow_ids_chk');
  if n <> 6 then raise exception 'gate: expected 6 payments contract constraints, found %', n; end if;

  -- Unique provider-object + attempt indexes
  select count(*) into n from pg_indexes
   where schemaname = 'public' and tablename = 'payments'
     and indexname in ('payments_stripe_payment_intent_id_uniq',
                       'payments_stripe_session_id_uniq',
                       'payments_enrollment_attempt_uniq');
  if n <> 3 then raise exception 'gate: expected 3 unique indexes, found %', n; end if;

  -- Conflicts table exists with cleanup state
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'payment_settlement_conflicts'
     and column_name in ('first_source_type','first_source_id',
                         'last_source_type','last_source_id','cleanup_status');
  if n <> 5 then raise exception 'gate: conflicts table missing source/cleanup columns (%)', n; end if;

  -- Finalizer is locked down: anon/authenticated cannot execute
  if has_function_privilege('anon'::name,
       'public.finalize_stripe_payment_attempt(uuid,uuid,text,integer,text,text,numeric,bigint,text,uuid)'::regprocedure::oid,
       'execute'::text) then
    raise exception 'gate: anon can execute the finalizer';
  end if;
  if has_function_privilege('authenticated'::name,
       'public.finalize_stripe_payment_attempt(uuid,uuid,text,integer,text,text,numeric,bigint,text,uuid)'::regprocedure::oid,
       'execute'::text) then
    raise exception 'gate: authenticated can execute the finalizer';
  end if;
  if not has_function_privilege('service_role'::name,
       'public.finalize_stripe_payment_attempt(uuid,uuid,text,integer,text,text,numeric,bigint,text,uuid)'::regprocedure::oid,
       'execute'::text) then
    raise exception 'gate: service_role cannot execute the finalizer';
  end if;
end $assert$;
`;

async function main() {
  const abs = validateArgs(process.argv.slice(2), process.cwd());
  let sql = readFileSync(abs, "utf8");
  // The artifact wraps itself in BEGIN/COMMIT; the gate owns the transaction
  // so it can roll back. Strip the outer pair only.
  sql = sql.replace(/^\s*BEGIN;\s*$/m, "").replace(/^\s*COMMIT;\s*$/m, "");

  const pg = require("pg");
  const client = new pg.Client({
    host: LOCAL_HOST,
    port: LOCAL_PORT,
    user: "postgres",
    password: "postgres",
    database: "postgres",
  });
  await client.connect();
  try {
    await client.query("begin");
    await client.query(sql);
    console.log("migration applied (in transaction): OK");
    await client.query(CATALOG_ASSERTIONS);
    console.log("catalog assertions: OK");
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
    console.log("rolled back — nothing committed");
  }
}

// Only run when invoked directly (validateArgs is imported by its tests).
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  main().catch((err) => {
    console.error(`gate FAILED: ${err.message}`);
    process.exit(1);
  });
}
