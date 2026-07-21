import fs from "fs";
import path from "path";

// ─── Database test setup: load, validate, and refuse anything non-local ─────
// Runs before test collection. Every check here fails loudly rather than
// skipping: a skipped integration suite reports green and proves nothing,
// which is the failure mode that let the seat-restoration bugs survive.

// ── Load .env.test.local ────────────────────────────────────────────────────
// Written by the capture step (see the plan). Not committed — .env*.local is
// gitignored. Values already in the environment win, so CI can supply them
// another way later.
const envFile = path.join(process.cwd(), ".env.test.local");
if (fs.existsSync(envFile)) {
  // Strip the UTF-8 BOM. PowerShell 5.1's Out-File -Encoding utf8 writes one,
  // so without this the first variable is named "﻿DATABASE_URL" — which
  // then fails the presence check below with a message naming a variable the
  // file appears to contain.
  const contents = fs.readFileSync(envFile, "utf8").replace(/^﻿/, "");
  for (const line of contents.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i < 1 || line.startsWith("#")) continue;
    const name = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (!process.env[name]) process.env[name] = value;
  }
}

// ── 1. Presence — all four ──────────────────────────────────────────────────
// The keys are not URLs and cannot be host-checked, but a missing key breaks
// verifyPayment() and the ACL cases for reasons unrelated to what they test.
// A red for the wrong reason is indistinguishable from a real defect.
for (const name of [
  "DATABASE_URL",
  "SUPABASE_TEST_URL",
  "SUPABASE_TEST_SERVICE_KEY",
  "SUPABASE_TEST_ANON_KEY",
] as const) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `${name} is missing or empty. Refusing to run database tests.\n` +
        `Run the capture step to write .env.test.local from the local stack.`,
    );
  }
}

// ── 2. Host — the two URLs only ─────────────────────────────────────────────
// check_expired_enrollments() is GLOBAL: it processes every eligible
// enrollment across every tenant. Pointed at a shared dev or production
// project it would reject unrelated enrollments. This guard is the reason the
// suite is safe to run at all.
for (const name of ["DATABASE_URL", "SUPABASE_TEST_URL"] as const) {
  const host = new URL(process.env[name]!).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(
      `${name} points at ${host}. Refusing to run database tests outside the isolated local stack.`,
    );
  }
}

// ── 3. Mirror hosted Supabase's table grants ────────────────────────────────
// The local stack does NOT reproduce production's privileges, and the gap is
// invisible until something goes through PostgREST.
//
// Supabase's default ACLs differ by the role that creates the object:
//   supabase_admin → anon/authenticated/service_role get arwdDxtm (full DML)
//   postgres       → they get only Dxtm (no SELECT/INSERT/UPDATE/DELETE)
//
// The CLI applies migrations as `postgres`, hosted Supabase as
// `supabase_admin`. So locally every public table is unreachable through the
// API — `permission denied for table …` (42501) for every key, including
// service_role — while production works.
//
// Without this, verifyPayment()'s writes fail and are DISCARDED by the code
// under test, which then returns a success-shaped result. The test still goes
// red, but for a harness reason rather than the defect. Measured: it reported
// "restored nothing" when the real defect is "restored twice".
//
// Granted here rather than in a migration: production already has these, so a
// migration would be a no-op there and would misrepresent this as a schema
// change. Idempotent, and the host guard above has already refused anything
// non-local.
{
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(`
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
        TO anon, authenticated, service_role;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
        TO anon, authenticated, service_role;
    `);
  } finally {
    await client.end();
  }
}

// ── 4. Test-only ticket signing key ─────────────────────────────────────────
// Tests that issue real tickets call loadSigningKey(), which reads
// TICKET_SIGNING_KEY (base64 DER pkcs8) and TICKET_KID.
//
// Generated in-process and assigned UNCONDITIONALLY with `=`. Deliberately not
// `??=` or `if (!process.env.X)`: an ambient-preserving pattern would let a
// developer's — or a hosted environment's — real signing key sign test tickets.
// The key never leaves this process and is never printed.
{
  const { generateKeyPairSync } = await import("crypto");
  const { privateKey } = generateKeyPairSync("ed25519");
  process.env.TICKET_SIGNING_KEY = privateKey
    .export({ type: "pkcs8", format: "der" })
    .toString("base64");
  process.env.TICKET_KID = "test-kid";
}

// ── 5. Map onto the names createAdminClient() reads ─────────────────────────
// It resolves these at call time, not import time. Without this it would pick
// up .env.local and run against the shared dev project — silently, because
// both are valid Supabase clients.
process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_TEST_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_TEST_SERVICE_KEY;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = process.env.SUPABASE_TEST_ANON_KEY;
