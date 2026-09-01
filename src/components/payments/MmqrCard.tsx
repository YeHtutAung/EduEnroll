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
// ── Why this is an SVG ──────────────────────────────────────────────────────
//
// The card must hold one ratio and one set of internal proportions at any
// width, and two earlier attempts to do that in CSS both failed:
//
//  1. A custom property holding `min(320px, 100%)`, with sizes as
//     `calc(var(--w) * 0.0435)`. A custom property containing a percentage is
//     substituted as tokens and re-resolved against whatever the USING
//     property means by `%` — and in font-size that is the parent's font size.
//     Labels rendered at 16px * 0.0435 = 0.7px while widths stayed right.
//
//  2. Pixels from a fixed `width` with `maxWidth: 100%`. The box narrowed while
//     the height and internals stayed pinned: measured inside the real panel, a
//     320px phone gave a 240x464 card, ratio 1.93 against the required 1.45,
//     with the QR overflowing the panel. Caught in review of PR #238.
//
// Measuring the container with ResizeObserver would fix (2), but it makes
// layout depend on a JS API that is throttled in background tabs and unreliable
// in embedded webviews — and payers open this inside bank and messenger
// in-app browsers.
//
// An SVG viewBox has none of these problems. Every coordinate below is in
// viewBox units on a 500x725 canvas, the browser scales the whole thing —
// text included — and `width: 100%` with `max-width` makes it responsive with
// no script and no percentage arithmetic. Container query units would also
// work but need Chrome 105+/Safari 16+, which is not a safe assumption here.

const VB_W = 500;
const VB_H = VB_W * (29 / 20); // 725

const HEADER_H = VB_H * 0.185;
const WORDING_H = VB_H * 0.125;
const QR = Math.min(VB_H * 0.44, VB_W * 0.75);
const SIDE = VB_W * 0.125;
const RULE_INSET = VB_W * 0.03;
const NAME_SIZE = VB_H * 0.03;
const AMOUNT_SIZE = VB_H * 0.06;
const CURRENCY_SIZE = VB_H * 0.03;

const YELLOW = "#FBD913";
const BLUE = "#17479E";

// Vertical rhythm, in viewBox units.
const RULE_Y = HEADER_H;
const WORDING_BASELINE = RULE_Y + WORDING_H * 0.72;
const QR_Y = RULE_Y + WORDING_H;
const NAME_BASELINE = QR_Y + QR + NAME_SIZE * 2;
const AMOUNT_BASELINE = NAME_BASELINE + AMOUNT_SIZE * 1.15;
const FOOTER_Y = VB_H - VB_H * 0.04;

const FONT = "Arial, Helvetica, sans-serif";

interface MmqrCardProps {
  /** Data URL of the rendered QR, or null while it is still being drawn. */
  qrImageUrl: string | null;
  /** Who receives the money — the merchant, never the payer. */
  receiverName: string;
  amount: number;
  currency: string;
  /** Widest the card may render. It shrinks freely below this. */
  maxWidth?: number;
}

export default function MmqrCard({
  qrImageUrl,
  receiverName,
  amount,
  currency,
  maxWidth = 320,
}: MmqrCardProps) {
  return (
    <svg
      data-testid="mmqr-card"
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      role="img"
      aria-label={`MMQR payment code for ${amount.toLocaleString("en-US")} ${currency} to ${receiverName}`}
      style={{ width: "100%", maxWidth, height: "auto", display: "block" }}
    >
      <rect width={VB_W} height={VB_H} fill="#ffffff" />

      {/* Header — logo at the centre, 18.5% of height */}
      <image
        href="/mmqr-logo.png"
        x={(VB_W - HEADER_H * 0.652) / 2}
        y={HEADER_H * 0.1}
        height={HEADER_H * 0.8}
        preserveAspectRatio="xMidYMid meet"
      />

      <line
        x1={RULE_INSET}
        y1={RULE_Y}
        x2={VB_W - RULE_INSET}
        y2={RULE_Y}
        stroke={YELLOW}
        strokeWidth={3}
      />

      {/* MMQR wording — top centre of the QR, 12.5% of height */}
      <text
        x={VB_W / 2}
        y={WORDING_BASELINE}
        textAnchor="middle"
        fontFamily={FONT}
        fontWeight="bold"
        fontSize={WORDING_H * 0.42}
        letterSpacing="0"
        fill={BLUE}
      >
        MMQR
      </text>

      {/* QR — 44% of height, left aligned with the text below it */}
      {qrImageUrl ? (
        <image href={qrImageUrl} x={SIDE} y={QR_Y} width={QR} height={QR} />
      ) : (
        <>
          <rect
            x={SIDE}
            y={QR_Y}
            width={QR}
            height={QR}
            fill="none"
            stroke="#e5e7eb"
            strokeWidth={2}
          />
          <text
            x={SIDE + QR / 2}
            y={QR_Y + QR / 2}
            textAnchor="middle"
            fontFamily={FONT}
            fontSize={NAME_SIZE}
            fill="#6b7280"
          >
            Rendering QR...
          </text>
        </>
      )}

      {/* Receiver and amount — left aligned with the QR. The guideline is
          explicit about this and gives its reason: a Cambodia Bakong user study
          found left-aligned values read in ~0.5s against 1-2s when centred.
          Not a taste call. */}
      <text
        x={SIDE}
        y={NAME_BASELINE}
        fontFamily={FONT}
        fontSize={NAME_SIZE}
        letterSpacing="0"
        fill="#000000"
      >
        {receiverName}
      </text>
      <text
        x={SIDE}
        y={AMOUNT_BASELINE}
        fontFamily={FONT}
        fontWeight="bold"
        fontSize={AMOUNT_SIZE}
        letterSpacing="0"
        fill="#000000"
      >
        {amount.toLocaleString("en-US")}
        <tspan fontSize={CURRENCY_SIZE} fontWeight="normal" dx={8}>
          {currency}
        </tspan>
      </text>

      <line
        x1={RULE_INSET}
        y1={FOOTER_Y}
        x2={VB_W - RULE_INSET}
        y2={FOOTER_Y}
        stroke={YELLOW}
        strokeWidth={3}
      />
    </svg>
  );
}
