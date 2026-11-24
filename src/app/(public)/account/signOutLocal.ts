/**
 * Sign this browser out of its buyer session. Never throws.
 *
 * signOut({ scope: "local" }) calls Auth's /logout first, and on a network
 * error or a 5xx it RETURNS { error } without removing the local session. The
 * page would then show the sign-in screen while the session cookies stay, and
 * a reload would sign the buyer back in. So on an error, returned or thrown,
 * the session cookies are expired here, as /auth/callback does on the server.
 * @supabase/ssr's session cookies are not httpOnly, so the page can do this.
 */

// The session cookie and its chunks (.0, .1, …), never the PKCE verifier.
const AUTH_COOKIE = /^sb-[^.]+-auth-token(\.\d+)?$/;

type CookieJar = { cookie: string };
type LocalSignOutClient = {
  auth: { signOut(options: { scope: "local" }): Promise<{ error: unknown }> };
};

/** Names of the Supabase session cookies in a document.cookie string. */
export function authCookieNames(cookieString: string): string[] {
  return cookieString
    .split(";")
    .map((pair) => pair.split("=")[0].trim())
    .filter((name) => AUTH_COOKIE.test(name));
}

export async function signOutLocal(client: LocalSignOutClient, jar: CookieJar): Promise<void> {
  let failed: boolean;
  try {
    const { error } = await client.auth.signOut({ scope: "local" });
    failed = error != null;
  } catch {
    failed = true;
  }
  if (!failed) return;
  try {
    for (const name of authCookieNames(jar.cookie)) {
      jar.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
    }
  } catch {
    // Nothing more this page can do; the next server request still sees the
    // session, which /account handles like any signed-in visit.
  }
}
