// Re-export the MMQR webhook handler at the production callback URL path
// MyanMyanPay production sends callbacks to: https://{host}/api/payments/webhook
export { POST } from "@/app/api/public/payments/mmpay/webhook/route";
