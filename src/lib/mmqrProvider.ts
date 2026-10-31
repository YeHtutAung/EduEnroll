// The MMQR providers a tenant can choose (tenants.mmqr_provider). One list, so
// a new provider cannot be known in one place and silently become MMPay in
// another (CB spec §4.2).

export type MmqrProvider = "abank" | "mmpay" | "kbzpay" | "cbmmqr";

const KNOWN: ReadonlySet<string> = new Set<MmqrProvider>(["abank", "mmpay", "kbzpay", "cbmmqr"]);

/** A known provider as is; anything else becomes the caller's fallback. */
export function normaliseMmqrProvider(value: unknown, fallback: MmqrProvider): MmqrProvider {
  return typeof value === "string" && KNOWN.has(value) ? (value as MmqrProvider) : fallback;
}
