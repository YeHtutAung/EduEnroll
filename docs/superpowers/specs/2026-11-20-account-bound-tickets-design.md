# Account-bound, non-transferable e-tickets — design

Date: 2026-11-20
Status: approved in conversation by the owner; awaiting review of this file

## 1. Goal

Stop ticket resale for events that ask for it. A ticket for a protected event:

- belongs to one buyer account, proven by an email code before payment;
- is shown only on that buyer's signed-in ticket page, never in email or on public order pages;
- is presented at the gate as a QR that changes every 15 seconds and is signed by a key that never leaves the buyer's phone, so a screenshot or a copied page does not work;
- cannot be transferred.

Out of scope, accepted (both need a gate ID check against the account email shown on the ticket
page, which organisers may choose to do):

- a reseller who live-shares their screen on a video call while the new holder stands at the gate;
- a reseller who hands over the account itself (the inbox or a forwarded sign-in code). The email
  inbox is the only factor, so the new holder can sign in and bind their phone. Each bind emails the
  account (section 6.1), and binds are limited, but this is a transfer the design cannot block.

## 2. Decisions

| Question | Decision |
|---|---|
| Where the buyer opens the ticket | Web profile now; the KuuNyi mobile app adopts the same scheme later |
| Sign-in method | Email code (Supabase Auth OTP) |
| When the buyer signs in | Before checkout, on protected events |
| Live QR method | Phone-bound key: non-extractable WebCrypto key, QR re-signed every 15 s |
| Transfers | None |

## 3. Scope switch

- New column `intakes.ticket_protection boolean not null default false`.
- A check constraint allows `true` only when `ticket_qr_format = 'jwt'`. Events that third parties
  scan by bare ticket id (`uuid`) cannot use protection.
- The flag can change only while the intake has no enrollments. Enforced in the database
  (trigger), not only in the admin form.
- Existing events and orders are untouched. Nothing is converted.

## 4. Buyer accounts

- Supabase Auth email OTP (6-digit code). Supabase's default mailer allows only a few emails per
  hour, so **Auth SMTP must be set to Resend** in each project before launch. Dev first.
- Account table and order link are the ones planned in #451: `buyer_profiles` (id = `auth.users.id`,
  email, created_at) and `enrollments.buyer_id uuid references auth.users`. This work creates
  them if #451 has not landed yet, in the shape #451's spec describes.
- **#451 currently specifies phone SMS sign-in.** It must change to email (or support email as the
  primary identity), or one person ends up with separate app and web accounts. Owner decision,
  recorded as a dependency.
- `requireBuyer()` in `src/lib/` resolves the session and the `buyer_profiles` row. Buyers and staff
  share `auth.users`, so every staff gate must reject a buyer, and a staff session is never treated
  as a buyer. Gates to cover, with tests in both directions:
  - `requireAuth` / `requireOwner` (`src/lib/api.ts`) and `requireSuperadmin`
    (`src/lib/superadminAuth.ts`);
  - `src/middleware.ts`: today any signed-in user on `/login` is redirected to `/admin/dashboard`,
    and `/admin` only stops signed-out users. Both must tell a buyer apart from staff (buyer on
    `/login` stays there or goes to `/account`; buyer on `/admin` goes to `/account`);
  - the admin and superadmin layouts.
- Sessions are per host (tenant subdomain or custom domain). One account, signed in separately on
  each tenant site. `/account/tickets` lists only the current tenant's tickets.
- Prerequisite: the private security advisories that #451 says must be closed before buyer sign-up
  is enabled.

## 5. Checkout on a protected event

1. The enrollment form asks for email first and sends a code; the buyer enters it and is signed in.
   An already-signed-in buyer skips this.
2. The email field is filled from the account and read-only. The read-only field is only a
   convenience: the enroll routes (`src/app/api/public/enroll/route.ts`,
   `src/app/api/public/enroll/[slug]/route.ts`) overwrite the order email with the session email on
   the server for protected intakes.
3. The submit RPCs take `buyer_id` from the server-verified session, never from the request body.
   The route rejects a protected-event submission with no buyer session (401).
4. All tickets in the order belong to the buyer. For orders with several attendees (for example
   one per runner), everyone enters on the buyer's phone. Attendee names stay as data on the
   ticket; they do not create accounts.
5. Admin "Edit Email" (#425) is refused for protected orders in
   `src/app/api/admin/enrollments/[id]/email/route.ts` (409), and the button is hidden. The email
   is the identity.

## 6. Phone-bound QR

### 6.1 Binding a phone

- **One key per device and account**, not per ticket. The first time a signed-in buyer opens any
  protected ticket on a browser, the page creates an ECDSA P-256 key pair with WebCrypto,
  `extractable: false`, and stores the `CryptoKey` in IndexedDB keyed by buyer id. Every ticket the
  buyer opens on that browser is bound to that same key, so a multi-attendee order works from one
  phone. (P-256 rather than Ed25519 because WebCrypto Ed25519 is not yet on every phone browser our
  buyers use.)
- The page exports the public key as `raw` (65-byte uncompressed point) and sends it base64url.
  The server stores it as-is and imports it with `crypto.createPublicKey` from a JWK built from
  the x/y halves. No point compression anywhere.
- `POST /api/me/tickets/{ticketId}/device` with that public key. `requireBuyer()`; the ticket must
  belong to the buyer, be valid, and be on a protected intake.
- New table `ticket_devices`: `id`, `ticket_id`, `buyer_id`, `public_key`, `created_at`,
  `revoked_at`, `revoked_by` (`rebind` | `admin` | `account_deleted`). Partial unique index: one row
  with `revoked_at is null` per ticket. Rows are never deleted; they are the audit trail.
- Binding the key that is already active for the ticket is a no-op (returns the current token,
  uses no bind).
- Limit: 3 self-service binds per ticket, counted as the rows created after the ticket's latest
  `revoked_by = 'admin'` row (or all rows if there is none). The 4th returns 429 with a message to
  contact the organiser. Admin reset (section 9) revokes with `revoked_by = 'admin'`, which starts a
  new count.
- The limit check, revoking the old row and inserting the new one run in **one SQL function**
  (service role only), locking the ticket row, so concurrent binds cannot exceed the limit or leave
  two active rows. supabase-js has no transactions, so this cannot be done in the route.
- Every successful bind after the first sends the account a short email ("Your ticket was opened on
  a new phone").
- Response: a bound ticket token, Ed25519-signed with the existing ticket key
  (`src/lib/tickets/sign.ts`), claims `{ jti, eid, tier, admits, exp, typ: "bound", dk }` where `dk`
  is the device public key. Stored in IndexedDB beside the key. Its `exp` is informational: the scan
  route uses `tickets.exp` and the event dates from the DB, as it does today, so a later expiry
  change needs no re-bind.

### 6.2 What the QR holds

```
k2.<bound token>.<ts>.<devsig>
```

Exactly six dot-separated segments: `k2`, the three segments of the bound token, `ts`, `devsig`.
Anything else is not a `k2` token.

- `ts`: Unix seconds as a canonical decimal string (no sign, no leading zeros), refreshed every
  15 seconds. The page reads server time once on load (from the bind response) and adds that offset
  to the phone clock, so a wrong phone clock does not matter while the page stays open.
- `devsig`: ECDSA P-256 with SHA-256 over the UTF-8 bytes of `k2|<jti>|<ts>`, using the `ts` segment
  exactly as it appears in the QR. WebCrypto produces raw r||s (64 bytes), sent base64url. The
  server verifies with `crypto.verify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, sig)`.
- Expected length is about 400 characters. The plan must render a real one at the current ticket
  QR size (240 px minimum) and confirm the scanner reads it from a phone screen at normal
  brightness. If not, shorten `dk` or the token claims before going further.

### 6.3 Offline behaviour

- Once the page has loaded, the key, token and signing are all local, so the QR keeps changing with
  no signal for the life of the token.
- Reloading the page with no signal fails. The ticket page says to open it before arriving and keep
  it open. An offline page cache (service worker) is a later improvement.
- Clearing site data, or a private-browsing window, loses the key. The buyer binds again, which
  counts toward the 3.

## 7. Scanning

`POST /api/scans` (`src/app/api/scans/route.ts`) gains a protected path:

Checks that need no database run first, keeping the route's rule that a forged token cannot probe
for ticket existence:

1. If the token starts with `k2.`, it must have exactly six segments. Verify the bound token's
   Ed25519 signature and that `typ = "bound"`.
2. Verify `devsig` with the `dk` from the signed claims.
3. Accept `ts` only within `[now − 20 s, now + 10 s]` of server time (one 15-second refresh plus
   scan and network delay; the page corrects for the phone clock, section 6.2).

Then the database:

4. Load the ticket as today (scoped to the scanner's tenant), plus its intake's
   `ticket_protection` and its active `ticket_devices` row.
5. The intake must be protected (a `k2` token on an unprotected intake is a 404), and `dk` must equal
   the active row's `public_key`. No active row, or a different key (a revoked phone), is a 404.
6. Then the existing single-use or once-per-day admission update, with the existing 409 "already
   scanned" response unchanged.

A plain (non-`k2`) token for a ticket whose intake has `ticket_protection = true` is rejected with
the same 404. This shuts out tokens that leaked before protection or through an old email.
Unprotected events take the current path, unchanged.

Every rejection keeps the existing rule: one indistinguishable 404 for "not an admission". A load
error on the ticket, intake or `ticket_devices` is a 500, never a 404.

The same `ts` and `devsig` can be scanned again inside the window, but only until the first
admission; after that the existing 409 applies. A copy forwarded in real time and used inside
those 30 seconds is the live-sharing case from section 1.

**Scanner app (kuunyi-scanner, separate repo):** must accept the `k2.` format in its offline preview
and must send `token` in the scan request. Our notes say it currently sends no `token`, which already
makes every scan fail against the current route. Protected tickets need the scanner online, because
a revoked phone can only be detected on the server. Both scanner changes are required before any
gate test.

## 8. Closing the other places a QR appears (protected events)

| Surface | Change |
|---|---|
| E-ticket email attachment, `buildEticketEmailAttachment` in `src/server/tickets/eticketEmailAttachment.ts` | The protection check lives **here** (it already loads the intake): no PDF for protected intakes, whichever caller asks |
| Its six callers: `src/server/payments/notifyEnrollmentConfirmed.ts`, `src/server/notifications/dispatchPaymentApproved.ts`, `src/app/api/webhooks/mmpay/route.ts`, `src/app/api/webhooks/abank/route.ts`, `src/app/api/public/payments/abank/status/route.ts`, `src/app/api/admin/enrollments/[id]/resend-email/route.ts` (admin Resend Email) | Each builds its own email body; for protected intakes the body has no QR and a "View your ticket" button to `/account/tickets`. One shared helper decides, so a caller cannot forget |
| `GET /api/public/enrollment/[ref]` | Omits each ticket's `jwt` and `qr` fields for protected intakes (server-side) |
| Checkout success page and `/enroll/payment/[ref]` | Both read the route above, so they lose the QR with it; they show an "Open My Tickets" button instead of the QR and PDF download |
| QR export CLI script `scripts/export-ticket-qr.ts` (#456) | Ticket ids only for protected intakes; a plain token is refused at the gate anyway |

Admin, Telegram, messenger and the status lookup page show no ticket QR today (checked
2026-11-20). Tests assert the API response and each email caller's output, not only the page markup.

## 9. Pages and admin

**Buyer:**
- `/account`: email code sign-in, and sign-out.
- `/account/tickets`: the current tenant's tickets for this buyer, grouped by event.
- `/account/tickets/[id]`: the live QR with a 15-second countdown, event and tier, the account email
  (and the attendee name where the order has one), and the "open before you arrive, keep this page
  open" notice. Myanmar and English text like the other public pages.

**Admin:**
- Event settings: the "Account-bound tickets" toggle, disabled once the event has orders, with an
  explanation.
- Order or ticket view: the phone status (bound / not bound, last bound time, binds used).
- "Reset phone" per ticket: revokes the active device (`revoked_by = admin`) and resets the bind
  count. Logged to the existing admin audit trail if there is one, otherwise to `ticket_devices`.

**Account deletion:** blocked while the buyer holds a protected ticket that is still valid. After
that, the existing #451 deletion flow applies and revokes devices (`account_deleted`).

## 10. Migrations

One migration, applied to the dev DB first, and to production before the code that reads it:
- `intakes.ticket_protection` plus check constraint plus lock trigger;
- `buyer_profiles` and `enrollments.buyer_id` if #451 has not created them;
- `ticket_devices` plus partial unique index plus RLS (buyer reads own rows; writes via service role
  only);
- submit RPC changes to accept and require `buyer_id` for protected intakes.

Hash guards on function bodies must strip `chr(13)` (see the CRLF note in the repo's migration
conventions).

## 11. Testing

- **Unit:** bound token sign and verify; `k2` envelope parse (wrong segment count, non-canonical
  `ts`); `devsig` verify against a key made by WebCrypto; the time window edges; a wrong `dk`; a
  plain token refused for a protected ticket.
- **Database:** the bind function's limit, reset after an admin revoke, and two concurrent binds
  leaving exactly one active row.
- **Route:** `/api/scans` protected and unprotected paths, 404 vs 500 vs 409; `/api/public/enrollment/[ref]`
  omitting `jwt` and `qr`; each email caller sending no PDF for a protected order;
  `/api/me/tickets/{id}/device` ownership and limit; the enroll routes overriding the email; Edit
  Email refused; `requireBuyer` vs every staff gate in section 4, including middleware, in both
  directions.
- **Staging, with real phones:** buy on a protected test event; bind phone A; scan succeeds. A
  screenshot of A's QR scanned after 60 s fails. Phone B binds, then A's live QR fails and B's
  passes. Local runs are not evidence for the auth and RLS parts.

## 12. Dependencies and order

1. Close the private security advisories (#451 prerequisite).
2. Owner decision: #451 moves to email sign-in.
3. Resend SMTP set for Supabase Auth on dev, then staging.
4. kuunyi-scanner: send `token`, accept `k2.`.
5. This feature: migration, accounts, checkout, binding, scan path, surface closing, pages, admin.
6. Staging phone test (section 11), then production through the normal dev → staging → main flow,
   with the migration applied to production before the code.

## 13. Risks

- **Live screen-sharing** defeats it (accepted, section 1).
- **Lost or cleared phone at the gate** with no signal: the buyer cannot re-bind. Organisers need a
  help-desk path (admin reset plus the buyer signs in on the spot with signal).
- **Phone clock changed after the page loaded** (rare): the server-time offset taken on load
  (section 6.2) goes wrong and scans fail the window until the page is reloaded with signal.
- **Account handover** is a transfer the design cannot block (section 1).
- **Email deliverability:** sign-in depends on Resend reaching the buyer. Code emails must be
  monitored on launch day.
