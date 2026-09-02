// ─── MMQR payment card ──────────────────────────────────────────────────────
//
// Layout follows the reference card MyanmarPay/KBZPay signed off, which the
// "Digital & POS Brand Guideline (Dynamic QR)" underpins:
//
//   card ratio        20:29
//   side margins      12.5% of width
//   header            logo sits ON the yellow rule
//   receiver + amount centred, ABOVE the QR
//   separator         dotted yellow rule
//   MMQR wording      centred, directly above the QR
//   QR                70% of width, centred, on the bottom margin
//   receiver name     3% of height, amount 6%, currency 3%
//   font              Arial, letter-spacing 0%
//   colours           #ffffff  #000000  #FBD913  #17479E
//
// The MyanmarPay mark is cropped to drop its own "MMQR" wordmark: the card
// already carries MMQR above the QR, and the duplicate was flagged for removal.
// 0-81.7% of the source height cuts through the blank band between
// "MyanmarPay" and that wordmark.
//
// ── Why this is an SVG ──────────────────────────────────────────────────────
//
// The card must hold one ratio and one set of internal proportions at any
// width, and two attempts to do that in CSS both failed:
//
//  1. A custom property holding `min(320px, 100%)` with `calc(var(--w) * k)`
//     sizes. `%` inside a custom property is re-resolved per property, and in
//     font-size it means the parent's font size — every label rendered at
//     0.7px while the widths stayed correct.
//  2. Fixed pixels with `maxWidth: 100%`. The box narrowed while the height
//     and internals stayed pinned: on a 320px phone, a 240x464 card at ratio
//     1.93 against the required 1.45, with the QR overflowing the panel.
//
// A viewBox has neither problem: coordinates are fixed in the markup and the
// browser scales the whole thing, text included.

const VB_W = 500;
const VB_H = VB_W * (29 / 20); // 725

const SIDE = VB_W * 0.125;
const RULE_INSET = VB_W * 0.03;
const QR = VB_W * 0.7;
const NAME_SIZE = VB_H * 0.03;
const AMOUNT_SIZE = VB_H * 0.06;
const CURRENCY_SIZE = VB_H * 0.03;

// Vertical rhythm, in viewBox units.
const RULE_Y = VB_H * 0.125;
const NAME_BASELINE = VB_H * 0.285;
const AMOUNT_BASELINE = VB_H * 0.355;
const DOTTED_Y = VB_H * 0.405;
const WORDING_BASELINE = VB_H * 0.455;
const BOTTOM_MARGIN = VB_H * 0.05;
const QR_Y = VB_H - BOTTOM_MARGIN - QR;
const QR_X = (VB_W - QR) / 2;

/** Logo height, straddling the rule. */
const LOGO_H = VB_H * 0.15;
/** Fraction of the logo's own height kept — drops its "MMQR" wordmark. */
const LOGO_CROP = 0.817;
/** Native aspect of the cropped mark, used to centre it without distortion. */
const LOGO_ASPECT = 1920 / 2432;

const YELLOW = "#FBD913";
const BLUE = "#17479E";
const FONT = "Arial, Helvetica, sans-serif";

interface MmqrCardProps {
  /** Data URL of the rendered QR, or null while it is still being drawn. */
  qrImageUrl: string | null;
  /** Who receives the money — the merchant, never the payer. */
  receiverName: string;
  amount: number;
  currency: string;
  /**
   * Wallet mark to place at the centre of the QR, or null for none.
   *
   * Only set this for a provider whose mark belongs there — an ABank or MMPay
   * tenant must not show KBZPay's. The QR must also be generated at error
   * correction H, or the covered modules cannot be recovered.
   */
  providerLogoUrl?: string | null;
  /** Widest the card may render. It shrinks freely below this. */
  maxWidth?: number;
}

export default function MmqrCard({
  qrImageUrl,
  receiverName,
  amount,
  currency,
  providerLogoUrl = null,
  maxWidth = 320,
}: MmqrCardProps) {
  // 18% of the QR. Level H recovers ~30% of modules, so a mark this size sits
  // well inside budget; the white plate gives the decoder a clean quiet zone.
  const markSize = QR * 0.18;
  const plate = markSize * 1.18;
  const qrCentreX = QR_X + QR / 2;
  const qrCentreY = QR_Y + QR / 2;

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

      {/* Header rule, with the logo sitting over it */}
      <line
        x1={RULE_INSET}
        y1={RULE_Y}
        x2={VB_W - RULE_INSET}
        y2={RULE_Y}
        stroke={YELLOW}
        strokeWidth={4}
      />
      {/* White plate so the rule does not run through the mark */}
      <rect
        x={(VB_W - LOGO_H * LOGO_ASPECT) / 2 - 8}
        y={RULE_Y - LOGO_H / 2 - 4}
        width={LOGO_H * LOGO_ASPECT + 16}
        height={LOGO_H + 8}
        fill="#ffffff"
      />
      {/* Cropped to drop the logo's own MMQR wordmark — the card carries one
          already, directly above the QR. */}
      <svg
        x={(VB_W - LOGO_H * LOGO_ASPECT) / 2}
        y={RULE_Y - LOGO_H / 2}
        width={LOGO_H * LOGO_ASPECT}
        height={LOGO_H}
        viewBox={`0 0 1920 ${Math.round(2943 * LOGO_CROP)}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <image href="/mmqr-logo.png" x={0} y={0} width={1920} height={2943} />
      </svg>

      {/* Receiver and amount — centred, above the QR */}
      <text
        x={VB_W / 2}
        y={NAME_BASELINE}
        textAnchor="middle"
        fontFamily={FONT}
        fontSize={NAME_SIZE}
        letterSpacing="0"
        fill="#000000"
      >
        {receiverName}
      </text>
      <text
        x={VB_W / 2}
        y={AMOUNT_BASELINE}
        textAnchor="middle"
        fontFamily={FONT}
        fontWeight="bold"
        fontSize={AMOUNT_SIZE}
        letterSpacing="0"
        fill="#000000"
      >
        {amount.toLocaleString("en-US")}
        <tspan fontSize={CURRENCY_SIZE} fontWeight="normal" dx={10}>
          {currency}
        </tspan>
      </text>

      {/* Dotted separator */}
      <line
        x1={SIDE}
        y1={DOTTED_Y}
        x2={VB_W - SIDE}
        y2={DOTTED_Y}
        stroke={YELLOW}
        strokeWidth={3}
        strokeDasharray="2 6"
        strokeLinecap="round"
      />

      {/* MMQR wording, directly above the QR */}
      <text
        x={VB_W / 2}
        y={WORDING_BASELINE}
        textAnchor="middle"
        fontFamily={FONT}
        fontSize={VB_H * 0.042}
        letterSpacing="0"
        fill={BLUE}
      >
        MMQR
      </text>

      {/* QR */}
      {qrImageUrl ? (
        <image href={qrImageUrl} x={QR_X} y={QR_Y} width={QR} height={QR} />
      ) : (
        <>
          <rect
            x={QR_X}
            y={QR_Y}
            width={QR}
            height={QR}
            fill="none"
            stroke="#e5e7eb"
            strokeWidth={2}
          />
          <text
            x={qrCentreX}
            y={qrCentreY}
            textAnchor="middle"
            fontFamily={FONT}
            fontSize={NAME_SIZE}
            fill="#6b7280"
          >
            Rendering QR...
          </text>
        </>
      )}

      {/* Wallet mark at the centre of the QR */}
      {qrImageUrl && providerLogoUrl && (
        <>
          <rect
            x={qrCentreX - plate / 2}
            y={qrCentreY - plate / 2}
            width={plate}
            height={plate}
            rx={plate * 0.14}
            fill="#ffffff"
          />
          <image
            href={providerLogoUrl}
            x={qrCentreX - markSize / 2}
            y={qrCentreY - markSize / 2}
            width={markSize}
            height={markSize}
            preserveAspectRatio="xMidYMid meet"
          />
        </>
      )}
    </svg>
  );
}
