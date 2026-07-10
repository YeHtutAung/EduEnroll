# kuunyi-scanner Integration Guide

Integration reference for the **kuunyi-scanner** mobile app team: how to authenticate,
list events, verify ticket QR codes offline, and record scans.

## Overview

1. The app is configured per tenant with a **base URL** and a per-tenant **API key**.
2. On startup, call `GET /api/events` to populate the event picker.
3. When a QR is scanned, verify the embedded JWT **offline** first (signature + `exp`),
   then call `POST /api/scans` to record the scan and enforce single-use server-side.

Never mark an entry as admitted based on offline JWT verification alone — always call
`/api/scans`. The server is the source of truth for single-use, tenant scope, void, and
expiry.

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
{ "jti": "<ticket id>", "eid": "<event id>", "gate": "Gate A" }
```

**Responses:**

| Status | Body                                                        | Meaning                                          |
| ------ | ----------------------------------------------------------- | ------------------------------------------------ |
| `200`  | `{ "ok": true }`                                            | First valid scan — admit.                        |
| `409`  | `{ "firstScanTime": "<ISO>", "firstScanGate": "<string>" }` | Already scanned — show prior scan info.          |
| `404`  | —                                                           | Ticket not found, wrong event, void, or expired. |
| `400`  | —                                                           | Malformed request body.                          |
| `401`  | —                                                           | Missing/invalid API key.                         |

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
calling the network. Signature and `exp` checks happen client-side; the server independently
re-checks tenant scope, existence, void status, expiry, and single-use when `/api/scans` is
called.

### Dev signing key (sandbox/dev environment)

Bundle this key/id pair for the dev environment:

| Field      | Value                                                                          |
| ---------- | ------------------------------------------------------------------------------ |
| `kid`      | `kuunyi-ed25519-1`                                                             |
| Public key | `ocHWM3Hs0_Pp-NRbc1rreP1vLUrriwC7wyaEyJuhK5A` (raw 32-byte Ed25519, base64url) |

**Production uses a separate key and `kid`**, provided separately before go-live. Do not
reuse the dev key/kid for production tickets.

## Notes

- **One QR per admission.** An order of 2×GA + 1×VIP produces 3 separate tickets, each with
  its own `jti` and `admits: 1` — there is no multi-admit ticket in v1.
- Always call `/api/scans` for every scan, even if offline verification passed. The server
  enforces single-use, tenant scope, void, and expiry independently of the client's
  offline verdict.
- A `404` from `/api/scans` should be treated by the UI as "not a valid ticket" without
  distinguishing the exact reason (not found / wrong event / void / expired) for a
  scanning operator.
