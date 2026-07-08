// scripts/seed-e2e.ts
// Seeds fixed E2E test data into the dev Supabase DB.
// Run with: npm run seed:e2e
// Requires .env.local with NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
//
// SEED_TENANT_SLUG env var (default: "e2e-test"):
//   - "e2e-test" → creates a dedicated test tenant
//   - any other slug (e.g. "walmal") → looks up existing tenant by subdomain

import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TENANT_SLUG = process.env.SEED_TENANT_SLUG ?? "e2e-test";

// ── Fixed IDs (stable across runs) ────────────────────────────────────────────

const BANK_ACCT_ID   = "e2e00000-0000-0000-0000-000000000002";
const INTAKE_ID      = "e2e00000-0000-0000-0000-000000000003";
const CLASS_ID       = "e2e00000-0000-0000-0000-000000000004";

// ── Helper ─────────────────────────────────────────────────────────────────────

async function run(label: string, fn: () => PromiseLike<{ error: unknown }>) {
  const { error } = await fn();
  if (error) {
    console.error(`  ✗ ${label}:`, error);
    process.exit(1);
  }
  console.log(`  ✓ ${label}`);
}

// ── Seed ──────────────────────────────────────────────────────────────────────

async function seed() {
  console.log(`\nSeeding E2E test data into dev DB (tenant: ${TENANT_SLUG})...\n`);

  // 1. Tenant — create if e2e-test, look up if any other existing tenant
  let TENANT_ID: string;
  if (TENANT_SLUG === "e2e-test") {
    const E2E_TENANT_ID = "e2e00000-0000-0000-0000-000000000001";
    await run("tenant (e2e-test)", () =>
      db.from("tenants").upsert(
        { id: E2E_TENANT_ID, name: "E2E Test Org", subdomain: "e2e-test", plan: "pro",
          payment_mode: "bank_transfer", mmqr_provider: "abank" } as never,
        { onConflict: "id" },
      ),
    );
    TENANT_ID = E2E_TENANT_ID;
  } else {
    const { data: tenant, error } = await db
      .from("tenants")
      .select("id")
      .eq("subdomain", TENANT_SLUG)
      .single();
    if (error || !tenant) {
      console.error(`  ✗ tenant not found for subdomain "${TENANT_SLUG}"`);
      process.exit(1);
    }
    TENANT_ID = (tenant as { id: string }).id;
    console.log(`  ✓ tenant (${TENANT_SLUG}) → ${TENANT_ID}`);
  }

  // 2. Bank account
  await run("bank_account (AYA)", () =>
    db.from("bank_accounts").upsert(
      { id: BANK_ACCT_ID, tenant_id: TENANT_ID, bank_name: "AYA",
        account_number: "100200300", account_holder: "E2E Test Org", is_active: true },
      { onConflict: "id" },
    ),
  );

  // 3. Tenant appearance — only seed for the dedicated e2e-test tenant to avoid
  //    overwriting real tenant branding when running against an existing tenant.
  if (TENANT_SLUG === "e2e-test") {
    await run("tenant_appearance", () =>
      db.from("tenant_appearance").upsert(
        { tenant_id: TENANT_ID, template_id: "ev-trusted-official", primary_color: "#0f1f42" },
        { onConflict: "tenant_id" },
      ),
    );
  } else {
    console.log("  - tenant_appearance (skipped — using existing tenant settings)");
  }

  // 4. Intake
  await run("intake (E2E Test Event)", () =>
    db.from("intakes").upsert(
      { id: INTAKE_ID, tenant_id: TENANT_ID, name: "E2E Test Event",
        year: 2026, slug: "e2e-test-2026", status: "open" },
      { onConflict: "id" },
    ),
  );

  // 5. Form fields (Full Name + Email + optional Phone)
  await run("intake_form_fields", () =>
    db.from("intake_form_fields").upsert(
      [
        { intake_id: INTAKE_ID, field_key: "name_en", field_label: "Full Name", field_type: "text",  is_required: true,  sort_order: 1, is_default: true  },
        { intake_id: INTAKE_ID, field_key: "email",   field_label: "Email",     field_type: "email", is_required: true,  sort_order: 2, is_default: true  },
        { intake_id: INTAKE_ID, field_key: "phone",   field_label: "Phone",     field_type: "phone", is_required: false, sort_order: 3, is_default: false },
      ],
      { onConflict: "intake_id,field_key" },
    ),
  );

  // 6. Class (N3, 5000 fee)
  await run("class (N3)", () =>
    db.from("classes").upsert(
      { id: CLASS_ID, intake_id: INTAKE_ID, tenant_id: TENANT_ID,
        level: "N3", fee_amount: 5000, seat_total: 100, seat_remaining: 100, status: "open" },
      { onConflict: "id" },
    ),
  );

  // 7. Enrollments — reset to known state before each test run
  const enrollments = [
    // Used by: step-1 form tests + bank_transfer payment page tests
    { enrollment_ref: "E2E-BANK-001",      class_id: CLASS_ID, tenant_id: TENANT_ID,
      student_name_en: "", phone: "", email: null, status: "pending_payment",   quantity: 1 },
    // Used by: null intake_id regression test (class_id = null → cart enrollment)
    { enrollment_ref: "E2E-FORM-NULL-001", class_id: null,     tenant_id: TENANT_ID,
      student_name_en: "", phone: "", email: null, status: "pending_payment",   quantity: 1 },
    // Used by: success page test — payment_submitted state
    { enrollment_ref: "E2E-SUBMITTED-001", class_id: CLASS_ID, tenant_id: TENANT_ID,
      student_name_en: "E2E User", phone: "0900000000", email: "e2e@test.com",
      status: "payment_submitted", quantity: 1 },
    // Used by: success page test — confirmed/verified state
    { enrollment_ref: "E2E-VERIFIED-001",  class_id: CLASS_ID, tenant_id: TENANT_ID,
      student_name_en: "E2E User", phone: "0900000000", email: "e2e@test.com",
      status: "confirmed", quantity: 1 },
  ] as never[];

  for (const row of enrollments) {
    const ref = (row as { enrollment_ref: string }).enrollment_ref;
    await run(`enrollment ${ref}`, () =>
      db.from("enrollments").upsert(row, { onConflict: "enrollment_ref" }),
    );
  }

  // 8. Payments — delete old records then insert fresh ones so status is reproducible.
  //    E2E-BANK-001 intentionally has NO payment: inserting a pending payment would
  //    trigger the DB to move it to payment_submitted, breaking the PATCH in the submit test.
  const paymentSeeds = [
    { ref: "E2E-SUBMITTED-001", payment_method: "bank_transfer", status: "pending",  card_brand: null,   card_last4: null   },
    { ref: "E2E-VERIFIED-001",  payment_method: "stripe",        status: "verified", card_brand: "visa", card_last4: "4242" },
  ];

  // Clean up any payments left on E2E-BANK-001 by previous upload tests
  const { data: bankEnr } = await db.from("enrollments").select("id").eq("enrollment_ref", "E2E-BANK-001").single();
  if (bankEnr) await db.from("payments").delete().eq("enrollment_id", (bankEnr as { id: string }).id);

  for (const { ref, ...payment } of paymentSeeds) {
    const { data: enr } = await db
      .from("enrollments")
      .select("id")
      .eq("enrollment_ref", ref)
      .single();

    if (!enr) { console.error(`  ✗ enrollment not found: ${ref}`); process.exit(1); }

    // Delete existing payments (trigger does not fire on DELETE)
    await db.from("payments").delete().eq("enrollment_id", (enr as { id: string }).id);

    await run(`payment for ${ref}`, () =>
      db.from("payments").insert({
        enrollment_id: (enr as { id: string }).id,
        tenant_id: TENANT_ID,
        amount: 5000,
        ...payment,
      } as never),
    );
  }

  console.log("\n✅  E2E seed complete.\n");
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
