# kuunyi-scanner Integration Guide

Integration reference for the **kuunyi-scanner** mobile app team: how to authenticate,
list events, verify ticket QR codes offline, and record scans.

## Overview

1. The app is configured per tenant with a **base URL** and a per-tenant **API key**.
2. On startup, call `GET /api/events` to populate the event picker.
3. When a QR is scanned, verify the embedded JWT **offline** first (signature + `exp`),
   then send **the token itself** to `POST /api/scans` to record the scan and enforce
   single-use server-side.

Never mark an entry as admitted based on offline JWT verification alone — always call
`/api/scans`. The server is the source of truth for single-use, tenant scope, void, and
expiry, and it independently verifies the token's signature.

## Auth

Every request sends:

```
Authorization: Bearer <api-key>
```

The API key is per-tenant and issued by EduEnroll ops. `401` is returned for any missing,
invalid, or revoked key.

## Endpoints

Base URL varies per tenant and is configured in the app; endpoints below are relative to
that base.

### `GET {base}/api/events`

Event picker. Returns the tenant's open, upcoming events.

**200** — array of events:

```json
[{ "id": "<intake uuid>", "name": "Summer Fest 2026", "date": "Jul 12", "location": "Main Arena" }]
```

| Field      | Notes                                                               |
| ---------- | ------------------------------------------------------------------- |
| `id`       | Must equal the `eid` claim in ticket JWTs (both are the intake id). |
| `name`     | Event display name.                                                 |
| `date`     | Human-readable, e.g. `"Jul 12"`.                                    |
| `location` | Venue string, may be `null`.                                        |

**401** — missing/invalid/revoked key.

### `POST {base}/api/scans`

Record a scan for a ticket.

**Request body:**

```json
{ "token": "<the compact JWT from the QR>", "gate": "Gate A" }
```

| Field   | Required | Notes                                                                     |
| ------- | -------- | ------------------------------------------------------------------------- |
| `token` | **yes**  | The compact JWT exactly as encoded in the QR. Its signature is the admission credential — the server verifies it before any lookup. |
| `gate`  | no       | Free-text gate label, recorded on the first scan only.                    |
| `jti`   | no       | Advisory. If sent it must equal the token's `jti` claim, or the request is rejected with `400`. |
| `eid`   | no       | Advisory. If sent it must equal the token's `eid` claim, or the request is rejected with `400`. |

The verified claims are the source of truth for which ticket and event are being
admitted; `jti`/`eid` in the body are a cross-check for client bugs, not inputs.

**Responses:**

| Status | Body                                                        | Meaning                                          |
| ------ | ----------------------------------------------------------- | ------------------------------------------------ |
| `200`  | `{ "ok": true }`                                            | First valid scan — admit.                        |
| `409`  | `{ "firstScanTime": "<ISO>", "firstScanGate": "<string>" }` | Already scanned — show prior scan info.          |
| `404`  | —                                                           | Not an admission: bad signature, not a ticket token, unknown ticket, wrong event, void, or expired. |
| `400`  | —                                                           | Malformed body, missing `token`, or body contradicting the token's claims. |
| `401`  | —                                                           | Missing/invalid API key.                         |
| `500`  | —                                                           | Server cannot verify tickets (signing key not configured). **Not** a bad ticket — do not show "invalid" to the operator. |

## Ticket JWT (embedded in each QR)

Each QR code encodes a compact JWT.

**Algorithm:** `EdDSA` (Ed25519)

**Header:**

```json
{ "alg": "EdDSA", "kid": "<key-id>" }
```

**Claims:**

```json
{
  "jti": "<ticket uuid>",
  "eid": "<event/intake uuid>",
  "tier": "GA",
  "admits": 1,
  "exp": 1752192000
}
```

| Claim    | Meaning                                                                                |
| -------- | -------------------------------------------------------------------------------------- |
| `jti`    | Ticket id — pass as `jti` to `/api/scans`.                                             |
| `eid`    | Event (intake) id — pass as `eid` to `/api/scans`; must match `id` from `/api/events`. |
| `tier`   | Ticket tier (e.g. `GA`, `VIP`).                                                        |
| `admits` | Always `1` in v1 — one QR admits one person.                                           |
| `exp`    | Unix seconds expiry. Reject if the current time is past this.                          |

The app verifies the JWT **offline** using a bundled `kid → public key` map before ever
calling the network, so a forged QR is rejected without a round trip. The server then
verifies the same signature again on `/api/scans`, and re-checks tenant scope, existence,
void status, expiry, and single-use.

Both checks matter and neither replaces the other. The offline check keeps a bad QR off
the network; the server check is what makes a stolen or guessed ticket id worthless,
because an admission now requires a validly signed token rather than an id alone.

### Dev signing key (sandbox/dev environment)

Bundle this key/id pair for the dev environment:

| Field      | Value                                                                          |
| ---------- | ------------------------------------------------------------------------------ |
| `kid`      | `kuunyi-ed25519-1`                                                             |
| Public key | `ocHWM3Hs0_Pp-NRbc1rreP1vLUrriwC7wyaEyJuhK5A` (raw 32-byte Ed25519, base64url) |

**Production uses a separate key and `kid`**, provided separately before go-live. Do not
reuse the dev key/kid for production tickets.

> **Key rotation is now a breaking change.** The server verifies signatures against its
> currently configured key, so rotating `TICKET_SIGNING_KEY` invalidates every outstanding
> ticket — they will scan as `404`. (Before signature verification was enforced, rotation
> had no effect on issued tickets.) Rotating requires reissuing tickets and shipping the
> new public key to the app together.

## Notes

- **One QR per admission.** An order of 2×GA + 1×VIP produces 3 separate tickets, each with
  its own `jti` and `admits: 1` — there is no multi-admit ticket in v1.
- Always call `/api/scans` for every scan, even if offline verification passed. The server
  enforces single-use, tenant scope, void, and expiry independently of the client's
  offline verdict.
- A `404` from `/api/scans` should be treated by the UI as "not a valid ticket" without
  distinguishing the exact reason (not found / wrong event / void / expired) for a
  scanning operator.
