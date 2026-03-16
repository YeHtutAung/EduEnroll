// Re-export the MMQR webhook handler at the sandbox callback URL path
// MyanMyanPay sandbox sends callbacks to: https://kuunyi.com/api/sandbox/payments/webhook
export { POST } from "@/app/api/public/payments/mmqr/webhook/route";
