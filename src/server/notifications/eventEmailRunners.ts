import { createAdminClient } from "@/lib/supabase/admin";
import { runnerRows } from "@/lib/enrollment/attendees";

/** One line of the confirmation email's runner list. */
export type EmailRunner = { tier: string; label: string };

type Lookup<T> = { data: T | null; error: { message?: string } | null };

type OrderRow = {
  class_id: string | null;
  attendees: unknown;
  classes: { level: string } | null;
  enrollment_items: { class_id: string; classes: { level: string } | null }[] | null;
};

/**
 * The runners to list in an order's confirmation email, in seat order — one
 * per ticket, as entered at checkout ("Early Bird - 5KM — Ko Aung · M"). Empty
 * when the event asks no per-ticket questions.
 *
 * Never throws: the list must not stop a paid buyer's confirmation and
 * e-ticket from going out, so a failed lookup logs and sends the email
 * without it.
 */
export async function loadEmailRunners(enrollmentId: string): Promise<EmailRunner[]> {
  try {
    const supabase = createAdminClient();
    const result = (await supabase
      .from("enrollments")
      .select("class_id, attendees, classes(level), enrollment_items(class_id, classes(level))")
      .eq("id", enrollmentId)
      .maybeSingle()) as unknown as Lookup<OrderRow>;
    if (result.error) {
      console.error("[event-email-runners] order lookup failed:", result.error.message);
      return [];
    }
    const order = result.data;
    if (!order) return [];

    const tierByClass = new Map<string, string>();
    if (order.class_id && order.classes?.level) tierByClass.set(order.class_id, order.classes.level);
    for (const item of order.enrollment_items ?? []) {
      if (item.classes?.level) tierByClass.set(item.class_id, item.classes.level);
    }

    return runnerRows(order.attendees, (classId) => tierByClass.get(classId) ?? "")
      .filter((r) => r.label.trim() !== "")
      .map((r) => ({ tier: r.tier, label: r.label }));
  } catch (error) {
    console.error("[event-email-runners] lookup failed:", error);
    return [];
  }
}
