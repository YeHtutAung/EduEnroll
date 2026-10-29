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
    through a static IP: either the existing `KBZPAY_PROXY_URL` host (as a
    `CBPAY_PROXY_URL`) or Vercel Static IPs. TODO: choose one and send the IP
    to CB.
  - Gateway base URLs (UAT and Live): CB will share them separately. TODO.
  - Return code `0006` (listed as both "Invalid Reference No." and "Waiting for
    payment"): CB's answer did not resolve it ("use the status check API"). Pin
    down its meaning in UAT before building on it.
  - QR validity: CB will update the sample page with the validity period (it
    currently says 3 minutes). TODO.
  - Maximum amount: not given. Amounts over the limit return `0052`. TODO: the
    actual limit, to check against ticket prices.
  - QR display: CB require the WebFrame sample layout, not our existing card
    as it is. Same as `MmqrCard`: MyanmarPay header, yellow dotted rule,
    "MMQR" label, colours. Different: receiver name and amount left-aligned
    (12.5% inset), QR at 80% of card width, CB Bank logo below the QR, a blue
    footer rule, and "QR will be expired in 3 mins" under the card. Needs a CB
    variant of `MmqrCard`; the KBZPay card stays unchanged.

## Branding

- Primary color: bright yellow `#FCFC10`. White button text is unreadable on it,
  so `readableTextColor()` (`src/lib/readableText.ts`) flips buttons to black text.
- TODO: template

## Notes / open items

- TODO
