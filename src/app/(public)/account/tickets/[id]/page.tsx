import LiveTicket from "./LiveTicket";

// One account ticket's live QR. Everything runs in the browser: the device key
// lives in IndexedDB and never reaches the server. The (public) layout keeps
// tag scripts off /account/* (isTrackedPath is an allowlist).
export default function AccountTicketPage({ params }: { params: { id: string } }) {
  return <LiveTicket ticketId={params.id} />;
}
