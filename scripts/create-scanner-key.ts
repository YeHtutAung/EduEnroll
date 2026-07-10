// scripts/create-scanner-key.ts
// One-off ops script: mints a per-tenant scanner API key for the kuunyi-scanner app.
//
// Run with:
//   node --env-file=.env.local --experimental-strip-types scripts/create-scanner-key.ts <tenant-slug> <key-name>
//
// Requires .env.local with NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
// (see scripts/seed-e2e.ts for the same admin-client + env pattern).
//
// NOTE: imports below use relative paths with explicit ".ts" extensions
// (not the "@/..." alias) — plain `node --experimental-strip-types` has no
// tsconfig "paths" resolution, only real ESM specifiers.

import { randomBytes } from "crypto";
import { createAdminClient } from "../src/lib/supabase/admin.ts";
import { hashApiKey } from "../src/lib/scanner/hash.ts";

async function main() {
  const [tenantSlug, name] = process.argv.slice(2);

  if (!tenantSlug || !name) {
    console.error("Usage: create-scanner-key.ts <tenant-slug> <key-name>");
    process.exit(1);
  }

  const supabase = createAdminClient();

  // NOTE: tenants are identified by "subdomain" in this schema (there is no
  // "slug" column on tenants — that field only exists on intakes). The CLI
  // arg is still called tenant-slug for readability since it's effectively
  // the tenant's stable identifier.
  const { data: tenant, error: tenantError } = (await supabase
    .from("tenants")
    .select("id")
    .eq("subdomain", tenantSlug)
    .single()) as { data: { id: string } | null; error: unknown };

  if (tenantError || !tenant) {
    console.error(`Tenant not found for slug "${tenantSlug}".`);
    process.exit(1);
  }

  const raw = randomBytes(32).toString("base64url");
  const keyHash = hashApiKey(raw);
  const keyPrefix = raw.slice(0, 8);

  const { error: insertError } = await supabase.from("scanner_api_keys").insert({
    tenant_id: tenant.id,
    name,
    key_hash: keyHash,
    key_prefix: keyPrefix,
  } as never);

  if (insertError) {
    console.error("Failed to create scanner API key:", insertError);
    process.exit(1);
  }

  console.log("\nScanner API key created.\n");
  console.log(`  Tenant:     ${tenantSlug}`);
  console.log(`  Key name:   ${name}`);
  console.log(`  Key prefix: ${keyPrefix}`);
  console.log(`\n  Raw key (shown ONCE — store it now, it is not recoverable):\n`);
  console.log(`  ${raw}\n`);
  console.log("  Only the SHA-256 hash of this key is stored in the database.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
