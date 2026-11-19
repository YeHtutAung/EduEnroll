import { NextRequest, NextResponse } from "next/server";
import { resolveSalesRequest, rpcArgs } from "@/lib/analytics/salesRequest";
import { compareTicketTypes, deriveSalesMetrics, type RawSalesAnalytics } from "@/lib/analytics/sales";

// GET /api/admin/analytics/sales?intake_id&from&to&class_id
// Aggregated sales metrics for one event. Sums and counts are computed in the
// database (public.sales_analytics); no order rows or buyer details are sent.
export async function GET(request: NextRequest) {
  const ctx = await resolveSalesRequest(request);
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, intakes, intake, ticketTypes, filters } = ctx;

  const filterOptions = {
    events: intakes,
    ticketTypes: [...ticketTypes].sort((a, b) => compareTicketTypes(a.level, b.level)),
    selected: filters,
  };

  if (!intake) {
    return NextResponse.json({ filters: filterOptions, metrics: null }, { headers: { "Cache-Control": "no-store" } });
  }

  const { data, error } = await supabase.rpc("sales_analytics", rpcArgs(filters));
  if (error || !data) {
    console.error("[sales-analytics] rpc failed:", error?.code ?? "no data");
    return NextResponse.json({ error: "Failed to load sales analytics." }, { status: 500 });
  }

  return NextResponse.json(
    { filters: filterOptions, metrics: deriveSalesMetrics(data as RawSalesAnalytics) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
