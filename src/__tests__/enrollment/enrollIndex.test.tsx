import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The enrollment index is where the root of a tenant's custom domain lands, so
// its failure modes are public-facing. The one that matters most cannot be
// reached by hand against healthy data: a FAILED query must not be presented as
// "No open events", which would read as the school closing enrolment.

let tenantHeader: string | null = "flashtic";
vi.mock("next/headers", () => ({
  headers: () => ({
    get: (k: string) => (k === "x-tenant-slug" ? tenantHeader : null),
  }),
  cookies: () => ({ get: () => null }),
}));

// redirect() throws NEXT_REDIRECT in Next; mirror that so control flow matches
// production and the call is assertable.
const redirectMock = vi.fn((url: string) => {
  const err = new Error(`NEXT_REDIRECT:${url}`);
  (err as Error & { digest?: string }).digest = `NEXT_REDIRECT;${url}`;
  throw err;
});
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirectMock(url) }));

type Result = { data: unknown; error: unknown };
let tenantResult: Result;
let intakeResult: Result;
const intakeEq = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === "tenants") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => tenantResult }) }),
        };
      }
      // intakes: .select().eq().eq().order().order() and awaited at the end
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          intakeEq(col, val);
          return chain;
        },
        order: () => chain,
        then: (resolve: (r: Result) => unknown) => resolve(intakeResult),
      };
      return chain;
    },
  }),
}));

const { default: EnrollPage } = await import("@/app/(public)/enroll/page");

async function render() {
  return renderToStaticMarkup(await EnrollPage());
}

beforeEach(() => {
  vi.clearAllMocks();
  tenantHeader = "flashtic";
  tenantResult = { data: { id: "tenant-1" }, error: null };
  intakeResult = { data: [], error: null };
});

// ── The blocking case: failure must not look like "nothing on sale" ────────

describe("enrollment index — a failed query is not an empty one", () => {
  it("does not claim 'No open events' when the tenant lookup fails", async () => {
    tenantResult = { data: null, error: { message: "connection refused" } };

    const html = await render();

    expect(html).not.toContain("No open events");
    expect(html).toContain("be loaded right now");
  });

  it("does not claim 'No open events' when the intake lookup fails", async () => {
    intakeResult = { data: null, error: { message: "relation does not exist" } };

    const html = await render();

    expect(html).not.toContain("No open events");
    expect(html).toContain("be loaded right now");
  });

  // The distinction is the whole point: a temporary fault must read as a
  // temporary fault, not as a deliberate business state.
  it("says the problem is ours and temporary", async () => {
    intakeResult = { data: null, error: { message: "boom" } };

    const html = await render();

    expect(html).toContain("temporary problem");
    expect(html).toContain("not a closed enrolment");
  });

  it("creates no redirect when a query fails", async () => {
    intakeResult = { data: null, error: { message: "boom" } };

    await render();

    expect(redirectMock).not.toHaveBeenCalled();
  });
});

// ── Successful queries ────────────────────────────────────────────────────

describe("enrollment index — successful queries", () => {
  it("reports no open events when the query succeeds with none", async () => {
    intakeResult = { data: [], error: null };

    const html = await render();

    expect(html).toContain("No open events");
    expect(html).not.toContain("be loaded right now");
  });

  it("redirects to the only open intake", async () => {
    intakeResult = {
      data: [{ id: "i1", name: "August 2026 Event", year: 2026, slug: "august-2026" }],
      error: null,
    };

    await expect(render()).rejects.toThrow("NEXT_REDIRECT:/enroll/august-2026");
    expect(redirectMock).toHaveBeenCalledWith("/enroll/august-2026");
  });

  it("lists every open intake when there is more than one", async () => {
    intakeResult = {
      data: [
        { id: "i1", name: "August 2026 Event", year: 2026, slug: "august-2026" },
        { id: "i2", name: "April 2026 Intake", year: 2026, slug: "april-2026" },
      ],
      error: null,
    };

    const html = await render();

    expect(redirectMock).not.toHaveBeenCalled();
    expect(html).toContain("August 2026 Event");
    expect(html).toContain("April 2026 Intake");
    expect(html).toContain("/enroll/august-2026");
    expect(html).toContain("/enroll/april-2026");
  });

  // A slugless intake has no page to link to; a dead link is worse than an
  // omission.
  it("omits intakes with no slug rather than linking nowhere", async () => {
    intakeResult = {
      data: [
        { id: "i1", name: "Has A Slug", year: 2026, slug: "has-a-slug" },
        { id: "i2", name: "Slugless Event", year: 2026, slug: "" },
        { id: "i3", name: "Also Fine", year: 2026, slug: "also-fine" },
      ],
      error: null,
    };

    const html = await render();

    expect(html).toContain("Has A Slug");
    expect(html).toContain("Also Fine");
    expect(html).not.toContain("Slugless Event");
  });

  // One linkable intake among slugless ones still counts as one.
  it("redirects when filtering leaves exactly one linkable intake", async () => {
    intakeResult = {
      data: [
        { id: "i1", name: "Slugless", year: 2026, slug: "" },
        { id: "i2", name: "The Only Real One", year: 2026, slug: "real-one" },
      ],
      error: null,
    };

    await expect(render()).rejects.toThrow("NEXT_REDIRECT:/enroll/real-one");
  });
});

// ── Tenant scoping ────────────────────────────────────────────────────────

describe("enrollment index — tenant scoping", () => {
  it("scopes the intake query to the resolved tenant and to open status", async () => {
    intakeResult = { data: [], error: null };

    await render();

    expect(intakeEq).toHaveBeenCalledWith("tenant_id", "tenant-1");
    expect(intakeEq).toHaveBeenCalledWith("status", "open");
  });

  it("queries nothing when no tenant resolves from the request", async () => {
    tenantHeader = null;

    const html = await render();

    expect(intakeEq).not.toHaveBeenCalled();
    expect(html).toContain("No open events");
  });

  // An unknown slug resolving to no row is a legitimate empty state, not a
  // fault — it must not show the failure copy.
  it("treats an unknown tenant as empty, not as a failure", async () => {
    tenantResult = { data: null, error: null };

    const html = await render();

    expect(html).toContain("No open events");
    expect(html).not.toContain("be loaded right now");
  });
});
