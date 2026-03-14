import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Enrollment, Payment, Class, Intake } from "@/types/database";

const SIGNED_URL_EXPIRES_IN = 3600; // 1 hour
const PROOF_BUCKET = "payment-proofs";

type CartItem = {
  class_level: string;
  quantity: number;
  fee_mmk: number;
  subtotal_mmk: number;
};

type PendingRow = {
  enrollment: Enrollment;
  payment: Payment;
  class_level: string;
  intake_id: string;
  intake_name: string;
  proof_signed_url: string | null;
  proof_signed_urls: string[];
  items: CartItem[] | null;
  total_fee_mmk: number;
};

// ─── GET /api/admin/payments/pending ──────────────────────────────────────────
// Returns all enrollments with status='payment_submitted', joined with student
// info, class level, intake name, amount_mmk, and signed URLs for all proof
// images. Ordered by enrolled_at ascending (oldest first).

export async function GET() {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  // Fetch payment_submitted enrollments joined to payments + class + intake
  const { data: rows, error } = await supabase
    .from("enrollments")
    .select(
      `
      *,
      payments ( * ),
      classes ( level, intake_id, fee_mmk, intakes ( name ) ),
      enrollment_items ( quantity, fee_mmk, classes ( level, intake_id, intakes ( name ) ) )
    `,
    )
    .eq("tenant_id", tenantId)
    .eq("status", "payment_submitted")
    .order("enrolled_at", { ascending: true }) as {
    data:
      | (Enrollment & {
          payments: Payment[];
          classes: (Pick<Class, "level" | "intake_id" | "fee_mmk"> & { intakes: Pick<Intake, "name"> | null }) | null;
          enrollment_items: { quantity: number; fee_mmk: number; classes: { level: string; intake_id: string; intakes: { name: string } | null } | null }[];
        })[]
      | null;
    error: unknown;
  };

  if (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }

  const adminClient = createAdminClient();

  // Build response rows with signed URLs
  const results: PendingRow[] = await Promise.all(
    (rows ?? []).map(async (row) => {
      const payment = row.payments[0] ?? null;
      let proof_signed_url: string | null = null;
      const proof_signed_urls: string[] = [];

      if (payment) {
        // Use proof_image_urls array if available, fallback to single URL
        const paths = payment.proof_image_urls?.length
          ? payment.proof_image_urls
          : payment.proof_image_url
            ? [payment.proof_image_url]
            : [];

        for (const path of paths) {
          const { data: signed } = await adminClient.storage
            .from(PROOF_BUCKET)
            .createSignedUrl(path, SIGNED_URL_EXPIRES_IN);
          if (signed?.signedUrl) {
            proof_signed_urls.push(signed.signedUrl);
          }
        }
        proof_signed_url = proof_signed_urls[0] ?? null;
      }

      // Strip the joined relation arrays before sending
      /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
      const { classes, payments: _p, enrollment_items: _ei, ...enrollment } = row;

      // Build cart items for cart enrollments (class_id is null)
      const isCart = enrollment.class_id === null && row.enrollment_items?.length > 0;
      const cartItems: CartItem[] | null = isCart
        ? row.enrollment_items.map((ei) => ({
            class_level: ei.classes?.level ?? "",
            quantity: ei.quantity,
            fee_mmk: ei.fee_mmk,
            subtotal_mmk: ei.fee_mmk * ei.quantity,
          }))
        : null;

      // Resolve intake info: from direct class join or from first enrollment_item
      const firstItemClass = row.enrollment_items?.[0]?.classes;
      const resolvedIntakeId = classes?.intake_id ?? firstItemClass?.intake_id ?? "";
      const resolvedIntakeName = classes?.intakes?.name ?? firstItemClass?.intakes?.name ?? "";
      const resolvedClassLevel = isCart
        ? (cartItems ?? []).map((i) => i.class_level).join(", ")
        : (classes?.level ?? "");

      // Total fee: from cart items or single class
      const totalFee = isCart
        ? (cartItems ?? []).reduce((sum, i) => sum + i.subtotal_mmk, 0)
        : (classes?.fee_mmk ?? 0) * (enrollment.quantity ?? 1);

      return {
        enrollment,
        payment,
        class_level: resolvedClassLevel,
        intake_id: resolvedIntakeId,
        intake_name: resolvedIntakeName,
        proof_signed_url,
        proof_signed_urls,
        items: cartItems,
        total_fee_mmk: totalFee,
      };
    }),
  );

  return NextResponse.json(results);
}
