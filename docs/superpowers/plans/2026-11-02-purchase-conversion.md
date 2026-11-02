# Server-side Purchase Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send one purchase event per ad platform (Meta, TikTok) from our server after an order is paid, for buyers with click data, without ever affecting a payment, ticket or notification.

**Architecture:** A database trigger on `payments` fills a queue when a payment becomes `verified`, so every payment path is covered. `issueTicketsForEnrollment` starts a send through `waitUntil` without blocking settlement, and a daily cron retries and deletes stored IP data. Click data is captured in a first-party cookie on tracked pages and copied to a service-role-only table when the order is created.

**Tech Stack:** Next.js 14 App Router, TypeScript, Supabase Postgres, Vitest, `@vercel/functions` (new), Vercel Cron.

**Spec:** `docs/superpowers/specs/2026-11-02-purchase-conversion-design.md`. Read it first.

---

## Rules for whoever runs this plan

- **Branch** from `origin/dev`: `git switch -c feature/purchase-conversion origin/dev`. Git identity must be `yehtutaung.yha@gmail.com`.
- **Never send or store email, phone, name or the order ref.** The owner ruled this out, hashed or not. If an API seems to need one, stop and ask the owner.
- **Never log** tokens, IPs, cookies, click IDs or platform response bodies.
- **Never touch production.** The dev DB (`fnfvwzwrdsnmwxunciti`) needs the owner's yes first. Production is the owner's job.
- **Never** run `npm run build` while a dev server is running.
- **Windows worktrees:** a worktree has no `.env.test.local`, so the DB suite reports "no tests". Copy it in for the run and delete the copy afterwards. Delete any `node_modules` junction before removing a worktree, and never use `git worktree remove --force`.
- **The repo is public.** No exploit detail in commits or PRs.
- **End commits with** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Show `git status` and `git diff` before each commit.

## File map

| File | Action | Responsibility |
|---|---|---|
| `supabase/migrations/20261103120000_purchase_conversions.sql` | Create | Three tables, the trigger, the clean-up function |
| `src/lib/conversions/clickData.ts` | Create | Pure: validate values, read and write the click cookie, build `fbc` |
| `src/components/tracking/AdClickCapture.tsx` | Create | Writes the cookie on tracked pages |
| `src/server/conversions/captureAdContext.ts` | Create | Stores ad context when an order is created |
| `src/lib/conversions/payloads.ts` | Create | Pure: request builders and response classification |
| `src/server/conversions/config.ts` | Create | Environment mode and credentials |
| `src/server/conversions/sendPendingConversions.ts` | Create | Claims, decides, sends, records |
| `src/server/conversions/sweep.ts` | Create | Cron logic: clean-up, then a bounded batch |
| `src/app/api/cron/conversions/route.ts` | Create | Cron auth and entry point |
| `src/lib/tagManager.ts` | Modify | Export `hasSensitiveParam` |
| `src/app/(public)/layout.tsx` | Modify | Render `AdClickCapture` |
| `src/app/api/public/enroll/route.ts` | Modify | Call `captureAdContext` on both branches |
| `src/server/tickets/issueTickets.ts` | Modify | Wrapper that schedules the sender |
| `vercel.json`, `package.json` | Modify | Cron entry, new dependency |

---

### Task 1: Confirm the platform facts (gate)

No code. The spec relied partly on third-party guides. Everything else depends on this task.

**Files:**
- Modify: `docs/superpowers/specs/2026-11-02-purchase-conversion-design.md` (section 6)

- [ ] **Step 1: Read the official references** in the browser pane:
  - Meta Conversions API: parameters, customer information parameters, errors.
  - TikTok Events API 2.0: web event parameters, supported events, currency codes, response codes.

- [ ] **Step 2: Answer these and write the answers into spec section 6**
  1. Does Meta accept a website event with `fbp`/`fbc`, IP and user agent, and no hashed email or phone?
  2. TikTok's current event name for a completed payment.
  3. Is `MMK` accepted by both?
  4. Current Meta API version, and whether TikTok is still `v1.3`.
  5. Exact error codes for rate limit, auth and permission on each platform.

- [ ] **Step 3: Apply the gate**

If the answer to question 1 is no, or question 3 is no for a platform, **stop and report to the owner.** Don't continue with that platform. Hashed contact data is not an available fix.

Otherwise, update the constants in Task 5 to match what you found.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-11-02-purchase-conversion-design.md
git commit -m "docs(conversions): record confirmed platform API facts"
```

---

### Task 2: Migration and database tests

**Files:**
- Create: `supabase/migrations/20261103120000_purchase_conversions.sql`
- Test: `src/__tests__/db/purchase-conversions.db.test.ts`

Before starting, check the highest number in `supabase/migrations/` and use a later timestamp if `20261103120000` is taken. Requires the local stack (`supabase start`, Docker running).

- [ ] **Step 1: Write the migration**

```sql
-- ─── Server-side purchase conversions ───────────────────────────────────────
--
-- See docs/superpowers/specs/2026-11-02-purchase-conversion-design.md.
--
--   tenant_conversion_settings  which tenants send, and to which pixels
--   enrollment_ad_context       click data, IP and user agent, kept briefly
--   conversion_events           one queued purchase event per platform
--
-- Additive. No tenant sends anything until a settings row is added by SQL.
--
-- DEPLOY ORDER: apply this BEFORE the code that reads it.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_payments_enqueue_conversions ON public.payments;
--   DROP FUNCTION IF EXISTS public.fn_payments_enqueue_conversions();
--   DROP FUNCTION IF EXISTS public.cleanup_conversion_data();
--   DROP TABLE IF EXISTS public.conversion_events;
--   DROP TABLE IF EXISTS public.enrollment_ad_context;
--   DROP TABLE IF EXISTS public.tenant_conversion_settings;

CREATE TABLE public.tenant_conversion_settings (
  tenant_id         uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  config_id         text NOT NULL CHECK (config_id ~ '^[A-Z0-9_]+$'),
  meta_pixel_id     text,
  tiktok_pixel_code text,
  enabled           boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER tenant_conversion_settings_updated_at
  BEFORE UPDATE ON public.tenant_conversion_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.enrollment_ad_context (
  enrollment_id uuid PRIMARY KEY REFERENCES public.enrollments(id) ON DELETE CASCADE,
  fbp           text,
  fbc           text,
  ttp           text,
  ttclid        text,
  client_ip     text,
  user_agent    text,
  source_url    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_enrollment_ad_context_created_at
  ON public.enrollment_ad_context (created_at);

CREATE TABLE public.conversion_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id   uuid NOT NULL REFERENCES public.enrollments(id) ON DELETE CASCADE,
  tenant_id       uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  platform        text NOT NULL CHECK (platform IN ('meta', 'tiktok')),
  event_id        text NOT NULL,
  value           numeric NOT NULL CHECK (value > 0),
  currency        text NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts        integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_error      text,
  UNIQUE (enrollment_id, platform)
);

CREATE INDEX idx_conversion_events_pending
  ON public.conversion_events (occurred_at)
  WHERE status = 'pending';

-- No policies: anon and authenticated can neither read nor write.
ALTER TABLE public.tenant_conversion_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enrollment_ad_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversion_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tenant_conversion_settings FROM public, anon, authenticated;
REVOKE ALL ON public.enrollment_ad_context FROM public, anon, authenticated;
REVOKE ALL ON public.conversion_events FROM public, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_conversion_settings TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.enrollment_ad_context TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversion_events TO service_role;

-- A conversion bug must never roll back a settlement, so the whole body is
-- wrapped and an error only raises a warning.
CREATE FUNCTION public.fn_payments_enqueue_conversions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_settings public.tenant_conversion_settings%ROWTYPE;
  v_currency text;
  v_value    numeric;
  v_event_id text;
BEGIN
  BEGIN
    SELECT * INTO v_settings
      FROM public.tenant_conversion_settings
     WHERE tenant_id = NEW.tenant_id AND enabled;
    IF NOT FOUND THEN RETURN NEW; END IF;

    SELECT upper(currency) INTO v_currency FROM public.tenants WHERE id = NEW.tenant_id;

    -- A charge in another currency would mislabel the value.
    IF NEW.provider_currency IS NOT NULL AND upper(NEW.provider_currency) <> v_currency THEN
      RETURN NEW;
    END IF;

    -- A top-up row holds only the remainder. The earlier row that recorded the
    -- partial payment holds the full ticket total.
    SELECT p.amount - p.platform_fee INTO v_value
      FROM public.payments p
     WHERE p.enrollment_id = NEW.enrollment_id
       AND p.id <> NEW.id
       AND p.received_amount IS NOT NULL
     ORDER BY p.created_at DESC
     LIMIT 1;
    v_value := COALESCE(v_value, NEW.amount - NEW.platform_fee);
    IF v_value <= 0 THEN RETURN NEW; END IF;

    v_event_id := encode(sha256(convert_to('purchase:' || NEW.enrollment_id::text, 'UTF8')), 'hex');

    IF v_settings.meta_pixel_id IS NOT NULL THEN
      INSERT INTO public.conversion_events (enrollment_id, tenant_id, platform, event_id, value, currency)
      VALUES (NEW.enrollment_id, NEW.tenant_id, 'meta', v_event_id, v_value, v_currency)
      ON CONFLICT (enrollment_id, platform) DO NOTHING;
    END IF;
    IF v_settings.tiktok_pixel_code IS NOT NULL THEN
      INSERT INTO public.conversion_events (enrollment_id, tenant_id, platform, event_id, value, currency)
      VALUES (NEW.enrollment_id, NEW.tenant_id, 'tiktok', v_event_id, v_value, v_currency)
      ON CONFLICT (enrollment_id, platform) DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'purchase conversion enqueue failed: %', SQLSTATE;
  END;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_payments_enqueue_conversions() FROM public, anon, authenticated;

CREATE TRIGGER trg_payments_enqueue_conversions
  AFTER UPDATE OF status ON public.payments
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'verified')
  EXECUTE FUNCTION public.fn_payments_enqueue_conversions();

-- Called first by the daily cron, so a sending backlog can't block deletion of
-- IP data. Order matters: expiring rows first lets their context go in this run.
CREATE FUNCTION public.cleanup_conversion_data()
RETURNS TABLE (expired integer, context_deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expired integer;
  v_finished integer;
  v_unpaid integer;
BEGIN
  UPDATE public.conversion_events
     SET status = 'failed', last_error = 'expired'
   WHERE status = 'pending' AND occurred_at < now() - interval '7 days';
  GET DIAGNOSTICS v_expired = ROW_COUNT;

  -- Every queue row finished: the data has done its job.
  DELETE FROM public.enrollment_ad_context c
   WHERE EXISTS (SELECT 1 FROM public.conversion_events e WHERE e.enrollment_id = c.enrollment_id)
     AND NOT EXISTS (SELECT 1 FROM public.conversion_events e
                      WHERE e.enrollment_id = c.enrollment_id AND e.status = 'pending');
  GET DIAGNOSTICS v_finished = ROW_COUNT;

  -- No queue rows after 8 days: an order that was never paid.
  DELETE FROM public.enrollment_ad_context c
   WHERE c.created_at < now() - interval '8 days'
     AND NOT EXISTS (SELECT 1 FROM public.conversion_events e WHERE e.enrollment_id = c.enrollment_id);
  GET DIAGNOSTICS v_unpaid = ROW_COUNT;

  RETURN QUERY SELECT v_expired, v_finished + v_unpaid;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_conversion_data() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_conversion_data() TO service_role;
```

- [ ] **Step 2: Write the database tests**

Copy the fixture approach from `src/__tests__/db/kbzpay-order-slot.db.test.ts` (`Pool`, `sql`, and tenant, intake, class and enrollment inserts, with clean-up in `afterEach`). Use tenant-unique `subdomain` values. Seed payments with `payment_method='bank_transfer'` and `status='pending'`, then `UPDATE payments SET status='verified'`. If that seed is rejected by a constraint, match the existing test's columns.

```ts
describe("enqueue trigger", () => {
  it("adds one row per configured platform when a payment becomes verified", async () => {
    // settings: both pixels. Expect rows for meta and tiktok, status pending,
    // value = amount - platform_fee, currency uppercase.
  });
  it("adds only the configured platform when one pixel is null", async () => {});
  it("adds nothing on a second transition to verified", async () => {
    // verified → pending → verified. Still two rows, no duplicates.
  });
  it("adds nothing for an unconfigured tenant", async () => {});
  it("adds nothing for a disabled tenant", async () => {});
  it("adds nothing when the value is zero", async () => {
    // amount 100, platform_fee 100.
  });
  it("skips a charge in another currency", async () => {
    // provider_currency 'sgd' on an MMK tenant.
  });
  it("reports the full total for a top-up", async () => {
    // Row A: amount 1000, received_amount 600, status pending.
    // Row B: amount 400, then verified. Expect value 1000.
  });
  it("stores an event id that is the hash of the enrollment id", async () => {
    // createHash("sha256").update(`purchase:${enrollmentId}`).digest("hex")
    // Also assert it does not contain the enrollment_ref.
  });
  it("does not roll back the payment when the trigger body fails", async () => {
    // Rename the column the body reads inside a transaction, or insert a settings
    // row and make the insert fail with a temporary CHECK on conversion_events.
    // Assert the payment is verified and the enrollment is confirmed.
    // Remove the temporary CHECK in finally.
  });
});

describe("cleanup_conversion_data", () => {
  it("expires pending rows older than 7 days and deletes their context", async () => {});
  it("keeps context while a pending row exists", async () => {});
  it("deletes context once every row is finished", async () => {});
  it("deletes context older than 8 days with no queue rows", async () => {});
  it("keeps context younger than 8 days with no queue rows", async () => {});
});

describe("privileges", () => {
  it.each(["tenant_conversion_settings", "enrollment_ad_context", "conversion_events"])(
    "%s has RLS on and no anon or authenticated access",
    async (table) => {
      // has_table_privilege('anon', 'public.<table>', 'SELECT') is false,
      // the same for 'authenticated', and pg_class.relrowsecurity is true.
      // Not through PostgREST: the local stack returns 42501 for every public
      // table, so a PostgREST check here would prove nothing.
    },
  );
  it("does not let anon or authenticated run the functions", async () => {
    // has_function_privilege for both functions.
  });
});
```

Write each body in full. These stubs show the cases, not the finished tests.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test:db -- src/__tests__/db/purchase-conversions.db.test.ts`
Expected: FAIL, because the tables don't exist.

- [ ] **Step 4: Apply the migration locally and re-run**

Run: `npx supabase migration up --local`, then the same test command.
Expected: PASS, exit code 0. Local stack only: never pass `--linked` in this task.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261103120000_purchase_conversions.sql src/__tests__/db/purchase-conversions.db.test.ts
git commit -m "feat(conversions): add queue tables, trigger and clean-up"
```

---

### Task 3: Click cookie rules

**Files:**
- Create: `src/lib/conversions/clickData.ts`
- Test: `src/__tests__/conversions/clickData.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import {
  AD_CLICK_COOKIE,
  cleanClickValue,
  nextClickCookie,
  parseClickCookie,
  buildFbc,
} from "@/lib/conversions/clickData";

describe("cleanClickValue", () => {
  it("accepts a normal value", () => expect(cleanClickValue("fb.1.1700000000.abc-DEF_1")).toBe("fb.1.1700000000.abc-DEF_1"));
  it("drops script characters", () => expect(cleanClickValue("<script>")).toBeNull());
  it("drops an over-long value", () => expect(cleanClickValue("a".repeat(501))).toBeNull());
  it("drops empty and missing values", () => {
    expect(cleanClickValue("")).toBeNull();
    expect(cleanClickValue(undefined)).toBeNull();
  });
});

describe("nextClickCookie", () => {
  const now = 1_700_000_000_000;

  it("returns null when the URL has no click ID", () => {
    expect(nextClickCookie("?utm_source=fb", null, now)).toBeNull();
  });
  it("stores a new fbclid with its capture time", () => {
    expect(parseClickCookie(nextClickCookie("?fbclid=AB1", null, now))).toEqual({ fbclid: "AB1", ttclid: null, at: now });
  });
  it("keeps the other platform's ID when only one changes", () => {
    const existing = nextClickCookie("?ttclid=T1", null, now);
    expect(parseClickCookie(nextClickCookie("?fbclid=F1", existing, now + 1))).toEqual({ fbclid: "F1", ttclid: "T1", at: now + 1 });
  });
  it("ignores an invalid ID", () => {
    expect(nextClickCookie("?fbclid=%3Cx%3E", null, now)).toBeNull();
  });
});

describe("parseClickCookie", () => {
  it("returns empty for a missing or malformed cookie", () => {
    const empty = { fbclid: null, ttclid: null, at: null };
    expect(parseClickCookie(undefined)).toEqual(empty);
    expect(parseClickCookie("not json")).toEqual(empty);
  });
  it("re-validates values on the way in", () => {
    const raw = encodeURIComponent(JSON.stringify({ fbclid: "<x>", ttclid: "T1", at: 5 }));
    expect(parseClickCookie(raw)).toEqual({ fbclid: null, ttclid: "T1", at: 5 });
  });
});

describe("buildFbc", () => {
  it("uses Meta's format", () => expect(buildFbc("AB1", 1700)).toBe("fb.1.1700.AB1"));
});

it("has a stable cookie name", () => expect(AD_CLICK_COOKIE).toBe("kn_ad_click"));
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/__tests__/conversions/clickData.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// ─── Ad click cookie: pure rules ────────────────────────────────────────────
//
// Holds the ad platforms' click IDs and when they were seen. Nothing else: no
// order ref, no buyer data. See
// docs/superpowers/specs/2026-11-02-purchase-conversion-design.md.

export const AD_CLICK_COOKIE = "kn_ad_click";
export const AD_CLICK_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

const CLICK_VALUE_RE = /^[A-Za-z0-9._\-=+/]{1,500}$/;

export function cleanClickValue(value: unknown): string | null {
  return typeof value === "string" && CLICK_VALUE_RE.test(value) ? value : null;
}

export interface ClickData {
  fbclid: string | null;
  ttclid: string | null;
  at: number | null;
}

export function parseClickCookie(raw: string | null | undefined): ClickData {
  const empty: ClickData = { fbclid: null, ttclid: null, at: null };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as Record<string, unknown>;
    return {
      fbclid: cleanClickValue(parsed.fbclid),
      ttclid: cleanClickValue(parsed.ttclid),
      at: typeof parsed.at === "number" && Number.isFinite(parsed.at) ? parsed.at : null,
    };
  } catch {
    return empty;
  }
}

/** The new cookie value, or null when the URL carries no valid click ID. */
export function nextClickCookie(search: string, existing: string | null | undefined, now: number): string | null {
  const params = new URLSearchParams(search);
  const fbclid = cleanClickValue(params.get("fbclid"));
  const ttclid = cleanClickValue(params.get("ttclid"));
  if (!fbclid && !ttclid) return null;
  const current = parseClickCookie(existing);
  return encodeURIComponent(
    JSON.stringify({ fbclid: fbclid ?? current.fbclid, ttclid: ttclid ?? current.ttclid, at: now }),
  );
}

export function buildFbc(fbclid: string, capturedAtMs: number): string {
  return `fb.1.${capturedAtMs}.${fbclid}`;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/__tests__/conversions/clickData.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/conversions/clickData.ts src/__tests__/conversions/clickData.test.ts
git commit -m "feat(conversions): add ad click cookie rules"
```

---

### Task 4: Capture the click in the browser

**Files:**
- Create: `src/components/tracking/AdClickCapture.tsx`
- Modify: `src/lib/tagManager.ts` (export `hasSensitiveParam`, currently at line 97)
- Modify: `src/app/(public)/layout.tsx`
- Test: `src/__tests__/tracking/adClickCapture.test.tsx`

- [ ] **Step 1: Write the failing test**

This project has no jsdom, so extract the decision as a pure, exported function and test it, the same way `kbzpay-modal.test.ts` does.

```ts
import { describe, it, expect } from "vitest";
import { clickCookieToWrite } from "@/components/tracking/AdClickCapture";

const base = { containerId: "GTM-ABC1234", pathname: "/enroll/event", search: "?fbclid=F1", existing: null, now: 5 };

describe("clickCookieToWrite", () => {
  it("writes on a tracked path with a valid container", () => {
    expect(clickCookieToWrite(base)).not.toBeNull();
  });
  it("does not write without a valid container", () => {
    expect(clickCookieToWrite({ ...base, containerId: null })).toBeNull();
    expect(clickCookieToWrite({ ...base, containerId: "bad" })).toBeNull();
  });
  it("does not write on an untracked path", () => {
    expect(clickCookieToWrite({ ...base, pathname: "/enroll/form" })).toBeNull();
  });
  it("does not write when the URL has a sensitive param", () => {
    expect(clickCookieToWrite({ ...base, search: "?fbclid=F1&ref=X" })).toBeNull();
  });
  it("does not write when there is no click ID", () => {
    expect(clickCookieToWrite({ ...base, search: "" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/__tests__/tracking/adClickCapture.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

In `src/lib/tagManager.ts`, change `function hasSensitiveParam` to `export function hasSensitiveParam`.

```tsx
"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { GTM_CONTAINER_ID_RE, hasSensitiveParam, isTrackedPath } from "@/lib/tagManager";
import { AD_CLICK_COOKIE, AD_CLICK_MAX_AGE_SECONDS, nextClickCookie } from "@/lib/conversions/clickData";

// Stores the ad platforms' click IDs for the server-side purchase event.
// Deliberately does not use the full GTM guard: that fails on any unknown storage
// key, so a repeat ad click would lose its IDs, and writing our own cookie loads no
// third-party code. See docs/superpowers/specs/2026-11-02-purchase-conversion-design.md.

export function clickCookieToWrite(args: {
  containerId: string | null;
  pathname: string;
  search: string;
  existing: string | null;
  now: number;
}): string | null {
  if (args.containerId === null || !GTM_CONTAINER_ID_RE.test(args.containerId)) return null;
  if (!isTrackedPath(args.pathname)) return null;
  if (hasSensitiveParam(new URLSearchParams(args.search))) return null;
  return nextClickCookie(args.search, args.existing, args.now);
}

function readCookie(name: string): string | null {
  const prefix = `${name}=`;
  const found = document.cookie.split("; ").find((c) => c.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

export default function AdClickCapture({ containerId }: { containerId: string | null }) {
  const pathname = usePathname();

  useEffect(() => {
    const value = clickCookieToWrite({
      containerId,
      pathname: pathname ?? "",
      search: window.location.search,
      existing: readCookie(AD_CLICK_COOKIE),
      now: Date.now(),
    });
    if (!value) return;
    document.cookie = `${AD_CLICK_COOKIE}=${value}; Path=/; Max-Age=${AD_CLICK_MAX_AGE_SECONDS}; SameSite=Lax; Secure`;
  }, [containerId, pathname]);

  return null;
}
```

In `src/app/(public)/layout.tsx`, add the import and render it beside the existing component:

```tsx
<TenantTagManager containerId={gtmAllowed ? gtmContainerId : null} />
<AdClickCapture containerId={gtmAllowed ? gtmContainerId : null} />
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/__tests__/tracking src/__tests__/lib/tagManager.test.ts`
Expected: PASS, including the existing GTM tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/tracking/AdClickCapture.tsx src/lib/tagManager.ts "src/app/(public)/layout.tsx" src/__tests__/tracking/adClickCapture.test.tsx
git commit -m "feat(conversions): capture ad click IDs on tracked pages"
```

---

### Task 5: Payload builders and response classification

**Files:**
- Create: `src/lib/conversions/payloads.ts`
- Test: `src/__tests__/conversions/payloads.test.ts`

Use the answers from Task 1 for the version, the event name and the error codes. The values below are what the spec assumed.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { buildMetaRequest, buildTiktokRequest, classifyResponse } from "@/lib/conversions/payloads";

const event = {
  eventId: "hash123",
  occurredAt: "2026-11-02T00:00:00.000Z",
  value: 50000,
  currency: "MMK",
  sourceUrl: "https://tickets.example.com/enroll/event",
  clientIp: "203.0.113.1",
  userAgent: "UA",
  fbp: "fb.1.1.1",
  fbc: "fb.1.1.abc",
  ttp: "ttp1",
  ttclid: "tt1",
};

describe("buildMetaRequest", () => {
  it("sends a Purchase with the agreed fields", () => {
    const r = buildMetaRequest({ pixelId: "123", token: "TOKEN", testCode: null, event });
    const body = JSON.parse(r.body);
    expect(r.url).toContain("/123/events");
    expect(r.url).not.toContain("TOKEN");
    expect(body.data[0]).toMatchObject({
      event_name: "Purchase",
      event_id: "hash123",
      event_time: 1793577600,
      action_source: "website",
      event_source_url: event.sourceUrl,
      custom_data: { value: 50000, currency: "MMK" },
    });
    expect(body.test_event_code).toBeUndefined();
  });
  it("adds the test code when there is one", () => {
    expect(JSON.parse(buildMetaRequest({ pixelId: "1", token: "T", testCode: "TEST1", event }).body).test_event_code).toBe("TEST1");
  });
});

describe("buildTiktokRequest", () => {
  it("sends a completed payment with the token only in the header", () => {
    const r = buildTiktokRequest({ pixelCode: "PX", token: "TOKEN", testCode: null, event });
    expect(r.headers["Access-Token"]).toBe("TOKEN");
    expect(r.body).not.toContain("TOKEN");
    const body = JSON.parse(r.body);
    expect(body.event_source).toBe("web");
    expect(body.event_source_id).toBe("PX");
    expect(body.data[0].event).toBe("CompletePayment");
  });
});

// The owner ruled out buyer contact data. The builders take an explicit field
// list, and this pins that nothing else can reach a payload.
describe("privacy", () => {
  it("never includes buyer data, even if it is passed in", () => {
    const leaky = { ...event, email: "buyer@example.com", phone: "0912345678", name: "Buyer", enrollmentRef: "SF2-1102-ABC" };
    const all = [
      buildMetaRequest({ pixelId: "1", token: "T", testCode: null, event: leaky }).body,
      buildTiktokRequest({ pixelCode: "P", token: "T", testCode: null, event: leaky }).body,
    ].join();
    for (const s of ["buyer@example.com", "0912345678", "Buyer", "SF2-1102-ABC", '"em"', '"ph"', '"email"', '"phone"']) {
      expect(all).not.toContain(s);
    }
  });
});

describe("classifyResponse", () => {
  it("treats Meta 200 as sent", () => expect(classifyResponse("meta", 200, {}).status).toBe("sent"));
  it("retries Meta rate limit and auth errors", () => {
    expect(classifyResponse("meta", 400, { error: { code: 17 } }).status).toBe("pending");
    expect(classifyResponse("meta", 400, { error: { code: 190 } }).status).toBe("pending");
  });
  it("fails any other Meta rejection", () => {
    expect(classifyResponse("meta", 400, { error: { code: 100 } })).toEqual({ status: "failed", code: "meta_100" });
  });
  it("treats TikTok 200 with code 0 as sent", () => expect(classifyResponse("tiktok", 200, { code: 0 }).status).toBe("sent"));
  it("does not treat TikTok 200 with an error code as sent", () => {
    expect(classifyResponse("tiktok", 200, { code: 40002 }).status).toBe("failed");
    expect(classifyResponse("tiktok", 200, { code: 40100 }).status).toBe("pending");
  });
  it("retries 5xx on both", () => {
    expect(classifyResponse("meta", 503, null).status).toBe("pending");
    expect(classifyResponse("tiktok", 503, null).status).toBe("pending");
  });
  it("records only a code, never the body", () => {
    expect(JSON.stringify(classifyResponse("meta", 400, { error: { code: 100, message: "secret detail" } }))).not.toContain("secret");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/__tests__/conversions/payloads.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// ─── Purchase event payloads: pure rules ────────────────────────────────────
//
// Each builder copies named fields only, so buyer data cannot reach a payload by
// accident. No email, phone, name or order ref, hashed or not: the owner's
// decision. See docs/superpowers/specs/2026-11-02-purchase-conversion-design.md.

export type ConversionPlatform = "meta" | "tiktok";

export interface PurchaseEvent {
  eventId: string;
  occurredAt: string;
  value: number;
  currency: string;
  sourceUrl: string;
  clientIp: string | null;
  userAgent: string | null;
  fbp: string | null;
  fbc: string | null;
  ttp: string | null;
  ttclid: string | null;
}

export interface PlatformRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

const META_API_VERSION = "v21.0"; // Confirm in Task 1.
const TIKTOK_URL = "https://business-api.tiktok.com/open_api/v1.3/event/track/"; // Confirm in Task 1.
const TIKTOK_EVENT = "CompletePayment"; // Confirm in Task 1.

// Confirm all four sets in Task 1. These stay pending, so a replaced token or a
// passing limit recovers within the 7-day window.
const META_RETRY_CODES = new Set([1, 2, 4, 10, 17, 32, 190, 200, 613, 80004]);
const TIKTOK_RETRY_CODES = new Set([40100, 40105]);

const eventTime = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

export function buildMetaRequest(args: {
  pixelId: string;
  token: string;
  testCode: string | null;
  event: PurchaseEvent;
}): PlatformRequest {
  const { event } = args;
  return {
    url: `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(args.pixelId)}/events`,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      access_token: args.token,
      ...(args.testCode ? { test_event_code: args.testCode } : {}),
      data: [
        {
          event_name: "Purchase",
          event_time: eventTime(event.occurredAt),
          event_id: event.eventId,
          action_source: "website",
          event_source_url: event.sourceUrl,
          user_data: {
            client_ip_address: event.clientIp ?? undefined,
            client_user_agent: event.userAgent ?? undefined,
            fbp: event.fbp ?? undefined,
            fbc: event.fbc ?? undefined,
          },
          custom_data: { value: event.value, currency: event.currency },
        },
      ],
    }),
  };
}

export function buildTiktokRequest(args: {
  pixelCode: string;
  token: string;
  testCode: string | null;
  event: PurchaseEvent;
}): PlatformRequest {
  const { event } = args;
  return {
    url: TIKTOK_URL,
    headers: { "Content-Type": "application/json", "Access-Token": args.token },
    body: JSON.stringify({
      event_source: "web",
      event_source_id: args.pixelCode,
      ...(args.testCode ? { test_event_code: args.testCode } : {}),
      data: [
        {
          event: TIKTOK_EVENT,
          event_time: eventTime(event.occurredAt),
          event_id: event.eventId,
          user: {
            ttclid: event.ttclid ?? undefined,
            ttp: event.ttp ?? undefined,
            ip: event.clientIp ?? undefined,
            user_agent: event.userAgent ?? undefined,
          },
          page: { url: event.sourceUrl },
          properties: { value: event.value, currency: event.currency },
        },
      ],
    }),
  };
}

export interface SendOutcome {
  status: "sent" | "pending" | "failed";
  /** A status or platform code only. Never a response body. */
  code: string | null;
}

export function classifyResponse(platform: ConversionPlatform, httpStatus: number, body: unknown): SendOutcome {
  if (httpStatus >= 500) return { status: "pending", code: `http_${httpStatus}` };
  const b = (body ?? {}) as { code?: unknown; error?: { code?: unknown } };

  if (platform === "meta") {
    if (httpStatus >= 200 && httpStatus < 300) return { status: "sent", code: null };
    const code = typeof b.error?.code === "number" ? b.error.code : null;
    if (code === null) return { status: "failed", code: `http_${httpStatus}` };
    const retry = META_RETRY_CODES.has(code) || (code >= 200 && code <= 299);
    return { status: retry ? "pending" : "failed", code: `meta_${code}` };
  }

  // TikTok reports errors in the body, with HTTP 200.
  if (b.code === 0 && httpStatus >= 200 && httpStatus < 300) return { status: "sent", code: null };
  if (typeof b.code !== "number") return { status: "failed", code: `http_${httpStatus}` };
  const retry = TIKTOK_RETRY_CODES.has(b.code) || b.code >= 50000;
  return { status: retry ? "pending" : "failed", code: `tiktok_${b.code}` };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/__tests__/conversions/payloads.test.ts`
Expected: PASS. The `leaky` object needs a cast or a typed extension to satisfy the compiler; don't change the builders' types to allow it.

- [ ] **Step 5: Commit**

```bash
git add src/lib/conversions/payloads.ts src/__tests__/conversions/payloads.test.ts
git commit -m "feat(conversions): add Meta and TikTok payload builders"
```

---

### Task 6: Environment mode and credentials

**Files:**
- Create: `src/server/conversions/config.ts`
- Test: `src/__tests__/conversions/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { resolveSendMode } from "@/server/conversions/config";

const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv;

describe("resolveSendMode", () => {
  it("sends live in production, ignoring a test code", () => {
    expect(
      resolveSendMode("SKY", "meta", env({ VERCEL_ENV: "production", CONVERSIONS_SKY_META_TOKEN: "T", CONVERSIONS_SKY_META_TEST_CODE: "C" })),
    ).toEqual({ kind: "send", token: "T", testCode: null });
  });
  it("sends with the test code outside production", () => {
    expect(
      resolveSendMode("SKY", "meta", env({ VERCEL_ENV: "preview", CONVERSIONS_SKY_META_TOKEN: "T", CONVERSIONS_SKY_META_TEST_CODE: "C" })),
    ).toEqual({ kind: "send", token: "T", testCode: "C" });
  });
  it("holds outside production with no test code", () => {
    expect(resolveSendMode("SKY", "meta", env({ VERCEL_ENV: "preview", CONVERSIONS_SKY_META_TOKEN: "T" }))).toEqual({ kind: "hold", reason: "no_test_code" });
  });
  it("holds with no token, and names the variable without a value", () => {
    expect(resolveSendMode("SKY", "tiktok", env({ VERCEL_ENV: "production" }))).toEqual({ kind: "hold", reason: "missing CONVERSIONS_SKY_TIKTOK_TOKEN" });
  });
  it("never reads another tenant's token", () => {
    expect(resolveSendMode("SKY", "meta", env({ VERCEL_ENV: "production", CONVERSIONS_OTHER_META_TOKEN: "T" })).kind).toBe("hold");
  });
  it("holds when VERCEL_ENV is unset", () => {
    expect(resolveSendMode("SKY", "meta", env({ CONVERSIONS_SKY_META_TOKEN: "T" }))).toEqual({ kind: "hold", reason: "no_test_code" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/__tests__/conversions/config.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
import type { ConversionPlatform } from "@/lib/conversions/payloads";

export type SendMode =
  | { kind: "send"; token: string; testCode: string | null }
  | { kind: "hold"; reason: string };

/**
 * The database does not separate environments (staging reads the dev database),
 * so only the deployment decides. Only production sends live events.
 */
export function resolveSendMode(
  configId: string,
  platform: ConversionPlatform,
  env: NodeJS.ProcessEnv = process.env,
): SendMode {
  const prefix = `CONVERSIONS_${configId}_${platform.toUpperCase()}`;
  const token = env[`${prefix}_TOKEN`]?.trim();
  if (!token) return { kind: "hold", reason: `missing ${prefix}_TOKEN` };
  if (env.VERCEL_ENV === "production") return { kind: "send", token, testCode: null };
  const testCode = env[`${prefix}_TEST_CODE`]?.trim();
  if (!testCode) return { kind: "hold", reason: "no_test_code" };
  return { kind: "send", token, testCode };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/__tests__/conversions/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/conversions/config.ts src/__tests__/conversions/config.test.ts
git commit -m "feat(conversions): add send mode and credential rules"
```

---

### Task 7: Store ad context with the order

**Files:**
- Create: `src/server/conversions/captureAdContext.ts`
- Modify: `src/app/api/public/enroll/route.ts`
- Test: `src/__tests__/conversions/captureAdContext.test.ts`

- [ ] **Step 1: Write the failing test**

Split the pure part out, so it can be tested without mocking Supabase.

```ts
import { describe, it, expect } from "vitest";
import { adContextFromRequest } from "@/server/conversions/captureAdContext";

const cookies = (o: Record<string, string>) => (name: string) => o[name];
const headers = new Headers({ "user-agent": "UA", "x-real-ip": "203.0.113.1" });

describe("adContextFromRequest", () => {
  it("returns null when no click data is present", () => {
    expect(adContextFromRequest(cookies({}), headers)).toBeNull();
  });
  it("reads the pixel cookies", () => {
    expect(adContextFromRequest(cookies({ _fbp: "fb.1.1.1", _ttp: "ttp1" }), headers)).toMatchObject({
      fbp: "fb.1.1.1", ttp: "ttp1", fbc: null, ttclid: null, client_ip: "203.0.113.1", user_agent: "UA",
    });
  });
  it("builds fbc from our cookie when the pixel has not set one", () => {
    const raw = encodeURIComponent(JSON.stringify({ fbclid: "F1", ttclid: "T1", at: 1700 }));
    expect(adContextFromRequest(cookies({ kn_ad_click: raw }), headers)).toMatchObject({ fbc: "fb.1.1700.F1", ttclid: "T1" });
  });
  it("prefers the pixel's own _fbc", () => {
    const raw = encodeURIComponent(JSON.stringify({ fbclid: "F1", at: 1700 }));
    expect(adContextFromRequest(cookies({ kn_ad_click: raw, _fbc: "fb.1.9.P" }), headers)?.fbc).toBe("fb.1.9.P");
  });
  it("drops invalid values, and returns null if nothing is left", () => {
    expect(adContextFromRequest(cookies({ _fbp: "<script>" }), headers)).toBeNull();
  });
  it("stores null for an unknown IP", () => {
    expect(adContextFromRequest(cookies({ _fbp: "fb.1.1.1" }), new Headers())?.client_ip).toBeNull();
  });
  it("caps the user agent", () => {
    const long = new Headers({ "user-agent": "a".repeat(2000) });
    expect(adContextFromRequest(cookies({ _fbp: "fb.1.1.1" }), long)?.user_agent).toHaveLength(1000);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/__tests__/conversions/captureAdContext.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
import { createAdminClient } from "@/lib/supabase/admin";
import { tenantLinkOrigin } from "@/lib/origin";
import { clientIpFrom } from "@/lib/rateLimit";
import { AD_CLICK_COOKIE, buildFbc, cleanClickValue, parseClickCookie } from "@/lib/conversions/clickData";

const USER_AGENT_MAX = 1000;

export interface AdContext {
  fbp: string | null;
  fbc: string | null;
  ttp: string | null;
  ttclid: string | null;
  client_ip: string | null;
  user_agent: string | null;
}

/** Null when there is no click data: an organic buyer's IP is never stored. */
export function adContextFromRequest(
  cookie: (name: string) => string | undefined,
  headers: Headers,
): AdContext | null {
  const clicks = parseClickCookie(cookie(AD_CLICK_COOKIE));
  const fbp = cleanClickValue(cookie("_fbp"));
  const ttp = cleanClickValue(cookie("_ttp"));
  const fbc =
    cleanClickValue(cookie("_fbc")) ??
    (clicks.fbclid && clicks.at !== null ? buildFbc(clicks.fbclid, clicks.at) : null);
  const ttclid = clicks.ttclid;
  if (!fbp && !fbc && !ttp && !ttclid) return null;

  const ip = clientIpFrom(headers);
  return {
    fbp,
    fbc,
    ttp,
    ttclid,
    client_ip: ip === "unknown" ? null : ip,
    user_agent: headers.get("user-agent")?.slice(0, USER_AGENT_MAX) ?? null,
  };
}

/**
 * Never throws: a tracking failure must not fail an order that already holds
 * its seats. The cookie check comes first, so organic orders cost no query.
 */
export async function captureAdContext(args: {
  cookie: (name: string) => string | undefined;
  headers: Headers;
  enrollmentId: string;
  tenantId: string;
  subdomain: string | null | undefined;
  classId: unknown;
}): Promise<void> {
  try {
    const context = adContextFromRequest(args.cookie, args.headers);
    if (!context) return;

    const supabase = createAdminClient();
    const { data: settings } = (await supabase
      .from("tenant_conversion_settings" as never)
      .select("tenant_id")
      .eq("tenant_id", args.tenantId)
      .eq("enabled", true)
      .maybeSingle()) as { data: { tenant_id: string } | null };
    if (!settings) return;

    // Built from our own data, never from the Host header or a request URL.
    let path = "/enroll";
    if (typeof args.classId === "string") {
      const { data: cls } = (await supabase
        .from("classes")
        .select("intakes(slug)")
        .eq("id", args.classId)
        .maybeSingle()) as { data: { intakes: { slug: string | null } | null } | null };
      if (cls?.intakes?.slug) path = `/enroll/${encodeURIComponent(cls.intakes.slug)}`;
    }

    const { error } = (await supabase
      .from("enrollment_ad_context" as never)
      .upsert(
        { enrollment_id: args.enrollmentId, ...context, source_url: `${tenantLinkOrigin(args.subdomain)}${path}` } as never,
        { onConflict: "enrollment_id", ignoreDuplicates: true },
      )) as { error: { code?: string } | null };
    if (error) console.error("[conversions] ad context not stored:", error.code ?? "unknown");
  } catch (err) {
    console.error("[conversions] ad context failed:", err instanceof Error ? err.name : "unknown");
  }
}
```

In `src/app/api/public/enroll/route.ts`, add the import, then call it in **both** branches, right after `const tenantInfo = await fetchTenantInfo(...)`:

```ts
// Cart branch:
await captureAdContext({
  cookie: (name) => request.cookies.get(name)?.value,
  headers: request.headers,
  enrollmentId: result.enrollment_id,
  tenantId: result.tenant_id,
  subdomain: tenantInfo?.subdomain,
  classId: (items as { class_id?: unknown }[])[0]?.class_id,
});

// Single-class branch: the same call, with classId: class_id
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run src/__tests__/conversions src/__tests__/enrollment` then `npx tsc --noEmit -p .`
Expected: PASS, and exit 0 on both. Add a mock of `captureAdContext` to any existing route test that breaks on the extra call.

- [ ] **Step 5: Commit**

```bash
git add src/server/conversions/captureAdContext.ts src/app/api/public/enroll/route.ts src/__tests__/conversions/captureAdContext.test.ts
git commit -m "feat(conversions): store ad context when an order is created"
```

---

### Task 8: The sender

**Files:**
- Create: `src/server/conversions/sendPendingConversions.ts`
- Test: `src/__tests__/conversions/sendPendingConversions.test.ts`

Note one change from the order written in spec section 5. The per-row environment check needs the settings row, because `config_id` is there, so the steps run: load rows, load settings, check mode, claim, then decide and send. The spec's intent is unchanged: rows that can't be sent are never claimed, and `attempts` doesn't move.

- [ ] **Step 1: Write the failing test**

Follow the mocking style in `src/__tests__/payments/kbzpay-settle.test.ts` for `createAdminClient`, and stub `global.fetch`. Split the per-row decision into an exported pure function.

```ts
import { describe, it, expect } from "vitest";
import { decideRow } from "@/server/conversions/sendPendingConversions";

const settings = { enabled: true, config_id: "SKY", meta_pixel_id: "1", tiktok_pixel_code: "P" };
const enrollment = { status: "confirmed", internal_test_at: null };
const context = { fbp: "f", fbc: null, ttp: null, ttclid: null };

describe("decideRow", () => {
  it("sends when everything is present", () => expect(decideRow("meta", settings, enrollment, context)).toBe("send"));
  it("skips an unconfirmed enrollment", () => expect(decideRow("meta", settings, { ...enrollment, status: "rejected" }, context)).toBe("skip"));
  it("skips an internal test order", () => expect(decideRow("meta", settings, { ...enrollment, internal_test_at: "x" }, context)).toBe("skip"));
  it("skips when settings are missing or disabled", () => {
    expect(decideRow("meta", null, enrollment, context)).toBe("skip");
    expect(decideRow("meta", { ...settings, enabled: false }, enrollment, context)).toBe("skip");
  });
  it("skips when that platform's pixel is null", () => expect(decideRow("tiktok", { ...settings, tiktok_pixel_code: null }, enrollment, { ...context, ttp: "t" })).toBe("skip"));
  it("skips when there is no ad context", () => expect(decideRow("meta", settings, enrollment, null)).toBe("skip"));
  it("requires each platform's own click data", () => {
    expect(decideRow("tiktok", settings, enrollment, context)).toBe("skip");
    expect(decideRow("meta", settings, enrollment, { ...context, fbp: null, ttclid: "t" })).toBe("skip");
    expect(decideRow("tiktok", settings, enrollment, { ...context, ttclid: "t" })).toBe("send");
  });
});

describe("sendPendingConversions", () => {
  it("does nothing, and sends nothing, when there are no pending rows", async () => {});
  it("leaves rows pending with attempts unchanged when the mode is hold", async () => {});
  it("marks a skipped row without calling fetch", async () => {});
  it("records sent, failed and pending outcomes per platform", async () => {});
  it("keeps a timed-out send pending", async () => {});
  it("records only a code in last_error", async () => {});
  it("never throws, even if the database client throws", async () => {
    // Make createAdminClient throw. Expect the promise to resolve.
  });
  it("resolves at its deadline even if fetch never settles", async () => {
    // Use fake timers and a fetch that never resolves.
  });
  it("logs no token, IP or click ID", async () => {
    // Spy on console.error and console.warn across a failing run.
  });
});
```

Write each body in full. Assert on the mock's recorded `update` payloads.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/__tests__/conversions/sendPendingConversions.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
import { createAdminClient } from "@/lib/supabase/admin";
import {
  buildMetaRequest,
  buildTiktokRequest,
  classifyResponse,
  type ConversionPlatform,
  type PlatformRequest,
  type SendOutcome,
} from "@/lib/conversions/payloads";
import { resolveSendMode } from "@/server/conversions/config";

// See docs/superpowers/specs/2026-11-02-purchase-conversion-design.md, section 5.

const RUN_DEADLINE_MS = 6000;
const SEND_TIMEOUT_MS = 2500;
const CLAIM_STALE_MS = 5 * 60 * 1000;

interface Settings {
  enabled: boolean;
  config_id: string;
  meta_pixel_id: string | null;
  tiktok_pixel_code: string | null;
}
interface ContextIds {
  fbp: string | null;
  fbc: string | null;
  ttp: string | null;
  ttclid: string | null;
}
interface QueueRow {
  id: string;
  tenant_id: string;
  platform: ConversionPlatform;
  event_id: string;
  value: number;
  currency: string;
  occurred_at: string;
  attempts: number;
}

export function decideRow(
  platform: ConversionPlatform,
  settings: Settings | null,
  enrollment: { status: string; internal_test_at: string | null } | null,
  context: ContextIds | null,
): "send" | "skip" {
  if (!enrollment || enrollment.status !== "confirmed" || enrollment.internal_test_at) return "skip";
  if (!settings || !settings.enabled) return "skip";
  if (!context) return "skip";
  if (platform === "meta") return settings.meta_pixel_id && (context.fbp || context.fbc) ? "send" : "skip";
  return settings.tiktok_pixel_code && (context.ttclid || context.ttp) ? "send" : "skip";
}

async function post(request: PlatformRequest, platform: ConversionPlatform): Promise<SendOutcome> {
  try {
    const res = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null);
    return classifyResponse(platform, res.status, body);
  } catch {
    return { status: "pending", code: "transport" };
  }
}

async function run(enrollmentId: string): Promise<void> {
  const supabase = createAdminClient();
  const table = () => supabase.from("conversion_events" as never);

  const staleBefore = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
  const { data: pending } = (await table()
    .select("id, tenant_id, platform, event_id, value, currency, occurred_at, attempts")
    .eq("enrollment_id", enrollmentId)
    .eq("status", "pending")
    .or(`last_attempt_at.is.null,last_attempt_at.lt.${staleBefore}`)) as unknown as { data: QueueRow[] | null };
  if (!pending || pending.length === 0) return;

  const { data: settings } = (await supabase
    .from("tenant_conversion_settings" as never)
    .select("enabled, config_id, meta_pixel_id, tiktok_pixel_code")
    .eq("tenant_id", pending[0].tenant_id)
    .maybeSingle()) as unknown as { data: Settings | null };

  const finish = (id: string, status: "sent" | "failed" | "skipped" | "pending", code: string | null) =>
    table().update({ status, last_error: code } as never).eq("id", id);

  const sendable: { row: QueueRow; token: string; testCode: string | null }[] = [];
  for (const row of pending) {
    // Before the mode check: turning a tenant off must stop queued rows, even
    // ones whose token has already been removed.
    if (!settings || !settings.enabled) {
      await finish(row.id, "skipped", "disabled");
      continue;
    }
    const mode = resolveSendMode(settings.config_id, row.platform);
    if (mode.kind === "hold") {
      // Names the variable, never a value. Stays pending, attempts unchanged.
      if (mode.reason !== "no_test_code") console.error(`[conversions] ${mode.reason}`);
      continue;
    }
    // The attempts check is the claim: only one caller can move it on.
    const { data: claimed } = (await table()
      .update({ attempts: row.attempts + 1, last_attempt_at: new Date().toISOString() } as never)
      .eq("id", row.id)
      .eq("status", "pending")
      .eq("attempts", row.attempts)
      .select("id")) as unknown as { data: { id: string }[] | null };
    if (claimed && claimed.length > 0) sendable.push({ row, token: mode.token, testCode: mode.testCode });
  }
  if (sendable.length === 0) return;

  const [{ data: enrollment }, { data: context }] = (await Promise.all([
    supabase.from("enrollments").select("status, internal_test_at").eq("id", enrollmentId).maybeSingle(),
    supabase
      .from("enrollment_ad_context" as never)
      .select("fbp, fbc, ttp, ttclid, client_ip, user_agent, source_url")
      .eq("enrollment_id", enrollmentId)
      .maybeSingle(),
  ])) as unknown as [
    { data: { status: string; internal_test_at: string | null } | null },
    { data: (ContextIds & { client_ip: string | null; user_agent: string | null; source_url: string }) | null },
  ];

  await Promise.all(
    sendable.map(async ({ row, token, testCode }) => {
      if (decideRow(row.platform, settings, enrollment, context) === "skip" || !context || !settings) {
        await finish(row.id, "skipped", "not_eligible");
        return;
      }
      const event = {
        eventId: row.event_id,
        occurredAt: row.occurred_at,
        value: Number(row.value),
        currency: row.currency,
        sourceUrl: context.source_url,
        clientIp: context.client_ip,
        userAgent: context.user_agent,
        fbp: context.fbp,
        fbc: context.fbc,
        ttp: context.ttp,
        ttclid: context.ttclid,
      };
      const request =
        row.platform === "meta"
          ? buildMetaRequest({ pixelId: settings.meta_pixel_id!, token, testCode, event })
          : buildTiktokRequest({ pixelCode: settings.tiktok_pixel_code!, token, testCode, event });
      const outcome = await post(request, row.platform);
      await finish(row.id, outcome.status, outcome.code);
    }),
  );
}

/** Never throws. A row left unfinished at the deadline is picked up by the cron. */
export async function sendPendingConversions(enrollmentId: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      run(enrollmentId),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, RUN_DEADLINE_MS);
      }),
    ]);
  } catch (err) {
    console.error("[conversions] send failed:", err instanceof Error ? err.name : "unknown");
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/__tests__/conversions/sendPendingConversions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/conversions/sendPendingConversions.ts src/__tests__/conversions/sendPendingConversions.test.ts
git commit -m "feat(conversions): send queued purchase events"
```

---

### Task 9: Start the sender without blocking settlement

**Files:**
- Modify: `package.json`, `package-lock.json`
- Modify: `src/server/tickets/issueTickets.ts`
- Test: `src/__tests__/tickets/issueTickets.test.ts`

- [ ] **Step 1: Install the dependency**

Run: `npm install @vercel/functions`
Expected: exit 0. Check the diff adds only this package, plus its lockfile entries. Confirm `waitUntil` is exported, and that it still runs the promise outside Vercel.

- [ ] **Step 2: Add failing tests** to `src/__tests__/tickets/issueTickets.test.ts`

Mock `@vercel/functions` and `@/server/conversions/sendPendingConversions`:

```ts
describe("purchase conversion hook", () => {
  it("schedules the sender with waitUntil, without awaiting it", async () => {
    // Make sendPendingConversions return a promise that never resolves.
    // issueTicketsForEnrollment must still resolve.
    // waitUntil must have been called once with that promise.
  });
  it("still schedules on an early return", async () => {
    // A non-event tenant returns early; the sender is still scheduled.
  });
  it("still schedules, and rethrows, when issuance throws", async () => {
    // A failed enrollment query. Expect rejects.toThrow and waitUntil called.
    // Callers depend on this throw to return a retryable result.
  });
  it("does not change the outcome if scheduling itself throws", async () => {
    // waitUntil throws. The function still resolves.
  });
});
```

Also add a settlement test to `src/__tests__/payments/kbzpay-settle.test.ts`: with a sender that never settles, `notifyEnrollmentConfirmed` is still called.

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run src/__tests__/tickets/issueTickets.test.ts`
Expected: the new tests FAIL.

- [ ] **Step 4: Implement**

In `src/server/tickets/issueTickets.ts`, rename the existing exported function to a private `issueTicketsInner` with the body unchanged, keep its doc comment on the new export, and add:

```ts
import { waitUntil } from "@vercel/functions";
import { sendPendingConversions } from "@/server/conversions/sendPendingConversions";

export async function issueTicketsForEnrollment(enrollmentId: string): Promise<void> {
  try {
    await issueTicketsInner(enrollmentId);
  } finally {
    // Not awaited. KBZPay and CB routes are capped at 10 seconds, and the
    // confirmation sent after this runs only for the settlement winner, so a
    // blocking send could lose it for good. Anything cut off stays pending for
    // the daily retry.
    try {
      waitUntil(sendPendingConversions(enrollmentId));
    } catch (err) {
      console.error("[conversions] schedule failed:", err instanceof Error ? err.name : "unknown");
    }
  }
}
```

- [ ] **Step 5: Run the payment and ticket suites**

Run: `npx vitest run src/__tests__/tickets src/__tests__/payments src/__tests__/webhooks`
Expected: PASS. If a test's queued Supabase mock is disturbed by the extra query, mock `@/server/conversions/sendPendingConversions` in that file. Don't change production code to suit a mock.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/server/tickets/issueTickets.ts src/__tests__/tickets/issueTickets.test.ts src/__tests__/payments/kbzpay-settle.test.ts
git commit -m "feat(conversions): start the send without blocking settlement"
```

---

### Task 10: Daily retry and clean-up

**Files:**
- Create: `src/server/conversions/sweep.ts`
- Create: `src/app/api/cron/conversions/route.ts`
- Modify: `vercel.json`
- Test: `src/__tests__/conversions/sweep.test.ts`, `src/__tests__/api/cron-conversions.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// cron-conversions.test.ts: mock sweepConversions.
describe("GET /api/cron/conversions", () => {
  it("returns 401 when CRON_SECRET is unset, even for 'Bearer undefined'", async () => {});
  it("returns 401 for a wrong secret", async () => {});
  it("returns 401 with no header", async () => {});
  it("runs the sweep and returns counts for the right secret", async () => {});
  it("returns 500 with no detail when the sweep throws", async () => {});
});

// sweep.test.ts: mock the admin client and sendPendingConversions.
describe("sweepConversions", () => {
  it("runs clean-up before reading any pending rows", async () => {});
  it("still sends when clean-up fails", async () => {});
  it("reads oldest first, and sends each enrollment once", async () => {});
  it("processes at most 40 enrollments", async () => {});
  it("runs at most 5 at a time", async () => {});
});
```

Write each body in full.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/__tests__/conversions/sweep.test.ts src/__tests__/api/cron-conversions.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/server/conversions/sweep.ts`:

```ts
import { createAdminClient } from "@/lib/supabase/admin";
import { sendPendingConversions } from "@/server/conversions/sendPendingConversions";

// 40 enrollments, 5 at a time, 6 seconds each: at most 48 seconds, inside the
// route's 60. Rows not reached wait for the next run.
const BATCH_ENROLLMENTS = 40;
const CONCURRENCY = 5;

export interface SweepCounts {
  expired: number;
  contextDeleted: number;
  processed: number;
}

export async function sweepConversions(): Promise<SweepCounts> {
  const supabase = createAdminClient();
  const counts: SweepCounts = { expired: 0, contextDeleted: 0, processed: 0 };

  // First, so a sending backlog can't stop IP data being deleted.
  const { data: cleaned, error: cleanupError } = (await supabase.rpc(
    "cleanup_conversion_data" as never,
  )) as unknown as { data: { expired: number; context_deleted: number }[] | null; error: { code?: string } | null };
  if (cleanupError) {
    console.error("[conversions] clean-up failed:", cleanupError.code ?? "unknown");
  } else if (cleaned?.[0]) {
    counts.expired = cleaned[0].expired;
    counts.contextDeleted = cleaned[0].context_deleted;
  }

  const { data: rows } = (await supabase
    .from("conversion_events" as never)
    .select("enrollment_id")
    .eq("status", "pending")
    .order("occurred_at", { ascending: true })
    .limit(BATCH_ENROLLMENTS * 2)) as unknown as { data: { enrollment_id: string }[] | null };

  const ids = Array.from(new Set((rows ?? []).map((r) => r.enrollment_id))).slice(0, BATCH_ENROLLMENTS);
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    await Promise.all(ids.slice(i, i + CONCURRENCY).map((id) => sendPendingConversions(id)));
  }
  counts.processed = ids.length;
  return counts;
}
```

`src/app/api/cron/conversions/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { sweepConversions } from "@/server/conversions/sweep";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  // Checked for presence first, so "Bearer undefined" can never pass.
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const counts = await sweepConversions();
    console.log("[conversions] sweep", JSON.stringify(counts));
    return NextResponse.json(counts);
  } catch (err) {
    console.error("[conversions] sweep failed:", err instanceof Error ? err.name : "unknown");
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
```

In `vercel.json`, add a top-level key. Vercel cron times are UTC, so this is 02:30 in Myanmar:

```json
"crons": [{ "path": "/api/cron/conversions", "schedule": "0 20 * * *" }]
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run src/__tests__/conversions src/__tests__/api/cron-conversions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/conversions/sweep.ts src/app/api/cron/conversions/route.ts vercel.json src/__tests__/conversions/sweep.test.ts src/__tests__/api/cron-conversions.test.ts
git commit -m "feat(conversions): add daily retry and clean-up"
```

---

### Task 11: Full verification and PR

- [ ] **Step 1: Run everything, and judge by exit code**

```bash
npm test
npm run test:db
npx tsc --noEmit -p .
npx eslint src/lib/conversions src/server/conversions src/components/tracking/AdClickCapture.tsx src/app/api/cron/conversions
npm run build
```

Expected: exit 0 on each. Stop any dev server before the build. A worktree needs its own env for `test:db` and `build`; delete any copied env file afterwards. Report what was run, and what wasn't.

- [ ] **Step 2: Check the privacy rule across the diff**

Run: `git diff origin/dev -- src | grep -nE "console\.(log|error|warn)"`
Expected: no log line contains a token, IP, cookie, click ID, response body or order ref.

- [ ] **Step 3: Open the PR into `dev`**

Don't merge it. End the body with the attribution line. The PR must state:
- The migration goes on before the code, and isn't applied by CI.
- No tenant sends anything until a settings row exists.
- What wasn't tested: real platform delivery, which needs Task 12.

- [ ] **Step 4: Report**

Split into Claude Code, Codex and Human. Ask the owner to trigger `@codex review`.

---

### Task 12: Staging test (needs the owner)

Not code. Each step that changes a shared system needs the owner's yes.

- [ ] **Step 1: Apply to the dev DB.** Show the migration diff, get a yes, then run `npx supabase migration up --linked` against `fnfvwzwrdsnmwxunciti` only. Check `has_table_privilege` and RLS state for the three tables.

- [ ] **Step 2: Promote to staging.** The owner merges `dev` → `staging`. Confirm the deploy.

- [ ] **Step 3: The owner adds Vercel vars, scoped to `staging`, then redeploys:** `CONVERSIONS_SKYFESTIVAL_META_TOKEN`, `_META_TEST_CODE`, `_TIKTOK_TOKEN`, `_TIKTOK_TEST_CODE`, `CRON_SECRET`. Never through chat.

- [ ] **Step 4: Add the settings row on the dev DB.** Show the SQL first:

```sql
INSERT INTO public.tenant_conversion_settings (tenant_id, config_id, meta_pixel_id, tiktok_pixel_code)
SELECT id, 'SKYFESTIVAL', '<meta pixel id>', '<tiktok pixel code>'
FROM public.tenants WHERE subdomain = 'skyfestival';
```

- [ ] **Step 5: Run a real paid test order.**
  - Open `https://skyfestival.staging.kuunyi.com/enroll/<event>?fbclid=TESTF1&ttclid=TESTT1`.
  - Check that `kn_ad_click` is set, and that GTM still behaves as in phase 1.
  - Buy with a real KBZPay UAT payment.
  - Check that the event appears in Meta's Test Events and TikTok's test tool, with the right value, and with no email or phone.
  - Check the row is `sent`.
  - Check that the buyer's confirmation arrived.

- [ ] **Step 6: Run the negative checks.**
  - An order with no click data creates no ad context, and its rows become `skipped`.
  - Clearing `enabled` stops a queued row being sent.
  - A wrong token leaves the row `pending`.

- [ ] **Step 7: Clean up.** Call the cron route by hand with the secret, and confirm the ad context is deleted. Archive the test orders, with the owner's yes.

- [ ] **Step 8: Hand production to the owner.** They apply the migration before the code, run the privilege check, add `CRON_SECRET` and live tokens, promote, add the settings row, and confirm the first cron log line.

---

## Spec coverage

| Spec section | Task |
|---|---|
| Click capture | 3, 4 |
| Ad context | 2, 7 |
| Tenant settings | 2, 6 |
| Queue, trigger, value and currency | 2 |
| Sender and where it is called | 8, 9 |
| Payloads and items to confirm | 1, 5 |
| Retry and clean-up | 2, 10 |
| Environments | 6 |
| Privacy and logging | 5, 8, 11 |
| Testing | 2 to 10, 12 |
| Rollout | 12 |
