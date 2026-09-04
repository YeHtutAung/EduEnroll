import { formatCurrencySimple } from "@/lib/utils";

export function OrderItemAmount({
  subtotal,
  unitPrice,
  quantity,
  currency,
}: {
  subtotal: number;
  unitPrice: number | null;
  quantity: number;
  currency: string;
}) {
  return (
    <div className="text-right">
      <span className="block text-sm font-semibold text-gray-900">
        {formatCurrencySimple(subtotal, currency)}
      </span>
      {unitPrice !== null && (
        <span className="text-xs text-gray-400">
          {formatCurrencySimple(unitPrice, currency)} × {quantity}
        </span>
      )}
    </div>
  );
}
