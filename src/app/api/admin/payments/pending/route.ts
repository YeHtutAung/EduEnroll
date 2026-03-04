import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Enrollment, Payment, Class, Intake } from "@/types/database";

const SIGNED_URL_EXPIRES_IN = 3600; // 1 hour
const PROOF_BUCKET = "payment-proofs";

type PendingRow = {
  enrollment: Enrollment;
  payment: Payment;
  class_level: string;
  intake_name: string;
  proof_signed_url: string | null;
};

// ─── GET /api/admin/payments/pending ──────────────────────────────────────────
// Returns all enrollments with status='payment_submitted', joined with student
// info, class level, intake name, amount_mmk, and a 1-hour signed URL for the
// proof image. Ordered by enrolled_at ascending (oldest first).

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
      classes ( level, intake_id, intakes ( name ) )
    `,
    )
    .eq("tenant_id", tenantId)
    .eq("status", "payment_submitted")
    .order("enrolled_at", { ascending: true }) as {
    data:
      | (Enrollment & {
          payments: Payment[];
          classes: (Pick<Class, "level" | "intake_id"> & { intakes: Pick<Intake, "name"> | null }) | null;
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

      if (payment?.proof_image_url) {
        // proof_image_url is stored as the storage object path (not a full URL)
        const { data: signed } = await adminClient.storage
          .from(PROOF_BUCKET)
          .createSignedUrl(payment.proof_image_url, SIGNED_URL_EXPIRES_IN);
        proof_signed_url = signed?.signedUrl ?? null;
      }

      // Strip the joined relation arrays before sending; eslint can't see they
      // are intentionally omitted via destructuring.
      /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
      const { classes, payments: _p, ...enrollment } = row;

      return {
        enrollment,
        payment,
        class_level: classes?.level ?? "",
        intake_name: classes?.intakes?.name ?? "",
        proof_signed_url,
      };
    }),
  );

  return NextResponse.json(results);
}
