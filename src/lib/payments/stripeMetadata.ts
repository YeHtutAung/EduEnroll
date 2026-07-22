// The shared Stripe metadata contract (Plan v18 §4). Every object this
// integration creates carries ALL six fields ON ITSELF — audit H attributes
// objects from the Stripe side alone, so a parent-only contract (the old
// Session-only metadata) leaves the underlying PaymentIntent unattributable.

export const STRIPE_METADATA_NAMESPACE = "eduenroll";
export const STRIPE_METADATA_VERSION = "1";

export type IntegrationFlow = "direct_payment_intent" | "hosted_checkout";

export function buildStripeMetadata(args: {
  flow: IntegrationFlow;
  tenantId: string;
  enrollmentId: string;
  enrollmentRef: string;
}): Record<string, string> {
  return {
    integration_namespace: STRIPE_METADATA_NAMESPACE,
    integration_version: STRIPE_METADATA_VERSION,
    integration_flow: args.flow,
    tenant_id: args.tenantId,
    enrollment_id: args.enrollmentId,
    enrollment_ref: args.enrollmentRef,
  };
}
