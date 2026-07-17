// scripts/verify-custom-domains.ts
// Read-only preflight for TENANT_CUSTOM_DOMAINS. Run before changing the Vercel
// environment variable, and before pointing DNS at the app.
//
// Run with:
//   node --env-file=.env.local --experimental-strip-types scripts/verify-custom-domains.ts
//
// NOTE: imports below use relative paths with explicit ".ts" extensions
// (not the "@/..." alias) — plain `node --experimental-strip-types` has no
// tsconfig "paths" resolution, only real ESM specifiers.
//
// WHAT THIS CANNOT DO, stated plainly: it validates the map against
// EduEnroll-dev only. Dev and production hold different tenants, so a slug that
// exists here says nothing about production. Confirming the production
// host → tenant → school mapping is a HUMAN step via the superadmin UI. This
// script narrows the window; it does not close it.

import { parseTenantCustomDomains } from "../src/lib/tenant.ts";
import { createAdminClient } from "../src/lib/supabase/admin.ts";

// This script must never touch production (nhxmumcvgnxlczjsgctz) or Rexiee
// (kbiszegobsbelzbyyfvo). Verify the target rather than trusting .env.local:
// a stray `supabase link` or a copied env file is all it takes.
const DEV_PROJECT_REF = "fnfvwzwrdsnmwxunciti";

function assertDevProject(): void {
  const configuredUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!configuredUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL is required.");

  const { hostname } = new URL(configuredUrl);
  if (hostname !== `${DEV_PROJECT_REF}.supabase.co`) {
    throw new Error(
      `Refusing to run: the custom-domain preflight is restricted to EduEnroll-dev.\n` +
        `  Configured Supabase host: ${hostname}\n` +
        `  Expected:                 ${DEV_PROJECT_REF}.supabase.co`,
    );
  }
}

async function main(): Promise<void> {
  // Guard BEFORE constructing any client.
  assertDevProject();

  const raw = process.env.TENANT_CUSTOM_DOMAINS ?? "";
  if (!raw.trim()) {
    console.log("TENANT_CUSTOM_DOMAINS is not set — no custom domains configured. Nothing to check.");
    return;
  }

  // The SAME parser the runtime uses. Never a second implementation: two
  // parsers would eventually disagree, and a preflight that passes while
  // runtime rejects is worse than none.
  const { map, issues } = parseTenantCustomDomains(raw);

  // Unlike the runtime warning (counts only — env values must not reach shared
  // logs), this is an explicit operator command on a local machine, so printing
  // the offending entries is what makes it useful.
  if (issues.length > 0) {
    console.error(`\n${issues.length} entr${issues.length === 1 ? "y" : "ies"} REJECTED:`);
    for (const issue of issues) {
      console.error(`  #${issue.entry} ${issue.host ?? "(unparseable)"} — ${issue.reason}`);
    }
  }

  if (map.size === 0) {
    console.error("\nNo valid custom domains. Fix the entries above before deploying.");
    process.exitCode = 1;
    return;
  }

  const supabase = createAdminClient();
  let missing = 0;

  console.log(`\nResolving ${map.size} custom domain(s) against EduEnroll-dev:\n`);

  for (const [host, slug] of map) {
    const { data: tenant } = (await supabase
      .from("tenants")
      .select("id, name")
      .eq("subdomain", slug)
      .maybeSingle()) as { data: { id: string; name: string } | null; error: unknown };

    if (!tenant) {
      console.error(`  ${host} → ${slug} → NO TENANT FOUND IN DEV`);
      missing++;
    } else {
      console.log(`  ${host} → ${slug} → "${tenant.name}"`);
    }
  }

  if (missing > 0 || issues.length > 0) {
    console.error(
      `\nFAILED: ${issues.length} invalid entr${issues.length === 1 ? "y" : "ies"}, ` +
        `${missing} slug(s) with no tenant in dev.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    "\nParser and dev tenant lookup passed.\n" +
      "\nSTILL REQUIRED — dev tenants are not production tenants:\n" +
      "  In the superadmin UI ON PRODUCTION, look up each slug above and confirm\n" +
      "  the school name is the client who owns that domain. A slug that exists\n" +
      "  but belongs to a different school is the failure this cannot catch, and\n" +
      "  only a human comparing the name to the domain will see it.",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
