// scripts/export-scanner-tickets.ts
// One-off ops script: exports an event's admissible tickets as a CSV for a
// third-party scanner that checks entries against its own database.
//
// Run with (the env file decides WHICH database is read):
//   node --env-file=.env.local --experimental-strip-types --import ./scripts/lib/register-alias.mjs \
//     scripts/export-scanner-tickets.ts <tenant-subdomain> <intake-slug> --out <file.csv>
//
// Read-only. Columns: ticket_ref, ticket_uuid, tier, seat_no, event.
// ticket_uuid is exactly what a 'uuid'-format event's QR encodes.
//
// Included: status 'valid' tickets on 'confirmed' enrollments that are not
// internal tests. Anything voided or rejected AFTER the export stays in the
// scanner's copy — export at sale close and send any later voids separately.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { createAdminClient } from "@/lib/supabase/admin";

type TicketRow = {
  id: string;
  tier: string;
  seat_no: number;
  enrollments: { enrollment_ref: string; status: string; internal_test_at: string | null } | null;
};

const PAGE = 1000; // PostgREST caps a response at 1000 rows; page past it.

async function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
  const [tenantSlug, intakeSlug] = args.filter((_, i) => i !== outIndex && i !== outIndex + 1);

  if (!tenantSlug || !intakeSlug || !out) {
    console.error("Usage: export-scanner-tickets.ts <tenant-subdomain> <intake-slug> --out <file.csv>");
    process.exit(1);
  }

  // The file lists every admissible ticket for the event. Keep it out of the
  // repository so it can never be committed.
  const outPath = path.resolve(out);
  const repoRoot = path.resolve(import.meta.dirname, "..");
  if (outPath.startsWith(repoRoot + path.sep)) {
    console.error(`Refusing to write inside the repository (${repoRoot}). Choose a path outside it.`);
    process.exit(1);
  }

  const supabase = createAdminClient();

  const { data: tenant, error: tenantError } = (await supabase
    .from("tenants")
    .select("id")
    .eq("subdomain", tenantSlug)
    .single()) as { data: { id: string } | null; error: unknown };
  if (tenantError || !tenant) {
    console.error(`Tenant not found for subdomain "${tenantSlug}".`);
    process.exit(1);
  }

  const { data: intake, error: intakeError } = (await supabase
    .from("intakes")
    .select("id, name, ticket_qr_format")
    .eq("tenant_id", tenant.id)
    .eq("slug", intakeSlug)
    .single()) as {
    data: { id: string; name: string; ticket_qr_format: string } | null;
    error: unknown;
  };
  if (intakeError || !intake) {
    console.error(`Event "${intakeSlug}" not found for tenant "${tenantSlug}".`);
    process.exit(1);
  }
  if (intake.ticket_qr_format !== "uuid") {
    console.warn(
      `WARNING: "${intakeSlug}" is on the '${intake.ticket_qr_format}' QR format — its tickets do NOT ` +
        `encode these UUIDs. Exporting anyway.`,
    );
  }

  const rows: TicketRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = (await supabase
      .from("tickets")
      .select("id, tier, seat_no, enrollments!inner(enrollment_ref, status, internal_test_at)")
      .eq("intake_id", intake.id)
      .eq("status", "valid")
      .order("id")
      .range(from, from + PAGE - 1)) as { data: TicketRow[] | null; error: { message: string } | null };

    if (error || !data) {
      // A partial list handed to a gate is worse than none: stop.
      console.error("Ticket query failed — nothing written:", error?.message ?? "no data");
      process.exit(1);
    }
    rows.push(...data);
    if (data.length < PAGE) break;
  }

  const admissible = rows
    .filter((t) => t.enrollments?.status === "confirmed" && t.enrollments.internal_test_at === null)
    .sort(
      (a, b) =>
        a.enrollments!.enrollment_ref.localeCompare(b.enrollments!.enrollment_ref) || a.seat_no - b.seat_no,
    );

  const uuids = new Set(admissible.map((t) => t.id));
  if (uuids.size !== admissible.length) {
    console.error("Duplicate ticket UUIDs in the result — nothing written.");
    process.exit(1);
  }

  const csv = [
    "ticket_ref,ticket_uuid,tier,seat_no,event",
    ...admissible.map((t) =>
      [t.enrollments!.enrollment_ref, t.id, t.tier, String(t.seat_no), intake.name].map(csvField).join(","),
    ),
  ].join("\r\n");

  writeFileSync(outPath, csv + "\r\n", { encoding: "utf8" });

  const orders = new Set(admissible.map((t) => t.enrollments!.enrollment_ref)).size;
  console.log(`Event:    ${intake.name} (${intakeSlug}), QR format '${intake.ticket_qr_format}'`);
  console.log(`Valid tickets read:       ${rows.length}`);
  console.log(`Excluded (not confirmed / internal test): ${rows.length - admissible.length}`);
  console.log(`Exported: ${admissible.length} tickets across ${orders} orders, all UUIDs unique`);
  console.log(`Written:  ${outPath}`);
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
