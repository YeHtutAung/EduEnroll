// ─── Canvas drawing primitives for the e-ticket renderers ───────────────────
//
// Moved verbatim from the checkout-success page. None of these touched React
// state there, which is what made the extraction safe.

import type { Sponsor } from "@/types/database";

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

export async function imageDataUrl(src: string): Promise<string | null> {
  try {
    const img = await loadImage(src);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

export function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export async function drawCanvasSponsor(
  ctx: CanvasRenderingContext2D,
  sponsor: Sponsor,
  x: number,
  y: number,
  markSize: number,
  maxLogoWidth: number,
  scale: number,
  align: "left" | "center" | "right" = "left",
  light = false,
) {
  if (sponsor.logo_url) {
    try {
      const img = await loadImage(sponsor.logo_url);
      const ratio = Math.min(
        (maxLogoWidth * scale) / img.naturalWidth,
        (markSize * scale) / img.naturalHeight,
      );
      const width = img.naturalWidth * ratio;
      const height = img.naturalHeight * ratio;
      const dx = align === "right" ? x - width : align === "center" ? x - width / 2 : x;
      ctx.drawImage(img, dx, y - height / 2, width, height);
      return;
    } catch {
      // Keep the placeholder wordmark when a remote logo cannot be rasterized.
    }
  }

  const size = markSize * scale;
  const shape = sponsor.mark ?? "square";
  const color = sponsor.mark_color || (shape === "circle" ? "#d4af5a" : "#0f1f42");
  const gap = 4 * scale;

  // Constrain the wordmark to its slot. `maxLogoWidth` bounded the logo path
  // only, so text sponsors were measured but never fitted and adjacent names
  // in the "SUPPORTED BY" strip ran into each other.
  const wordBudget = Math.max(maxLogoWidth * scale - size - gap, 8 * scale);
  let name = sponsor.name;
  if (ctx.measureText(name).width > wordBudget) {
    while (name.length > 1 && ctx.measureText(`${name}…`).width > wordBudget) {
      name = name.slice(0, -1);
    }
    name = `${name}…`;
  }
  const wordWidth = ctx.measureText(name).width;
  const groupWidth = size + gap + wordWidth;
  const startX = align === "right" ? x - groupWidth : align === "center" ? x - groupWidth / 2 : x;
  const markX = startX;
  const markY = y - size / 2;

  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2 * scale, size / 5);
  if (shape === "circle") {
    ctx.beginPath();
    ctx.arc(markX + size / 2, y, size / 2, 0, Math.PI * 2);
    ctx.fill();
    if (markSize >= 18) {
      ctx.fillStyle = "#0f1f42";
      ctx.font = `800 ${11 * scale}px Helvetica, Arial, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(
        sponsor.name.trim().charAt(0).toUpperCase(),
        markX + size / 2,
        y + scale * 0.3,
      );
    }
  } else if (shape === "ring") {
    ctx.beginPath();
    ctx.arc(markX + size / 2, y, size * 0.36, 0, Math.PI * 2);
    ctx.stroke();
  } else if (shape === "diamond") {
    ctx.translate(markX + size / 2, y);
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-size * 0.32, -size * 0.32, size * 0.64, size * 0.64);
  } else {
    roundRectPath(ctx, markX, markY, size, size, Math.max(2 * scale, size / 5));
    ctx.fill();
  }
  ctx.restore();

  ctx.fillStyle = light ? "#ffffff" : "#0f1f42";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(name, startX + size + gap, y);
}

// Render a single e-ticket to a PNG blob (canvas), mirroring the PDF layout.
