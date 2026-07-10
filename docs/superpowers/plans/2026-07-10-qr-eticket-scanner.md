# QR E-Ticket + kuunyi-scanner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed a signed Ed25519 JWT QR in each per-admission e-ticket, and expose `POST /api/scans` and `GET /api/events` for the kuunyi-scanner app.

**Architecture:** A new `tickets` table holds one row per admission, materialized idempotently when an enrollment is confirmed. Tickets are signed on demand into EdDSA JWTs (Node `crypto`, no new dep) and rendered as QR codes client-side. Scanner endpoints authenticate with a per-tenant Bearer key (hashed at rest) and resolve tenant from the key, independent of host.

**Tech Stack:** Next.js App Router, Supabase (service-role admin client), Node `crypto` (Ed25519), `qrcode`, `jspdf`/`html2canvas`, vitest.

**Spec:** `docs/superpowers/specs/2026-07-10-qr-eticket-scanner-design.md`

---

## File Structure

**Create:**
- `supabase/migrations/088_tickets_and_scanner_keys.sql` — `tickets` + `scanner_api_keys` tables.
- `src/lib/tickets/exp.ts` — event-day expiry computation.
- `src/lib/tickets/sign.ts` — `signTicketJwt` / `verifyTicketJwt` (EdDSA).
- `src/lib/tickets/keys.ts` — load signing key + kid from env; export public key (base64url).
- `src/lib/scanner/apiKey.ts` — hash + `resolveScannerTenant(request)`.
- `src/server/tickets/issueTickets.ts` — `issueTicketsForEnrollment` / `voidTicketsForEnrollment`.
- `src/app/api/events/route.ts` — `GET /api/events`.
- `src/app/api/scans/route.ts` — `POST /api/scans`.
- `scripts/generate-ticket-key.ts` — one-off keypair generator (prints public key).
- `scripts/create-scanner-key.ts` — mint a scanner API key for a tenant (dev/ops).
- Tests under `src/__tests__/tickets/` and `src/__tests__/scanner/`.

**Modify:**
- `src/types/database.ts` — add `Ticket`, `ScannerApiKey` interfaces.
- `src/server/payments/verifyPayment.ts` — call `issueTicketsForEnrollment` after confirm.
- `src/app/api/webhooks/{abank,hitpay,mmpay,paypay,stripe}/route.ts` — same call after confirm.
- `src/app/api/public/enrollment/[ref]/route.ts` — include `tickets[]` (with `jwt`) when confirmed.
- `src/app/(public)/enroll/[slug]/checkout/success/page.tsx` — one e-ticket + QR per ticket; multi-page PDF.
- `src/middleware.ts` — add `/api/events`, `/api/scans` to skip-tenant routes.

**Conventions:** vitest, run a single file with `npx vitest run <path>`. Public/scanner routes use `createAdminClient()` from `src/lib/supabase/admin.ts`. Follow the Supabase cast pattern `as unknown as Promise<{ data: T; error: unknown }>` where needed.

---

## Task 1: Migration — tickets + scanner_api_keys

**Files:**
- Create: `supabase/migrations/088_tickets_and_scanner_keys.sql`
- Modify: `src/types/database.ts`

- [ ] **Step 1: Write the migration**

```sql
-- tickets: one row per admission
create table if not exists public.tickets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  intake_id uuid not null references public.intakes(id) on delete cascade,
  enrollment_id uuid not null references public.enrollments(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  tier text not null,
  admits int not null default 1,
  exp timestamptz not null,
  kid text not null,
  status text not null default 'valid',
  first_scan_at timestamptz,
  first_scan_gate text,
  created_at timestamptz not null default now()
);
create index if not exists tickets_tenant_intake_idx on public.tickets (tenant_id, intake_id);
create index if not exists tickets_enrollment_idx on public.tickets (enrollment_id);

-- scanner_api_keys: per-tenant bearer keys (hashed)
create table if not exists public.scanner_api_keys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  key_hash text not null unique,
  key_prefix text not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists scanner_api_keys_hash_idx on public.scanner_api_keys (key_hash);

alter table public.tickets enable row level security;
alter table public.scanner_api_keys enable row level security;
-- No policies: access is service-role only (createAdminClient bypasses RLS).
```

- [ ] **Step 2: Show the diff, then apply to dev only**

Run: `git --no-pager diff --stat` then apply via the documented dev flow (`npx supabase db push` against dev — confirm the target ref is `fnfvwzwrdsnmwxunciti`). Do **not** touch prod.
Expected: two tables created on dev.

- [ ] **Step 3: Add TS types**

In `src/types/database.ts` add:

```ts
export interface Ticket {
  id: string;
  tenant_id: string;
  intake_id: string;
  enrollment_id: string;
  class_id: string;
  tier: string;
  admits: number;
  exp: string;
  kid: string;
  status: "valid" | "void";
  first_scan_at: string | null;
  first_scan_gate: string | null;
  created_at: string;
}

export interface ScannerApiKey {
  id: string;
  tenant_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/088_tickets_and_scanner_keys.sql src/types/database.ts
git commit -m "feat(tickets): add tickets + scanner_api_keys tables and types"
```

---

## Task 2: Signing keypair + key loader

**Files:**
- Create: `scripts/generate-ticket-key.ts`, `src/lib/tickets/keys.ts`
- Test: `src/__tests__/tickets/keys.test.ts`

- [ ] **Step 1: Keypair generator script**

```ts
// scripts/generate-ticket-key.ts — run: node --experimental-strip-types scripts/generate-ticket-key.ts
import { generateKeyPairSync } from "crypto";
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const priv = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
const rawPub = publicKey.export({ type: "spki", format: "der" }).subarray(-32); // last 32 bytes = raw ed25519 pubkey
console.log("TICKET_SIGNING_KEY (private, pkcs8 base64):\n" + priv + "\n");
console.log("Public key (raw, base64url) for the app bundle:\n" + rawPub.toString("base64url") + "\n");
console.log("Set TICKET_KID to a stable id, e.g. kuunyi-ed25519-1");
```

- [ ] **Step 2: Key loader with test**

```ts
// src/__tests__/tickets/keys.test.ts
import { describe, it, expect } from "vitest";
import { loadSigningKey, getPublicKeyBase64Url } from "@/lib/tickets/keys";
import { generateKeyPairSync } from "crypto";

describe("keys", () => {
  it("derives raw base64url public key from the configured private key", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
    process.env.TICKET_SIGNING_KEY = pkcs8;
    process.env.TICKET_KID = "test-kid";
    const { kid } = loadSigningKey();
    expect(kid).toBe("test-kid");
    expect(getPublicKeyBase64Url()).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
  });
});
```

- [ ] **Step 3: Run test (fails — module missing)**

Run: `npx vitest run src/__tests__/tickets/keys.test.ts`
Expected: FAIL (cannot import `@/lib/tickets/keys`).

- [ ] **Step 4: Implement `src/lib/tickets/keys.ts`**

```ts
import { createPrivateKey, createPublicKey, type KeyObject } from "crypto";

export function loadSigningKey(): { privateKey: KeyObject; kid: string } {
  const b64 = process.env.TICKET_SIGNING_KEY;
  const kid = process.env.TICKET_KID;
  if (!b64 || !kid) throw new Error("TICKET_SIGNING_KEY / TICKET_KID not configured");
  const privateKey = createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8" });
  return { privateKey, kid };
}

export function getPublicKeyBase64Url(): string {
  const { privateKey } = loadSigningKey();
  const spki = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  return spki.subarray(-32).toString("base64url");
}
```

- [ ] **Step 5: Run test (passes), then commit**

Run: `npx vitest run src/__tests__/tickets/keys.test.ts` → PASS

```bash
git add scripts/generate-ticket-key.ts src/lib/tickets/keys.ts src/__tests__/tickets/keys.test.ts
git commit -m "feat(tickets): Ed25519 key loader + generator script"
```

- [ ] **Step 6: Generate the dev key and set env**

Run `node --experimental-strip-types scripts/generate-ticket-key.ts`, add `TICKET_SIGNING_KEY`, `TICKET_KID`, `TICKET_TZ=Asia/Yangon` to `.env.local`. Record the public key + kid in the deliverables doc (Task 13). Do NOT commit `.env.local`.

---

## Task 3: Expiry computation

**Files:**
- Create: `src/lib/tickets/exp.ts`
- Test: `src/__tests__/tickets/exp.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { ticketExpiry } from "@/lib/tickets/exp";

describe("ticketExpiry", () => {
  it("returns end-of-event-day epoch seconds in the event tz", () => {
    // 2026-07-12 23:59:59 Asia/Yangon (UTC+6:30) = 2026-07-12T17:29:59Z
    const exp = ticketExpiry("2026-07-12", "Asia/Yangon");
    expect(exp).toBe(Math.floor(Date.parse("2026-07-12T17:29:59+00:00") / 1000));
  });
  it("falls back to ~1 year out when event_date is null", () => {
    const now = Math.floor(Date.now() / 1000);
    const exp = ticketExpiry(null, "Asia/Yangon");
    expect(exp).toBeGreaterThan(now + 300 * 24 * 3600);
  });
});
```

- [ ] **Step 2: Run (fails), Step 3: implement `exp.ts`**

```ts
// Returns Unix seconds for 23:59:59 on event_date in the given IANA tz.
export function ticketExpiry(eventDate: string | null, tz: string): number {
  if (!eventDate) return Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
  // Build the local wall-clock end-of-day, then find its UTC instant for `tz`.
  const [y, m, d] = eventDate.split("-").map(Number);
  const asUTC = Date.UTC(y, m - 1, d, 23, 59, 59);
  // offset(tz) at that date: difference between the tz's local time and UTC.
  const local = new Date(asUTC).toLocaleString("en-US", { timeZone: tz });
  const offsetMs = new Date(local).getTime() - asUTC;
  return Math.floor((asUTC - offsetMs) / 1000);
}
```

- [ ] **Step 4: Run (passes), Step 5: commit**

```bash
git add src/lib/tickets/exp.ts src/__tests__/tickets/exp.test.ts
git commit -m "feat(tickets): event-day expiry helper"
```

---

## Task 4: JWT sign/verify

**Files:**
- Create: `src/lib/tickets/sign.ts`
- Test: `src/__tests__/tickets/sign.test.ts`

- [ ] **Step 1: Failing test** — sign a ticket, verify with the raw public key, assert claims.

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPairSync } from "crypto";
import { signTicketJwt, verifyTicketJwt } from "@/lib/tickets/sign";

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("ed25519");
  process.env.TICKET_SIGNING_KEY = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  process.env.TICKET_KID = "test-kid";
});

it("signs and verifies an EdDSA ticket JWT", () => {
  const jwt = signTicketJwt({ jti: "t1", eid: "e1", tier: "GA", admits: 1, exp: 9999999999 });
  const parts = jwt.split(".");
  expect(parts).toHaveLength(3);
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
  expect(header).toEqual({ alg: "EdDSA", kid: "test-kid" });
  const claims = verifyTicketJwt(jwt); // throws if signature invalid
  expect(claims).toMatchObject({ jti: "t1", eid: "e1", tier: "GA", admits: 1 });
});
```

- [ ] **Step 2: Run (fails), Step 3: implement `sign.ts`**

```ts
import { sign as edSign, verify as edVerify } from "crypto";
import { loadSigningKey, getPublicKeyBase64Url } from "./keys";
import { createPublicKey } from "crypto";

const b64u = (b: Buffer) => b.toString("base64url");

export interface TicketClaims {
  jti: string; eid: string; tier: string; admits: number; exp: number;
}

export function signTicketJwt(claims: TicketClaims): string {
  const { privateKey, kid } = loadSigningKey();
  const header = b64u(Buffer.from(JSON.stringify({ alg: "EdDSA", kid })));
  const payload = b64u(Buffer.from(JSON.stringify(claims)));
  const data = Buffer.from(`${header}.${payload}`);
  const sig = edSign(null, data, privateKey); // Ed25519: algorithm arg is null
  return `${header}.${payload}.${b64u(sig)}`;
}

export function verifyTicketJwt(jwt: string): TicketClaims {
  const [h, p, s] = jwt.split(".");
  const rawPub = Buffer.from(getPublicKeyBase64Url(), "base64url");
  // Rebuild a KeyObject from the raw 32-byte key via SPKI prefix.
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawPub]);
  const pubKey = createPublicKey({ key: spki, format: "der", type: "spki" });
  const ok = edVerify(null, Buffer.from(`${h}.${p}`), pubKey, Buffer.from(s, "base64url"));
  if (!ok) throw new Error("invalid ticket signature");
  return JSON.parse(Buffer.from(p, "base64url").toString());
}
```

- [ ] **Step 4: Run (passes), Step 5: commit**

```bash
git add src/lib/tickets/sign.ts src/__tests__/tickets/sign.test.ts
git commit -m "feat(tickets): EdDSA JWT sign/verify"
```

---

## Task 5: Scanner API-key auth

**Files:**
- Create: `src/lib/scanner/apiKey.ts`
- Test: `src/__tests__/scanner/apiKey.test.ts`

Reuse the existing Supabase admin mock helper (see `src/__tests__` for the mock pattern used by hitpay tests).

- [ ] **Step 1: Failing test** — `hashApiKey` is stable SHA-256 hex; `resolveScannerTenant` returns tenant_id for a valid non-revoked key, and `null` for missing/invalid/revoked.

- [ ] **Step 2: Run (fails), Step 3: implement**

```ts
import { createHash, timingSafeEqual } from "crypto";
import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export async function resolveScannerTenant(request: NextRequest): Promise<string | null> {
  const auth = request.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const hash = hashApiKey(m[1].trim());
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("scanner_api_keys")
    .select("tenant_id, revoked_at, key_hash")
    .eq("key_hash", hash)
    .is("revoked_at", null)
    .single() as unknown as { data: { tenant_id: string; revoked_at: string | null; key_hash: string } | null };
  if (!data) return null;
  // constant-time re-check
  const a = Buffer.from(hash), b = Buffer.from(data.key_hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  void supabase.from("scanner_api_keys").update({ last_used_at: new Date().toISOString() } as never).eq("key_hash", hash);
  return data.tenant_id;
}
```

- [ ] **Step 4: Run (passes), Step 5: commit**

```bash
git add src/lib/scanner/apiKey.ts src/__tests__/scanner/apiKey.test.ts
git commit -m "feat(scanner): per-tenant API key hashing and resolution"
```

---

## Task 6: Ticket materialization service

**Files:**
- Create: `src/server/tickets/issueTickets.ts`
- Test: `src/__tests__/tickets/issueTickets.test.ts`

- [ ] **Step 1: Failing tests** (mocked admin client):
  - Single-class enrollment (`class_id` set, `quantity=2`) → inserts 2 rows with correct `tier`, `intake_id`, `exp`, `kid`.
  - Cart enrollment (`class_id` null, two `enrollment_items` 2 + 1) → inserts 3 rows.
  - Idempotent: if tickets already exist for the enrollment, insert nothing.
  - `voidTicketsForEnrollment` sets `status='void'` on the enrollment's tickets.

- [ ] **Step 2: Run (fails), Step 3: implement**

```ts
import { createAdminClient } from "@/lib/supabase/admin";
import { ticketExpiry } from "@/lib/tickets/exp";
import { loadSigningKey } from "@/lib/tickets/keys";

const TZ = process.env.TICKET_TZ ?? "Asia/Yangon";

export async function issueTicketsForEnrollment(enrollmentId: string): Promise<void> {
  const supabase = createAdminClient();
  // idempotency guard
  const { count } = await supabase.from("tickets").select("id", { count: "exact", head: true }).eq("enrollment_id", enrollmentId);
  if ((count ?? 0) > 0) return;

  const { data: e } = await supabase.from("enrollments")
    .select("id, tenant_id, class_id, quantity, intake_id:classes(intake_id)")
    .eq("id", enrollmentId).single() as unknown as { data: any };
  if (!e) return;

  // Build (class_id, quantity) list from single-class or cart items.
  let lines: { class_id: string; quantity: number }[] = [];
  if (e.class_id) {
    lines = [{ class_id: e.class_id, quantity: e.quantity ?? 1 }];
  } else {
    const { data: items } = await supabase.from("enrollment_items")
      .select("class_id, quantity").eq("enrollment_id", enrollmentId) as unknown as { data: { class_id: string; quantity: number }[] };
    lines = items ?? [];
  }
  if (lines.length === 0) return;

  const classIds = lines.map((l) => l.class_id);
  const { data: classes } = await supabase.from("classes")
    .select("id, level, intake_id, event_date").in("id", classIds) as unknown as { data: any[] };
  const byId = new Map((classes ?? []).map((c) => [c.id, c]));
  const { kid } = loadSigningKey();

  const rows: any[] = [];
  for (const line of lines) {
    const c = byId.get(line.class_id);
    if (!c) continue;
    for (let i = 0; i < line.quantity; i++) {
      rows.push({
        tenant_id: e.tenant_id,
        intake_id: c.intake_id,
        enrollment_id: enrollmentId,
        class_id: line.class_id,
        tier: c.level,
        admits: 1,
        exp: new Date(ticketExpiry(c.event_date, TZ) * 1000).toISOString(),
        kid,
        status: "valid",
      });
    }
  }
  if (rows.length) await supabase.from("tickets").insert(rows as never);
}

export async function voidTicketsForEnrollment(enrollmentId: string): Promise<void> {
  const supabase = createAdminClient();
  await supabase.from("tickets").update({ status: "void" } as never).eq("enrollment_id", enrollmentId);
}
```

Note: adjust the `intake_id` selection to match how the codebase joins classes — verify against `src/app/api/public/enroll/[slug]/route.ts` select patterns during implementation.

- [ ] **Step 4: Run (passes), Step 5: commit**

```bash
git add src/server/tickets/issueTickets.ts src/__tests__/tickets/issueTickets.test.ts
git commit -m "feat(tickets): idempotent per-admission materialization service"
```

---

## Task 7: Wire materialization into confirmation + refund paths

**Files (modify):** `src/server/payments/verifyPayment.ts`, `src/app/api/webhooks/{abank,hitpay,mmpay,paypay,stripe}/route.ts`; refund/cancel path (find via `git grep "status: \"cancelled\""` / refund handler).

- [ ] **Step 1:** After each `status: "confirmed"` update succeeds, `await issueTicketsForEnrollment(enrollment.id)` (wrap in try/catch + `console.error` so a ticket failure never breaks confirmation — mirror the notification error handling in `dispatchPaymentApproved`).
- [ ] **Step 2:** In the refund/cancel handler, call `await voidTicketsForEnrollment(enrollment.id)`.
- [ ] **Step 3:** Run the existing payment/webhook test suites: `npx vitest run src/__tests__/payments src/__tests__/notifications` → PASS (add a mock for `issueTicketsForEnrollment` where needed).
- [ ] **Step 4: Commit**

```bash
git commit -am "feat(tickets): issue tickets on confirm, void on refund"
```

---

## Task 8: Ticket issuance in enrollment fetch

**Files:**
- Modify: `src/app/api/public/enrollment/[ref]/route.ts`
- Test: `src/__tests__/tickets/enrollmentTickets.test.ts`

- [ ] **Step 1: Failing test** — for a `confirmed` enrollment, the response includes `tickets: [{ jti, tier, admits, jwt }]` (jwt verifies); for an unconfirmed enrollment, `tickets` is empty/omitted.
- [ ] **Step 2: Run (fails), Step 3: implement** — after loading the enrollment, if `status === "confirmed"`, load its `tickets` rows and map each to `{ jti: t.id, tier: t.tier, admits: t.admits, jwt: signTicketJwt({ jti: t.id, eid: t.intake_id, tier: t.tier, admits: t.admits, exp: Math.floor(Date.parse(t.exp)/1000) }) }`. Attach as `tickets` on the JSON.
- [ ] **Step 4: Run (passes), Step 5: commit**

```bash
git commit -am "feat(tickets): return signed ticket JWTs on confirmed enrollment fetch"
```

---

## Task 9: E-ticket QR + multi-page PDF

**Files:**
- Modify: `src/app/(public)/enroll/[slug]/checkout/success/page.tsx`

- [ ] **Step 1:** Render one e-ticket block per `tickets[]` entry; in each, draw a QR from the ticket's `jwt` using `qrcode` (`QRCode.toDataURL(jwt)` → `<img>`), showing `tier`, a short `jti`, and event info.
- [ ] **Step 2:** Change PDF export to iterate the per-ticket refs and add one page per ticket (`pdf.addPage()` between captures), keeping the existing html2canvas approach.
- [ ] **Step 3: Manual verification** — run `/run` skill or dev server, confirm a confirmed multi-ticket enrollment shows N e-tickets each with a scannable QR, and the PDF has N pages. Decode one QR and verify it's the ticket JWT.
- [ ] **Step 4: Commit**

```bash
git commit -am "feat(tickets): render per-ticket QR e-tickets + multi-page PDF export"
```

---

## Task 10: GET /api/events

**Files:**
- Create: `src/app/api/events/route.ts`
- Test: `src/__tests__/scanner/events.test.ts`

- [ ] **Step 1: Failing tests** — 401 without key; with a valid key returns only that tenant's non-past event intakes as `{ id, name, date, location }`; `date` = human `min(class.event_date)` (e.g. "Jul 12"), `location` = that class's venue.
- [ ] **Step 2: Run (fails), Step 3: implement** — `resolveScannerTenant`; if null → 401. Query intakes for tenant (status `open` OR having a class with `event_date >= today`); for each, fetch its classes to derive earliest `event_date` + venue; format date as `toLocaleString("en-US",{month:"short",day:"numeric"})`. Return array.
- [ ] **Step 4: Run (passes), Step 5: commit**

```bash
git commit -am "feat(scanner): GET /api/events endpoint"
```

---

## Task 11: POST /api/scans

**Files:**
- Create: `src/app/api/scans/route.ts`
- Test: `src/__tests__/scanner/scans.test.ts`

- [ ] **Step 1: Failing tests** covering: 401 (no key); 404 (jti not found / wrong tenant / `eid` mismatch / `status='void'` / expired); 200 (first scan sets `first_scan_at`+`first_scan_gate`); 409 (second scan returns `{ firstScanTime, firstScanGate }`).
- [ ] **Step 2: Run (fails), Step 3: implement**

Logic: resolve tenant (401 if null) → load ticket by `jti` where `tenant_id = tenant` → if missing or `intake_id !== body.eid` or `status !== 'valid'` or `Date.parse(exp) < now` → 404 → if `first_scan_at` null: update it + gate, return 200 → else return 409 with `{ firstScanTime: first_scan_at, firstScanGate: first_scan_gate }`. Use a conditional update (`.is("first_scan_at", null)`) to avoid a double-scan race.

- [ ] **Step 4: Run (passes), Step 5: commit**

```bash
git commit -am "feat(scanner): POST /api/scans endpoint with single-use enforcement"
```

---

## Task 12: Middleware skip-tenant

**Files:**
- Modify: `src/middleware.ts`

- [ ] **Step 1:** Add `/api/events` and `/api/scans` to the skip-tenant route list (same place `/api/saas/*` etc. are skipped) so subdomain tenant resolution never runs for them.
- [ ] **Step 2:** Manual check: a scanner request to a bare host with a valid key succeeds (tenant comes from the key, not host).
- [ ] **Step 3: Commit**

```bash
git commit -am "feat(scanner): exempt scanner endpoints from host tenant resolution"
```

---

## Task 13: Ops — mint key + deliverables doc

**Files:**
- Create: `scripts/create-scanner-key.ts`, `docs/kuunyi-scanner-integration.md`

- [ ] **Step 1:** `create-scanner-key.ts` — args: tenant slug + name; generates a random 32-byte base64url key, inserts `{ tenant_id, name, key_hash: sha256, key_prefix }`, prints the raw key **once**.
- [ ] **Step 2:** Write `docs/kuunyi-scanner-integration.md` for the app team: endpoint URLs (`{base}/api/events`, `{base}/api/scans`), request/response shapes, status codes, and the `kid` → base64url public key (from Task 2). Do not include private material.
- [ ] **Step 3: Commit**

```bash
git commit -am "chore(scanner): key-mint script + app integration doc"
```

---

## Wrap-up

- [ ] Run the full suite: `npx vitest run` → all PASS.
- [ ] `npm run build` → clean.
- [ ] Open a PR `feat/qr-eticket-scanner` → `dev` (do not merge yourself).
- [ ] Prod rollout (later, via dual-DB flow): apply migration 088 to prod, set `TICKET_SIGNING_KEY`/`TICKET_KID`/`TICKET_TZ` in Vercel prod (use `printf`, not `echo`), mint a prod scanner key, hand the public key + key to the app team.
