// scripts/export-ticket-qr.ts
// One-off ops script: exports an event's admissible tickets as a CSV with the
// exact text each ticket's QR encodes — for the owner's own records or reprints.
//
// Run with (the env file decides WHICH database is read and WHICH signing key
// is used — for a 'jwt' event it must hold that environment's
// TICKET_SIGNING_KEY and TICKET_KID, or the tokens will not scan):
//   node --env-file=<env file> --experimental-strip-types --import ./scripts/lib/register-alias.mjs \
//     scripts/export-ticket-qr.ts <tenant-subdomain> <intake-slug> --out <file.csv>
//
// Read-only. Columns: ticket_ref, ticket_id, tier, admits, seat_no, expires_at, qr_text.
// qr_text is built by the same code as the order page and the e-ticket email:
// the bare ticket id on a 'uuid' event, the signed token on a 'jwt' event.
//
// Every row is a working entry pass. The file is refused inside the repository
// so it can never be committed; keep it private and delete it when done.
//
// Included: status 'valid' tickets on 'confirmed' enrollments that are not
// internal tests. Unlike export-scanner-tickets.ts, any QR format is accepted.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { createAdminClient } from "@/lib/supabase/admin";
import { isTicketQrFormat } from "@/lib/tickets/qrPayload";
import { loadSigningKey } from "@/lib/tickets/keys";
import { admissibleTickets, qrExportCsv, type QrExportTicket } from "@/server/tickets/qrExport";

const PAGE = 1000; // PostgREST caps a response at 1000 rows; page past it.

async function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
  const [tenantSlug, intakeSlug] = args.filter((_, i) => i !== outIndex && i !== outIndex + 1);

  if (!tenantSlug || !intakeSlug || !out) {
    console.error("Usage: export-ticket-qr.ts <tenant-subdomain> <intake-slug> --out <file.csv>");
    process.exit(1);
  }

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
    data: { id: string; name: string; ticket_qr_format: unknown } | null;
    error: unknown;
  };
  if (intakeError || !intake) {
    console.error(`Event "${intakeSlug}" not found for tenant "${tenantSlug}".`);
    process.exit(1);
  }
  // Same rule as the order page: an unknown format is not "the default".
  if (!isTicketQrFormat(intake.ticket_qr_format)) {
    console.error(`"${intakeSlug}" has an unknown QR format (${String(intake.ticket_qr_format)}). Nothing written.`);
    process.exit(1);
  }
  const format = intake.ticket_qr_format;

  // Fail before reading tickets if a jwt event has no key to sign with.
  let kid: string | null = null;
  if (format === "jwt") {
    if (!process.env.TICKET_SIGNING_KEY || !process.env.TICKET_KID) {
      console.error("TICKET_SIGNING_KEY / TICKET_KID are not set in this env file. Nothing written.");
      process.exit(1);
    }
    try {
      kid = loadSigningKey().kid;
    } catch {
      // Never print the value. A swapped pair (kid in the key line) lands here.
      console.error(
        "TICKET_SIGNING_KEY is set but is not a valid private key (pkcs8, base64). " +
          "Check it is the key and not the kid. Nothing written.",
      );
      process.exit(1);
    }
  }

  const rows: QrExportTicket[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = (await supabase
      .from("tickets")
      .select("id, intake_id, tier, admits, seat_no, exp, enrollments!inner(enrollment_ref, status, internal_test_at)")
      .eq("intake_id", intake.id)
      .eq("status", "valid")
      .order("id")
      .range(from, from + PAGE - 1)) as { data: QrExportTicket[] | null; error: { message: string } | null };

    if (error || !data) {
      console.error("Ticket query failed — nothing written:", error?.message ?? "no data");
      process.exit(1);
    }
    rows.push(...data);
    if (data.length < PAGE) break;
  }

  const admissible = admissibleTickets(rows);
  if (new Set(admissible.map((t) => t.id)).size !== admissible.length) {
    console.error("Duplicate ticket ids in the result — nothing written.");
    process.exit(1);
  }

  writeFileSync(outPath, qrExportCsv(format, admissible), { encoding: "utf8" });

  const orders = new Set(admissible.map((t) => t.enrollments!.enrollment_ref)).size;
  console.log(`Event:    ${intake.name} (${intakeSlug}), QR format '${format}'${kid ? `, signing kid '${kid}'` : ""}`);
  console.log(`Valid tickets read:       ${rows.length}`);
  console.log(`Excluded (not confirmed / internal test): ${rows.length - admissible.length}`);
  console.log(`Exported: ${admissible.length} tickets across ${orders} orders`);
  console.log(`Written:  ${outPath}`);
  console.log("Every row is a working entry pass. Keep the file private and delete it when done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
