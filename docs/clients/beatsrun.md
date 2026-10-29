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
    guideline (v1.0, Apr 2025) and a static sample page. The existing
    `MmqrCard` already follows the UI guideline.
  - On 2026-10-28 CB asked for a callback URL and a public IP to whitelist, for
    UAT and Live. Callback URLs for the reply (the tenant's canonical subdomain,
    never a custom domain, like the planned per-tenant KBZPay design):
    - Production: `https://beatsrun.kuunyi.com/api/webhooks/cbmmqr`
    - UAT/sandbox: `https://beatsrun.staging.kuunyi.com/api/webhooks/cbmmqr`
    - Both answered POST directly on 2026-10-29 (404 until the route exists,
      no redirect).
    - These replace the platform-wide `www.kuunyi.com` / `staging.kuunyi.com`
      URLs given in the 2026-10-23 paperwork.
  - The future route must be `src/app/api/webhooks/cbmmqr/route.ts` and the
    notify origin must produce exactly the URLs CB registers.
  - Public IP: no IP was given. Vercel has no fixed egress IP, so the reply asks
    CB whether whitelisting is mandatory and, if so, what alternative they
    accept for a serverless platform. TODO: CB's answer. If a fixed IP is
    required, the fallback is a static-IP proxy like `KBZPAY_PROXY_URL`.
  - Other open questions in the reply to CB: gateway base URLs (UAT and Live); whether CB
    calls the registered URL as given or appends the spec's
    `/dynamicqr/callback` path; UAT credentials and IDs; the meaning of
    return code `0006`, which the spec lists as both "invalid reference" and
    "waiting for payment"; QR lifetime (the sample page says 3 minutes) and the
    maximum amount; whether CB need screenshots for Central Bank approval.

## Branding

- Primary color: bright yellow `#FCFC10`. White button text is unreadable on it,
  so `readableTextColor()` (`src/lib/readableText.ts`) flips buttons to black text.
- TODO: template

## Notes / open items

- TODO
