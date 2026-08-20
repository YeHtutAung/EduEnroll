# KBZPay MMQR Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add KBZPay as a third MMQR payment provider, selectable per tenant alongside ABank and MMPay.

**Architecture:** A pure client (`src/lib/kbzpay.ts`) handles signing and HTTP. Two transactional SQL functions own the order slot so only one KBZPay order per enrollment can ever be live. A new `settleMmqrPayment()` operation performs the conditional payment transition and delegates fulfilment to the existing `issueTicketsForEnrollment` / `notifyEnrollmentConfirmed` helpers. Three routes (create, webhook, status) wire it together. ABank and MMPay are not touched.

**Tech Stack:** Next.js 14 App Router, TypeScript, Supabase (Postgres + PL/pgSQL), Vitest, MSW, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-20-kbzpay-mmqr-integration-design.md` (revision 7, approved). Section references below (§3.3, §5.1, etc.) point there.

---

## Before you start

**Read the spec's §13 first.** It records thirteen review findings and two invariants that the
design converged on after seven rounds. Both are easy to break while implementing:

1. **No terminal transition and no order-slot release without a `queryorder` answer.** A local
   clock, a cached QR, a `closeorder` return code and a failed outbound request were each
   wrongly treated as authoritative during review. If you find yourself writing
   `mmqr_status = 'FAILED'` anywhere except after KBZPay reports the order does not exist,
   stop and re-read §4.3.
2. **No `settleMmqrPayment()` result object ever reaches the browser.** The route always
   translates to the §5.1a response contract.

**Credentials are not available (spec §11, gate G1).** Every test in this plan runs against
fake env values and mocked HTTP. Nothing here requires a real KBZPay account. The tasks are
ordered so that everything except live verification can be completed and merged before
credentials arrive.

**Environment for tests.** Add to `.env.test.local` (gitignored, already used by the DB suite):

```
KBZPAY_APPID=kptest0000000000000000000000000000
KBZPAY_MERCH_CODE=70000000001
KBZPAY_APP_KEY=testkey0123456789abcdef
KBZPAY_MODE=uat
```

**Commands used throughout:**

| Purpose | Command |
|---|---|
| Unit / route tests | `npm test` |
| A single unit file | `npx vitest run src/__tests__/payments/<file>.test.ts` |
| Database tests | `npm run test:db` |
| A single DB file | `npx vitest run --config vitest.db.config.ts src/__tests__/db/<file>.db.test.ts` |
| Lint | `npm run lint` |
| Build (judge by **exit code**, not output text) | `npm run build` |
| Apply migrations **locally** | `npx supabase migration up --local` |

> **Never run `npm run db:migrate` from this workspace.** It is `npx supabase db push`, which
> targets whichever project the CLI is *linked* to — and `supabase/.temp/project-ref` currently
> reads `nhxmumcvgnxlczjsgctz`, the **production** project. There is no `--dev` in that script;
> the word "dev" appears nowhere in it. Use the explicit `--local` form above, or have an
> operator apply the migration to dev through the normal pipeline.

**Git.** Work on the current branch `feat/kbzpay-mmqr-design`, which is branched from
`origin/dev` and already carries the spec commit. Never push to `main` or `staging`; the
branch reaches `dev` through a PR that a human reviews.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/kbzpay.ts` | **Create.** Pure client: `sign`, `verifySign`, `buildMerchOrderId`, `precreate`, `queryOrder`, `closeOrder`. No Supabase, no Next.js imports. |
| `supabase/migrations/20260820120000_kbzpay_mmqr.sql` | **Create.** Columns, indexes, and the two order-slot functions. |
| `src/server/payments/settleMmqrPayment.ts` | **Create.** The settlement operation. |
| `src/server/payments/resolveKbzpayOrder.ts` | **Create.** The §5.1 step 7 resolve procedure, extracted so the create route stays readable and the procedure is testable on its own. |
| `src/app/api/public/payments/kbzpay/route.ts` | **Create.** `POST` — claim, resolve, precreate, return QR. |
| `src/app/api/public/payments/kbzpay/status/route.ts` | **Create.** `GET` — poller, self-heals a missed callback. |
| `src/app/api/webhooks/kbzmmqr/route.ts` | **Create.** `POST` — signed callback receiver. |
| `src/components/payments/QRPaymentModal.tsx` | **Modify.** Provider union, endpoint map, `already_paid` branch. |
| `src/app/admin/settings/page.tsx` | **Modify.** Third `mmqr_provider` option. |
| `src/app/(public)/enroll/[slug]/checkout/payment/page.tsx` | **Modify.** Pass the provider through. |
| `src/mocks/handlers.ts` | **Modify.** MSW handlers for the three KBZPay endpoints. |

`resolveKbzpayOrder.ts` is separated from the route deliberately: §5.1 step 7 is where all
eight of the spec's wrong-statement findings lived, and it is far easier to test exhaustively
as a function than through a route handler.

---

## Task 1: Signature algorithm — `stringA` construction

This is the highest-risk unit in the integration and the KBZPay docs publish two worked
examples, so it is tested against real vectors rather than self-authored ones (§3.3).

**Files:**
- Create: `src/lib/kbzpay.ts`
- Test: `src/__tests__/payments/kbzpay-sign.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { buildStringA } from "@/lib/kbzpay";

// Vector 1 — the precreate example published in the KBZPay PGW docs (§3.3).
// The docs print the expected stringA verbatim, so this is a real vector.
const PRECREATE_REQUEST = {
  timestamp: 1536637503,
  notify_url: "http://test.com/payment/notify",
  nonce_str: "845255910308564481",
  sign_type: "SHA256",
  method: "kbz.payment.precreate",
  sign: "wait_to_generate",
  version: "1.0",
  biz_content: {
    merch_order_id: "201811212009001",
    merch_code: "100001",
    appid: "kp123456789987654321abcdefghijkl",
    trade_type: "APPH5",
    total_amount: "1000",
    trans_currency: "MMK",
  },
};

const PRECREATE_STRING_A =
  "appid=kp123456789987654321abcdefghijkl&merch_code=100001" +
  "&merch_order_id=201811212009001&method=kbz.payment.precreate" +
  "&nonce_str=845255910308564481&notify_url=http://test.com/payment/notify" +
  "&timestamp=1536637503&total_amount=1000&trade_type=APPH5" +
  "&trans_currency=MMK&version=1.0";

// Vector 2 — the orderinfo example from the same section.
const ORDERINFO = {
  prepay_id: "KBZ00c25d94271b4d950ec748fdaf20c81d2b154042384",
  merch_code: "200001",
  appid: "kp419a753459284f72aa76d2ae9d6057",
  timestamp: 1535165303,
  nonce_str: "5K8264ILTKCH16CQ2502SI8ZNMTM67VS",
};

const ORDERINFO_STRING_A =
  "appid=kp419a753459284f72aa76d2ae9d6057&merch_code=200001" +
  "&nonce_str=5K8264ILTKCH16CQ2502SI8ZNMTM67VS" +
  "&prepay_id=KBZ00c25d94271b4d950ec748fdaf20c81d2b154042384" +
  "&timestamp=1535165303";

describe("buildStringA", () => {
  it("matches the published precreate vector", () => {
    expect(buildStringA(PRECREATE_REQUEST)).toBe(PRECREATE_STRING_A);
  });

  it("matches the published orderinfo vector", () => {
    expect(buildStringA(ORDERINFO)).toBe(ORDERINFO_STRING_A);
  });

  it("excludes sign and sign_type", () => {
    const s = buildStringA({ b: "2", sign: "x", sign_type: "SHA256", a: "1" });
    expect(s).toBe("a=1&b=2");
  });

  it("excludes empty, null and undefined values", () => {
    const s = buildStringA({ a: "1", b: "", c: null, d: undefined, e: "2" });
    expect(s).toBe("a=1&e=2");
  });

  it("excludes array and object values (JSONArray fields like refund_info)", () => {
    const s = buildStringA({ a: "1", refund_info: [{ x: 1 }], nested: { y: 2 } });
    expect(s).toBe("a=1");
  });

  // The callback carries Wallet_identifier with a capital W, which sorts BEFORE
  // every lowercase key under ASCII. localeCompare would place it elsewhere and
  // silently break every real callback (§3.3).
  it("sorts by ASCII, so capitalised keys come first", () => {
    const s = buildStringA({ appid: "x", Wallet_identifier: "MCB", merch_code: "1" });
    expect(s).toBe("Wallet_identifier=MCB&appid=x&merch_code=1");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/payments/kbzpay-sign.test.ts`
Expected: FAIL — `buildStringA` is not exported from `@/lib/kbzpay` (the module does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `src/lib/kbzpay.ts`:

```ts
// ─── KBZPay Payment Gateway (PGW) MMQR client ───────────────────────────────
// Docs: https://wap.kbzpay.com/pgw/uat/api/  (MMQR Payment)
// Design: docs/superpowers/specs/2026-08-20-kbzpay-mmqr-integration-design.md
//
// Pure module: no Supabase, no Next.js. Everything here is unit-testable.

export type KbzField = string | number | null | undefined | unknown;

/**
 * Step 1 of the KBZPay signature algorithm (§3.3).
 *
 * Flattens biz_content into the common params, drops sign/sign_type, drops
 * empty values, drops JSONArray/object fields (e.g. refund_info), sorts by
 * ASCII, and joins as k=v&k=v.
 *
 * MUST sort with the default comparator, which compares UTF-16 code units.
 * localeCompare() is wrong here: the callback's `Wallet_identifier` has a
 * capital W and must sort ahead of every lowercase key.
 */
export function buildStringA(input: Record<string, KbzField>): string {
  const flat: Record<string, string> = {};

  const absorb = (obj: Record<string, KbzField>) => {
    for (const [key, value] of Object.entries(obj)) {
      if (key === "sign" || key === "sign_type") continue;
      if (key === "biz_content" && value && typeof value === "object" && !Array.isArray(value)) {
        absorb(value as Record<string, KbzField>);
        continue;
      }
      if (value === null || value === undefined) continue;
      if (typeof value === "object") continue; // JSONArray / nested object
      const str = String(value);
      if (str === "") continue;
      flat[key] = str;
    }
  };

  absorb(input);

  return Object.keys(flat)
    .sort() // ASCII / UTF-16 code unit order — NOT localeCompare
    .map((k) => `${k}=${flat[k]}`)
    .join("&");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/payments/kbzpay-sign.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/kbzpay.ts src/__tests__/payments/kbzpay-sign.test.ts
git commit -m "feat(kbzpay): build signature stringA against published doc vectors"
```

---

## Task 2: `sign()` and `verifySign()`

**Files:**
- Modify: `src/lib/kbzpay.ts`
- Test: `src/__tests__/payments/kbzpay-sign.test.ts`

- [ ] **Step 1: Generate a fixed hash vector**

The docs mask the app key, so their published `sign` values cannot be reproduced. Generate one
fixed vector with our own key and paste the result into the test — this pins the hash step
without the test re-implementing it.

Run:

```bash
node -e "const c=require('crypto');console.log(c.createHash('sha256').update('a=1&b=2&key=testkey0123456789abcdef').digest('hex').toUpperCase())"
```

Copy the 64-character output into `EXPECTED_SIGN` below.

- [ ] **Step 2: Write the failing test (append to the same file)**

```ts
import { sign, verifySign } from "@/lib/kbzpay";

const KEY = "testkey0123456789abcdef";
// Output of the node one-liner in Task 2 Step 1.
const EXPECTED_SIGN = "<paste the 64-char uppercase hex here>";

describe("sign", () => {
  it("appends &key= and returns uppercase hex SHA256", () => {
    expect(sign({ a: "1", b: "2" }, KEY)).toBe(EXPECTED_SIGN);
    expect(sign({ a: "1", b: "2" }, KEY)).toMatch(/^[0-9A-F]{64}$/);
  });
});

describe("verifySign", () => {
  const payload = {
    merch_order_id: "KBZ_1a2b3c4d_9f3c7b21d0e4a856",
    total_amount: "40000",
    trans_currency: "MMK",
    trade_status: "PAY_SUCCESS",
    Wallet_identifier: "MCB",
    sign_type: "SHA256",
  };

  it("accepts a correctly signed payload", () => {
    const signed = { ...payload, sign: sign(payload, KEY) };
    expect(verifySign(signed, KEY)).toBe(true);
  });

  // The docs state KBZPay may add fields and that extension fields must be
  // supported when verifying. A hardcoded field list would break every callback
  // the day they add one (§3.3).
  it("accepts a payload carrying an unknown extension field", () => {
    const extended = { ...payload, some_future_field: "whatever" };
    const signed = { ...extended, sign: sign(extended, KEY) };
    expect(verifySign(signed, KEY)).toBe(true);
  });

  it("rejects a payload whose amount was tampered with", () => {
    const signed = { ...payload, sign: sign(payload, KEY) };
    expect(verifySign({ ...signed, total_amount: "1" }, KEY)).toBe(false);
  });

  it("rejects a missing or malformed signature without throwing", () => {
    expect(verifySign({ ...payload }, KEY)).toBe(false);
    expect(verifySign({ ...payload, sign: "short" }, KEY)).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/__tests__/payments/kbzpay-sign.test.ts`
Expected: FAIL — `sign`/`verifySign` are not exported.

- [ ] **Step 4: Implement**

Append to `src/lib/kbzpay.ts`:

```ts
import { createHash, timingSafeEqual } from "crypto";

/** SHA256 (not HMAC) of stringA + "&key=" + appKey, uppercase hex (§3.3). */
export function sign(input: Record<string, KbzField>, appKey: string): string {
  const stringToSign = `${buildStringA(input)}&key=${appKey}`;
  // Never log stringToSign — it ends with the app key.
  return createHash("sha256").update(stringToSign, "utf8").digest("hex").toUpperCase();
}

/**
 * Verifies a signature over WHATEVER keys arrived — never a fixed list, so a
 * future KBZPay field cannot silently break verification (§3.3).
 */
export function verifySign(payload: Record<string, KbzField>, appKey: string): boolean {
  const received = payload.sign;
  if (typeof received !== "string" || received.length !== 64) return false;

  const expected = sign(payload, appKey);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received.toUpperCase(), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/__tests__/payments/kbzpay-sign.test.ts`
Expected: PASS — 11 tests total.

- [ ] **Step 6: Commit**

```bash
git add src/lib/kbzpay.ts src/__tests__/payments/kbzpay-sign.test.ts
git commit -m "feat(kbzpay): sign and verifySign with generic extension-field support"
```

---

## Task 3: `buildMerchOrderId()`

KBZPay allows only letters, digits and underscores, max 40. A timestamp suffix is not
collision-safe, and a duplicate `payment_ref` breaks settlement for both payments because the
webhooks resolve it with `.single()` (spec R1).

**Files:**
- Modify: `src/lib/kbzpay.ts`
- Test: `src/__tests__/payments/kbzpay-sign.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { buildMerchOrderId } from "@/lib/kbzpay";

describe("buildMerchOrderId", () => {
  const ENROLLMENT = "1a2b3c4d-5e6f-7788-99aa-bbccddeeff00";

  it("matches KBZPay's charset and length limit", () => {
    expect(buildMerchOrderId(ENROLLMENT)).toMatch(/^[A-Za-z0-9_]{1,40}$/);
  });

  it("keeps a recognisable enrollment prefix for support triage", () => {
    expect(buildMerchOrderId(ENROLLMENT)).toMatch(/^KBZ_1a2b3c4d_/);
  });

  it("never collides across repeated calls for the SAME enrollment", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(buildMerchOrderId(ENROLLMENT));
    expect(seen.size).toBe(10_000);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/payments/kbzpay-sign.test.ts`
Expected: FAIL — `buildMerchOrderId` is not exported.

- [ ] **Step 3: Implement**

```ts
import { randomBytes } from "crypto";

/**
 * KBZ_{8 hex of enrollment id}_{16 hex random} — 29 chars, 64 bits of entropy.
 * Randomness, not a timestamp: two requests for one enrollment in the same
 * millisecond would otherwise produce the same reference (R1).
 */
export function buildMerchOrderId(enrollmentId: string): string {
  const short = enrollmentId.replace(/-/g, "").slice(0, 8);
  return `KBZ_${short}_${randomBytes(8).toString("hex")}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/__tests__/payments/kbzpay-sign.test.ts`
Expected: PASS — 14 tests total.

- [ ] **Step 5: Commit**

```bash
git add src/lib/kbzpay.ts src/__tests__/payments/kbzpay-sign.test.ts
git commit -m "feat(kbzpay): collision-safe merch_order_id generation"
```

---

## Task 4: Transport — `precreate`, `queryOrder`, `closeOrder`

**Files:**
- Modify: `src/lib/kbzpay.ts`
- Test: `src/__tests__/payments/kbzpay-client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ENV = {
  KBZPAY_APPID: "kptest0000000000000000000000000000",
  KBZPAY_MERCH_CODE: "70000000001",
  KBZPAY_APP_KEY: "testkey0123456789abcdef",
  KBZPAY_MODE: "uat",
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  Object.assign(process.env, ENV);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function ok(body: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => ({ Response: body }) };
}

describe("precreate", () => {
  it("posts a signed PAY_BY_QRCODE order over HTTPS and returns the QR", async () => {
    const { precreate } = await import("@/lib/kbzpay");
    fetchMock.mockResolvedValue(
      ok({ result: "SUCCESS", code: "0", qrCode: "0002010102...", prepay_id: "KBZ00abc" }),
    );

    const res = await precreate({
      merchOrderId: "KBZ_1a2b3c4d_9f3c7b21d0e4a856",
      amount: 40000,
      title: "Payment for ENR-1",
      notifyUrl: "https://www.kuunyi.com/api/webhooks/kbzmmqr",
    });

    expect(res).toEqual({ ok: true, qrCode: "0002010102...", prepayId: "KBZ00abc" });

    const [url, init] = fetchMock.mock.calls[0];
    // Never plaintext, even though the UAT docs print http:// (§3.1, gate G2).
    expect(url).toMatch(/^https:\/\/api-uat\.kbzpay\.com\/payment\/gateway\/uat\/precreate$/);

    const body = JSON.parse(init.body).Request;
    expect(body.method).toBe("kbz.payment.precreate");
    expect(body.version).toBe("1.0");
    expect(body.biz_content.trade_type).toBe("PAY_BY_QRCODE");
    expect(body.biz_content.trans_currency).toBe("MMK");
    expect(body.biz_content.timeout_express).toBe("120m");
    expect(body.sign).toMatch(/^[0-9A-F]{64}$/);
    expect(body.nonce_str).toMatch(/^[A-Za-z0-9]{1,32}$/);
  });

  it("reports failure without throwing when result is FAIL", async () => {
    const { precreate } = await import("@/lib/kbzpay");
    fetchMock.mockResolvedValue(
      ok({ result: "FAIL", code: "ATHENTICATION_FAIL", msg: "merchant authentication fail." }),
    );
    const res = await precreate({
      merchOrderId: "KBZ_x_y", amount: 1, title: "t", notifyUrl: "https://x/y",
    });
    expect(res.ok).toBe(false);
  });

  it("reports failure on a non-2xx response", async () => {
    const { precreate } = await import("@/lib/kbzpay");
    fetchMock.mockResolvedValue({ ok: false, status: 502, text: async () => "bad gateway" });
    const res = await precreate({
      merchOrderId: "KBZ_x_y", amount: 1, title: "t", notifyUrl: "https://x/y",
    });
    expect(res.ok).toBe(false);
  });
});

describe("queryOrder", () => {
  it("uses version 3.0 and maps trade_status", async () => {
    const { queryOrder } = await import("@/lib/kbzpay");
    fetchMock.mockResolvedValue(
      ok({
        result: "SUCCESS", code: "0", trade_status: "PAY_SUCCESS",
        total_amount: "40000", trans_currency: "MMK",
        mm_order_id: "01003791060036848066", Wallet_identifier: "MCB",
      }),
    );

    const res = await queryOrder("KBZ_1a2b3c4d_9f3c7b21d0e4a856");

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).Request.version).toBe("3.0");
    expect(res).toMatchObject({
      ok: true, tradeStatus: "PAY_SUCCESS", totalAmount: "40000",
      transCurrency: "MMK", mmOrderId: "01003791060036848066", walletIdentifier: "MCB",
    });
  });

  it("reports order_not_found distinctly from other failures", async () => {
    const { queryOrder } = await import("@/lib/kbzpay");
    fetchMock.mockResolvedValue(
      ok({ result: "FAIL", code: "QUERYORDER_FAIL", msg: "The order does not exist." }),
    );
    const res = await queryOrder("KBZ_missing");
    expect(res).toMatchObject({ ok: true, tradeStatus: "ORDER_NOT_FOUND" });
  });
});

describe("closeOrder", () => {
  it("treats ORDER_ALREADY_CLOSED and QUERYORDER_FAIL as non-erroring", async () => {
    const { closeOrder } = await import("@/lib/kbzpay");
    for (const code of ["ORDER_ALREADY_CLOSED", "QUERYORDER_FAIL"]) {
      fetchMock.mockResolvedValue(ok({ result: "FAIL", code, msg: "x" }));
      expect((await closeOrder("KBZ_x")).ok).toBe(true);
    }
  });

  it("treats AOP03028 and SYSTEM_ERROR as genuine failures", async () => {
    const { closeOrder } = await import("@/lib/kbzpay");
    for (const code of ["AOP03028", "SYSTEM_ERROR", "FLOW_CONTROL"]) {
      fetchMock.mockResolvedValue(ok({ result: "FAIL", code, msg: "x" }));
      expect((await closeOrder("KBZ_x")).ok).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/payments/kbzpay-client.test.ts`
Expected: FAIL — the three functions are not exported.

- [ ] **Step 3: Implement**

Append to `src/lib/kbzpay.ts`. Note `closeOrder` returning `ok: true` means only "the call did
not error" — it is **never** proof the order went unpaid. §5.1 step 7b re-queries afterwards
(R12).

```ts
const APPID = () => process.env.KBZPAY_APPID!;
const MERCH_CODE = () => process.env.KBZPAY_MERCH_CODE!;
const APP_KEY = () => process.env.KBZPAY_APP_KEY!;

// Always HTTPS. The UAT docs print http:// for precreate and queryorder; sending
// merchant credentials in plaintext is not acceptable (§3.1, gate G2).
const BASE = () =>
  process.env.KBZPAY_MODE === "production"
    ? "https://api.kbzpay.com/payment/gateway"
    : "https://api-uat.kbzpay.com/payment/gateway/uat";

function nonce(): string {
  return randomBytes(16).toString("hex").toUpperCase();
}

async function call(
  path: string,
  method: string,
  version: string,
  bizContent: Record<string, KbzField>,
  extraCommon: Record<string, KbzField> = {},
): Promise<{ ok: boolean; body?: Record<string, KbzField>; code?: string; msg?: string }> {
  const request: Record<string, KbzField> = {
    timestamp: Math.floor(Date.now() / 1000).toString(),
    method,
    nonce_str: nonce(),
    sign_type: "SHA256",
    version,
    biz_content: bizContent,
    ...extraCommon,
  };
  request.sign = sign(request, APP_KEY());

  let res: Response;
  try {
    res = await fetch(`${BASE()}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Request: request }),
    });
  } catch (err) {
    console.error(`[kbzpay] ${method} transport error:`, err instanceof Error ? err.message : err);
    return { ok: false };
  }

  if (!res.ok) {
    console.error(`[kbzpay] ${method} HTTP ${res.status}`);
    return { ok: false };
  }

  const json = (await res.json()) as { Response?: Record<string, KbzField> };
  const body = json?.Response;
  if (!body) return { ok: false };

  // §3.5: check `result` first, then `code`, then business fields.
  const code = typeof body.code === "string" ? body.code : undefined;
  const msg = typeof body.msg === "string" ? body.msg : undefined;
  if (body.result !== "SUCCESS" || code !== "0") {
    // Never log the signing input — it ends with the app key.
    console.error(`[kbzpay] ${method} failed: code=${code} msg=${msg}`);
    return { ok: false, body, code, msg };
  }
  return { ok: true, body, code, msg };
}

export type PrecreateParams = {
  merchOrderId: string;
  amount: number;
  title: string;
  notifyUrl: string;
};

export async function precreate(
  p: PrecreateParams,
): Promise<{ ok: false } | { ok: true; qrCode: string; prepayId: string }> {
  const r = await call(
    "precreate",
    "kbz.payment.precreate",
    "1.0",
    {
      appid: APPID(),
      merch_code: MERCH_CODE(),
      merch_order_id: p.merchOrderId,
      trade_type: "PAY_BY_QRCODE",
      title: p.title,
      total_amount: String(p.amount),
      trans_currency: "MMK",
      timeout_express: "120m",
    },
    { notify_url: p.notifyUrl },
  );
  if (!r.ok || typeof r.body?.qrCode !== "string") return { ok: false };
  return {
    ok: true,
    qrCode: r.body.qrCode,
    prepayId: typeof r.body.prepay_id === "string" ? r.body.prepay_id : "",
  };
}

export type TradeStatus =
  | "PAY_SUCCESS" | "PAY_FAILED" | "WAIT_PAY" | "PAYING"
  | "ORDER_EXPIRED" | "ORDER_CLOSED" | "ORDER_NOT_FOUND";

export type QueryResult =
  | { ok: false }
  | {
      ok: true;
      tradeStatus: TradeStatus;
      totalAmount?: string;
      transCurrency?: string;
      mmOrderId?: string;
      walletIdentifier?: string;
    };

export async function queryOrder(merchOrderId: string): Promise<QueryResult> {
  const r = await call("queryorder", "kbz.payment.queryorder", "3.0", {
    appid: APPID(),
    merch_code: MERCH_CODE(),
    merch_order_id: merchOrderId,
  });

  // "The order does not exist" is an ANSWER, not a failure: it proves KBZPay
  // holds no order under this reference, which is what lets a row become
  // FAILED (R13).
  if (!r.ok && r.code === "QUERYORDER_FAIL") {
    return { ok: true, tradeStatus: "ORDER_NOT_FOUND" };
  }
  if (!r.ok || typeof r.body?.trade_status !== "string") return { ok: false };

  return {
    ok: true,
    tradeStatus: r.body.trade_status.trim() as TradeStatus,
    totalAmount: typeof r.body.total_amount === "string" ? r.body.total_amount : undefined,
    transCurrency: typeof r.body.trans_currency === "string" ? r.body.trans_currency : undefined,
    mmOrderId: typeof r.body.mm_order_id === "string" ? r.body.mm_order_id : undefined,
    walletIdentifier:
      typeof r.body.Wallet_identifier === "string" ? r.body.Wallet_identifier : undefined,
  };
}

/**
 * `ok: true` means only "the close call did not error". It is NOT proof the
 * order went unpaid — the caller MUST re-query afterwards (§5.1 step 7b, R12).
 */
export async function closeOrder(merchOrderId: string): Promise<{ ok: boolean }> {
  const r = await call("closeorder", "kbz.payment.closeorder", "3.0", {
    appid: APPID(),
    merch_code: MERCH_CODE(),
    merch_order_id: merchOrderId,
  });
  if (r.ok) return { ok: true };
  if (r.code === "ORDER_ALREADY_CLOSED" || r.code === "QUERYORDER_FAIL") return { ok: true };
  return { ok: false };
}

const kbzpay = { precreate, queryOrder, closeOrder, sign, verifySign, buildMerchOrderId };
export default kbzpay;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/__tests__/payments/kbzpay-client.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/kbzpay.ts src/__tests__/payments/kbzpay-client.test.ts
git commit -m "feat(kbzpay): precreate, queryOrder and closeOrder transport"
```

---

## Task 5: Migration — columns, indexes, order-slot functions

**Files:**
- Create: `supabase/migrations/20260820120000_kbzpay_mmqr.sql`

- [ ] **Step 1: Run the pre-migration duplicate check (spec §11, gate G6)**

The unique index sits on a column shared with ABank, MMPay and PayPay rows, so it fails if
duplicates already exist. **Read-only.** Run against dev, and ask the operator to run it
against production before this migration is promoted:

```sql
select payment_ref, count(*) from payments
 where payment_ref is not null group by 1 having count(*) > 1;
```

Expected: zero rows. If it returns rows, **stop** and reconcile them before continuing —
do not proceed with the migration.

- [ ] **Step 2: Write the migration**

Create `supabase/migrations/20260820120000_kbzpay_mmqr.sql`:

```sql
-- ─── KBZPay MMQR support ────────────────────────────────────────────────────
-- Design: docs/superpowers/specs/2026-08-20-kbzpay-mmqr-integration-design.md
--
-- No CREATE INDEX CONCURRENTLY: Postgres forbids it inside a transaction block
-- and no migration in this repo uses it (R6). Built non-concurrently it takes a
-- SHARE lock on payments for the duration — milliseconds at this table size.
-- Rollback: drop the two new indexes, recreate idx_payments_payment_ref.

BEGIN;

COMMENT ON COLUMN public.tenants.mmqr_provider IS
  'abank | mmpay | kbzpay — only used when payment_mode = mmqr';

-- R1: settlement resolves payment_ref with .single(); a duplicate breaks BOTH
-- payments, so uniqueness is a correctness requirement, not tidiness.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_payment_ref_unique
  ON public.payments (payment_ref)
  WHERE payment_ref IS NOT NULL;
DROP INDEX IF EXISTS idx_payments_payment_ref;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS provider_qr text,
  ADD COLUMN IF NOT EXISTS provider_order_expires_at timestamptz;

COMMENT ON COLUMN public.payments.provider_qr IS
  'MMQR/EMVCo payload returned by the provider, re-served on repeat requests';
COMMENT ON COLUMN public.payments.provider_order_expires_at IS
  'Local ESTIMATE of provider order expiry. A hint that triggers a queryorder check — never authority to free the slot (R8)';

-- R4: at most ONE live KBZPay order per enrollment, enforced by the database.
-- 'PENDING' is the liveness marker; SUCCESS/FAILED/EXPIRED/SUPERSEDED free it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_one_live_kbzpay_order
  ON public.payments (enrollment_id)
  WHERE payment_method = 'kbzpay_mmqr'
    AND status = 'awaiting_payment'
    AND mmqr_status = 'PENDING';

-- ── claim_kbzpay_order_slot ────────────────────────────────────────────────
-- Outcomes: 'reuse' | 'unresolved' | 'created'. Only 'created' writes.
-- 'reuse' is a NARROW allowlist (same amount AND non-null QR AND inside the
-- expiry hint); every other live row is 'unresolved' so no state can fall
-- between branches (R9, R13).
CREATE OR REPLACE FUNCTION public.claim_kbzpay_order_slot(
  p_enrollment_id uuid,
  p_tenant_id     uuid,
  p_payment_ref   text,
  p_amount        numeric,
  p_expires_at    timestamptz
)
RETURNS TABLE (outcome text, payment_id uuid, ref text, qr text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_live public.payments%ROWTYPE;
  v_new_id uuid;
BEGIN
  -- Serialise concurrent creators for this enrollment (R4).
  PERFORM 1 FROM public.enrollments WHERE id = p_enrollment_id FOR UPDATE;

  SELECT * INTO v_live
    FROM public.payments
   WHERE enrollment_id = p_enrollment_id
     AND payment_method = 'kbzpay_mmqr'
     AND status = 'awaiting_payment'
     AND mmqr_status = 'PENDING'
   LIMIT 1;

  IF FOUND THEN
    IF v_live.amount = p_amount
       AND v_live.provider_qr IS NOT NULL
       AND v_live.provider_order_expires_at IS NOT NULL
       AND v_live.provider_order_expires_at > now()
    THEN
      RETURN QUERY SELECT 'reuse'::text, v_live.id, v_live.payment_ref, v_live.provider_qr;
    ELSE
      RETURN QUERY SELECT 'unresolved'::text, v_live.id, v_live.payment_ref, NULL::text;
    END IF;
    RETURN;
  END IF;

  -- status MUST be 'awaiting_payment', never 'pending': the INSERT branch of
  -- trg_payments_sync_enrollment fires on 'pending' and would advance the
  -- enrollment to payment_submitted before a QR exists (migration 054).
  INSERT INTO public.payments (
    enrollment_id, tenant_id, amount, payment_ref, payment_method,
    mmqr_status, status, provider_order_expires_at
  ) VALUES (
    p_enrollment_id, p_tenant_id, p_amount, p_payment_ref, 'kbzpay_mmqr',
    'PENDING', 'awaiting_payment', p_expires_at
  )
  RETURNING id INTO v_new_id;

  RETURN QUERY SELECT 'created'::text, v_new_id, p_payment_ref, NULL::text;
END;
$$;

-- ── complete_kbzpay_supersede ──────────────────────────────────────────────
-- Outcomes: 'replaced' | 'already_settled' | 'not_live' | 'not_found'.
-- Retires a PROVEN-DEAD old order and inserts its replacement atomically (R7).
CREATE OR REPLACE FUNCTION public.complete_kbzpay_supersede(
  p_enrollment_id    uuid,
  p_tenant_id        uuid,
  p_expected_old_ref text,
  p_reason           text,
  p_new_ref          text,
  p_amount           numeric,
  p_expires_at       timestamptz
)
RETURNS TABLE (outcome text, payment_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old public.payments%ROWTYPE;
  v_new_id uuid;
BEGIN
  IF p_reason NOT IN ('FAILED', 'EXPIRED', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'invalid reason: %', p_reason;
  END IF;

  PERFORM 1 FROM public.enrollments WHERE id = p_enrollment_id FOR UPDATE;

  SELECT * INTO v_old
    FROM public.payments
   WHERE enrollment_id = p_enrollment_id
     AND payment_ref = p_expected_old_ref
     AND payment_method = 'kbzpay_mmqr'
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid;
    RETURN;
  END IF;

  -- A callback settled it between the provider query and now (R7/R11).
  IF v_old.status = 'verified' THEN
    RETURN QUERY SELECT 'already_settled'::text, v_old.id;
    RETURN;
  END IF;

  -- Someone else already retired it; the caller re-claims rather than assuming.
  IF v_old.mmqr_status IS DISTINCT FROM 'PENDING' THEN
    RETURN QUERY SELECT 'not_live'::text, v_old.id;
    RETURN;
  END IF;

  UPDATE public.payments SET mmqr_status = p_reason WHERE id = v_old.id;

  INSERT INTO public.payments (
    enrollment_id, tenant_id, amount, payment_ref, payment_method,
    mmqr_status, status, provider_order_expires_at
  ) VALUES (
    p_enrollment_id, p_tenant_id, p_amount, p_new_ref, 'kbzpay_mmqr',
    'PENDING', 'awaiting_payment', p_expires_at
  )
  RETURNING id INTO v_new_id;

  RETURN QUERY SELECT 'replaced'::text, v_new_id;
END;
$$;

-- Service-role only, matching 20260719100000_restrict_enrollment_rpc_privileges.sql.
-- These functions insert payments; anon/authenticated must never reach them.
REVOKE ALL ON FUNCTION public.claim_kbzpay_order_slot(uuid, uuid, text, numeric, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_kbzpay_order_slot(uuid, uuid, text, numeric, timestamptz)
  TO service_role;

REVOKE ALL ON FUNCTION public.complete_kbzpay_supersede(uuid, uuid, text, text, text, numeric, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_kbzpay_supersede(uuid, uuid, text, text, text, numeric, timestamptz)
  TO service_role;

COMMIT;
```

- [ ] **Step 3: Validate the migration against a local database**

`supabase db diff` is the wrong instrument here: it detects *drift* between a database and the
migration files, which is how you capture manual DB edits into a migration. It does not preview
a hand-written migration. The SQL file is the diff; validation means executing it.

```bash
npx supabase start
npx supabase migration up --local
```

Expected: applies cleanly. **Do not use `npm run db:migrate`** — see the warning in the command
table above; it pushes to the linked project, which is production.

If `migration up --local` fails on an *earlier* migration because the local database has
drifted (objects present but absent from `supabase_migrations.schema_migrations`), apply this
migration directly instead — it is idempotent throughout:

```bash
docker exec -i supabase_db_EduEnroll psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -f - < supabase/migrations/20260820120000_kbzpay_mmqr.sql
```

Then verify the objects, and confirm EXECUTE is granted to `service_role` **only**.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260820120000_kbzpay_mmqr.sql
git commit -m "feat(kbzpay): schema, live-order slot index and order-slot functions"
```

---

## Task 6: Database tests for the order-slot functions

These are the tests that mocks cannot substitute for: the guarantees are a row lock and a
partial unique index, neither of which exists in a mock (R4).

**Files:**
- Test: `src/__tests__/db/kbzpay-order-slot.db.test.ts`

- [ ] **Step 1: Write the failing tests**

Follow the existing structure in `src/__tests__/db/stripe-settlement.db.test.ts` for
connection setup and fixture creation.

```ts
import { describe, it, expect, beforeEach } from "vitest";
// Reuse this suite's existing helpers for a pooled client and seeded tenant /
// enrollment fixtures — see stripe-settlement.db.test.ts.

describe("claim_kbzpay_order_slot", () => {
  it("returns created and inserts one PENDING row when none exists", async () => {
    // expect outcome 'created', one row, status awaiting_payment, mmqr_status PENDING
  });

  it("returns reuse only when amount, QR and expiry all match", async () => {
    // seed a live row WITH provider_qr and a future expiry -> 'reuse'
  });

  it("returns unresolved when the QR is null even if the amount matches (R13)", async () => {
    // seed live row, provider_qr = NULL, same amount -> 'unresolved', NOT 'created'
    // This exact state matched no branch before R13 and produced a 502.
  });

  it("returns unresolved when the amount differs (R5)", async () => {});

  it("returns unresolved when past provider_order_expires_at, even at same amount (R9)", async () => {
    // Staleness must shadow reuse, or an expired QR is re-served indefinitely.
  });

  it("inserts with awaiting_payment so the enrollment is NOT advanced (migration 054)", async () => {
    // assert enrollments.status is unchanged after the claim
  });

  it("permits only ONE live order per enrollment under concurrency (R4)", async () => {
    // Fire two claims concurrently with different refs via Promise.all.
    // Exactly one 'created'; the other must not create a second live row.
    // Assert count of live kbzpay rows for the enrollment === 1.
  });

  // P1 review: the route's guard is a TOCTOU check. These prove the function
  // defends itself, since it is SECURITY DEFINER and inserts payments rows.
  it("returns invalid_enrollment for a mismatched tenant and inserts nothing", async () => {});

  it("returns invalid_enrollment for a rejected/confirmed/cancelled enrollment", async () => {
    // Parameterise over every enrollment_status except pending_payment and
    // partial_payment. Assert no payments row is created for any of them.
  });

  it("fails closed when the enrollment is rejected concurrently", async () => {
    // Begin a transaction that sets the enrollment to 'rejected' but does not
    // commit; call the claim; commit the rejection. Under READ COMMITTED,
    // FOR UPDATE re-evaluates the predicate after the lock, so the claim must
    // return invalid_enrollment rather than inserting.
  });

  it("attributes the payment to the enrollment's own tenant_id", async () => {
    // The INSERT uses the tenant read from the locked enrollment row, not the
    // p_tenant_id argument.
  });
});

describe("complete_kbzpay_supersede", () => {
  it("retires the old row and inserts the replacement atomically", async () => {
    // outcome 'replaced'; old mmqr_status = 'SUPERSEDED'; exactly one PENDING row
  });

  it("reports already_settled and inserts nothing when the old row is verified (R7)", async () => {
    // Set the old payment to verified first, then call. Assert NO new row exists.
  });

  it("reports not_live when the old row was already retired", async () => {});

  it("rejects an invalid reason", async () => {
    // expect the call to reject
  });

  it("returns invalid_enrollment and leaves the old row PENDING (P1 review)", async () => {
    // Enrollment rejected between the claim and this call — the window here is
    // wider, since the route makes one or two KBZPay round trips in between.
    // Assert: no new row, and the OLD row is still PENDING (not retired).
  });

  it("frees the slot for every terminal reason", async () => {
    // FAILED / EXPIRED / SUPERSEDED each allow a subsequent 'created'
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --config vitest.db.config.ts src/__tests__/db/kbzpay-order-slot.db.test.ts`
Expected: FAIL. If it fails because `.env.test.local` is missing the DB variables, fix that
first — the suite refuses to skip on purpose, because a skipped integration suite reports
green and proves nothing.

- [ ] **Step 3: Fill in the test bodies and make them pass**

The functions already exist from Task 5, so this task is about writing real assertions rather
than new implementation. Fix the migration if a test exposes a defect.

- [ ] **Step 4: Run the whole DB suite for regressions**

Run: `npm run test:db`
Expected: PASS, including the pre-existing seat-restoration and stripe suites.

- [ ] **Step 5: Commit**

```bash
git add src/__tests__/db/kbzpay-order-slot.db.test.ts
git commit -m "test(kbzpay): real-database tests for order-slot concurrency and lifecycle"
```

---

## Task 7: `settleMmqrPayment()`

**Files:**
- Create: `src/server/payments/settleMmqrPayment.ts`
- Test: `src/__tests__/payments/kbzpay-settle.test.ts`

- [ ] **Step 1: Write the failing test**

Mock `@/lib/supabase/admin` following `src/__tests__/payments/abank-callback-route.test.ts`.

```ts
describe("settleMmqrPayment", () => {
  it("refuses to settle when the currency is not MMK (R3)", async () => {
    // observedCurrency 'USD' -> kind 'currency_mismatch', NO payment update
  });

  it("checks currency BEFORE the amount comparison", async () => {
    // currency USD AND a matching amount -> still currency_mismatch
  });

  it("refuses when the amount does not match the stored snapshot", async () => {
    // -> 'amount_mismatch', no update
  });

  it("settles a matching payment and issues tickets", async () => {
    // -> 'settled'; payments.status -> 'verified'; issueTickets called once
  });

  it("NEVER writes enrollments.status — the trigger owns that", async () => {
    // assert no update was issued against the enrollments table
  });

  it("returns already_settled when the conditional update affects zero rows", async () => {
    // and does NOT notify again
  });

  it("returns not_found for an unknown payment_ref", async () => {});

  it("returns retryable when fulfilment throws after settlement", async () => {});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/payments/kbzpay-settle.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Model the contract on `src/server/payments/settlePaidPayment.ts`. Key requirements from §6:

```ts
export type SettleMmqrInput = {
  paymentRef: string;
  observedAmount: number;
  observedCurrency: string | null;
  mmOrderId?: string | null;
  walletIdentifier?: string | null;
  source: "callback" | "status" | "create";
};

export type SettleMmqrOutcome =
  | { kind: "settled"; paymentId: string; enrollmentId: string }
  | { kind: "already_settled"; paymentId: string; enrollmentId: string }
  | { kind: "amount_mismatch" }
  | { kind: "currency_mismatch" }
  | { kind: "not_found" }
  | { kind: "retryable"; reason: string };
```

Order of operations, which is load-bearing:

1. **Currency first.** `observedCurrency !== "MMK"` → `currency_mismatch`. An amount is
   meaningless without its currency (R3).
2. Load the payment by `payment_ref`; absent → `not_found`.
3. Compare `observedAmount` to the stored `payments.amount` **snapshot** — never a figure
   recomputed from current class or tenant config. Mismatch → `amount_mismatch`.
4. Conditional update: `.eq("id", …).in("status", ["awaiting_payment", "pending"])` setting
   `status: 'verified'`, `mmqr_status: 'SUCCESS'`, `paid_at`, `bank_reference: mmOrderId`,
   `payer_institution: walletIdentifier`. Zero rows → reload; if now `verified`, return
   `already_settled`.
5. **Never update `enrollments.status`.** `trg_payments_sync_enrollment` confirms it in the
   same statement.
6. `issueTicketsForEnrollment(enrollmentId)` then, **only for `settled`**,
   `notifyEnrollmentConfirmed(enrollmentId)`. A throw here → `retryable`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/__tests__/payments/kbzpay-settle.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/payments/settleMmqrPayment.ts src/__tests__/payments/kbzpay-settle.test.ts
git commit -m "feat(kbzpay): settleMmqrPayment with currency and snapshot guards"
```

---

## Task 8: `resolveKbzpayOrder()` — the §5.1 step 7 procedure

Every one of the spec's eight wrong-statement findings lived in this procedure. Test it
exhaustively as a function.

**Files:**
- Create: `src/server/payments/resolveKbzpayOrder.ts`
- Test: `src/__tests__/payments/kbzpay-resolve.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("resolveKbzpayOrder", () => {
  it("settles and reports already_paid when the first query says PAY_SUCCESS", async () => {
    // no closeOrder call, no replacement
  });

  it("reports reason FAILED when the provider has no such order (R13)", async () => {
    // ORDER_NOT_FOUND -> the ONLY path that may mark a row FAILED
  });

  it("reports reason EXPIRED for a terminal unpaid status", async () => {
    // ORDER_EXPIRED / ORDER_CLOSED / PAY_FAILED
  });

  it("closes then RE-QUERIES when the order is still payable (R12)", async () => {
    // WAIT_PAY -> closeOrder called -> queryOrder called a SECOND time
    expect(queryOrder).toHaveBeenCalledTimes(2);
  });

  it("settles instead of superseding when the re-query says PAY_SUCCESS (R12)", async () => {
    // WAIT_PAY, then close ok, then PAY_SUCCESS on re-query.
    // -> already_paid, NO replacement created. This is the race that re-opens
    //    R5's over-collection.
  });

  it("fails closed when the re-query still says WAIT_PAY (R12)", async () => {
    // the close did not take effect -> failure, slot NOT freed
  });

  it("fails closed when closeOrder genuinely errors", async () => {
    // no re-query, no supersede
  });

  it("never treats a closeOrder return code as proof of retirement (R12)", async () => {
    // closeOrder ok:true but re-query WAIT_PAY -> must NOT supersede
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/payments/kbzpay-resolve.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```ts
export type ResolveOutcome =
  | { kind: "already_paid" }
  | { kind: "settlement_conflict"; reason: "amount_mismatch" | "currency_mismatch" }
  | { kind: "retire"; reason: "FAILED" | "EXPIRED" | "SUPERSEDED" }
  | { kind: "blocked"; reason: string };
```

Implements §5.1 step 7 exactly:

1. `queryOrder(oldRef)`.
   - `PAY_SUCCESS` → `settleMmqrPayment({ source: "create", … })`. `settled` /
     `already_settled` → `already_paid`; `amount_mismatch` / `currency_mismatch` →
     `settlement_conflict`; anything else → `blocked`.
   - `ORDER_NOT_FOUND` → `retire` with reason `FAILED`.
   - `ORDER_EXPIRED` / `ORDER_CLOSED` / `PAY_FAILED` → `retire` with reason `EXPIRED`.
   - `WAIT_PAY` / `PAYING` → step 2.
   - `ok: false` → `blocked`.
2. `closeOrder(oldRef)`; `ok: false` → `blocked`.
3. **Re-query, always.** Branch on the provider's answer, never the close return code:
   `PAY_SUCCESS` → settle → `already_paid`; terminal unpaid → `retire` with reason
   `SUPERSEDED`; still `WAIT_PAY`/`PAYING` → `blocked`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/__tests__/payments/kbzpay-resolve.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/payments/resolveKbzpayOrder.ts src/__tests__/payments/kbzpay-resolve.test.ts
git commit -m "feat(kbzpay): order resolve procedure with mandatory post-close re-query"
```

---

## Task 9: Creation route

**Files:**
- Create: `src/app/api/public/payments/kbzpay/route.ts`
- Test: `src/__tests__/payments/kbzpay-create-route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("POST /api/public/payments/kbzpay", () => {
  it("returns 404 for an unknown enrollment and 409 when not awaiting payment", async () => {});

  it("claims, precreates, then stores the QR — in that order (R2)", async () => {
    // Assert the claim RPC resolved BEFORE fetch was called.
  });

  it("never calls KBZPay when the claim fails", async () => {
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the stored QR on reuse without calling KBZPay", async () => {});

  it("leaves the row PENDING when precreate fails — never FAILED (R13)", async () => {
    // 502; assert no update set mmqr_status to 'FAILED';
    // assert enrollments.status untouched (the 'rejected' cascade guard)
  });

  it("leaves the row PENDING when the provider_qr write fails (R13)", async () => {
    // 502; row stays PENDING with a null QR so the next request can recover
  });

  it("returns { status: 'already_paid' } from all three branches (R10, R11, R12)", async () => {
    // parameterised: first query PAY_SUCCESS; re-query PAY_SUCCESS;
    // complete_kbzpay_supersede reports already_settled
  });

  it("returns 409 on a settlement conflict rather than a QR", async () => {});

  it("returns { status: 'created', qr, orderId, amount } on the happy path", async () => {});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/payments/kbzpay-create-route.test.ts`
Expected: FAIL — route does not exist.

- [ ] **Step 3: Implement**

Follow `src/app/api/public/payments/abank/route.ts` for tenant resolution, enrollment lookup,
the cart/class fee calculation and the partial-payment adjustment. Then §5.1 steps 5–12:

1. `resolveTenantId()`, validate `enrollmentRef`, load the enrollment (404), guard status (409).
2. Compute the fee exactly as the ABank route does.
3. `buildMerchOrderId(enrollment.id)`; `expiresAt = now + 120 min`.
4. Call `claim_kbzpay_order_slot` via `supabase.rpc(...)`.
   - `invalid_enrollment` → **409**. The enrollment stopped being a legal payment target
     between the route's guard and the function's lock — a rejection, an auto-cancellation,
     or a tenant mismatch. Never retry and never call KBZPay (P1 review).
   - `reuse` → `{ status: 'created', qr, orderId, amount }` from the stored row, no KBZPay call.
   - `unresolved` → `resolveKbzpayOrder()`, then:
     - `already_paid` → `{ status: 'already_paid' }` (200)
     - `settlement_conflict` → 409
     - `blocked` → 502
     - `retire` → `complete_kbzpay_supersede(...)`; `already_settled` →
       `{ status: 'already_paid' }` (R11); `not_live` → re-claim once; `invalid_enrollment` →
       **409**, leaving the old row PENDING (P1 review); `replaced` → continue.
   - `created` → continue.
5. `notifyUrl = notifyOrigin() + "/api/webhooks/kbzmmqr"`. **Never** from the inbound `Host`.
6. `precreate(...)`. On failure → 502, **leave the row `PENDING`** (R13).
7. Update `provider_qr` and re-anchor `provider_order_expires_at` to the response time + 120
   min. On failure → 502, row stays `PENDING`.
8. `{ status: 'created', qr, orderId, amount }`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/__tests__/payments/kbzpay-create-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/public/payments/kbzpay/route.ts src/__tests__/payments/kbzpay-create-route.test.ts
git commit -m "feat(kbzpay): QR creation route with slot claim and ambiguous-state recovery"
```

---

## Task 10: Webhook route

**Files:**
- Create: `src/app/api/webhooks/kbzmmqr/route.ts`
- Test: `src/__tests__/payments/kbzpay-webhook-route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("POST /api/webhooks/kbzmmqr", () => {
  it("returns 403 and does not settle when the signature is invalid", async () => {});

  it("returns 404 when the payment_ref is unknown, so KBZPay retries", async () => {});

  it("CONFIRMS via queryOrder before settling — a valid signature alone is not enough", async () => {
    expect(queryOrder).toHaveBeenCalledWith("KBZ_...");
  });

  it("settles once and returns the literal body 'success'", async () => {
    expect(await res.text()).toBe("success");
  });

  it("returns 'success' on a duplicate callback without notifying again", async () => {});

  it("returns 500 when queryOrder is unreachable or not PAY_SUCCESS", async () => {});

  it("returns 200 'success' on amount or currency mismatch — a retry cannot fix it", async () => {});

  it("returns 500 when fulfilment fails after settlement", async () => {});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/payments/kbzpay-webhook-route.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Per §5.2 and the §8 callback table. Two things to get exactly right:

- The success body is the **literal string** `success`, not JSON:
  `new NextResponse("success", { status: 200 })`. Anything else and KBZPay retries.
- `verifySign` runs against the parsed `Request` object, and settlement is decided by
  `queryOrder`, not by the callback body (§7).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/__tests__/payments/kbzpay-webhook-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/webhooks/kbzmmqr/route.ts src/__tests__/payments/kbzpay-webhook-route.test.ts
git commit -m "feat(kbzpay): signed callback receiver with server-side confirmation"
```

---

## Task 11: Status route

**Files:**
- Create: `src/app/api/public/payments/kbzpay/status/route.ts`
- Test: `src/__tests__/payments/kbzpay-status-route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("GET /api/public/payments/kbzpay/status", () => {
  it("returns mmqr_status so the existing modal poller understands it", async () => {
    // The modal reads data.mmqr_status — see QRPaymentModal.startPolling.
  });

  it("self-heals a missed callback by settling on PAY_SUCCESS", async () => {});

  it("does not settle for WAIT_PAY or PAYING", async () => {});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/payments/kbzpay-status-route.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Mirror `src/app/api/public/payments/abank/status/route.ts`. Call `queryOrder`, map
`trade_status` onto the `mmqr_status` shape the modal already polls for, and call
`settleMmqrPayment({ source: "status" })` on `PAY_SUCCESS` so the poller is a genuine recovery
path rather than a read-only display (§5.3).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/__tests__/payments/kbzpay-status-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/public/payments/kbzpay/status/route.ts src/__tests__/payments/kbzpay-status-route.test.ts
git commit -m "feat(kbzpay): status route with missed-callback self-healing"
```

---

## Task 12: Client wiring — modal, admin settings, checkout

**Files:**
- Modify: `src/components/payments/QRPaymentModal.tsx:9` (union), `:35` (endpoint map), `:141-165` (create effect)
- Modify: `src/app/admin/settings/page.tsx:529` and the provider selector around `:1363`
- Modify: `src/app/(public)/enroll/[slug]/checkout/payment/page.tsx`
- Test: `src/__tests__/payments/kbzpay-modal.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
describe("QRPaymentModal — already_paid (R10)", () => {
  it("renders success, calls onSuccess, and starts NO poller", async () => {
    // POST resolves { status: 'already_paid' }
    // Assert onSuccess called once AND no request to /status was ever issued.
    // The pre-fix behaviour polls ref=undefined for 10 minutes, so asserting on
    // the ABSENCE of that request is what makes this test meaningful.
  });

  it("still renders the QR and polls for a response with no status field", async () => {
    // Regression guard for ABank / MMPay / PayPay, which never send `status`.
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/payments/kbzpay-modal.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `QRPaymentModal.tsx`:

- Add `"kbzpay"` to `QRProvider` and to the `apiBase` map
  (`provider === "kbzpay" ? "/api/public/payments/kbzpay" : …`).
- In the create effect, **before** touching `data.qr`:

```ts
if (data.status === "already_paid") {
  setState("success");
  onSuccess();
  return;                 // no QR render, no poller
}
```

- KBZPay header branding and instruction copy ("scan with any Myanmar banking app" — the MMQR
  string is scannable by any bank app, which is the reason for this provider).

In `admin/settings/page.tsx`: widen the `mmqrProvider` union to
`"abank" | "mmpay" | "kbzpay"` and add the third option to the selector.

In the checkout payment page: pass `provider="kbzpay"` when
`tenant.mmqr_provider === "kbzpay"`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/__tests__/payments/kbzpay-modal.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/payments/QRPaymentModal.tsx src/app/admin/settings/page.tsx "src/app/(public)/enroll/[slug]/checkout/payment/page.tsx" src/__tests__/payments/kbzpay-modal.test.tsx
git commit -m "feat(kbzpay): wire provider into modal, admin settings and checkout"
```

---

## Task 13: MSW handlers, E2E, and full verification

**Files:**
- Modify: `src/mocks/handlers.ts`
- Modify: `e2e/checkout.spec.ts`

- [ ] **Step 1: Add MSW handlers**

Handlers for `precreate`, `queryorder` and `closeorder` on `api-uat.kbzpay.com`, returning
correctly **signed** responses using the test app key — an unsigned mock would let a broken
`verifySign` pass.

- [ ] **Step 2: Extend the E2E spec**

Add a `kbzpay` tenant path asserting the QR renders and the modal reaches the confirmed state.

Run: `npm run test:e2e`
Expected: PASS.

- [ ] **Step 3: Full verification — do not skip any of these**

```bash
npm test
```
Expected: PASS, entire unit suite, no regressions in the ABank / MMPay / PayPay / Stripe tests.

```bash
npm run test:db
```
Expected: PASS.

```bash
npm run lint
```
Expected: clean.

```bash
npm run build
```
Expected: **exit code 0.** Judge by the exit code, not by output text.

- [ ] **Step 4: Commit**

```bash
git add src/mocks/handlers.ts e2e/checkout.spec.ts
git commit -m "test(kbzpay): MSW handlers and end-to-end checkout coverage"
```

---

## Task 14: Operator gates — do not skip before production

These are the spec's §11 gates. Implementation is complete without them, but the provider must
not go live until each is closed. Record the outcome of each in the PR description.

- [ ] **G1** — KBZPay UAT credentials issued; run one real `precreate` → scan → callback →
      settle cycle against UAT. This is the only thing mocks cannot prove, and the order
      lifecycle is where all thirteen review findings lived.
- [ ] **G2** — Confirm HTTPS works on `api-uat.kbzpay.com`. The docs print `http://` for
      `precreate` and `queryorder`. If KBZPay genuinely serves UAT over HTTP only, raise it
      with them before a real app key is used anywhere.
- [ ] **G3** — Register the production `notify_url` with KBZPay; confirm whether they require
      IP allowlisting.
- [ ] **G4** — Production `notify_url` must be `https://www.kuunyi.com/api/webhooks/kbzmmqr`.
      The apex domain 307-redirects and redirects break POST callbacks.
- [ ] **G5** — Confirm the MMK decimal convention for `total_amount`. Adjust the amount
      comparison in `settleMmqrPayment` if KBZPay sends decimals.
- [ ] **G6** — The `payment_ref` duplicate check must have passed on **production** as well as
      dev before this migration is promoted (Task 5, Step 1).
- [ ] Set `KBZPAY_*` production env vars in Vercel using `printf`, never `echo` — `echo`
      appends a newline and would break every signature.

- [ ] **Final step: open a PR to `dev` for human review.** Do not merge it yourself.

---

## Notes for the implementer

**Where the risk actually is.** Tasks 5–9 are the order lifecycle. Thirteen review findings,
eight of them corrections of statements that were actively wrong, all landed in that area —
and four of those eight were defects introduced by the fix for an earlier finding. Work
slowly there, and prefer removing a distinction over adding a branch if something does not fit.

**If you find yourself adding a fourth claim outcome, stop.** The contract is deliberately
`reuse | unresolved | created`, where `reuse` is a narrow allowlist and everything else asks
KBZPay. Revisions 4–6 of the spec split it three ways and produced a defect each time,
because each new branch created a state that could fall between the others.

**The two invariants worth re-reading before every task in 5–11:**

1. No terminal `mmqr_status` transition and no slot release without a `queryorder` answer.
2. No `settleMmqrPayment()` result object reaches the browser.
