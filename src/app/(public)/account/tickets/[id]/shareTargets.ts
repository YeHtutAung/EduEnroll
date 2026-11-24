// ─── "Share to app" links for a seat-share URL ──────────────────────────────
//
// The share URL carries the link's secret in its fragment. Every href here
// encodes it with encodeURIComponent, so the `#` becomes `%23` and the secret
// travels inside the shared text instead of becoming the href's own fragment.
// Nothing here stores, logs or tracks the URL.

export interface ShareTargets {
  /** Works on every device: the web page hands off to the app or Telegram Web. */
  telegram: string;
  /** Phones only: needs the Viber app. */
  viber: string;
  /** Phones only: needs the Messenger app (no Facebook App ID for desktop). */
  messenger: string;
}

export function shareTargets(url: string, message: string): ShareTargets {
  const u = encodeURIComponent(url);
  return {
    telegram: `https://t.me/share/url?url=${u}&text=${encodeURIComponent(message)}`,
    viber: `viber://forward?text=${encodeURIComponent(`${message} ${url}`)}`,
    messenger: `fb-messenger://share?link=${u}`,
  };
}

/** A phone or tablet, where app links (viber://, fb-messenger://) can open an app. */
export function isPhoneUserAgent(userAgent: string): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent);
}

export function canShareSheet(nav: Navigator | undefined): boolean {
  return !!nav && typeof nav.share === "function";
}

export type ShareSheetOutcome = "shared" | "cancelled" | "failed";

/**
 * Opens the system share sheet. The user closing it (AbortError) is
 * "cancelled"; any other failure is "failed" and the caller does nothing more:
 * Copy stays on the page.
 */
export async function shareSheet(nav: Navigator | undefined, url: string, text: string): Promise<ShareSheetOutcome> {
  if (!nav || !canShareSheet(nav)) return "failed";
  try {
    await nav.share({ text, url });
    return "shared";
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
    return "failed";
  }
}
