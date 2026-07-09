import { createAdminClient } from "@/lib/supabase/admin";

interface EnrollmentRef {
  id: string;
  class_id: string | null;
  quantity: number | null;
}

/**
 * Restores seats to their classes after a payment rejection.
 * Handles both single-class and cart enrollments.
 * Safe to call only when enrollment.status !== 'rejected' to prevent double-restore.
 */
export async function restoreSeats(enrollment: EnrollmentRef): Promise<void> {
  const admin = createAdminClient();
  const itemsToRestore: { class_id: string; quantity: number }[] = [];

  const isCart = enrollment.class_id === null;

  if (isCart) {
    const { data: items } = await admin
      .from("enrollment_items")
      .select("class_id, quantity")
      .eq("enrollment_id", enrollment.id) as {
      data: { class_id: string; quantity: number }[] | null;
      error: unknown;
    };
    if (items) itemsToRestore.push(...items);
  } else if (enrollment.class_id) {
    itemsToRestore.push({
      class_id: enrollment.class_id,
      quantity: enrollment.quantity ?? 1,
    });
  }

  for (const item of itemsToRestore) {
    const { data: cls } = await admin
      .from("classes")
      .select("seat_remaining")
      .eq("id", item.class_id)
      .single() as { data: { seat_remaining: number } | null; error: unknown };

    if (cls) {
      await admin
        .from("classes")
        .update({
          seat_remaining: cls.seat_remaining + item.quantity,
          status: "open",
        } as never)
        .eq("id", item.class_id);
    }
  }
}
