import { createAdminClient } from "@/lib/supabase/admin";
import { normaliseOrganiserTerms } from "@/lib/legal/terms";

type Lookup<T> = { data: T | null; error: { message?: string } | null };

/**
 * The organiser's terms to print in an order's confirmation email, or null when
 * the event has none.
 *
 * Never throws: these terms must not stop a paid buyer's confirmation and
 * e-ticket from going out, so a failed lookup logs and sends the email without
 * them.
 */
export async function loadEventEmailTerms(enrollmentId: string): Promise<string | null> {
  try {
    const supabase = createAdminClient();

    // A single-ticket order holds its class on the enrollment, a cart in items.
    const [enrollmentResult, itemsResult] = await Promise.all([
      supabase.from("enrollments").select("class_id").eq("id", enrollmentId).maybeSingle(),
      supabase.from("enrollment_items").select("class_id").eq("enrollment_id", enrollmentId),
    ]);
    const enrollment = enrollmentResult as unknown as Lookup<{ class_id: string | null }>;
    const items = itemsResult as unknown as Lookup<{ class_id: string }[]>;
    if (enrollment.error || items.error) {
      console.error("[event-email-terms] order lookup failed:", enrollment.error?.message ?? items.error?.message);
      return null;
    }

    const classIds = [
      ...new Set(
        [enrollment.data?.class_id, ...(items.data ?? []).map((item) => item.class_id)].filter(
          (id): id is string => Boolean(id),
        ),
      ),
    ];
    if (classIds.length === 0) return null;

    const classes = (await supabase
      .from("classes")
      .select("intake_id")
      .in("id", classIds)) as unknown as Lookup<{ intake_id: string }[]>;
    if (classes.error) {
      console.error("[event-email-terms] class lookup failed:", classes.error.message);
      return null;
    }

    const intakeIds = [...new Set((classes.data ?? []).map((row) => row.intake_id))];
    if (intakeIds.length === 0) return null;

    const intakes = (await supabase
      .from("intakes")
      .select("email_terms")
      .in("id", intakeIds)) as unknown as Lookup<{ email_terms: string | null }[]>;
    if (intakes.error) {
      console.error("[event-email-terms] event lookup failed:", intakes.error.message);
      return null;
    }

    const terms = [
      ...new Set((intakes.data ?? []).map((row) => normaliseOrganiserTerms(row.email_terms))),
    ].filter((text): text is string => text !== null);
    return terms.length > 0 ? terms.join("\n\n") : null;
  } catch (error) {
    console.error("[event-email-terms] lookup failed:", error);
    return null;
  }
}
