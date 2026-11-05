"use client";

import { suggestEmailCorrection } from "@/lib/enrollment/emailAddress";

/**
 * Offers the address the person probably meant. It never blocks: a form that
 * shows this also lets an unusual address through on the second try.
 */
export default function EmailTypoHint({
  value,
  onUse,
}: {
  value: string;
  onUse: (email: string) => void;
}) {
  const suggestion = suggestEmailCorrection(value);
  if (!suggestion) return null;

  return (
    <p
      role="status"
      className="mt-1.5 rounded-md px-2.5 py-1.5 text-xs"
      style={{ background: "#fef3c7", color: "#78350f" }}
    >
      Did you mean{" "}
      <button
        type="button"
        onClick={() => onUse(suggestion)}
        className="font-semibold underline break-all"
        style={{ color: "#78350f" }}
      >
        {suggestion}
      </button>
      ?
    </p>
  );
}
