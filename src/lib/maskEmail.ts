/** "kyaw@gmail.com" -> "k***@gmail.com". Anything unusable -> "***". */
export function maskEmail(email: string | null | undefined): string {
  const parts = (email ?? "").split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return "***";
  // Array.from splits by code point, so an emoji first character stays whole.
  return `${Array.from(parts[0])[0]}***@${parts[1]}`;
}
