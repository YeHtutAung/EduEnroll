// ─── CB Bank MMQR card ──────────────────────────────────────────────────────
//
// CB require their "E-commerce MMQR WebFrame" layout (CB email, 2026-10-29),
// not MmqrCard's. From CB's sample page and CB's UI guideline v1.0:
//
//   card ratio        20:29 (guideline; the sample itself has no fixed ratio)
//   header            full-width MyanmarPay banner (rule + logo + wordmark)
//   receiver + amount LEFT-aligned at a 12.5% inset, amount with 2 decimals
//   separator         yellow dotted rule, full width
//   MMQR wording      centred, BLACK
//   QR                80% of width, centred
//   CB Bank logo      20% of width, centred below the QR
//   footer            solid #264EA1 rule; 1px grey border round the card
//   font              Arial (guideline) — the sample uses Calibri
//
// At an 80% QR the content only just fits 20:29, so the vertical layout below
// is its own; MmqrCard's constants do not apply. Same SVG technique as
// MmqrCard (see its header for why CSS failed twice).

const VB_W = 500;
const VB_H = VB_W * (29 / 20); // 725

// Pixel sizes of the two assets in public/cbmmqr/, measured from the PNG headers.
const BANNER_W = 1080;
const BANNER_H = 300;
const LOGO_W = 371;
const LOGO_H = 160;

const INSET = VB_W * 0.125; // 62.5
const QR = VB_W * 0.8; // 400
const QR_X = (VB_W - QR) / 2; // 50
const LOGO_DRAW_W = VB_W * 0.2; // 100
const LOGO_DRAW_H = LOGO_DRAW_W * (LOGO_H / LOGO_W);
const BANNER_DRAW_H = VB_W * (BANNER_H / BANNER_W);

const NAME_SIZE = VB_H * 0.03;
const AMOUNT_SIZE = VB_H * 0.06;
const CURRENCY_SIZE = VB_H * 0.03;
const MMQR_SIZE = 30;

// Vertical rhythm, top to bottom, in viewBox units. The plan's gaps (32, 45,
// 18, 34, 10, 6) overflowed with the measured 1080x300 banner (logo bottom at
// 727 of 725), so each is 2 units smaller; the QR stays at 80%.
const NAME_BASELINE = BANNER_DRAW_H + 30;
const AMOUNT_BASELINE = NAME_BASELINE + 43;
const DOTTED_Y = AMOUNT_BASELINE + 16;
const MMQR_BASELINE = DOTTED_Y + 32;
const QR_Y = MMQR_BASELINE + 8;
const LOGO_Y = QR_Y + QR + 4;
const FOOTER_Y = VB_H - 2;

const YELLOW = "#FBD913";
const CB_BLUE = "#264EA1";
const GREY = "#808080";
const FONT = "Arial, Helvetica, sans-serif";

interface CbMmqrCardProps {
  /** Data URL of the rendered QR, or null while it is still being drawn. */
  qrImageUrl: string | null;
  /** Who receives the money — the merchant, never the payer. */
  receiverName: string;
  amount: number;
  currency: string;
  /** Widest the card may render. It shrinks freely below this. */
  maxWidth?: number;
}

export default function CbMmqrCard({ qrImageUrl, receiverName, amount, currency, maxWidth = 320 }: CbMmqrCardProps) {
  const amountText = amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <svg
      data-testid="cb-mmqr-card"
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      role="img"
      aria-label={`MMQR payment code for ${amountText} ${currency} to ${receiverName}`}
      style={{ width: "100%", maxWidth, height: "auto", display: "block" }}
    >
      <rect width={VB_W} height={VB_H} fill="#ffffff" />
      <rect x={0.5} y={0.5} width={VB_W - 1} height={VB_H - 1} fill="none" stroke={GREY} strokeWidth={1} />

      <image href="/cbmmqr/myanmarpay-banner.png" x={0} y={0} width={VB_W} height={BANNER_DRAW_H} />

      <text x={INSET} y={NAME_BASELINE} textAnchor="start" fontFamily={FONT} fontSize={NAME_SIZE} letterSpacing="0" fill="#000000">
        {receiverName}
      </text>
      <text x={INSET} y={AMOUNT_BASELINE} textAnchor="start" fontFamily={FONT} fontWeight="bold" fontSize={AMOUNT_SIZE} letterSpacing="0" fill="#000000">
        {amountText}
        <tspan fontSize={CURRENCY_SIZE} fontWeight="normal" dx={10}>
          {currency}
        </tspan>
      </text>

      <line x1={0} y1={DOTTED_Y} x2={VB_W} y2={DOTTED_Y} stroke={YELLOW} strokeWidth={3} strokeDasharray="2 6" strokeLinecap="round" />

      <text x={VB_W / 2} y={MMQR_BASELINE} textAnchor="middle" fontFamily={FONT} fontSize={MMQR_SIZE} letterSpacing="0" fill="#000000">
        MMQR
      </text>

      {qrImageUrl ? (
        <image href={qrImageUrl} x={QR_X} y={QR_Y} width={QR} height={QR} />
      ) : (
        <>
          <rect x={QR_X} y={QR_Y} width={QR} height={QR} fill="none" stroke="#e5e7eb" strokeWidth={2} />
          <text x={VB_W / 2} y={QR_Y + QR / 2} textAnchor="middle" fontFamily={FONT} fontSize={NAME_SIZE} fill="#6b7280">
            Rendering QR...
          </text>
        </>
      )}

      <image href="/cbmmqr/cb-bank-logo.png" x={(VB_W - LOGO_DRAW_W) / 2} y={LOGO_Y} width={LOGO_DRAW_W} height={LOGO_DRAW_H} />

      <line x1={0} y1={FOOTER_Y} x2={VB_W} y2={FOOTER_Y} stroke={CB_BLUE} strokeWidth={4} />
    </svg>
  );
}
