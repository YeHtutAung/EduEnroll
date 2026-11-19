import { NextRequest, NextResponse } from "next/server";
import { resolveSalesRequest, rpcArgs } from "@/lib/analytics/salesRequest";
import { csvCell, toMMT } from "@/lib/analytics/sales";

// GET /api/admin/analytics/sales/not-converted?intake_id&from&to&class_id[&format=csv]
// Buyers whose every order for the event was rejected, one row per ticket line,
// for follow-up. This is the only Sales Analytics endpoint that returns contact
// details; it is admin-session only (see resolveSalesRequest) and never cached.

interface NotConvertedRow {
  ref: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  ticket_type: string;
  qty: number;
  fee: number;
  enrolled_at: string;
}

const NO_STORE = { "Cache-Control": "no-store, private" };

export async function GET(request: NextRequest) {
  const ctx = await resolveSalesRequest(request);
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, intake, filters } = ctx;

  let rows: NotConvertedRow[] = [];
  if (intake) {
    const { data, error } = await supabase.rpc("sales_not_converted", rpcArgs(filters));
    if (error) {
      console.error("[sales-analytics] not-converted rpc failed:", error.code);
      return NextResponse.json({ error: "Failed to load the not-converted list." }, { status: 500 });
    }
    rows = (data ?? []) as NotConvertedRow[];
  }

  const out = rows.map((r) => {
    const { date, time } = toMMT(r.enrolled_at);
    return {
      ref: r.ref,
      name: r.name ?? "",
      email: r.email ?? "",
      phone: r.phone ?? "",
      ticketType: r.ticket_type,
      qty: Number(r.qty),
      fee: Number(r.fee),
      date,
      time,
    };
  });

  if (new URL(request.url).searchParams.get("format") !== "csv") {
    return NextResponse.json({ rows: out }, { headers: NO_STORE });
  }

  const header = ["Ref", "Name", "Email", "Phone", "Ticket Type", "Qty", "Fee (MMK)", "Date (MMT)", "Time (MMT)"];
  const lines = [
    header.map(csvCell).join(","),
    ...out.map((r) =>
      [r.ref, r.name, r.email, r.phone, r.ticketType, String(r.qty), String(r.fee), r.date, r.time]
        .map(csvCell)
        .join(","),
    ),
  ];
  // BOM so Excel reads UTF-8 (Myanmar names) correctly.
  const body = `﻿${lines.join("\r\n")}\r\n`;
  const stamp = new Date().toISOString().slice(0, 10);

  return new NextResponse(body, {
    status: 200,
    headers: {
      ...NO_STORE,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="not-converted-${stamp}.csv"`,
    },
  });
}
