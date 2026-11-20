import { NextRequest, NextResponse } from "next/server";
import { resolveSalesRequest, rpcArgs } from "@/lib/analytics/salesRequest";
import {
  compareTicketTypes,
  deriveSalesMetrics,
  type RawSalesAnalytics,
  type RawWalletRow,
} from "@/lib/analytics/sales";

// GET /api/admin/analytics/sales?intake_id&from&to&class_id
// Aggregated sales metrics for one event. Sums and counts are computed in the
// database (public.sales_analytics, public.sales_payment_wallets); no order
// rows or buyer details are sent.
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

  const args = rpcArgs(filters);
  const [sales, wallets] = await Promise.all([
    supabase.rpc("sales_analytics", args),
    supabase.rpc("sales_payment_wallets", args),
  ]);
  if (sales.error || !sales.data || wallets.error) {
    console.error(
      "[sales-analytics] rpc failed:",
      sales.error?.code ?? (sales.data ? "" : "no data"),
      wallets.error?.code ?? "",
    );
    return NextResponse.json({ error: "Failed to load sales analytics." }, { status: 500 });
  }

  const metrics = deriveSalesMetrics(sales.data as RawSalesAnalytics, (wallets.data ?? []) as RawWalletRow[]);
  return NextResponse.json(
    { filters: filterOptions, metrics },
    { headers: { "Cache-Control": "no-store" } },
  );
}
