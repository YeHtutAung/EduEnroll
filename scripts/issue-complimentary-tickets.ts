// scripts/issue-complimentary-tickets.ts
// One-off ops script: gives free (complimentary) tickets to a list of people,
// e.g. The Beats Run's Warm-Up Day runners. The app has no free-ticket
// feature: a tier cannot be priced 0 and admins cannot create orders.
//
// Run with (the env file decides WHICH database and mail account are used):
//   node --env-file=.env.local --experimental-strip-types --import ./scripts/lib/register-alias.mjs \
//     scripts/issue-complimentary-tickets.ts <tenant-subdomain> <intake-slug> <list.csv> \
//     --tier "5KM=Early Bird - 5KM" --tier "10KM=Early Bird - 10KM" [--apply] [--send] [--delay-ms 600]
//
// The list is a CSV with the columns name, phone, email, distance, size (any
// order, extra columns ignored). Every line is checked before anything is
// written; one bad line stops the run. --tier maps each distance in the list
// to the tier (classes.level) the ticket is issued on.
//
// THREE STEPS, each opt-in:
//   (none)   dry run: checks the list and seats, prints what would happen.
//   --apply  creates the orders and their tickets. Writes to the database.
//   --send   emails each order's e-ticket, once (status_notified_at is set
//            after a send, and a set order is skipped).
// Re-running is safe: an order is found again by its idempotency key
// (comp:<intake>:<email>), so nobody gets a second free ticket.
//
// Each order is a confirmed cart order with one enrollment_items line priced
// 0, so Sales Analytics counts the ticket but no revenue. It takes a seat from
// the tier like a sale does. Undo: reject the order in the admin page (the seat
// goes back and the ticket must then be voided) or delete the order.

import { readFileSync } from "node:fs";
import { createAdminClient } from "@/lib/supabase/admin";
import { tenantLinkOrigin } from "@/lib/origin";
import { enrollmentApprovedEmail, sendEmail } from "@/lib/email";
import { validateAttendees, type AttendeeField } from "@/lib/enrollment/attendees";
import { buildEnrollmentUpdatePayload } from "@/server/enrollment/formDataMapper";
import { issueTicketsForEnrollment } from "@/server/tickets/issueTickets";
import { buildEticketEmailAttachment } from "@/server/tickets/eticketEmailAttachment";
import { loadEmailRunners } from "@/server/notifications/eventEmailRunners";
import { loadEventEmailTerms } from "@/server/notifications/eventEmailTerms";
import { loadEventEmailImages } from "@/server/notifications/eventEmailImages";
import {
  complimentaryKey,
  parseComplimentaryRows,
  parseCsv,
  type ComplimentaryRow,
} from "@/lib/complimentary/rows";

type Field = AttendeeField & { per_attendee: boolean };
type Klass = { id: string; level: string; seat_remaining: number; seat_total: number; status: string; pack_size: number | null };
type Order = {
  id: string;
  enrollment_ref: string;
  idempotency_key: string;
  status: string;
  status_notified_at: string | null;
  /** A run stopped between inserting the order and its line (see repairLine). */
  missingLine?: boolean;
};

const supabase = createAdminClient();

async function main() {
  const args = process.argv.slice(2);
  const values = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
  const apply = args.includes("--apply");
  const send = args.includes("--send");
  const delayMs = Number(values("--delay-ms")[0] ?? 600);
  const valued = new Set(["--tier", "--delay-ms"]);
  const positional = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]));
  const [tenantSlug, intakeSlug, csvPath] = positional;

  const tiers = new Map<string, string>();
  for (const t of values("--tier")) {
    const eq = t.indexOf("=");
    if (eq < 1) fail(`--tier "${t}" must look like "10KM=Early Bird - 10KM".`);
    tiers.set(t.slice(0, eq).trim(), t.slice(eq + 1).trim());
  }

  if (!tenantSlug || !intakeSlug || !csvPath || tiers.size === 0 || !Number.isFinite(delayMs) || delayMs < 0) {
    fail(
      "Usage: issue-complimentary-tickets.ts <tenant-subdomain> <intake-slug> <list.csv> " +
        '--tier "<distance>=<tier level>" [--tier ...] [--apply] [--send] [--delay-ms 600]',
    );
  }

  // ── Event ──────────────────────────────────────────────────────────────────
  const { data: tenant } = (await supabase
    .from("tenants")
    .select("id, name, org_type, logo_url, subdomain")
    .eq("subdomain", tenantSlug)
    .maybeSingle()) as {
    data: { id: string; name: string; org_type: string; logo_url: string | null; subdomain: string } | null;
  };
  if (!tenant) fail(`Tenant not found for subdomain "${tenantSlug}".`);
  if (tenant.org_type !== "event") fail(`"${tenantSlug}" is not an event organiser; it has no tickets.`);

  const { data: intake } = (await supabase
    .from("intakes")
    .select("id, name")
    .eq("tenant_id", tenant.id)
    .eq("slug", intakeSlug)
    .maybeSingle()) as { data: { id: string; name: string } | null };
  if (!intake) fail(`Event "${intakeSlug}" not found for tenant "${tenantSlug}".`);
  // Built on main, which has no account-bound tickets (intakes.ticket_protection
  // is not in its migrations). The copy on dev checks that column instead.

  const { data: classRows, error: classesError } = (await supabase
    .from("classes")
    .select("id, level, seat_remaining, seat_total, status, pack_size")
    .eq("intake_id", intake.id)) as { data: Klass[] | null; error: { message: string } | null };
  if (classesError || !classRows) fail(`Could not load the event's ticket types: ${classesError?.message ?? "no data"}`);
  const classByLevel = new Map(classRows.map((c) => [c.level, c]));
  for (const level of Array.from(new Set(tiers.values()))) {
    const c = classByLevel.get(level);
    if (!c) {
      fail(`Tier "${level}" is not in "${intakeSlug}". Tiers: ${(classRows ?? []).map((c) => `"${c.level}"`).join(", ")}`);
    }
    // A package tier issues pack_size tickets per unit (issueTicketsForEnrollment),
    // so one free unit would hand one person several tickets.
    if ((c.pack_size ?? 1) !== 1) {
      fail(`Tier "${level}" is a ${c.pack_size}-ticket package. Map each distance to a single-ticket tier.`);
    }
  }

  const { data: fieldRows, error: fieldsError } = (await supabase
    .from("intake_form_fields")
    .select("field_key, field_label, field_type, is_required, options, per_attendee")
    .eq("intake_id", intake.id)
    .order("sort_order")) as { data: Field[] | null; error: { message: string } | null };
  // A failed lookup is not "no questions": treating it so would issue tickets
  // without the runner's name and size, and a re-run would not add them.
  if (fieldsError || !fieldRows) fail(`Could not load the event's form questions: ${fieldsError?.message ?? "no data"}`);
  const fields = fieldRows;
  const buyer = buyerFieldKeys(fields);
  const runnerFields = fields.filter((f) => f.per_attendee);
  const runnerName = runnerFields.find((f) => f.field_type === "text");
  const runnerSize = runnerFields.find((f) => f.field_type === "select" || f.field_type === "radio");
  const unknown = runnerFields.filter((f) => f !== runnerName && f !== runnerSize);
  if (unknown.length) {
    fail(`The form asks each ticket for ${unknown.map((f) => `"${f.field_label}"`).join(", ")}, which this list has no column for.`);
  }
  // null: the event does not ask each ticket for a size, so the list needs none.
  let sizes: string[] | null = null;
  if (runnerSize) {
    sizes = Array.isArray(runnerSize.options) ? (runnerSize.options as unknown[]).map(String) : [];
    if (sizes.length === 0) fail(`"${runnerSize.field_label}" has no choices to check sizes against.`);
  }

  // ── List ───────────────────────────────────────────────────────────────────
  const parsed = parseComplimentaryRows(parseCsv(readFileSync(csvPath, "utf8")), tiers, sizes);
  if (!parsed.ok) {
    console.error(`The list has ${parsed.errors.length} problem(s). Nothing was written.`);
    for (const e of parsed.errors) console.error(`  ${e}`);
    process.exit(1);
  }
  const rows = parsed.rows;

  // Runner details exactly as checkout would store them, so the ticket, the
  // email and the admin page show them the usual way.
  const runnersFor = (row: ComplimentaryRow, classId: string) => {
    if (runnerFields.length === 0) return [];
    const answers: Record<string, string> = {};
    if (runnerName) answers[runnerName.field_key] = row.name;
    if (runnerSize) answers[runnerSize.field_key] = row.size;
    const checked = validateAttendees([{ class_id: classId, seat_no: 1, answers }], [{ class_id: classId, seat_no: 1 }], runnerFields);
    if (!checked.ok) fail(`Line ${row.line}: ${checked.message}`);
    return checked.attendees;
  };

  const existing = await loadOrders(rows.map((r) => complimentaryKey(intake.id, r.email)));
  const toCreate = rows.filter((r) => !existing.has(complimentaryKey(intake.id, r.email)));

  // Seats are checked for the whole list before the first write.
  const need = new Map<string, number>();
  for (const r of toCreate) need.set(r.tierLevel, (need.get(r.tierLevel) ?? 0) + 1);
  let short = false;
  for (const [level, n] of Array.from(need.entries())) {
    const c = classByLevel.get(level)!;
    if (c.seat_remaining < n) {
      console.error(`"${level}" has ${c.seat_remaining} seat(s) left; the list needs ${n}.`);
      short = true;
    }
  }
  if (short) fail("Not enough seats. Nothing was written.");

  const paid = await paidOrderEmails(intake.id, rows.map((r) => r.email));

  console.log(`Event:  ${intake.name} (${intakeSlug})`);
  console.log(`List:   ${rows.length} people, ${toCreate.length} new, ${rows.length - toCreate.length} already created`);
  for (const [level, n] of Array.from(need.entries())) {
    const c = classByLevel.get(level)!;
    console.log(`Seats:  "${level}" ${c.seat_remaining} left, takes ${n}${c.status !== "open" ? ` (tier is ${c.status})` : ""}`);
  }
  for (const r of rows) {
    const order = existing.get(complimentaryKey(intake.id, r.email));
    const state = !order
      ? "new"
      : order.missingLine
        ? `exists ${order.enrollment_ref}, MISSING ITS ORDER LINE (--apply repairs it)`
        : `exists ${order.enrollment_ref}${order.status_notified_at ? ", emailed" : ""}`;
    const note = paid.has(r.email) ? "  (also has a paid order)" : "";
    console.log(`  line ${String(r.line).padStart(3)}  ${r.tierLevel.padEnd(20)} ${(r.size || "-").padEnd(7)} ${mask(r.email).padEnd(24)} ${state}${note}`);
  }

  if (!apply && !send) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to create the orders and tickets.");
    return;
  }

  // ── Create ─────────────────────────────────────────────────────────────────
  if (apply) {
    for (const row of toCreate) {
      const c = classByLevel.get(row.tierLevel)!;
      const fd: Record<string, string> = {};
      if (buyer.name) fd[buyer.name] = row.name;
      if (buyer.phone) fd[buyer.phone] = row.phone;
      if (buyer.email) fd[buyer.email] = row.email;
      const columns = buildEnrollmentUpdatePayload(fd, new Map(fields.map((f) => [f.field_key, f.field_type])));
      const key = complimentaryKey(intake.id, row.email);
      try {
        const order = await createOrder(c, {
          tenant_id: tenant.id,
          class_id: null,
          status: "confirmed",
          enrollment_ref: "",
          quantity: 1,
          idempotency_key: key,
          student_name_en: columns.student_name_en ?? row.name,
          phone: columns.phone ?? row.phone,
          email: columns.email ?? row.email,
          form_data: columns.form_data,
          attendees: runnersFor(row, c.id),
        });
        existing.set(key, order);
        console.log(`  created ${order.enrollment_ref}  line ${row.line}`);
      } catch (err) {
        console.error(`  FAILED  line ${row.line}: ${(err as Error).message}`);
        console.error("Stopped. Orders made before this line stay; re-run to continue.");
        process.exit(1);
      }
    }

    // Also repairs an order a previous run created but could not finish.
    for (const row of rows) {
      const order = existing.get(complimentaryKey(intake.id, row.email));
      if (!order) continue;
      if (order.missingLine) {
        const result = await repairLine(order, classByLevel.get(row.tierLevel)!.id, tenant.id);
        order.missingLine = false;
        console.log(
          result === "added"
            ? `  repaired ${order.enrollment_ref}  line ${row.line} (added its missing order line)`
            : `  repaired ${order.enrollment_ref}  line ${row.line} (another run already added its line)`,
        );
      }
      await issueTicketsForEnrollment(order.id);
    }
    const ticketless = await ordersWithoutTickets(Array.from(existing.values()).map((o) => o.id));
    if (ticketless.length) fail(`No ticket was issued for: ${ticketless.join(", ")}`);
    console.log(`Tickets: every order in the list has its ticket.`);
  }

  // ── Email ──────────────────────────────────────────────────────────────────
  if (send) {
    const origin = tenantLinkOrigin(tenant.subdomain);
    const failed: number[] = [];
    const unmarked: string[] = [];
    let sent = 0;
    const queue = rows.flatMap((row) => {
      const order = existing.get(complimentaryKey(intake.id, row.email));
      if (!order) {
        console.log(`  not created yet, not emailed: line ${row.line}`);
        return [];
      }
      return order.status_notified_at ? [] : [{ row, order }];
    });

    for (const [index, { row, order }] of queue.entries()) {
      try {
        const attachment = await buildEticketEmailAttachment(order.id);
        if (!attachment) throw new Error("no valid ticket to attach");
        const content = enrollmentApprovedEmail({
          complimentary: true,
          studentName: row.name,
          enrollmentRef: order.enrollment_ref,
          classLevel: row.tierLevel,
          statusUrl: `${origin}/status?ref=${order.enrollment_ref}`,
          ticketCount: 1,
          eventTerms: await loadEventEmailTerms(order.id),
          runners: await loadEmailRunners(order.id),
          eventImages: await loadEventEmailImages(order.id),
          orgType: tenant.org_type,
          tenantName: tenant.name,
          logoUrl: tenant.logo_url ?? undefined,
        });
        const ok = await sendEmail({ to: row.email, subject: content.subject, html: content.html, attachments: [attachment] });
        if (!ok) throw new Error("email provider rejected the send");
        sent++;
        // The marker is what stops a later --send emailing this person again, so
        // a failure to save it is reported, never counted as a clean send.
        const { error: markError } = await supabase
          .from("enrollments")
          .update({ status_notified_at: new Date().toISOString() } as never)
          .eq("id", order.id);
        if (markError) {
          unmarked.push(order.enrollment_ref);
          console.error(`  SENT, NOT RECORDED  ${order.enrollment_ref}: ${markError.message}`);
        } else {
          console.log(`  sent    ${order.enrollment_ref}  ${mask(row.email)}`);
        }
      } catch (err) {
        failed.push(row.line);
        console.error(`  FAILED  ${order.enrollment_ref} (line ${row.line}): ${(err as Error).message}`);
      }
      if (index < queue.length - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
    console.log(`\nSent ${sent} of ${queue.length}.`);
    if (unmarked.length) {
      console.log(
        `Emailed but NOT recorded: ${unmarked.join(", ")}. A re-run with --send would email these again. ` +
          "Set status_notified_at on these orders by hand before re-running.",
      );
    }
    if (failed.length) {
      console.log(`Failed lines: ${failed.join(", ")}. Re-run with --send to retry only those.`);
    }
    if (failed.length || unmarked.length) process.exit(1);
  }
}

/** Which form fields hold the buyer's name, phone and email. */
function buyerFieldKeys(fields: Field[]) {
  const own = fields.filter((f) => !f.per_attendee);
  return {
    name: own.find((f) => f.field_key === "name_en")?.field_key ?? own.find((f) => f.field_type === "text" && /name/i.test(f.field_label))?.field_key,
    phone: own.find((f) => f.field_type === "phone")?.field_key ?? own.find((f) => f.field_key === "phone")?.field_key,
    email: own.find((f) => f.field_type === "email")?.field_key ?? own.find((f) => f.field_key === "email")?.field_key,
  };
}

/**
 * One free order: take the seat, insert the confirmed order, insert its 0-priced
 * line. Each step undoes the earlier ones if it fails, so a failure leaves
 * neither a lost seat nor an order without a line.
 */
async function createOrder(c: Klass, insert: Record<string, unknown>): Promise<Order> {
  await takeSeat(c.id);

  const { data: order, error } = (await supabase
    .from("enrollments")
    .insert(insert as never)
    .select("id, enrollment_ref, idempotency_key, status, status_notified_at")
    .single()) as { data: Order | null; error: { message: string } | null };
  if (error || !order) {
    await giveSeatBack(c.id);
    throw new Error(`order insert failed: ${error?.message ?? "no row"}`);
  }

  const { error: itemError } = await supabase.from("enrollment_items").insert({
    // The order's own id: one line per complimentary order, enforced by the
    // primary key (see repairLine).
    id: order.id,
    enrollment_id: order.id,
    class_id: c.id,
    tenant_id: insert.tenant_id,
    quantity: 1,
    fee_amount: 0,
  } as never);
  if (itemError) {
    // The order has no line yet, so its delete trigger restores nothing.
    await supabase.from("enrollments").delete().eq("id", order.id);
    await giveSeatBack(c.id);
    throw new Error(`order line insert failed: ${itemError.message}`);
  }
  return order;
}

/**
 * Adds the 0-priced line to an order a run left without one (it stopped after
 * inserting the order). No seat is taken: createOrder takes the seat BEFORE it
 * inserts the order, so an order that exists already holds its seat.
 *
 * Not covered: a run that stops after taking the seat but before inserting the
 * order leaves one seat taken and no order, which nothing records. The tier
 * then shows one seat fewer than expected; add it back by hand. A database
 * transaction would close this, but needs a new function (a migration), which
 * this script deliberately does without.
 *
 * Two runs repairing the same order at once must not add two lines: that
 * would issue two tickets for one seat, as enrollment_items has no unique key
 * on (enrollment_id, class_id). The line's id is the order's id, so the
 * primary key admits exactly one; the run that loses gets 23505 and moves on.
 */
async function repairLine(order: Order, classId: string, tenantId: string): Promise<"added" | "already"> {
  const { error } = (await supabase.from("enrollment_items").insert({
    id: order.id,
    enrollment_id: order.id,
    class_id: classId,
    tenant_id: tenantId,
    quantity: 1,
    fee_amount: 0,
  } as never)) as { error: { code?: string; message: string } | null };
  if (error?.code === "23505") return "already";
  if (error) fail(`Could not repair ${order.enrollment_ref}: ${error.message}`);
  // Belt and braces: a line added another way (not by this script) would make
  // two. Stop before issuing rather than hand out a second ticket.
  const { count } = await supabase
    .from("enrollment_items")
    .select("id", { count: "exact", head: true })
    .eq("enrollment_id", order.id);
  if (count !== 1) fail(`${order.enrollment_ref} now has ${count} order lines; check it by hand before issuing.`);
  return "added";
}

/**
 * Takes one seat without overwriting a sale made at the same moment: the write
 * only lands if seat_remaining is still what was read. Marks the tier full at
 * 0, as checkout does.
 */
async function takeSeat(classId: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: c } = (await supabase
      .from("classes")
      .select("seat_remaining")
      .eq("id", classId)
      .single()) as { data: { seat_remaining: number } | null };
    if (!c) throw new Error("tier did not load");
    if (c.seat_remaining < 1) throw new Error("tier has no seat left");
    const left = c.seat_remaining - 1;
    const { data: updated } = (await supabase
      .from("classes")
      .update({ seat_remaining: left, ...(left === 0 ? { status: "full" } : {}) } as never)
      .eq("id", classId)
      .eq("seat_remaining", c.seat_remaining)
      .select("id")) as { data: { id: string }[] | null };
    if (updated?.length) return;
  }
  throw new Error("could not take a seat (tier busy); re-run");
}

async function giveSeatBack(classId: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: c } = (await supabase
      .from("classes")
      .select("seat_remaining, seat_total")
      .eq("id", classId)
      .single()) as { data: { seat_remaining: number; seat_total: number } | null };
    if (!c) break;
    const { data: updated } = (await supabase
      .from("classes")
      .update({ seat_remaining: Math.min(c.seat_remaining + 1, c.seat_total) } as never)
      .eq("id", classId)
      .eq("seat_remaining", c.seat_remaining)
      .select("id")) as { data: { id: string }[] | null };
    if (updated?.length) return;
  }
  console.error(`  WARNING: could not give a seat back to tier ${classId}; add 1 to seat_remaining by hand.`);
}

async function loadOrders(keys: string[]): Promise<Map<string, Order>> {
  const map = new Map<string, Order>();
  for (let i = 0; i < keys.length; i += 100) {
    const { data, error } = (await supabase
      .from("enrollments")
      .select("id, enrollment_ref, idempotency_key, status, status_notified_at, enrollment_items(id)")
      .in("idempotency_key", keys.slice(i, i + 100))) as {
      data: (Order & { enrollment_items: { id: string }[] | null })[] | null;
      error: { message: string } | null;
    };
    if (error || !data) fail(`Order lookup failed: ${error?.message ?? "no data"}`);
    for (const { enrollment_items, ...o } of data) {
      if (o.status !== "confirmed") fail(`${o.enrollment_ref} (${o.idempotency_key}) is ${o.status}, not confirmed. Check it by hand.`);
      map.set(o.idempotency_key, { ...o, missingLine: !enrollment_items?.length });
    }
  }
  return map;
}

/** Emails in the list that also have a paid, confirmed order for this event. */
async function paidOrderEmails(intakeId: string, emails: string[]): Promise<Set<string>> {
  const { data: classes } = (await supabase.from("classes").select("id").eq("intake_id", intakeId)) as {
    data: { id: string }[] | null;
  };
  const ids = (classes ?? []).map((c) => c.id);
  const found = new Set<string>();
  for (let i = 0; i < emails.length; i += 100) {
    const { data } = (await supabase
      .from("enrollments")
      .select("email, idempotency_key, class_id, enrollment_items(class_id)")
      .eq("status", "confirmed")
      .is("internal_test_at", null)
      .in("email", emails.slice(i, i + 100))) as {
      data: { email: string; idempotency_key: string | null; class_id: string | null; enrollment_items: { class_id: string }[] }[] | null;
    };
    for (const o of data ?? []) {
      if (o.idempotency_key?.startsWith("comp:")) continue;
      const classIds = o.class_id ? [o.class_id] : o.enrollment_items.map((it) => it.class_id);
      if (classIds.some((id) => ids.includes(id))) found.add(o.email.toLowerCase());
    }
  }
  return found;
}

async function ordersWithoutTickets(orderIds: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const id of orderIds) {
    const { count } = await supabase
      .from("tickets")
      .select("id", { count: "exact", head: true })
      .eq("enrollment_id", id)
      .eq("status", "valid");
    if (!count) missing.push(id);
  }
  return missing;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
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
