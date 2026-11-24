// ─── /t/claim: take the share-link secret out of the URL (plan 4, Task 12) ──
//
// A share link is `<origin>/t/claim#<token>` (design 6.4). The token is a
// secret: page.tsx renders STRIP_FRAGMENT_JS inline as its first element, so it
// runs while the body is parsed, before React hydrates. It
//   1. removes the fragment with history.replaceState, so the token is in
//      neither the address bar nor the history entry, and
//   2. keeps a well-formed token in sessionStorage["seat_claim"], or on
//      window.__seatClaim if sessionStorage throws (blocked storage).
// A hash that isn't a token is stripped and dropped. Nothing is logged or sent:
// only claimFlow reads the token, for the two claim endpoints.
//
// The script refers to `window` only, so the tests run it with
// new Function("window", STRIP_FRAGMENT_JS) against a fake window.
//
// stripFragment() is the same logic in TypeScript, a backup for when the
// inline script didn't run (a client-side render, e.g. under MSW): ClaimSeat
// calls it on mount if location.hash is still non-empty. The inline script
// stays primary, because it runs before any bundle.

export const SEAT_CLAIM_KEY = "seat_claim";

/** The server's token shape (isShareToken in src/server/tickets/shareLinks.ts): 32 bytes, base64url. */
export const SHARE_TOKEN_PATTERN = "^[A-Za-z0-9_-]{43}$";

export const STRIP_FRAGMENT_JS = `(function(){var w=window,t=null;try{var h=w.location.hash||"";if(h){if(h.charAt(0)==="#")h=h.slice(1);if(/${SHARE_TOKEN_PATTERN}/.test(h))t=h;w.history.replaceState(null,"","/t/claim")}}catch(e){}if(t){try{w.sessionStorage.setItem("${SEAT_CLAIM_KEY}",t)}catch(e){w.__seatClaim=t}}})();`;

interface StripWindow {
  location: { hash: string };
  history: { replaceState: (data: unknown, unused: string, url: string) => void };
  sessionStorage: Pick<Storage, "setItem">;
  __seatClaim?: string;
}

const TOKEN_RE = new RegExp(SHARE_TOKEN_PATTERN);

/** STRIP_FRAGMENT_JS, callable: strip the fragment, keep a well-formed token. */
export function stripFragment(win: StripWindow): void {
  let token: string | null = null;
  try {
    let h = win.location.hash || "";
    if (h) {
      if (h.charAt(0) === "#") h = h.slice(1);
      if (TOKEN_RE.test(h)) token = h;
      win.history.replaceState(null, "", "/t/claim");
    }
  } catch {
    // As the inline script: never throw on a strange window.
  }
  if (!token) return;
  try {
    win.sessionStorage.setItem(SEAT_CLAIM_KEY, token);
  } catch {
    win.__seatClaim = token;
  }
}
