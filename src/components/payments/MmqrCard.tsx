// ─── MMQR payment card ──────────────────────────────────────────────────────
//
// Layout follows the framed reference card KBZPay sent (2026-11-02), Option 1,
// on the proportions of the "Digital & POS Brand Guideline (Dynamic QR)":
//
//   card ratio        20:29
//   frame             1px border, solid blue footer rule; the QR sits inside it
//   header            full-width MyanmarPay banner (rule + logo + wordmark)
//   receiver + amount centred, ABOVE the QR (owner's call over the sample)
//   separator         dotted yellow rule, full width
//   MMQR wording      centred, black, directly above the QR
//   QR                70% of width, centred, wallet mark at its centre
//   receiver name     3% of height, amount 6%, currency 3%
//   font              Arial, letter-spacing 0%
//   colours           #ffffff  #000000  #FBD913  #17479E
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

const QR = VB_W * 0.7;
const NAME_SIZE = VB_H * 0.03;
const AMOUNT_SIZE = VB_H * 0.06;
const CURRENCY_SIZE = VB_H * 0.03;

// Pixel size of the shared banner asset, measured from the PNG header.
const BANNER_W = 1080;
const BANNER_H = 300;
const BANNER_DRAW_H = VB_W * (BANNER_H / BANNER_W);

// Vertical rhythm, in viewBox units.
const NAME_BASELINE = VB_H * 0.285;
const AMOUNT_BASELINE = VB_H * 0.355;
const DOTTED_Y = VB_H * 0.405;
const WORDING_BASELINE = VB_H * 0.455;
const BOTTOM_MARGIN = VB_H * 0.05;
const QR_Y = VB_H - BOTTOM_MARGIN - QR;
const QR_X = (VB_W - QR) / 2;
const FOOTER_H = 12;
const BORDER = 2;

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

      <image href="/cbmmqr/myanmarpay-banner.png" x={0} y={0} width={VB_W} height={BANNER_DRAW_H} />

      {/* Receiver and amount, above the QR */}
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
        x1={0}
        y1={DOTTED_Y}
        x2={VB_W}
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
        fill="#000000"
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

      {/* The frame: footer rule, then the border over everything */}
      <rect data-testid="mmqr-footer" x={0} y={VB_H - FOOTER_H} width={VB_W} height={FOOTER_H} fill={BLUE} />
      <rect
        data-testid="mmqr-frame"
        x={BORDER / 2}
        y={BORDER / 2}
        width={VB_W - BORDER}
        height={VB_H - BORDER}
        fill="none"
        stroke="#000000"
        strokeWidth={BORDER}
      />
    </svg>
  );
}
