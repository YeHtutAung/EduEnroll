import { createAdminClient } from "@/lib/supabase/admin";
import { lastEventDate } from "@/lib/tickets/exp";

type Lookup<T> = { data: T | null; error: { message?: string } | null };

interface ClassRow {
  level: string;
  event_date: string | null;
  end_time: string | null;
  email_image_url: string | null;
}

export interface EventEmailImage {
  url: string;
  alt: string;
}

/**
 * The images to print in an order's confirmation email: one per tier bought, in
 * date order. An order that includes a multi-day tier (an All Day pass) gets none,
 * even when it also holds a single day. A tier only has an image if an organiser
 * uploaded one, so every other event gets an empty list.
 *
 * Never throws: an image must not stop a paid buyer's confirmation and e-ticket
 * from going out, so a failed lookup logs and sends the email without them.
 */
export async function loadEventEmailImages(enrollmentId: string): Promise<EventEmailImage[]> {
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
      console.error(
        "[event-email-images] order lookup failed:",
        enrollment.error?.message ?? items.error?.message,
      );
      return [];
    }

    const classIds = [
      ...new Set(
        [enrollment.data?.class_id, ...(items.data ?? []).map((item) => item.class_id)].filter(
          (id): id is string => Boolean(id),
        ),
      ),
    ];
    if (classIds.length === 0) return [];

    const classes = (await supabase
      .from("classes")
      .select("level, event_date, end_time, email_image_url")
      .in("id", classIds)) as unknown as Lookup<ClassRow[]>;
    if (classes.error) {
      console.error("[event-email-images] class lookup failed:", classes.error.message);
      return [];
    }

    const rows = classes.data ?? [];
    const includesMultiDay = rows.some(
      (row) => lastEventDate(row.event_date, row.end_time) !== row.event_date,
    );
    if (includesMultiDay) return [];

    const seen = new Set<string>();
    return [...rows]
      .sort((a, b) => (a.event_date ?? "").localeCompare(b.event_date ?? ""))
      .flatMap((row) => {
        const url = row.email_image_url?.trim();
        if (!url || !url.startsWith("https://") || seen.has(url)) return [];
        seen.add(url);
        return [{ url, alt: row.level }];
      });
  } catch (error) {
    console.error("[event-email-images] lookup failed:", error);
    return [];
  }
}
