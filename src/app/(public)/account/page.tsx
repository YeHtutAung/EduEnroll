import AccountSignIn from "./AccountSignIn";

// Buyer sign-in with an email code. The (public) layout supplies the tenant's
// branding; the page itself needs nothing from the server: the client asks
// GET /api/account/profile who is signed in.
export default function AccountPage() {
  return <AccountSignIn />;
}
