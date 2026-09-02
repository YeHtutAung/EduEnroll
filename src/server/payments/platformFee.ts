// ─── Online platform fee ────────────────────────────────────────────────────
//
// The single place an order total is worked out. It exists because the total
// was previously recomputed independently in eight payment routes — abank,
// hitpay, kbzpay, mmpay, paypay, stripe (x2) and upload — each summing
// fee_amount * quantity by hand.
//
// That duplication is dangerous now. Settlement compares what the provider
// reports against the amount stored on the payment row:
//
//   if (Number(observedAmount) !== Number(payment.amount)) -> amount_mismatch
//
// so a route that forgets the fee sends the gateway a different figure than we
// recorded, and the payment is refused after the payer has already been
// charged. Money taken, no ticket. One calculator, called by every route, is
// what prevents that; kbzpay-total-coverage.test.ts enforces it.

/** Fee settings as stored on the tenant. */
export type PlatformFeeConfig = {
  platform_fee_mode?: string | null;
  platform_fee_amount?: number | null;
  /** Fees apply to online gateways only; a bank_transfer tenant pays none. */
  payment_mode?: string | null;
};

export type OrderItem = {
  fee_amount: number;
  quantity: number;
};

export type OrderTotal = {
  /** Tickets alone. */
  ticketSubtotal: number;
  /** The platform fee, already included in `total`. */
  platformFee: number;
  /** What the payer is asked for, and what the gateway is sent. */
  total: number;
  /** Tickets across the order, which drives the per_ticket mode. */
  ticketCount: number;
};

/**
 * Manual bank transfer is not an online gateway. Charging a platform fee there
 * would bill for a service that was never used, and the name says "online".
 */
function chargesOnlineFee(tenant: PlatformFeeConfig): boolean {
  return (tenant.payment_mode ?? "") !== "bank_transfer";
}

export function computePlatformFee(
  tenant: PlatformFeeConfig,
  ticketSubtotal: number,
  ticketCount: number,
): number {
  if (!chargesOnlineFee(tenant)) return 0;

  const amount = Math.max(0, Math.trunc(tenant.platform_fee_amount ?? 0));
  if (amount === 0) return 0;

  // A free order stays free. Adding a fee to a zero subtotal turns a
  // no-payment enrolment into one that must go through a gateway.
  if (ticketSubtotal <= 0) return 0;

  switch (tenant.platform_fee_mode) {
    case "per_transaction":
      return amount;
    case "per_ticket":
      return amount * Math.max(0, ticketCount);
    default:
      return 0;
  }
}

/**
 * The order total, fee included.
 *
 * `alreadyPaid` covers the partial-payment top-up: the fee was charged on the
 * first payment, so the remainder must not carry it a second time.
 */
export function computeOrderTotal(
  items: OrderItem[],
  tenant: PlatformFeeConfig,
  alreadyPaid = 0,
): OrderTotal {
  const ticketSubtotal = items.reduce(
    (sum, item) => sum + item.fee_amount * item.quantity,
    0,
  );
  const ticketCount = items.reduce((sum, item) => sum + item.quantity, 0);

  const platformFee =
    alreadyPaid > 0 ? 0 : computePlatformFee(tenant, ticketSubtotal, ticketCount);

  return {
    ticketSubtotal,
    platformFee,
    ticketCount,
    total: ticketSubtotal + platformFee - alreadyPaid,
  };
}

// ─── Resolving an order total from an enrollment ────────────────────────────

type EnrollmentLike = {
  tenant_id: string;
  quantity?: number | null;
  classes?: { fee_amount: number } | null;
  enrollment_items?: { fee_amount: number; quantity: number }[] | null;
};

/**
 * Only `from` is needed, and it is deliberately opaque.
 *
 * Typing this against the generated Database types made the checker report
 * "Type instantiation is excessively deep" and rejected the real client, so
 * the query is built through a narrow local shape instead. The cast is
 * confined to this function rather than spread across eight call sites.
 */
type FeeQueryClient = { from: (table: string) => unknown };

type TenantQuery = {
  select: (cols: string) => {
    eq: (col: string, val: string) => {
      maybeSingle: () => PromiseLike<{ data: unknown }>;
    };
  };
};

/**
 * The payable total for an enrollment, fee included.
 *
 * Every payment route calls this rather than summing line items itself. Four
 * of them did not previously read the tenant at all, so putting the lookup
 * here is what keeps a fee from being silently omitted by whichever route the
 * tenant happens to use — an omission that surfaces as amount_mismatch after
 * the payer has been charged.
 */
export async function resolveOrderTotal(
  supabase: FeeQueryClient,
  enrollment: EnrollmentLike,
  alreadyPaid = 0,
): Promise<OrderTotal> {
  const items: OrderItem[] =
    enrollment.enrollment_items && enrollment.enrollment_items.length > 0
      ? enrollment.enrollment_items.map((i) => ({
          fee_amount: i.fee_amount,
          quantity: i.quantity,
        }))
      : enrollment.classes
        ? [{ fee_amount: enrollment.classes.fee_amount, quantity: enrollment.quantity ?? 1 }]
        : [];

  // A tenant row that cannot be read must not invent a fee: charging one we
  // are unsure of is worse than charging none, and the failure would only be
  // visible as amount_mismatch after the payer had been debited.
  let config: PlatformFeeConfig = {};
  try {
    const { data } = await (supabase.from("tenants") as TenantQuery)
      .select("payment_mode, platform_fee_mode, platform_fee_amount")
      .eq("id", enrollment.tenant_id)
      .maybeSingle();
    if (data) config = data as PlatformFeeConfig;
  } catch (err) {
    console.error("[platform-fee] tenant lookup failed; charging no fee:", err);
  }

  return computeOrderTotal(items, config, alreadyPaid);
}

// ─── What a completed order reports ─────────────────────────────────────────

/**
 * The split to display for an order.
 *
 * Once money has moved the payment row is the truth: `payments.amount` is
 * immutable, while the tenant's fee settings are not. Recomputing from current
 * settings would let an admin edit the setting and change what a COMPLETED
 * order says it was charged, so the receipt would disagree with the money.
 *
 * Before payment there is no such record, and quoting the current setting is
 * right — it is what the buyer would be charged.
 */
export function displayTotals(
  ticketSubtotal: number,
  chargedAmount: number | null,
  feeIfUnpaid: number,
): { platformFee: number; total: number } {
  // An order total can never be less than the tickets it contains. A smaller
  // figure is a REMAINDER, not a total — a partial-payment top-up row, whose
  // amount is the balance left over.
  //
  // That distinction is load-bearing. `request_remaining` sets verified_at and
  // received_amount on the original row but never moves its status to
  // 'verified', so on a partial order the only row that looks verified can be
  // the top-up. Reporting its amount would tell a customer their 1,000 order
  // cost 600. Rejecting anything below the subtotal makes the answer
  // independent of which row is found, and of the order rows come back in.
  const isOrderTotal = chargedAmount !== null && chargedAmount >= ticketSubtotal;

  if (!isOrderTotal) {
    return { platformFee: feeIfUnpaid, total: ticketSubtotal + feeIfUnpaid };
  }

  // Derived rather than stored, against a subtotal that cannot move because
  // enrollment_items snapshot their price.
  return { platformFee: chargedAmount - ticketSubtotal, total: chargedAmount };
}

// ─── Gateway line items ─────────────────────────────────────────────────────

export type GatewayLineItem = { name: string; amount: number; quantity: number };

/**
 * Line items that sum to `total`, or a single balance line when they cannot.
 *
 * MMPay and Stripe are sent line items alongside a total and reject the order
 * when the two disagree. The items describe the WHOLE order, so the moment a
 * partial payment reduces the amount to a remainder they stop summing to it.
 * Stripe already collapsed to one line here; MMPay did not, and had been
 * sending a mismatched payload since before the platform fee existed.
 */
export function reconcileLineItems(
  items: GatewayLineItem[],
  total: number,
  balanceLabel = "Remaining balance",
): GatewayLineItem[] {
  const sum = items.reduce((n, i) => n + i.amount * i.quantity, 0);
  if (sum === total) return items;

  return [{ name: balanceLabel, amount: total, quantity: 1 }];
}
