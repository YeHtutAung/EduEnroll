# QR E-Ticket + kuunyi-scanner Support — Design

**Date:** 2026-07-10
**Status:** Draft (pending review)
**Component:** EduEnroll backend + public e-ticket flow

## 1. Goal

Add a scannable QR code to each e-ticket so the **kuunyi-scanner** mobile app can validate entry at the gate. This requires three parts:

1. **Per-ticket identity + signed JWT** embedded as a QR in each e-ticket.
2. **`POST /api/scans`** — record the first scan, reject duplicates.
3. **`GET /api/events`** — list a tenant's events for the app's event picker.

The scanner verifies the JWT **offline** (bundled Ed25519 public key), then calls `/api/scans` online to enforce single-use.

## 2. Key decisions (confirmed)

- **One QR per admission.** An order of 2×GA + 1×VIP + 1×VVIP produces **4 separate e-tickets**, each with a unique `jti` and `admits: 1`.
- **`eid` = `intakes.id`.** `tier` = `classes.level`.
- **`/events` date/location derived from classes**: `date` = earliest `class.event_date` for the intake; `location` = that class's `venue`.
- **Per-tenant API key.** Tenant is resolved from the Bearer key, **not** the host — the app's base URL varies per tenant.
- **`exp` = end of event day** (`class.event_date` at 23:59:59 in the event timezone; fallback `now + 365d` if `event_date` is null).
- **Identity storage: dedicated `tickets` table** (Approach A), materialized on payment confirmation.

## 3. Data model

### 3.1 `tickets` (new)

One row per admission.

| Column            | Type          | Notes                                                        |
| ----------------- | ------------- | ------------------------------------------------------------ |
| `id`              | uuid PK       | Also the JWT `jti` (opaque to the app).                      |
| `tenant_id`       | uuid FK       | Owning tenant.                                               |
| `intake_id`       | uuid FK       | The event; JWT `eid`.                                        |
| `enrollment_id`   | uuid FK       | Source order.                                                |
| `class_id`        | uuid FK       | The tier's class.                                            |
| `tier`            | text          | Denormalized `class.level` (JWT `tier`).                     |
| `admits`          | int           | Always `1` in v1 (kept for forward-compat).                 |
| `exp`             | timestamptz   | End of event day (see §6).                                   |
| `kid`             | text          | Signing key id used for this ticket.                        |
| `status`          | text          | `valid` \| `void` (void = refunded/cancelled).              |
| `first_scan_at`   | timestamptz   | Null until first scan.                                       |
| `first_scan_gate` | text          | Null until first scan.                                       |
| `created_at`      | timestamptz   | Default now().                                               |

Indexes: PK on `id`; `(tenant_id, intake_id)`; `(enrollment_id)`.

### 3.2 `scanner_api_keys` (new)

| Column        | Type        | Notes                                             |
| ------------- | ----------- | ------------------------------------------------- |
| `id`          | uuid PK     |                                                   |
| `tenant_id`   | uuid FK     | Tenant this key authorizes.                       |
| `name`        | text        | Human label (e.g. "Front gate iPad").             |
| `key_hash`    | text        | SHA-256 of the raw key; raw key shown once.       |
| `key_prefix`  | text        | First 8 chars, for admin display/lookup.          |
| `last_used_at`| timestamptz | Updated on each authenticated call.               |
| `revoked_at`  | timestamptz | Null = active.                                    |
| `created_at`  | timestamptz | Default now().                                     |

The raw key is a random 32-byte base64url string, shown to the operator once at creation and **never stored in plaintext**. Auth compares `sha256(presented)` against `key_hash` (constant-time).

## 4. Ticket materialization

Tickets are created when an enrollment becomes `confirmed`, in the existing confirmation path (`src/server/payments/verifyPayment.ts` and the equivalent used by webhook auto-confirms — the same place `dispatchPaymentApproved` fires).

- **Single-class enrollment**: create `enrollment.quantity` rows for `enrollment.class_id`.
- **Cart enrollment**: for each `enrollment_items` row, create `quantity` rows for its `class_id`.
- **Idempotent**: skip if tickets already exist for the enrollment (guard on `enrollment_id` count) so re-confirms/webhook retries don't duplicate.
- `exp` computed per §6; `tier` copied from the class; `kid` = current signing key id.

Refund/cancel path sets `status = 'void'` for the enrollment's tickets (scanner then treats them as not-valid — see §7.2).

## 5. Signing keys

- One **Ed25519** keypair, generated once with Node's built-in `crypto` (`crypto.generateKeyPairSync('ed25519')`). No new dependency.
- **Private key** (PKCS#8, base64) stored in env `TICKET_SIGNING_KEY`; key id in `TICKET_KID` (e.g. `kuunyi-ed25519-1`).
- **Public key** (raw 32-byte, base64url) is delivered to the app team to bundle as `kid → publicKey`.
- `kid` in the JWT header lets us rotate later without breaking old tickets; v1 ships a single key.

Helper: `src/lib/tickets/sign.ts` → `signTicketJwt(ticket): string`.

## 6. JWT format

Header:
```json
{ "alg": "EdDSA", "kid": "kuunyi-ed25519-1" }
```
Claims:
```json
{ "jti": "<ticket uuid>", "eid": "<intake uuid>", "tier": "GA", "admits": 1, "exp": 1752192000 }
```

`exp` = `class.event_date` at 23:59:59 in the event timezone, as a Unix seconds value. Timezone: a platform constant (default `Asia/Yangon`; kuunyi/SG events use `Asia/Singapore`) — stored as `TICKET_TZ` config, refined per-tenant later if needed. If `event_date` is null, `exp = now + 365d`.

The QR encodes the compact JWT string. Rendered client-side with the existing `qrcode` dependency.

## 7. Endpoints

All scanner endpoints are added to the middleware **skip-tenant** list and resolve tenant from the API key.

### 7.1 Ticket issuance (public, ref-guarded)

Extend the confirmed-enrollment fetch (`GET /api/public/enrollment/[ref]`) to include a `tickets` array, each `{ jti, tier, admits, jwt }`, **only** when the enrollment is `confirmed`. The success page renders one e-ticket per entry with its QR; PDF export becomes **multi-page (one ticket per page)**.

### 7.2 `POST /api/scans`

Auth: `Authorization: Bearer <api-key>`. Body: `{ "jti", "eid", "gate" }`.

Logic:
1. Resolve tenant from key (else `401`).
2. Load ticket by `jti` scoped to tenant; if missing or `intake_id != eid` → `404`.
3. If `status = 'void'` or `exp` past → `404` (treated as not a valid ticket).
4. If `first_scan_at` is null → set `first_scan_at = now()`, `first_scan_gate = gate`, return `200`.
5. Else → `409` with `{ "firstScanTime": <ISO>, "firstScanGate": <string> }`.

The scanner already verified the JWT signature/`exp` offline; the server re-checks tenant scope, existence, void, and single-use.

### 7.3 `GET /api/events`

Auth: same Bearer key. Returns all of the tenant's **event** intakes that are not past/archived (status `open`, or `event_date >= today`):
```json
[ { "id": "<intake uuid>", "name": "Summer Fest 2026", "date": "Jul 12", "location": "Main Arena" } ]
```
`date` = `min(class.event_date)` formatted human-readable; `location` = that class's `venue`. `id` **must** equal the `eid` in ticket JWTs (both are `intakes.id`).

Errors for both endpoints: `401`/`403` on missing/invalid/revoked key.

## 8. Security

- API keys hashed at rest (SHA-256); constant-time comparison; `revoked_at` short-circuits.
- Strict tenant scoping on every ticket/event query.
- Server independently enforces single-use, void, expiry, and tenant match — never trusts the client's offline verdict alone.
- Private signing key only in env (Vercel prod secret / `.env.local` dev), never in the repo or client.
- `/api/scans` and `/api/events` exempt from subdomain tenant resolution.

## 9. Migrations

- `NNN_tickets.sql` — `tickets` table + indexes.
- `NNN_scanner_api_keys.sql` — `scanner_api_keys` table.
- Applied to dev first; prod via the documented dual-DB flow.

## 10. Testing

- Unit: `signTicketJwt` (header/claims, EdDSA verifies with the public key), `exp` computation (event day, tz, null fallback), materialization (single vs cart, idempotency), API-key hashing/compare.
- Route: `/api/scans` (200 first / 409 duplicate payload / 404 missing / 404 wrong eid / 401 no key / 403 revoked), `/api/events` (tenant scoping, shape, past-event exclusion), issuance array on confirmed vs unconfirmed enrollment.

## 11. Deliverables to the app team

- Endpoint paths: `POST {base}/api/scans`, `GET {base}/api/events` (base configured per tenant in the app).
- `kid` → base64url Ed25519 **public** key for the bundle.
- Confirmation that `jti`/`eid`/`tier`/`admits`/`exp` match this doc.

## 12. Out of scope (future)

- Key rotation tooling (structure supports it via `kid`).
- `scan_events` full audit log (v1 keeps only first-scan fields).
- Per-tenant event timezone table.
- Admin UI to mint/revoke scanner API keys (v1 may seed keys via a script/SQL).
