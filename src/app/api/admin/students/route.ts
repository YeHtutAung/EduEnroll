import { NextRequest, NextResponse } from "next/server";
import { requireAuth, badRequest } from "@/lib/api";
import type { EnrollmentStatus, JlptLevel } from "@/types/database";

const VALID_STATUSES: EnrollmentStatus[] = [
  "pending_payment",
  "payment_submitted",
  "partial_payment",
  "confirmed",
  "rejected",
];

const DEFAULT_PAGE      = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE     = 100;

export interface StudentRow {
  enrollment_id:   string;
  enrollment_ref:  string;
  student_name_en: string;
  student_name_mm: string | null;
  phone:           string;
  form_data:       Record<string, string> | null;
  status:          EnrollmentStatus;
  enrolled_at:     string;
  class_level:     JlptLevel;
  intake_name:     string;
  fee_mmk:         number;
  quantity:        number;
  items?:          { class_level: string; quantity: number; fee_mmk: number; subtotal_mmk: number }[] | null;
}

// ─── GET /api/admin/students ──────────────────────────────────────────────────
// Paginated student list with optional filters.
//
// Query params:
//   intake_id    — filter by intake UUID
//   class_level  — N5 | N4 | N3 | N2 | N1
//   status       — enrollment status
//   search       — partial match on student_name_en OR phone (case-insensitive)
//   page         — 1-based page number (default 1)
//   page_size    — rows per page (default 20, max 100)

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  const { searchParams } = new URL(request.url);

  const intake_id   = searchParams.get("intake_id")   ?? undefined;
  const class_level = searchParams.get("class_level")  ?? undefined;
  const status      = searchParams.get("status")       ?? undefined;
  const search      = searchParams.get("search")       ?? undefined;

  const pageRaw     = parseInt(searchParams.get("page")      ?? String(DEFAULT_PAGE),      10);
  const pageSizeRaw = parseInt(searchParams.get("page_size") ?? String(DEFAULT_PAGE_SIZE), 10);

  const page      = Number.isFinite(pageRaw)     && pageRaw     >= 1 ? pageRaw     : DEFAULT_PAGE;
  const page_size = Number.isFinite(pageSizeRaw) && pageSizeRaw >= 1
    ? Math.min(pageSizeRaw, MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;

  if (status && !VALID_STATUSES.includes(status as EnrollmentStatus)) {
    return badRequest(`status must be one of: ${VALID_STATUSES.join(", ")}.`);
  }

  // Build query — join to classes (for level + fee) and intakes (for name)
  // Use left join so cart enrollments (class_id=NULL) are included
  let query = supabase
    .from("enrollments")
    .select(
      `
      id,
      enrollment_ref,
      student_name_en,
      student_name_mm,
      phone,
      form_data,
      status,
      enrolled_at,
      quantity,
      class_id,
      classes (
        level,
        fee_mmk,
        intake_id,
        intakes ( name )
      ),
      enrollment_items ( quantity, fee_mmk, classes ( level, intake_id, intakes ( name ) ) )
    `,
      { count: "exact" },
    )
    .eq("tenant_id", tenantId);

  // ── Filters ────────────────────────────────────────────────────────────────
  if (status)      query = query.eq("status", status);
  if (class_level) query = query.eq("classes.level", class_level);
  if (intake_id)   query = query.eq("classes.intake_id", intake_id);

  // Free-text search: name (EN) OR phone — PostgREST OR filter
  if (search && search.trim() !== "") {
    const term = search.trim();
    query = query.or(`student_name_en.ilike.%${term}%,phone.ilike.%${term}%`);
  }

  // ── Pagination ─────────────────────────────────────────────────────────────
  const from = (page - 1) * page_size;
  const to   = from + page_size - 1;

  query = query.order("enrolled_at", { ascending: false }).range(from, to);

  const { data, error, count } = await (query as unknown as Promise<{
    data: {
      id:              string;
      enrollment_ref:  string;
      student_name_en: string;
      student_name_mm: string | null;
      phone:           string;
      form_data:       Record<string, string> | null;
      status:          EnrollmentStatus;
      enrolled_at:     string;
      quantity:        number | null;
      class_id:        string | null;
      classes: {
        level:     JlptLevel;
        fee_mmk:   number;
        intake_id: string;
        intakes:   { name: string } | null;
      } | null;
      enrollment_items: {
        quantity: number;
        fee_mmk: number;
        classes: { level: string; intake_id: string; intakes: { name: string } | null } | null;
      }[];
    }[]
    | null;
    error:   unknown;
    count:   number | null;
  }>);

  if (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }

  const students: StudentRow[] = (data ?? []).map((row) => {
    const isCart = row.class_id === null && row.enrollment_items?.length > 0;

    // For cart enrollments, derive level/fee/intake from enrollment_items
    const cartLevels = isCart
      ? row.enrollment_items.map((ei) => ei.classes?.level ?? "").join(", ")
      : null;
    const cartFee = isCart
      ? row.enrollment_items.reduce((sum, ei) => sum + ei.fee_mmk * ei.quantity, 0)
      : null;
    const cartIntake = isCart
      ? row.enrollment_items[0]?.classes?.intakes?.name ?? ""
      : null;
    const cartItems = isCart
      ? row.enrollment_items.map((ei) => ({
          class_level: ei.classes?.level ?? "",
          quantity: ei.quantity,
          fee_mmk: ei.fee_mmk,
          subtotal_mmk: ei.fee_mmk * ei.quantity,
        }))
      : null;

    return {
      enrollment_id:   row.id,
      enrollment_ref:  row.enrollment_ref,
      student_name_en: row.student_name_en,
      student_name_mm: row.student_name_mm,
      phone:           row.phone,
      form_data:       row.form_data,
      status:          row.status,
      enrolled_at:     row.enrolled_at,
      class_level:     (cartLevels ?? row.classes?.level ?? "") as JlptLevel,
      intake_name:     cartIntake ?? row.classes?.intakes?.name ?? "",
      fee_mmk:         cartFee ?? (row.classes?.fee_mmk ?? 0) * (row.quantity ?? 1),
      quantity:        isCart
        ? cartItems!.reduce((sum, ci) => sum + ci.quantity, 0)
        : (row.quantity ?? 1),
      items:           cartItems,
    };
  });

  const total      = count ?? 0;
  const total_pages = Math.ceil(total / page_size);

  return NextResponse.json({
    data: students,
    pagination: { page, page_size, total, total_pages },
  });
}
