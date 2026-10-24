import type { CSSProperties } from "react";
import { formatCurrencySimple } from "@/lib/utils";
import { packInfo, type TemplateClass } from "./types";

/**
 * "3 tickets · Save 10,000 MMK" under a package tier's price. Renders nothing
 * for an ordinary tier, so templates can drop it in unconditionally. Colours
 * come from the caller because every template has its own palette.
 */
export default function PackBadge({
  cls,
  currency,
  className = "",
  style,
  savingsStyle,
}: {
  cls: Pick<TemplateClass, "fee_amount" | "pack_size" | "compare_at_amount">;
  currency: string;
  className?: string;
  style?: CSSProperties;
  savingsStyle?: CSSProperties;
}) {
  const pack = packInfo(cls);
  if (!pack) return null;
  return (
    <p className={`text-xs font-myanmar ${className}`} style={style}>
      {pack.size} tickets per package · လက်မှတ် {pack.size} စောင်
      {pack.savings !== null && (
        <>
          {" · "}
          <span className="font-semibold" style={savingsStyle}>
            Save {formatCurrencySimple(pack.savings, currency)}
          </span>
        </>
      )}
    </p>
  );
}
