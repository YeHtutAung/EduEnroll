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
  No code and no credentials exist yet, and merchant-account ownership (the
  organiser's own account or the platform's) is still undecided.
  - Callback URLs submitted to CB (platform-wide, not the tenant host):
    - Production: `https://www.kuunyi.com/api/webhooks/cbmmqr`
    - UAT/sandbox: `https://staging.kuunyi.com/api/webhooks/cbmmqr`
  - The future route must be `src/app/api/webhooks/cbmmqr/route.ts` and must
    produce exactly these URLs.
  - Open question for CB: does the gateway call the full registered URL, or
    append its spec's `/dynamicqr/callback` path?

## Branding

- Primary color: bright yellow `#FCFC10`. White button text is unreadable on it,
  so `readableTextColor()` (`src/lib/readableText.ts`) flips buttons to black text.
- TODO: template

## Notes / open items

- TODO
