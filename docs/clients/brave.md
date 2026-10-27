# Brave (Louder Myanmar)

## Identity

- Tenant slug: `brave`
- Display name: Louder Myanmar
- org_type: `event` — currency MMK
- Enrollment reference prefix: `LM-` (e.g. `LM-0904-XXXX`)

## Hosts

- Canonical: https://brave.kuunyi.com
- Staging: https://brave.staging.kuunyi.com
- Custom domain: loudermyanmar.com, mapped in the `TENANT_CUSTOM_DOMAINS` env var.
  Student-facing links (emails, SMS, Telegram) use the custom domain through
  `tenantLinkOrigin()`. The payment return-URL allowlist keeps **both** hosts.
  See `src/lib/origin.ts`.

## Payments

- KBZPay MMQR — webhook `src/app/api/webhooks/kbzmmqr/`
- Callback URLs registered with KBZPay:
  - Production: `https://brave.kuunyi.com/api/webhooks/kbzmmqr`
  - UAT/staging: `https://brave.staging.kuunyi.com/api/webhooks/kbzmmqr`
- `KBZPAY_NOTIFY_ORIGIN` must match the registered URL exactly. The apex domain
  307-redirects, and a redirected POST is lost. Design notes:
  `docs/superpowers/specs/2026-08-20-kbzpay-mmqr-integration-design.md`.
- TODO: confirm the tenant's `payment_mode` / other methods in use.

## Branding

- TODO: template, primary color

## Notes / open items

- TODO
