// scripts/resend-etickets.ts
// One-off ops script: re-sends every buyer of one event their e-ticket email,
// with a freshly built PDF attachment. For after an event is switched to the
// 'uuid' QR format, so buyers holding a saved signed-token QR get the new one.
//
// Run with (the env file decides WHICH database and mail account are used):
//   node --env-file=.env.local --experimental-strip-types --import ./scripts/lib/register-alias.mjs \
//     scripts/resend-etickets.ts <tenant-subdomain> <intake-slug> [--send] [--delay-ms 600] [--only REF1,REF2]
//
// DRY RUN BY DEFAULT: without --send it lists who would be emailed and sends
// nothing. --only limits a run to specific order refs (re-running failures).
//
// Uses the app's own attachment builder and email template, so what buyers
// receive is exactly what the admin "resend email" button would send.

import { buildEticketEmailAttachment } from "@/server/tickets/eticketEmailAttachment";
import { enrollmentApprovedEmail, sendEmail } from "@/lib/email";
import { createAdminClient } from "@/lib/supabase/admin";
import { tenantLinkOrigin } from "@/lib/origin";
import { resolveEmailFromFormData } from "@/lib/utils";

type Order = {
  id: string;
  enrollment_ref: string;
  student_name_en: string | null;
  email: string | null;
  form_data: Record<string, string> | null;
};

const PAGE = 1000;
const CHUNK = 200;

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const send = args.includes("--send");
  const delayMs = Number(flag("--delay-ms") ?? 600);
  const only = flag("--only")?.split(",").map((r) => r.trim()).filter(Boolean);
  const valued = new Set(["--delay-ms", "--only"]);
  const positional = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]));
  const [tenantSlug, intakeSlug] = positional;

  if (!tenantSlug || !intakeSlug || !Number.isFinite(delayMs) || delayMs < 0) {
    console.error(
      "Usage: resend-etickets.ts <tenant-subdomain> <intake-slug> [--send] [--delay-ms 600] [--only REF1,REF2]",
    );
    process.exit(1);
  }

  const supabase = createAdminClient();

  const { data: tenant } = (await supabase
    .from("tenants")
    .select("id, name, org_type, logo_url, subdomain")
    .eq("subdomain", tenantSlug)
    .single()) as {
    data: { id: string; name: string; org_type: string; logo_url: string | null; subdomain: string } | null;
  };
  if (!tenant) {
    console.error(`Tenant not found for subdomain "${tenantSlug}".`);
    process.exit(1);
  }

  const { data: intake } = (await supabase
    .from("intakes")
    .select("id, name, ticket_qr_format")
    .eq("tenant_id", tenant.id)
    .eq("slug", intakeSlug)
    .single()) as { data: { id: string; name: string; ticket_qr_format: string } | null };
  if (!intake) {
    console.error(`Event "${intakeSlug}" not found for tenant "${tenantSlug}".`);
    process.exit(1);
  }
  // The point of the re-send is the NEW QR. Sending before the switch would
  // hand every buyer the old signed-token QR again.
  if (intake.ticket_qr_format !== "uuid") {
    console.error(
      `"${intakeSlug}" is on the '${intake.ticket_qr_format}' QR format. Switch it to 'uuid' first — ` +
        "otherwise buyers are re-sent the same QR they already have.",
    );
    process.exit(1);
  }

  // Orders holding at least one admissible ticket for this event.
  const ticketCounts = new Map<string, Map<string, number>>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = (await supabase
      .from("tickets")
      .select("enrollment_id, tier")
      .eq("intake_id", intake.id)
      .eq("status", "valid")
      .order("id")
      .range(from, from + PAGE - 1)) as {
      data: { enrollment_id: string; tier: string }[] | null;
      error: { message: string } | null;
    };
    if (error || !data) {
      console.error("Ticket query failed — nothing sent:", error?.message ?? "no data");
      process.exit(1);
    }
    for (const t of data) {
      const tiers = ticketCounts.get(t.enrollment_id) ?? new Map<string, number>();
      tiers.set(t.tier, (tiers.get(t.tier) ?? 0) + 1);
      ticketCounts.set(t.enrollment_id, tiers);
    }
    if (data.length < PAGE) break;
  }

  const ids = [...ticketCounts.keys()];
  const orders: Order[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = (await supabase
      .from("enrollments")
      .select("id, enrollment_ref, student_name_en, email, form_data")
      .in("id", ids.slice(i, i + CHUNK))
      .eq("status", "confirmed")
      .is("internal_test_at", null)) as { data: Order[] | null; error: { message: string } | null };
    if (error || !data) {
      console.error("Order query failed — nothing sent:", error?.message ?? "no data");
      process.exit(1);
    }
    orders.push(...data);
  }

  let targets = orders.sort((a, b) => a.enrollment_ref.localeCompare(b.enrollment_ref));
  if (only) {
    const wanted = new Set(only);
    targets = targets.filter((o) => wanted.has(o.enrollment_ref));
    const missing = only.filter((ref) => !targets.some((o) => o.enrollment_ref === ref));
    if (missing.length) console.warn(`Not eligible or not found: ${missing.join(", ")}`);
  }

  const withEmail = targets.map((o) => ({ order: o, to: o.email || resolveEmailFromFormData(o.form_data) }));
  const noEmail = withEmail.filter((t) => !t.to).map((t) => t.order.enrollment_ref);
  const sendable = withEmail.filter((t): t is { order: Order; to: string } => Boolean(t.to));

  console.log(`Event:  ${intake.name} (${intakeSlug}), QR format 'uuid'`);
  console.log(`Orders: ${targets.length} eligible, ${sendable.length} with an email, ${noEmail.length} without`);
  if (noEmail.length) console.log(`No email (reach another way): ${noEmail.join(", ")}`);

  if (!send) {
    for (const { order, to } of sendable) console.log(`  would send  ${order.enrollment_ref}  ${mask(to)}`);
    console.log("\nDRY RUN — nothing sent. Re-run with --send to email these buyers.");
    return;
  }

  const origin = tenantLinkOrigin(tenant.subdomain);
  const failed: string[] = [];
  let sent = 0;

  for (const [index, { order, to }] of sendable.entries()) {
    const ref = order.enrollment_ref;
    try {
      const attachment = await buildEticketEmailAttachment(order.id);
      if (!attachment) throw new Error("no valid tickets to attach");

      const tiers = ticketCounts.get(order.id)!;
      const classLevel = [...tiers.entries()].map(([tier, n]) => (n > 1 ? `${tier} x${n}` : tier)).join(", ");
      const content = enrollmentApprovedEmail({
        studentName: order.student_name_en ?? "",
        enrollmentRef: ref,
        classLevel,
        statusUrl: `${origin}/status?ref=${ref}`,
        ticketCount: [...tiers.values()].reduce((a, b) => a + b, 0),
        orgType: tenant.org_type,
        tenantName: tenant.name,
        logoUrl: tenant.logo_url ?? undefined,
      });

      const ok = await sendEmail({ to, subject: content.subject, html: content.html, attachments: [attachment] });
      if (!ok) throw new Error("email provider rejected the send");
      sent++;
      console.log(`  sent    ${ref}  ${mask(to)}`);
    } catch (err) {
      failed.push(ref);
      console.error(`  FAILED  ${ref}: ${(err as Error).message}`);
    }
    if (index < sendable.length - 1) await new Promise((r) => setTimeout(r, delayMs));
  }

  console.log(`\nSent ${sent} of ${sendable.length}.`);
  if (failed.length) {
    console.log(`Failed ${failed.length}. Re-run just these with:  --only ${failed.join(",")}`);
    process.exit(1);
  }
}

// Enough to recognise an address in the log without writing it out in full.
function mask(email: string): string {
  const [user, domain] = email.split("@");
  return `${user.slice(0, 2)}***@${domain ?? "?"}`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
