// ─── isInAppBrowser: embedded web views where Google sign-in won't run ──────
//
// Google refuses OAuth inside embedded web views ("disallowed_useragent"), so
// /account hides "Continue with Google" there and offers Copy link instead.
// Facebook (FBAN, FBAV, FB_IAB), Instagram, Messenger, LINE, Viber, WeChat
// (MicroMessenger) and any Android WebView ("; wv)").

const IN_APP = /FBAN|FBAV|FB_IAB|Instagram|Messenger|Line\/|Viber|MicroMessenger|; wv\)/;

export function isInAppBrowser(userAgent: string | null | undefined): boolean {
  return typeof userAgent === "string" && IN_APP.test(userAgent);
}
