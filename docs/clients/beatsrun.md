# The Beats Run (BeatsRun)

## Identity

- Tenant slug: `beatsrun`
- Display name: The Beats Run
- TODO: org_type, currency, enrollment reference prefix

## Hosts

- Canonical: https://beatsrun.kuunyi.com
- TODO: staging host, custom domain (if any — must be added to `TENANT_CUSTOM_DOMAINS`)

## Payments

- TODO: current `payment_mode` / methods in use.
- CB Bank MMQR — **in onboarding, not built.** Paperwork started on 2026-10-23.
  No code and no credentials exist yet.
  - CB merchant name: YOUNG MONEY CO.,LTD (the organiser's own merchant account,
    not the platform's).
  - Docs from CB: QR Gateway API spec v1.0.10 (30 Jul 2026), an MMQR UI
    guideline (v1.0, Apr 2025) and a static sample page ("E-commerce MMQR
    WebFrame").
  - Callback URLs sent to CB on 2026-10-29 (the tenant's canonical subdomain,
    never a custom domain, like the planned per-tenant KBZPay design):
    - Production: `https://beatsrun.kuunyi.com/api/webhooks/cbmmqr`
    - UAT/sandbox: `https://beatsrun.staging.kuunyi.com/api/webhooks/cbmmqr`
      — **to be replaced**: UAT runs locally behind a tunnel (see the IP
      blocker below), so the UAT callback must be the tunnel host. TODO: pick
      the host, then send it to CB with the office IP.
    - Both answered POST directly on 2026-10-29 (404 until the route exists,
      no redirect).
    - These replace the platform-wide `www.kuunyi.com` / `staging.kuunyi.com`
      URLs given in the 2026-10-23 paperwork.
    - CB confirmed (2026-10-29) that the gateway calls the URL exactly as
      given. It does not append the spec's `/dynamicqr/callback` path.
  - The future route must be `src/app/api/webhooks/cbmmqr/route.ts` and the
    notify origin must produce exactly these URLs.
  - **Blocker: public IP whitelisting is mandatory.** CB answered on 2026-10-29
    and did not offer an alternative. UAT credentials and integration
    parameters will be issued only after IP whitelisting and callback setup
    are complete. Vercel has no fixed egress IP, so CB traffic must leave
    through a static IP.
    - **UAT: decided 2026-10-30 — office IP plus a tunnel**, as for KBZPay.
      The app runs locally (port 3005), calls CB from the office's public IP,
      and a Cloudflare tunnel exposes the callback route. Consequences:
      - The UAT callback URL already sent to CB (staging) must be replaced by
        the tunnel URL, and the CB notify origin set to the tunnel host in
        `.env.local`.
      - The office IP is not fixed. TODO: ask CB whether they will update the
        whitelist when it changes (KBZ agreed to), and check the current IP
        before sending it.
      - TODO: send CB the office IP and the tunnel callback URL. CB issue UAT
        credentials only after this.
    - **Live: not decided.** TODO: choose and send the IP to CB before go-live.
      Options:
      - A new static-IP proxy host. No such host exists yet:
        `src/lib/kbzpay.ts` only supports one, and `KBZPAY_PROXY_URL` was
        unset everywhere when that code merged (2026-08-31, PR #234). A CB
        client could use the same mechanism (e.g. `CBPAY_PROXY_URL`).
      - Vercel Static IPs.
  - Gateway base URLs (UAT and Live): CB will share them separately. TODO.
  - Amounts: the spec sets a minimum of 1,000 (`0051`), so the UAT test item
    must be at least 1,000 MMK (the KBZPay UAT used 100 MMK) and tickets below
    that cannot use CB. The maximum is not given: amounts over it return
    `0052`, and the spec's text is a placeholder ("xxxxx"). TODO: the actual
    maximum, to check against ticket prices.
  - QR validity: each `/dynamicqr` response carries `qrExpiredDateTime` (the
    spec's example is 3 minutes after issue). The countdown and the "expired"
    text must come from that field, not a hard-coded 3 minutes. CB will also
    update the sample page with the period.
  - Return codes: v1.0.10 §4.2 gives `0006` two meanings ("Invalid Reference
    No." and "Waiting for payment"); `0017` and `0018` are duplicated too, so
    a code alone does not identify the outcome. CB answered that the reference
    only exists once the payment completes and to use the status check. Until
    UAT shows otherwise, treat `0006` from the status check as not paid yet:
    keep polling, and never fail the enrollment or release the seat on it.
  - Callback: the request authenticates only with a static `apiKey` in the
    body; there is no signature. The route must check the key and then
    confirm with the status check (`PATCH /dynamicqr/{qrReferenceNo}/status`)
    before marking the payment verified. The response body carries
    `qrReferenceNo`, `returnCode` and `message`.
  - Token: `/auth/token` returns `expiredDateTime`. Reuse the token until then
    and fetch a new one on `0012` (Token Expired).
  - QR display: CB require the WebFrame sample layout (CB's reply of
    2026-10-29), so CB needs its own variant of `MmqrCard`; the KBZPay card
    stays unchanged. The sample against `MmqrCard`:
    - Header: one full-width MyanmarPay banner image (yellow rule, logo and
      "MyanmarPay" wordmark), not cropped.
    - Receiver name and amount left-aligned at a 12.5% inset; the currency
      follows the amount. Amount shown with two decimals (`100,000.00`).
    - Yellow (`#FBD913`) dotted rule across the full card width, not inset.
    - "MMQR" label centred and **black**, not blue.
    - QR at 80% of card width, CB Bank logo at 20% width centred below it.
    - A solid blue rule at the bottom, in `#264EA1` (not `#17479E`), and a
      1px grey border round the card.
    - "QR will be expired in 3 mins..." under the card, outside it.
    - The sample uses Calibri, but CB's UI guideline says Arial: keep Arial.
    - The sample has no fixed ratio; the UI guideline requires 20:29. At an
      80% QR the content only just fits 20:29, so the CB card needs its own
      vertical layout and cannot reuse `MmqrCard`'s.
    - The UI guideline also says the QR must be at least 0.6 inches and that
      account numbers may not appear on the card.
  - Central Bank approval: CB's UI guideline says participants must submit
    their mockups to the Central Bank of Myanmar for approval. CB's reply did
    not mention this. TODO: submit the CB card mockup once it is built.

## Branding

- Primary color: bright yellow `#FCFC10`. White button text is unreadable on it,
  so `readableTextColor()` (`src/lib/readableText.ts`) flips buttons to black text.
- TODO: template

## Notes / open items

- TODO
