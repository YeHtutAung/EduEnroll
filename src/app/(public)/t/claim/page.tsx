import ClaimSeat from "./ClaimSeat";
import { STRIP_FRAGMENT_JS } from "./stripFragment";

// ─── /t/claim#<token>: claim a shared seat (plan 4, Task 12, decision 10) ───
//
// In the (public) group for the tenant's branding. The strip script is the
// page's FIRST element: it runs as the body is parsed, before React hydrates,
// and takes the share-link token out of the URL before anything else reads it.
// /t/claim loads no tag scripts (isTrackedPath is an /enroll allowlist, so
// TenantTagManager and AdClickCapture render nothing here), so the only
// scripts that could run before it are the app's own bundles, which don't
// read the fragment. The token never reaches the server in the URL: a
// fragment isn't sent with the request.
export default function ClaimPage() {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: STRIP_FRAGMENT_JS }} />
      <ClaimSeat />
    </>
  );
}
