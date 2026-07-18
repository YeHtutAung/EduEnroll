import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractSubdomainFromHost } from "@/lib/tenant";

// ─── Public enrollment index ────────────────────────────────────────────────
// The landing page for a tenant's domain: middleware sends the root of a custom
// domain here, so this is where a visitor who types "flashtic.com" arrives.
//
// Behaviour depends on how many intakes are open:
//   1  → redirect straight to it, so the bare domain lands on the ticket page
//   2+ → list them
//   0  → say so plainly, rather than rendering a blank page
//
// Resolving the open intake here rather than hardcoding a slug in middleware
// means this keeps working when the current event ends and the next one opens.

export const dynamic = "force-dynamic";

interface OpenIntake {
  id: string;
  name: string;
  year: number;
  slug: string;
}

export default async function EnrollPage() {
  const headersList = headers();
  // Same resolution the public layout uses: middleware's header, falling back
  // to the host — the header doesn't always propagate on Vercel.
  const tenantSlug =
    headersList.get("x-tenant-slug") ||
    extractSubdomainFromHost(headersList.get("host") ?? "");

  let intakes: OpenIntake[] = [];
  // A query that FAILED is not a tenant with nothing on sale. Keeping these
  // apart matters: telling visitors "No open events" during a database
  // incident reads as "this school closed enrolment", which is a different
  // and damaging claim.
  let loadFailed = false;

  if (tenantSlug) {
    const supabase = createAdminClient();

    const { data: tenant, error: tenantError } = (await supabase
      .from("tenants")
      .select("id")
      .eq("subdomain", tenantSlug)
      .maybeSingle()) as {
      data: { id: string } | null;
      error: { message?: string } | null;
    };

    if (tenantError) {
      console.error("[enroll-index] tenant lookup failed for", tenantSlug, tenantError);
      loadFailed = true;
    } else if (tenant) {
      const { data, error: intakeError } = (await supabase
        .from("intakes")
        .select("id, name, year, slug")
        .eq("tenant_id", tenant.id)
        .eq("status", "open")
        .order("year", { ascending: false })
        .order("created_at", { ascending: false })) as {
        data: OpenIntake[] | null;
        error: { message?: string } | null;
      };

      if (intakeError) {
        console.error("[enroll-index] intake lookup failed for", tenantSlug, intakeError);
        loadFailed = true;
      } else {
        // An intake with no slug has no page to link to — skip rather than
        // render a dead link.
        intakes = (data ?? []).filter((i) => i.slug);
      }
    }
    // A tenant that resolved to no row is not a failure: an unconfigured or
    // unknown slug legitimately has nothing to show.
  }

  if (loadFailed) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-20 text-center">
        <h1 className="text-2xl font-semibold text-slate-900">
          Events can&rsquo;t be loaded right now
        </h1>
        <p className="mt-3 text-slate-600">
          This is a temporary problem on our side, not a closed enrolment. Please try again
          shortly.
        </p>
        <p className="mt-1 font-myanmar text-slate-600">
          ယာယီ ပြဿနာဖြစ်နေပါသည်။ ခဏအကြာတွင် ပြန်လည်ကြိုးစားပါ။
        </p>
      </main>
    );
  }

  // Exactly one open intake: send them straight there. redirect() throws, so
  // nothing below runs.
  if (intakes.length === 1) {
    redirect(`/enroll/${intakes[0].slug}`);
  }

  if (intakes.length === 0) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-20 text-center">
        <h1 className="text-2xl font-semibold text-slate-900">No open events</h1>
        <p className="mt-3 text-slate-600">
          There is nothing open for enrollment right now. Please check back soon.
        </p>
        <p className="mt-1 font-myanmar text-slate-600">
          လက်ရှိတွင် စာရင်းသွင်းရန် မရှိသေးပါ။ ခဏအကြာတွင် ပြန်လည်စစ်ဆေးပါ။
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-semibold text-slate-900">Open for enrollment</h1>
      <p className="mt-1 font-myanmar text-slate-600">စာရင်းသွင်းရန် ဖွင့်ထားသည်</p>

      <ul className="mt-8 space-y-3">
        {intakes.map((intake) => (
          <li key={intake.id}>
            <Link
              href={`/enroll/${intake.slug}`}
              className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-5 py-4 transition hover:border-slate-400 hover:shadow-sm"
            >
              <span className="font-medium text-slate-900">{intake.name}</span>
              <span className="text-sm text-slate-500">{intake.year}</span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
