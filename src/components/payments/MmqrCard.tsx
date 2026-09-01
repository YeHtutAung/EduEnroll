// ─── MMQR payment card ──────────────────────────────────────────────────────
// Layout is dictated by the MyanmarPay "Digital & POS Brand Guideline
// (Dynamic QR)", which KBZPay require merchants to follow when displaying an
// MMQR code. Every number here is the guideline's own figure:
//
//   card ratio        20:29
//   side margins      12.5% of width
//   header            18.5% of height, logo ~centre of header
//   header/footer     rules inset 3% of card
//   MMQR wording      12.5% of height, top centre of the QR
//   QR area           44% of height, capped at 75% of width
//   receiver name     3% of height
//   amount            6% of height
//   currency          3% of height
//   font              Arial, letter-spacing 0%
//   colours           #ffffff  #000000  #FBD913  #17479E
//
// Sizes are resolved to plain pixels here rather than expressed in CSS.
//
// That is deliberate, and the first attempt got it wrong in a way worth
// recording. It drove everything from a custom property holding
// `min(320px, 100%)` and sized text with `calc(var(--w) * 0.0435)`. A custom
// property containing a percentage is substituted as raw tokens and then
// re-resolved against whatever the *using* property means by `%` — and for
// font-size, `100%` is the PARENT'S FONT SIZE, not the container width. Every
// label came out 20x too small (16px * 0.0435) while the widths were correct,
// and the heights were wrong in a third way again. Percentages cannot be
// shared across properties this way; pixels can.

/** Guideline ratio: width 20, height 29. */
const HEIGHT_RATIO = 29 / 20;

const OF_HEIGHT = {
  header: 0.185,
  wording: 0.125,
  qr: 0.44,
  name: 0.03,
  amount: 0.06,
  currency: 0.03,
} as const;

const OF_WIDTH = {
  side: 0.125,
  ruleInset: 0.03,
  qrCap: 0.75,
} as const;

const YELLOW = "#FBD913";
const BLUE = "#17479E";

interface MmqrCardProps {
  /** Data URL of the rendered QR, or null while it is still being drawn. */
  qrImageUrl: string | null;
  /** Who receives the money — the merchant, never the payer. */
  receiverName: string;
  amount: number;
  currency: string;
  /** Card width in px. Every other dimension is derived from it. */
  width?: number;
}

export default function MmqrCard({
  qrImageUrl,
  receiverName,
  amount,
  currency,
  width = 320,
}: MmqrCardProps) {
  const height = width * HEIGHT_RATIO;

  const headerH = height * OF_HEIGHT.header;
  const wordingH = height * OF_HEIGHT.wording;
  const qr = Math.min(height * OF_HEIGHT.qr, width * OF_WIDTH.qrCap);
  const side = width * OF_WIDTH.side;
  const ruleInset = width * OF_WIDTH.ruleInset;
  const nameSize = height * OF_HEIGHT.name;
  const amountSize = height * OF_HEIGHT.amount;
  const currencySize = height * OF_HEIGHT.currency;

  const rule = {
    height: 2,
    backgroundColor: YELLOW,
    marginLeft: ruleInset,
    marginRight: ruleInset,
  };

  return (
    <div
      data-testid="mmqr-card"
      style={{
        width,
        height,
        maxWidth: "100%",
        backgroundColor: "#ffffff",
        color: "#000000",
        fontFamily: "Arial, Helvetica, sans-serif",
        letterSpacing: 0,
        lineHeight: "normal",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header — logo at the centre, 18.5% of height */}
      <div
        style={{
          height: headerH,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/mmqr-logo.png"
          alt="MyanmarPay MMQR"
          style={{ height: "82%", width: "auto" }}
        />
      </div>

      <div style={rule} />

      {/* MMQR wording — top centre of the QR, 12.5% of height */}
      <div
        style={{
          height: wordingH,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span style={{ fontSize: wordingH * 0.42, fontWeight: 700, color: BLUE }}>
          MMQR
        </span>
      </div>

      {/* QR — 44% of height, left aligned with the text below it */}
      <div style={{ marginLeft: side, width: qr, height: qr }}>
        {qrImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={qrImageUrl}
            alt="MMQR payment code"
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
          />
        ) : (
          <div
            style={{
              width: "100%",
              height: "100%",
              border: "1px solid #e5e7eb",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: nameSize,
              color: "#6b7280",
            }}
          >
            Rendering QR...
          </div>
        )}
      </div>

      {/* Receiver and amount — left aligned with the QR.
          The guideline is explicit that these are left aligned and gives its
          reason: a Cambodia Bakong user study found left-aligned values read in
          ~0.5s against 1-2s when centred. Not a taste call. */}
      <div style={{ marginLeft: side, marginTop: nameSize }}>
        <div style={{ fontSize: nameSize }}>{receiverName}</div>
        <div style={{ fontSize: amountSize, fontWeight: 700 }}>
          {amount.toLocaleString("en-US")}
          <span
            style={{ fontSize: currencySize, fontWeight: 400, marginLeft: width * 0.02 }}
          >
            {currency}
          </span>
        </div>
      </div>

      <div style={{ ...rule, marginTop: "auto", marginBottom: width * 0.04 }} />
    </div>
  );
}
