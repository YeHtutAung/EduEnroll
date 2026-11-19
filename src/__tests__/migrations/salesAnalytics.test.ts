import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// Static assertions on the migration text, so they run without a database.
// The numbers themselves were checked against the dev DB by hand (see PR).

const SQL = fs.readFileSync(
  path.join(process.cwd(), "supabase", "migrations", "20261119144828_sales_analytics.sql"),
  "utf8",
);

function fnBody(name: string): string {
  const start = SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const end = SQL.indexOf("$$;", start);
  return SQL.slice(start, end);
}

describe("sales analytics migration", () => {
  it("adds the (tenant, status, enrolled_at) index for visible orders", () => {
    expect(SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_enrollments_tenant_status_enrolled_at\s+ON public\.enrollments \(tenant_id, status, enrolled_at\)\s+WHERE internal_test_at IS NULL;/,
    );
  });

  it("runs both functions as the caller, read-only", () => {
    for (const fn of ["sales_analytics", "sales_not_converted"]) {
      const body = fnBody(fn);
      expect(body).toContain("SECURITY INVOKER");
      expect(body).toContain("STABLE");
      expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    }
  });

  it("keeps contact details out of the aggregate function's output", () => {
    const body = fnBody("sales_analytics");
    expect(body).not.toMatch(/'(email|phone|name)'/);
    expect(body).not.toContain("student_name");
  });

  it("matches the export: test orders out, saved cart price, MMT dates", () => {
    for (const fn of ["sales_analytics", "sales_not_converted"]) {
      const body = fnBody(fn);
      expect(body).toContain("e.internal_test_at IS NULL");
      expect(body).toContain("ei.fee_amount::bigint * ei.quantity");
      expect(body).toContain("e.tenant_id = i.tenant_id");
    }
    expect(fnBody("sales_analytics")).toContain("AT TIME ZONE 'Asia/Yangon'");
  });

  it("is not callable by anon", () => {
    expect(SQL).toContain("REVOKE ALL ON FUNCTION public.sales_analytics(uuid, date, date, uuid) FROM PUBLIC, anon;");
    expect(SQL).toContain("REVOKE ALL ON FUNCTION public.sales_not_converted(uuid, date, date, uuid) FROM PUBLIC, anon;");
  });
});
