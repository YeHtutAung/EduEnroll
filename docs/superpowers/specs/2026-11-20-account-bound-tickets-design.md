# Account-bound e-tickets, with seat sharing inside the order — design

Date: 2026-11-20
Status: revised 2026-11-20 for compatibility with the KuuNyi mobile backend contract
(`kuunyi-app/docs/specs/eduenroll-mobile-backend.md`, "the mobile spec" below). Sign-in identity
decided by the owner 2026-11-20: **email for both web and app** (section 4.1 (a)). The mobile spec
must be updated to match before either side builds buyer sign-in (section 4.1, "What this changes").
Revised 2026-11-22 to balance organisers and customers (owner decisions, section 2): group seats
can be shared by link (section 6.4), phone moves are unlimited, and the bind limit, admin "Reset
phone" and help-desk path are removed. Revised again 2026-11-22 (owner): no backup phone; Google
sign-in on the website first; a lost account is recovered by the organiser moving the order to the
buyer's new account (section 4.7).

## 1. Goal

Stop ticket resale for events that ask for it, without making group buyers arrive together. A
ticket (a "seat") for a protected event:

- belongs to one signed-in buyer account with a verified email, set before payment (the order's
  buyer, called "the leader" below);
- is held either by the leader (mode A, the default) or by one other account the leader shared it
  with by link (mode B, section 6.4);
- is shown only on its holder's signed-in ticket page, never in email or on public order pages;
- is presented at the gate as a QR that changes every 15 seconds and is signed by a key that never leaves the holder's phone, so a screenshot or a copied page does not work;
- can move only inside the order: the leader shares a seat with one account, the holder cannot pass
  it on, and all sharing and give-back close 24 hours before the event.

Out of scope, accepted:

- a reseller who live-shares their screen on a video call while the new holder stands at the gate;
- a reseller who hands over the account itself (the inbox or a forwarded sign-in code). The
  sign-in factor is the only factor, so the new holder can sign in and bind their phone. Each bind
  emails the account (section 6.1), but this is a transfer the design cannot block;
- **a leader who sells seat links.** Each claim is recorded with both accounts (section 6.4), so a
  sale is traceable, but it is not capped: there is no per-account limit beyond today's per-tier
  quantity caps;
- **no entry without a working phone.** There is no manual, ID-only or help-desk entry. A holder
  whose phone is lost, or who cannot sign in at the gate, does not get in. Refunds follow the
  organiser's policy; there are no face-value returns through the platform.

Organisers may still check ID against the account email shown on the ticket page; the design does
not require it.

## 2. Decisions

| Question | Decision |
|---|---|
| Where the buyer opens the ticket | Web profile now; the KuuNyi mobile app adopts the same scheme later |
| Sign-in identity | The verified email is the identity, shared by web and app — owner decision 2026-11-20, option (a) in section 4.1 |
| Ways to sign in | Email code, or "Continue with Google" on the website (same account when the Google email matches). The app keeps email codes; Google comes to the app later together with Sign in with Apple. No phone sign-in or backup phone. Owner decision 2026-11-22, section 4.1 |
| Lost account | The tenant owner moves the order to the buyer's new account after checking it (section 4.7), logged and emailed to both addresses. Owner decision 2026-11-22; the one exception to "no admin holder changes" |
| When the buyer signs in | Before checkout, on protected events |
| Live QR method | Phone-bound key: non-extractable WebCrypto key, QR re-signed every 15 s |
| Transfers | Inside the order only: the leader shares a seat by link with one account (one hop); the holder can give it back. Owner decision 2026-11-22 |
| Group seats | Mode A: stays with the leader (default). Mode B: shared to a friend's phone by link. No attendee accounts or friends' details at checkout. Owner decision 2026-11-22 |
| Sharing cutoff | Share, claim and give-back close 24 hours before the event (section 6.4). Owner decision 2026-11-22 |
| Taking a seat back | A friend can give a claimed seat back before the cutoff. The leader can cancel an unclaimed link but never take back a claimed seat. Owner decision 2026-11-22 |
| Phone moves | Unlimited, each emailed to the holder. No admin "Reset phone". Owner decision 2026-11-22 |
| Per-account limit | None beyond today's per-tier caps (accepted risk, section 1). Owner decision 2026-11-22 |
| No-phone entry | None: no ID seat, help desk or manual entry. The event page and checkout say "Smartphone required. Open your ticket before you arrive." Owner decision 2026-11-22 |
| Returns | No face-value returns; refunds follow the organiser's policy. Owner decision 2026-11-22 |

**The app later.** Until the app supports bound tickets, protected events are kept out of the app
entirely (section 8.2). When the app does adopt them, it must not use WebCrypto: the key has to be
hardware-backed (Android Keystore, iOS Secure Enclave) through a native module, and register through
the same bind endpoint and `ticket_devices` table. That is a separate future story with its own spec.
The QR format in section 6.2 (P-256, raw r||s) is chosen so both kinds of key can produce it.

## 3. Scope switch

- New column `intakes.ticket_protection boolean not null default false`.
- A check constraint allows `true` only when `ticket_qr_format = 'jwt'`. Events that third parties
  scan by bare ticket id (`uuid`) cannot use protection.
- The flag can change only while the intake has no enrollments. Enforced in the database
  (trigger), not only in the admin form.
- Existing events and orders are untouched. Nothing is converted.

## 4. Buyer accounts

Buyer accounts are shared with the KuuNyi mobile app. Everything here must stay compatible with the
mobile spec sections 4.3, 4.4, 6.1, 7 and 11.

### 4.1 Sign-in identity — decided: email for web and app

**Owner decision, 2026-11-20: option (a).** Buyers sign in with a 6-digit email code (Supabase Auth
email OTP) on the web and in the app. One person, one account, one ticket list.

- Supabase Auth SMTP is set to Resend in each project (the default mailer allows only a few emails
  per hour). Dev first.
- The verified email on the auth user is the identity. `buyer_profiles.email` copies it; the order
  email for a protected event is this email (section 5).
- **Email change is not offered**, but Supabase can't switch off `auth.updateUser({ email })`.
  "Secure email change" stays on, so both addresses must confirm, and an `AFTER UPDATE OF email`
  trigger on `auth.users` keeps `buyer_profiles.email` equal to the auth email in the same transaction
  (mobile spec 4.2). `requireBuyer` still fails closed (401) if they ever differ.
- Phone becomes an optional, unverified contact field (`buyer_profiles.phone_e164`), used to pre-fill
  forms. It is no longer unique or required. It is never verified and never signs anyone in; the
  organiser may use it to check a recovery request (section 4.7).
- No SMS is sent for buyer sign-in, and buyers without a Myanmar number can sign in.

**Ways in (owner decision 2026-11-22).** Email is not used daily by many buyers in Myanmar, and some
forget which address they used. The identity stays the verified email; there are two ways to prove
it, and one way back for a buyer who can do neither:

1. **Email code**, as above. Always offered.
2. **"Continue with Google"**, on the website (Supabase Google provider, PKCE redirect through a
   new `/auth/callback` route on the tenant host). Most Android phones already have a Google account
   signed in, so there is nothing to remember or type. Google returns a verified email, and Supabase
   links it to the existing auth user with the same address, so an email-code account and a Google
   sign-in for the same email are **one account**, never two. The plan must prove that linking, and
   that a Google sign-in for an address that has only an unconfirmed password sign-up does not
   inherit that sign-up's password (the `ensureBuyerProfile` reset covers it if it does).
   - Google refuses sign-in inside embedded browsers (Facebook, Messenger, Instagram, Viber and
     similar in-app browsers), and that is how many links are opened in Myanmar. The sign-in page
     detects them, hides the Google button there, and shows "Open in Chrome / Safari" with a
     copy-link button. The email code works everywhere, so it can never be removed.
   - Each tenant host (subdomains and custom domains such as `skyfestivalmm.com`) must be on the
     Supabase Redirect URLs allowlist, or Google sign-in returns to the wrong site. The plan lists
     it as an owner step per domain.
   - **Not in the app yet.** An app that offers Google sign-in must also offer Sign in with Apple
     on iOS (App Store guideline 4.8). The app keeps email codes until both are built together, as
     its own story. Because the account is shared, a buyer who joined with Google on the website
     signs in to the app with an email code to the same Gmail address.
3. **Recovery through the organiser** (section 4.7), for a buyer who has lost the mailbox and the
   Google account. There is no self-service recovery.

Both sign-in sessions are buyer sessions. Neither is a `password` session, so every staff gate
(section 4.4) refuses them; staff keep signing in with a password. The plan must record the `amr`
each produces (email code `otp`; Google to be confirmed), and `ensureBuyerProfile` must accept both
for creating a profile.

**What this changes in the mobile spec** (must be updated before either side builds buyer sign-in;
that is the app team's document, not edited by this work):
- 4.1: phone OTP and the SmsPoh Send SMS Hook are replaced by email OTP. The durable OTP caps move to
  per-email and per-IP. `signInWithOtp({ email })` / `verifyOtp({ email, token, type: 'email' })`.
- 4.1 App Review: Supabase's fixed-code test numbers are phone-only, so the reviewer account needs
  another way in (for example a reviewer address on a domain we control, read by us, or a
  superadmin-issued reviewer code). To be designed in the mobile spec.
- 4.2: "phone change not supported" becomes "email change not supported".
- 4.3: `requireBuyer` matches on email, not phone, and returns `email`.
- 4.4: `email` NOT NULL UNIQUE (from the auth user, verified); `phone_e164` nullable, not unique.
- 4.5: `POST /me` takes the email from the auth user, never the body; `phone` moves to the editable
  fields.
- 11.2: web deletion is by email code (`signInWithOtp({ email, options: { shouldCreateUser: false } })`),
  with the same "if an account exists, it has been deleted" answer.
- 4.1 (revision 2026-11-22): nothing for now. ADR-81 stands (no phone codes). Google sign-in in the
  app is a later story, shipped together with Sign in with Apple, on the same accounts. An order the
  organiser moves (section 4.7) shows up in the new account's `/me/orders` through `buyer_id`.

**Options not chosen**, kept for the record: (b) phone stays the identity and protected events add a
verified email on the same account (SMS cost per web sign-in, `+959` numbers only); (c) separate web
and app accounts (two unconnected accounts per person); (d) a verified backup phone that signs in by
SMS code to recover the account (designed 2026-11-22, dropped the same day by the owner): it brings
back SMS cost and the SmsPoh dependency that ADR-81 removed, recycled Myanmar SIMs would become a
way to take over accounts holding non-transferable tickets, and without passwords few buyers lose
access at all.

### 4.2 Tables

If this work lands before #451, it creates `buyer_profiles` and `enrollments.buyer_id` in **the full
mobile spec 4.4 / 7.1 shape**, adjusted for email identity, not a reduced one:

- `buyer_profiles`: `id` (PK, FK `auth.users(id)` ON DELETE CASCADE), `email` (NOT NULL UNIQUE,
  from the verified auth user), `phone_e164` (nullable, not unique), `name`, `locale` (`my` | `en`,
  default `my`), `created_at`, `updated_at`, `deleted_at`, `is_reviewer` (default false,
  superadmin-set).
- `enrollments.buyer_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL`, index
  `(buyer_id, enrolled_at DESC)`, and the `p_buyer_id` parameter on `submit_enrollment` /
  `submit_cart_enrollment` with the idempotency rule from mobile spec 7.1.

### 4.3 `requireBuyer`

One `requireBuyer` in `src/lib/api.ts`, used by web and mobile routes, behaving exactly as mobile
spec 4.3:

- Verify with `supabase.auth.getUser(token)`, which asks the Auth server. Never a local-only check
  (`getClaims`, or verifying the JWT with the project key): a deleted user or ended session must
  fail even while the JWT is unexpired. Web routes take the token from the cookie session; the call
  is the same.
- `401 UNAUTHENTICATED` **only** for a missing token or a real Auth rejection (a 4xx such as 401,
  403 `bad_jwt`, `session_not_found`, `user_not_found`, expired).
- `503` with code `SERVER` when Auth is unreachable, times out, answers 5xx, or answers 429. An Auth
  outage is never a 401, because the app signs the buyer out on 401.
- Require a `buyer_profiles` row with `deleted_at IS NULL` whose `email` equals the auth user's
  verified email.
- A staff account (a `users` row exists) → `403 FORBIDDEN`.
- Read `session_id` from the token only after `getUser` succeeds. A token without it → 401.
- Returns `{ buyerId, email, isReviewer, sessionId }`.

### 4.4 Staff gates

Buyers and staff share `auth.users`, so every staff gate must reject a buyer. Tests in both
directions:
- `requireAuth` / `requireOwner` (`src/lib/api.ts`), which already return 403 without a `users` row,
  and `requireSuperadmin` (`src/lib/superadminAuth.ts`);
- `src/middleware.ts`: today any signed-in user on `/login` is redirected to `/admin/dashboard`,
  and `/admin` only stops signed-out users. Both must tell a buyer apart from staff (buyer on
  `/login` stays there or goes to `/account`; buyer on `/admin` goes to `/account`);
- the admin and superadmin layouts.

**Email codes and staff accounts.** Email OTP is a project-wide Supabase setting, and staff also
have email addresses. Staff access is defined as requiring a password sign-in, so:
- Every staff gate above (`requireAuth`, `requireOwner`, `requireSuperadmin`, middleware, layouts)
  accepts a staff session only when the token's `amr` claim shows a `password` sign-in. A staff
  session made with an email code is treated as signed out for admin and gets 403 on admin APIs.
  The plan must confirm the `amr` contents on the dev project before relying on it.
- `requireBuyer` already refuses staff (403), so a staff member who wants to buy a protected ticket
  uses a different email. The sign-in page says so when a staff email asks for a code.

### 4.5 Sessions and ticket lists

- Web sessions are per host (tenant subdomain or custom domain): one account, signed in separately
  on each tenant site. `/account/tickets` lists **only the current tenant's** tickets.
- The app's `/api/mobile/v1/me/tickets` is **cross-tenant**: every tenant's tickets for the buyer.
  The two lists are meant to differ; neither should be "fixed" to match the other.

### 4.6 Prerequisite

The private security advisories that #451 says must be closed before buyer sign-up is enabled.

### 4.7 Recovering a lost account (organiser moves the order)

For a buyer who can no longer sign in to the account that bought the order: the mailbox is gone and
there is no Google account for it. Rare without passwords; handled by people, not by a
self-service flow.

1. The buyer signs in on the tenant's site with a new email or Google, which creates a new buyer
   account, and contacts the organiser.
2. The organiser checks the request outside the system: the order reference, the payment proof or
   payer details, and the contact phone on the order. The page lists these as the checks to make.
3. The tenant **owner** (`requireOwner`, password session) opens the order and uses "Move order to
   another account": the new account's email and a required reason.
4. One SQL function, `move_order_buyer(enrollment, tenant, staff_user, to_buyer, reason)` (service
   role only), locks the enrollment and its tickets `FOR UPDATE` and refuses, with one generic
   error:
   - an order from another tenant, or one that is not confirmed;
   - an order whose `buyer_id` is NULL (the old account was deleted; section 9 promises those
     tickets cannot be recovered);
   - a target that has no live `buyer_profiles` row, is staff (a `users` row) or is the current
     buyer;
   - an event whose last day has ended.
5. It sets `enrollments.buyer_id` to the new account, revokes the active `ticket_devices` row of
   every seat still with the leader (`revoked_by = 'order_moved'`), cancels the open share links the
   old leader made (Plan 4), and logs `order_moved` in `ticket_holder_events` for each of those
   seats with the staff user as actor. Seats already claimed by friends stay with them. The move is
   also written to `order_moves` (`id`, `enrollment_id`, `tenant_id`, `from_buyer_id`,
   `to_buyer_id`, `moved_by` (FK `users`), `reason`, `created_at`; RLS with no policies; never
   updated or deleted).
6. Both addresses are emailed, in Myanmar and English: the old one "Order <ref> was moved to another
   account by <organiser>", so a real owner notices a wrong move; the new one "Order <ref> was added
   to your account".

The new account binds its phone as usual (section 6.1). The admin order view shows every move. A
dishonest staff member could move an order to someone else; the owner-only rule, the log and the
email to the old address are the controls (section 13).

## 5. Checkout on a protected event

1. The enrollment form first asks for the buyer's email and sends a code; the buyer enters it and is
   signed in. An already-signed-in buyer skips this. A mistyped email can't receive the code, so
   typo'd order emails cannot happen on protected events.
2. The email field is filled from the account's verified email and read-only. The read-only field
   is only a convenience: the enroll routes (`src/app/api/public/enroll/route.ts`,
   `src/app/api/public/enroll/[slug]/route.ts`) overwrite the order email with the account's
   verified email on the server for protected intakes.
3. The submit RPCs take `buyer_id` from the server-verified session, never from the request body.
   The route rejects a protected-event submission with no buyer session (401).
4. All tickets in the order belong to the buyer (the leader) and start with the leader. Checkout
   asks for no friends' accounts or contact details. Anyone arriving separately gets their seat by
   a share link after purchase (section 6.4); everyone else enters on the leader's phone. Attendee
   names (for example one per runner) stay as data on the ticket, unchanged by sharing; they do not
   create accounts.
5. Admin "Edit Email" (#425) is refused for protected orders in
   `src/app/api/admin/enrollments/[id]/email/route.ts` (409), and the button is hidden. The email
   is the identity.
6. The protected event's public page and the checkout show, in Myanmar and English: "Smartphone
   required. Open your ticket before you arrive." The leader's confirmation says seats can be shared
   from My Tickets until 24 hours before the event.

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
- `POST /api/me/tickets/{ticketId}/device` with that public key. `requireBuyer()`; the buyer must be
  the ticket's **current holder** (section 6.4: `tickets.holder_buyer_id`, or the order's buyer when
  that is NULL), and the ticket must be valid and on a protected intake. Anyone else gets 404.
- New table `ticket_devices`: `id`, `ticket_id`, `buyer_id` (FK `auth.users(id)` **ON DELETE SET
  NULL**, so rows outlive a deleted account), `public_key`, `created_at`, `revoked_at`, `revoked_by`
  (`rebind` | `holder_changed` | `account_deleted` | `order_moved`). Partial unique index: one row with
  `revoked_at is null` per ticket. Rows are never deleted; they are the audit trail.
- Binding the key that is already active for the ticket is a no-op (returns the current token).
- **No bind limit** (owner decision 2026-11-22). A holder can move to a new phone any number of
  times, including on event day; each move revokes the previous phone (`revoked_by = 'rebind'`), so
  only one phone can show a working QR. There is no admin "Reset phone": a holder who changes or
  loses a phone signs in on the new one and opens the ticket. Losing the key is still made rarer:
  - the ticket page asks iOS buyers to add it to the Home Screen, which keeps its storage out of
    Safari's 7-day deletion (section 6.3);
  - repeat binds are emailed to the holder (below), so an unexpected one is visible.
- Abuse protection only: at most 30 phone *changes* per buyer per hour; re-opening a ticket on the
  bound phone is never counted (Plan 3, Task 7).
- The holder check, revoking the old row and inserting the new one run in **one SQL function**
  (service role only), locking the ticket row, so concurrent binds cannot leave two active rows,
  and a bind racing a claim or give-back (section 6.4) cannot leave the previous holder's phone
  active. supabase-js has no transactions, so this cannot be done in the route.
- **Bind email:** the first bind per (ticket, holder) sends nothing; every later bind by that
  holder sends them a short email ("Your ticket was opened on a new phone"). So a friend's first
  bind after claiming, or the leader's after a give-back, is silent.
- The route passes the host's tenant id; the function refuses a ticket whose `tenant_id` differs
  (same 404).
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
- **As built (Plan 3, Task 8):** each QR is signed 5 s ahead of its slot start, and the clock
  offset is anchored to the moment the bind response arrived. A QR on screen therefore carries a
  `ts` from about 11 s behind to 5 s ahead of server time, which leaves about 9 s for the
  scanner's upload inside the scan window.
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
- Clearing site data, or a private-browsing window, loses the key. The holder binds again, which
  needs signal and the sign-in email.
- **iOS Safari deletes script-written storage, IndexedDB included, after 7 days of Safari use
  without a visit to the site.** A buyer who binds a week or more before the event and doesn't open
  the page again can lose the key and arrive needing a re-bind, with signal. Mitigations: the ticket
  page asks iOS buyers to add it to the Home Screen (Home Screen web apps keep their own storage,
  outside that rule); the confirmation and reminder messages say to open the ticket again before the
  event day; and binding is deferred until the buyer first opens the ticket, not done at purchase.
  The plan must confirm the current WebKit behaviour on a real iPhone before relying on the Home
  Screen exemption.

### 6.4 Sharing a seat

For a group that does not arrive together. Only the leader shares, and only seats they still hold.

**Data** (new):
- `tickets.holder_buyer_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL`. NULL means the
  seat is with the order's buyer (`enrollments.buyer_id`). "Current holder" everywhere in this spec
  means `coalesce(holder_buyer_id, enrollments.buyer_id)`.
- `ticket_share_links`: `id`, `ticket_id`, `token_hash` (SHA-256 of the raw token, unique),
  `created_by` (the leader, FK ON DELETE SET NULL), `created_at`, `expires_at` (the cutoff),
  `claimed_by` (FK ON DELETE SET NULL), `claimed_at`, `cancelled_at`. Partial unique index: at most
  one open link (not claimed, not cancelled) per ticket. **Only the hash is stored**; the raw token
  exists only in the link the leader sends.
- `ticket_holder_events`: `id`, `ticket_id`, `event` (`link_created` | `link_cancelled` | `claimed`
  | `given_back` | `holder_deleted` | `voided` | `order_moved`), `actor_buyer_id`, `from_buyer_id`, `to_buyer_id` (all FK ON
  DELETE SET NULL), `created_at`. Never updated or deleted; the organiser's record of every move.
- All three, and `ticket_devices` (section 10): RLS enabled with **no policies**, so only the
  service role reads or writes them. Writes go only through the functions below; buyers and admins
  read through the routes.

**Cutoff:** `classes.event_date` is a DATE, so the cutoff is the start of that date in
`Asia/Yangon` minus 24 hours, compared with database time (`now()`). The zone is fixed in SQL (plpgsql
cannot read the `TICKET_TZ` env var, and a route must not pass it); a test asserts it equals the
app's `TICKET_TZ` default. An event with no `event_date` offers no sharing (fails closed). Multi-day
events use the first day. The cutoff is **recomputed from the current `event_date` under the lock**
in every function; `ticket_share_links.expires_at` is display only, so an admin moving the date
moves the cutoff with it.

**Seat state checks** shared by create, claim and give-back: the ticket `status = 'valid'`, on a protected
intake, `first_scan_at IS NULL` (never admitted), `tickets.tenant_id` equal to the tenant id the
route passes from the host, and the time before the cutoff.

**Database functions** (service role only; each locks the ticket row `FOR UPDATE` before deciding):
- `create_share_link(ticket, tenant, leader, token_hash)`: the caller must be the order's buyer and
  the seat unclaimed (`holder_buyer_id` NULL). Cancels any open link for the seat, inserts the new
  one, logs `link_created`.
- `cancel_share_link(ticket, tenant, leader)`: cancels the open link, logs `link_cancelled`. A
  no-op if there is none. Checks only the tenant match and that the caller is the leader, so it
  also works after the cutoff and on a voided or admitted seat.
- `claim_share_link(token_hash, tenant, claimer)`: looks the link up by hash without locking, then
  locks its ticket `FOR UPDATE` and **re-reads the link and the seat under the lock**, so a replace,
  cancel or second claim racing it is seen. The link must be open, the seat still unclaimed, and
  the claimer must not be the leader. Sets `holder_buyer_id`, marks the link claimed, revokes the
  seat's active `ticket_devices` row (`holder_changed`), logs `claimed`. A claimer may hold several
  seats; there is no per-account limit.
- `give_back_seat(ticket, tenant, holder)`: the caller must be `holder_buyer_id`, and the order must
  still have a buyer (`enrollments.buyer_id IS NOT NULL`): after the leader's account is deleted a
  give-back would leave the seat with no one, so it is refused and the button hidden. Clears
  `holder_buyer_id`, revokes the holder's active device row (`holder_changed`), logs `given_back`.
  The seat is with the leader again and can be shared again.
- Every function returns one generic failure to the route for any refused case, so a claim cannot
  probe whether a link existed, was used or was cancelled.

**Voided seats** (refund, cancellation: `voidTicketsForEnrollment` in
`src/server/tickets/issueTickets.ts` sets `status = 'void'`): voiding also cancels the seat's open
link and logs `voided` in `ticket_holder_events`, under the same ticket-row lock (one SQL function
the void path calls, since supabase-js has no transactions). The holder is kept as a record and no
email is sent. `/account/tickets` shows the seat as "Cancelled" to both leader and holder. The scan
already refuses a void ticket.

**Routes** (`requireBuyer()`, on the tenant's own host, passing the host's tenant id). Rate limits
use the durable `consume_rate_limit(key, window, limit)` RPC that Plan 2 creates (section 12),
never the in-memory `src/lib/rateLimit.ts`. Starting values, tunable in the plan: share and cancel
20 per buyer per hour; claim 10 per buyer and 30 per IP per 15 minutes; give-back 10 per buyer per
hour. Over the limit is 429:
- `POST /api/me/tickets/{id}/share` → the share link, returned once. The route makes 32 random
  bytes (base64url) and passes only the hash to the function. Calling it again replaces the old
  link.
- `DELETE /api/me/tickets/{id}/share` → cancels the open link.
- `POST /api/me/tickets/{id}/give-back`.
- `POST /api/me/tickets/claim` with `{ token }` → the claimed ticket's id. Any refusal is one 404
  "This link no longer works".

**Link format:** `https://<tenant host>/t/claim#<token>`. The token is in the fragment, so browsers
never send it in a request to our servers or logs. Client-side scripts can still read
`location.href`, so:
- `/t/claim` loads **no** per-tenant GTM, Meta pixel or other analytics (the tag loader excludes the
  path), and
- the first inline script on the page, before any other script, copies the fragment into memory
  and strips it with `history.replaceState`.
The page then asks for email-code sign-in if needed (the token survives the sign-in step in
`sessionStorage`, cleared as soon as the claim request returns, whether it succeeded or failed), shows the event and tier, and posts it on "Claim this
seat".

**Emails** (Myanmar and English, through the existing mailer):
- To the leader: "Your seat was claimed by k***@gmail.com" and "A seat was given back to you".
- To the holder: "Your ticket was opened on a new phone" (section 6.1).

**Deleting an account** (section 9 adds this to the deletion steps):
- A friend's account: their held seats get `holder_deleted` logged and their device rows revoked
  (`account_deleted`); `holder_buyer_id` then becomes NULL by the FK, so **the seat returns to the
  leader**, who can open or re-share it.
- The leader's account: open links are cancelled; seats still with the leader stop working, as in
  section 9; seats already claimed by friends keep working, since their holder still exists.

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
   Because a claim, give-back or phone move always revokes the previous phone (sections 6.1, 6.4),
   the active row should always be the current holder's. As defence in depth the scan also requires
   the active row's `buyer_id` to equal the current holder; a mismatch is the same 404.
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

### 8.1 Web

| Surface | Change |
|---|---|
| E-ticket email attachment, `buildEticketEmailAttachment` in `src/server/tickets/eticketEmailAttachment.ts` | The protection check lives **here** (it already loads the intake): no PDF for protected intakes, whichever caller asks |
| Its six callers: `src/server/payments/notifyEnrollmentConfirmed.ts`, `src/server/notifications/dispatchPaymentApproved.ts`, `src/app/api/webhooks/mmpay/route.ts`, `src/app/api/webhooks/abank/route.ts`, `src/app/api/public/payments/abank/status/route.ts`, `src/app/api/admin/enrollments/[id]/resend-email/route.ts` (admin Resend Email) | Each builds its own email body; for protected intakes the body has no QR and a "View your ticket" button to `/account/tickets`. One shared helper decides, so a caller cannot forget |
| `GET /api/public/enrollment/[ref]` | Omits each ticket's `jwt` and `qr` fields for protected intakes (server-side) |
| Checkout success page and `/enroll/payment/[ref]` | Both read the route above, so they lose the QR with it; they show an "Open My Tickets" button instead of the QR and PDF download |
| QR export CLI script `scripts/export-ticket-qr.ts` (#456) | Ticket ids only for protected intakes; a plain token is refused at the gate anyway |

Admin, Telegram, messenger and the status lookup page show no ticket QR today (checked
2026-11-20). Tests assert the API response and each email caller's output, not only the page markup.

### 8.2 Mobile API (until the app supports bound tickets)

Without this, the app could buy a protected ticket the gate then rejects: `POST
/api/mobile/v1/orders` is not behind the web checkout's sign-in gate, and `/me/tickets` returns the
plain ticket JWT, which section 7 refuses with a 404. The `/api/mobile/v1/*` routes are not on
`dev` yet (checked 2026-11-20); these rules bind whichever of this work and #451 lands second.

| Surface (mobile spec section) | Change |
|---|---|
| Event listing conditions (6.1) | Add **`intakes.ticket_protection = false`** to the conditions. 6.1 is per tenant, so this one is checked per event: `GET /events` omits protected events, and `GET /events/{tenant}/{slug}` and `POST /orders` return `EVENT_NOT_SUPPORTED` for them. The reviewer exception does not override it |
| `POST /api/mobile/v1/orders` (7.1) | Re-checks protection server-side and returns `EVENT_NOT_SUPPORTED`, so a stale app or a direct call can't buy one |
| `GET /api/mobile/v1/me/tickets` (7.4) | Never returns `qr` (or any JWT) for a protected ticket. It is left out of the snapshot entirely, because `Ticket.qr` is a required string in the contract |
| `GET /api/mobile/v1/me/orders/{ref}` (7.4) | Same: no protected ticket in `tickets[]`, so no `qr`. The order itself can still be listed |
| Issue on read and re-sign on read (7.4) | Never sign a plain JWT for a protected ticket on these paths |

When the app gains hardware-backed binding (section 2), it gets its own bind and ticket contract,
and these rules are relaxed in that story, not before.

## 9. Pages and admin

**Buyer:**
- `/account`: email code sign-in, and sign-out.
- `/account/tickets`: the current tenant's seats this buyer holds, grouped by event. For the
  leader, seats they shared also appear, with their status ("Link sent", "Claimed by
  k***@gmail.com") but no QR.
- `/account/tickets/[id]`: the live QR with a 15-second countdown, event and tier, the account email
  (and the attendee name where the order has one), and the "open before you arrive, keep this page
  open" notice. Before the cutoff it also shows "Share this seat" (leader, unclaimed seat: create,
  copy or cancel the link) or "Give back to <leader>" (friend). Myanmar and English text like the
  other public pages.
- `/t/claim`: section 6.4.

**Admin:**
- Event settings: the "Account-bound tickets" toggle, disabled once the event has orders, with an
  explanation.
- Order or ticket view, read-only: each seat's current holder (masked email), link status, phone
  status (bound / not bound, last bound time) and the `ticket_holder_events` history.
- No "Reset phone" and no admin holder changes (owner decision 2026-11-22), with one exception: the
  owner-only "Move order to another account" for a lost account (section 4.7).

**Account deletion is never blocked.** These are also the app's accounts, and Apple guideline
5.1.1(v) and Google Play both require that users can delete their account in the app. Mobile spec
11 deletes immediately; this feature keeps that:

- **Warning before confirming**, in the app (`DELETE /api/mobile/v1/me`), on the web deletion page
  (mobile spec 11.2) and on `/account`: tickets for account-bound events stop working at once and
  cannot be recovered, by signing up again or by order reference. The mobile spec 11.1 text
  ("upcoming tickets stay valid") gets this exception. The app shows the line always, not only when
  the account holds such a ticket, so no new API is needed.
- **Server step**, added to mobile spec 11.1 after step 1 (`deleted_at` set) and before
  `auth.admin.deleteUser`: revoke every active `ticket_devices` row of the buyer with
  `revoked_by = 'account_deleted'`. Idempotent like the other steps, and also run by the 15-minute
  sweep (11.1 step 6), so a deletion that fails part-way still revokes. The same step logs
  `holder_deleted` for seats the buyer holds as a friend and cancels open links the buyer created
  (section 6.4).
- After `deleteUser`, `enrollments.buyer_id`, `tickets.holder_buyer_id` and
  `ticket_devices.buyer_id` become NULL (SET NULL). A seat whose current holder was the deleted
  leader has no owner and no active phone, so it can never be bound or admitted again. A seat held
  by a deleted friend returns to the leader. A seat a friend holds keeps working after the leader's
  deletion. The order, payment and ticket rows stay as the organiser's records, under the retention
  rule in mobile spec 11.
- Any refund for the dead ticket is the organiser's call, as today. The warning says so.

## 10. Migrations

One migration per plan (section 12), each applied to the dev DB first, and to production before the
code that reads it:
- Plan 2: `buyer_profiles` and `enrollments.buyer_id` if #451 has not created them, in the full
  mobile spec shape (section 4.2), plus the durable `consume_rate_limit` RPC and its counter table
  (service role only);
- Plan 3: `intakes.ticket_protection` plus check constraint plus lock trigger; `ticket_devices` plus
  partial unique index plus RLS with no policies (service role only, section 6.4); the bind
  function; submit RPC changes to accept and require `buyer_id` for protected intakes; `order_moves`
  and `move_order_buyer` (section 4.7);
- Plan 4: `tickets.holder_buyer_id`, `ticket_share_links`, `ticket_holder_events` with RLS, the four
  sharing functions and the void function (section 6.4), the bind function updated to check
  the current holder and tenant, and `move_order_buyer` updated to cancel share links and log
  `order_moved`.

Hash guards on function bodies must strip `chr(13)` (see the CRLF note in the repo's migration
conventions).

## 11. Testing

- **Unit:** bound token sign and verify; `k2` envelope parse (wrong segment count, non-canonical
  `ts`); `devsig` verify against a key made by WebCrypto; the time window edges; a wrong `dk`; a
  plain token refused for a protected ticket.
- **Database:** two concurrent binds leave exactly one active row; a bind by anyone but the current
  holder is refused; many re-binds in a row all succeed and leave one active row.
- **Sharing (section 6.4):** create, cancel and replace a link (only one open); claim by the leader
  refused; two concurrent claims of one link give one holder; a bind racing a claim leaves only the
  new holder able to bind; give-back by anyone but the holder refused; share, claim and give-back
  one second before and after the cutoff, and with no `event_date`; a claimed, cancelled, replaced,
  expired and unknown token all give the same 404; a friend cannot share; deleting a friend's
  account returns the seat to the leader; deleting the leader's account leaves a friend's seat
  working and refuses its give-back; every move writes one `ticket_holder_events` row; voiding a
  seat with an open link cancels the link, and a claim racing a void never leaves a claimed void
  seat with an open link; a link from tenant X posted on tenant Y's host is refused (also for share,
  give-back and bind); moving `event_date` moves the cutoff for an existing link; share, claim and
  give-back refused on an admitted seat; the cutoff zone equals the `TICKET_TZ` default; `/t/claim`
  loads no third-party tag and its URL has no fragment once the first script has run; a scan with
  an active row whose `buyer_id` is not the current holder is a 404.
- **Route:** `/api/scans` protected and unprotected paths, 404 vs 500 vs 409; `/api/public/enrollment/[ref]`
  omitting `jwt` and `qr`; each email caller sending no PDF for a protected order;
  `/api/me/tickets/{id}/device` holder check; the share routes' rate limits and that no route or
  log line contains the raw link token; the enroll routes overriding the email; Edit
  Email refused; `requireBuyer` vs every staff gate in section 4.4, including middleware, in both
  directions.
- **Staff and email codes (section 4.4):** a staff account signed in with an email code gets 403 on
  admin and superadmin APIs and is sent away from `/admin`; the same account signed in with its
  password is unaffected.
- **Ways in (section 4.1):** a Google sign-in for an existing email-code account lands on the same
  auth user and profile; a Google sign-in creates a profile on first use; a Google session gets 403
  on every staff gate; the Google button is hidden in in-app browsers.
- **Order move (section 4.7):** only a tenant owner with a password session can move; each refusal
  in 4.7 step 4 gives the same error; a move revokes the leader-held seats' devices, leaves friends'
  seats alone, cancels the old leader's open links, writes one `order_moves` row and one
  `order_moved` event per affected seat, and emails both addresses; the old account no longer sees
  the order and the new one does, on the web and in `/me/orders`.
- **`requireBuyer` (section 4.3):** auth email different from `buyer_profiles.email` → 401;
  Auth rejection → 401; Auth unreachable, timeout, 5xx and 429 →
  503 `SERVER`, never 401; staff account → 403; deleted profile → 401; token without `session_id`
  → 401; claims never read before `getUser` succeeds.
- **Mobile routes (section 8.2):** `GET /events` omits a protected event; `GET
  /events/{tenant}/{slug}` and `POST /orders` return `EVENT_NOT_SUPPORTED` for one (including for a
  reviewer); `/me/tickets` and `/me/orders/{ref}` return no `qr` or JWT for a protected ticket,
  including the issue-on-read path.
- **Deletion (section 9):** deleting an account with a bound protected ticket succeeds, revokes the
  device with `account_deleted`, and the ticket's next scan is a 404; a retried or swept deletion
  revokes too.
- **Staging, with real phones:** buy on a protected test event; bind phone A; scan succeeds. A
  screenshot of A's QR scanned after 60 s fails. Phone B binds, then A's live QR fails and B's
  passes. The leader shares a second seat; a friend claims it on phone C; the leader's QR for that
  seat fails and C's passes; the friend gives it back and C's fails. Local runs are not evidence for
  the auth and RLS parts.

## 12. Dependencies and order

1. Close the private security advisories (#451 prerequisite).
2. Sign-in identity: **decided 2026-11-20, email for web and app** (section 4.1). The mobile spec
   (kuunyi-app) and #451 are updated to email sign-in, including a new App Review reviewer route,
   before either side builds buyer sign-in.
3. Resend SMTP set for Supabase Auth on dev, then staging. Staff gates require a `password` sign-in
   (section 4.4) **before** email OTP is turned on in any project.
4. **Plan 1** (#471): staff gates require a password session. Done on dev and staging.
5. **Plan 2:** buyer accounts (section 4): email code first, then Google sign-in on the website. It
   also creates the durable `consume_rate_limit` RPC that Plans 3 and 4 use. Owner prerequisites: a
   Google OAuth client for the Supabase Google provider, and every tenant host on the Redirect URLs
   allowlist.
6. kuunyi-scanner: send `token`, accept `k2.`. Needed before any gate test of Plan 3.
7. **Plan 3:** the leader's phone (mode A): scope switch, checkout, binding with no limit, the `k2`
   QR, the scan path, closing the other QR surfaces, `/account/tickets`, the admin read-only view,
   the order move (section 4.7) and the deletion step. Mode A works end to end.
8. **Plan 4:** seat sharing (mode B, section 6.4): the tables and functions, the share, claim and
   give-back routes, `/t/claim`, the emails and the holder history in admin. Built on Plan 3, since a
   claim revokes a bound phone.
9. Staging phone test (section 11) after each of Plans 3 and 4. Changes go dev → staging only while
   the owner's release freeze on main (2026-11-21) holds; production later through the normal flow,
   with each migration applied to production before its code.

## 13. Risks

- **Live screen-sharing** defeats it (accepted, section 1).
- **Seat links can be sold** (accepted, section 1). Every claim is logged with both accounts, so
  the organiser can see who passed seats to whom, but nothing caps it.
- **Lost or cleared phone at the gate** with no signal: the holder cannot re-bind, and there is no
  manual or help-desk entry (accepted, section 1). With signal and access to their email, they sign
  in on any phone and bind it (no limit). Mitigations: the "Smartphone required" notice, the
  reminder to open the ticket before arriving, and Home Screen install.
- **Phone clock changed after the page loaded** (rare): the server-time offset taken on load
  (section 6.2) goes wrong and scans fail the window until the page is reloaded with signal.
- **Account handover** is a transfer the design cannot block (section 1); unlimited phone moves
  make it easier. Each move emails the holder.
- **iOS storage deletion:** Safari can delete the IndexedDB key after 7 days without a visit
  (section 6.3), so early buyers may need a re-bind at the gate, which needs signal. Home Screen
  install and reminders reduce it.
- **A friend misses the cutoff:** a seat not claimed 24 hours before the event stays with the
  leader, and the friend can enter only on the leader's phone. The share page and the leader's
  reminder say when sharing closes.
- **Organiser support load:** with no reset and only one admin change (the order move for a lost
  account, section 4.7), seat problems are solved by the buyers themselves (share, give-back,
  re-bind). Organisers need the read-only history (section 9) to answer questions, and must check
  each move request by hand.
- **A wrong or dishonest order move:** a staff member could move an order to someone who isn't its
  buyer, which is a resale path. Only the tenant owner can move, every move is logged with a reason,
  and the old address is emailed. Accepted.
- **Email deliverability:** email-code sign-in depends on Resend reaching the buyer. Code emails
  must be monitored on launch day. Google sign-in keeps buyers who use it able to sign in during a
  Resend outage; everyone else, and everyone in the app, waits for email.
- **Google in in-app browsers:** Google blocks sign-in in Facebook, Messenger and similar embedded
  browsers. The page hides the button there and says to open the page in Chrome or Safari; buyers
  who don't will use the email code.
- **Staff accounts and email codes:** email OTP is project-wide, so staff gates must refuse
  non-password sessions (section 4.4) before it is turned on.
- **App and web drift:** until the app supports bound tickets, protected events are invisible in
  the app (section 8.2). A buyer may see an event on the web that the app doesn't list.
- **A rebind racing an admission:** the scan checks the active phone, then admits; a rebind landing
  between the two lets the old phone in once (Plan 3, decision 6). Accepted.
- **Tag scripts on the same site:** a script on the tenant's host runs as the signed-in buyer and
  could bind its own phone. Tenant tag scripts are off on the whole host while the tenant has a live
  protected event (owner decision 2026-11-23, Plan 3 decision 8).
- **A page opened before protection keeps its tags:** a tag script that loaded before the event was
  protected stays on an already-open page until a full reload. Accepted.
- **Edits wait behind checkouts:** during an on-sale every checkout holds a share lock on its
  intake row, so an organiser's edit of that event can wait behind checkouts (Plan 3, Task 1).
- **The bind limit is approximate:** it counts key changes after a non-atomic pre-read, so
  concurrent requests from the buyer's own session can pass it by about 2×. The new-phone email's
  10-minute slot is used up even when the send fails, so a failed send is not retried in that
  window. Accepted: the limit is abuse protection only (section 6.1).
- **Known gap, `intakes_update` RLS:** the policy lets any authenticated member of a tenant update
  any intake column through PostgREST, `ticket_protection` included. The admin route that switches
  protection is owner-only, but closing it in the database is a follow-up, not done in Plan 3.
