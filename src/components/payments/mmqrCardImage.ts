// ─── Save the MMQR card as a PNG ────────────────────────────────────────────
//
// KBZPay require the MMQR code to sit inside the frame, and a saved image is
// the copy a payer forwards or opens later, so Save QR exports the card as
// drawn rather than the bare code.
//
// An SVG loaded as an image cannot fetch anything, so every asset is inlined
// first. WebKit can also report the image as loaded before its embedded images
// have decoded, which would produce a frame with no code in it. The QR area is
// therefore checked after drawing and the draw retried. If it never appears the
// export fails: the caller must not hand out an image with a missing code.

const EXPORT_WIDTH = 1000;
const DRAW_ATTEMPTS = 4;
const RETRY_MS = 150;

/** True if an RGBA buffer holds at least one opaque, near-black pixel. */
export function hasDarkPixels(rgba: ArrayLike<number>): boolean {
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i] < 64 && rgba[i + 1] < 64 && rgba[i + 2] < 64 && rgba[i + 3] > 200) return true;
  }
  return false;
}

async function assetToDataUrl(href: string): Promise<string> {
  const res = await fetch(href);
  if (!res.ok) throw new Error(`Asset failed to load: ${res.status}`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Asset could not be read"));
    reader.readAsDataURL(blob);
  });
}

export async function renderCardPng(card: SVGSVGElement): Promise<Blob> {
  const { width: vbWidth, height: vbHeight } = card.viewBox.baseVal;
  const scale = EXPORT_WIDTH / vbWidth;
  const height = Math.round(vbHeight * scale);

  const clone = card.cloneNode(true) as SVGSVGElement;
  clone.removeAttribute("style");
  clone.setAttribute("width", String(EXPORT_WIDTH));
  clone.setAttribute("height", String(height));

  // The QR is the only image that is already a data URL.
  const images = Array.from(clone.querySelectorAll("image"));
  const qr = images.find((image) => image.getAttribute("href")?.startsWith("data:"));
  if (!qr) throw new Error("Card has no QR image");

  await Promise.all(
    images
      .filter((image) => image !== qr)
      .map(async (image) => {
        image.setAttribute("href", await assetToDataUrl(image.getAttribute("href") ?? ""));
      }),
  );

  const canvas = document.createElement("canvas");
  canvas.width = EXPORT_WIDTH;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available");

  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
  const [x, y, w, h] = ["x", "y", "width", "height"].map((attr) => Number(qr.getAttribute(attr)) * scale);

  for (let attempt = 0; attempt < DRAW_ATTEMPTS; attempt++) {
    const image = new Image();
    // onload, not decode(): a repeat decode() of an SVG image never settled in
    // Edge when tested, which would leave a second tap on Save hanging.
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("Card image failed to load"));
      image.src = svgUrl;
    });

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, EXPORT_WIDTH, height);
    ctx.drawImage(image, 0, 0, EXPORT_WIDTH, height);

    if (hasDarkPixels(ctx.getImageData(x, y, w, h).data)) {
      return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG export failed"))), "image/png");
      });
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
  throw new Error("QR did not render into the card image");
}
