type CartItem = { subtotal: number };

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
      feeAmount: cartItems.reduce((sum, item) => sum + item.subtotal, 0),
      unitFeeAmount: null,
    };
  }

  return {
    feeAmount: unitFeeAmount === null ? null : unitFeeAmount * (quantity ?? 1),
    unitFeeAmount,
  };
}
