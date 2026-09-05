type CartItem = { subtotal: number };

export type StatusTicketSubtotalInput = {
  items: CartItem[] | null | undefined;
  fee_amount: number | null;
  quantity: number | null | undefined;
};

/**
 * Ticket subtotal displayed for a public status response.
 *
 * A single-class response's `fee_amount` is already its line total, so
 * `quantity` deliberately does not participate in that branch.
 */
export function ticketSubtotal({ items, fee_amount }: StatusTicketSubtotalInput): number {
  return items && items.length > 0
    ? items.reduce((sum, item) => sum + item.subtotal, 0)
    : fee_amount ?? 0;
}

/**
 * Values exposed by the public status endpoint.
 *
 * `feeAmount` is always the ticket line total. A single-class order also
 * exposes `unitFeeAmount` so consumers never need to infer it by division.
 */
export function statusTicketAmounts(
  cartItems: CartItem[] | null,
  unitFeeAmount: number | null,
  quantity: number | null | undefined,
): { feeAmount: number | null; unitFeeAmount: number | null } {
  if (cartItems && cartItems.length > 0) {
    return {
      feeAmount: ticketSubtotal({ items: cartItems, fee_amount: null, quantity: null }),
      unitFeeAmount: null,
    };
  }

  return {
    feeAmount: unitFeeAmount === null ? null : unitFeeAmount * (quantity ?? 1),
    unitFeeAmount,
  };
}
