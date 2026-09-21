"use client";

// ─── Terms of Sale consent ──────────────────────────────────────────────────
//
// One required checkbox covering the KuuNyi Terms of Sale, the Privacy Policy
// and — when the event has any — the organiser's own rules, shown above it.
// Used on every surface that creates an order; the order API refuses one that
// does not carry this acceptance, so this box is a convenience, not the control.

interface TermsConsentProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The organiser's event rules, or null when the event has none. */
  organiserTerms: string | null;
  /** Set after the buyer tried to continue without ticking the box. */
  showError?: boolean;
  /** Tighter spacing for the sticky cart bar. */
  compact?: boolean;
}

export default function TermsConsent({
  checked,
  onChange,
  organiserTerms,
  showError = false,
  compact = false,
}: TermsConsentProps) {
  const link = "font-medium underline underline-offset-2";
  const text = compact ? "text-[11.5px]" : "text-sm";

  return (
    <div className={compact ? "mb-3" : "mb-5"}>
      {organiserTerms && (
        <details className="mb-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
          <summary className={`${text} cursor-pointer font-medium text-gray-800`}>
            Event rules / <span className="font-myanmar">ပွဲစည်းကမ်းများ</span>
          </summary>
          {/* Plain text on purpose: organiser input is never rendered as markup. */}
          <p className={`${text} mt-2 max-h-48 overflow-y-auto whitespace-pre-line text-gray-600`}>
            {organiserTerms}
          </p>
        </details>
      )}

      <label className="flex cursor-pointer items-start gap-2.5">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          aria-invalid={showError ? true : undefined}
          aria-describedby={showError ? "terms-consent-error" : undefined}
          className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-gray-300"
        />
        <span className={`${text} leading-snug text-gray-700`}>
          I agree to the{" "}
          <a href="/terms" target="_blank" rel="noopener noreferrer" className={link}>
            Terms of Sale
          </a>{" "}
          and{" "}
          <a href="/privacy" target="_blank" rel="noopener noreferrer" className={link}>
            Privacy Policy
          </a>
          {organiserTerms ? ", and the event rules above." : "."}
          <span className="font-myanmar mt-0.5 block text-gray-500">
            ရောင်းချမှုစည်းကမ်းချက်များနှင့် ကိုယ်ရေးအချက်အလက်မူဝါဒ
            {organiserTerms ? "၊ အထက်ပါ ပွဲစည်းကမ်းများ" : ""}ကို သဘောတူပါသည်။
          </span>
        </span>
      </label>

      {showError && (
        <p id="terms-consent-error" role="alert" className={`${text} mt-1.5 text-red-600`}>
          Please tick the box to continue.{" "}
          <span className="font-myanmar">ဆက်လက်ဆောင်ရွက်ရန် အမှတ်ခြစ်ပါ။</span>
        </p>
      )}
    </div>
  );
}
