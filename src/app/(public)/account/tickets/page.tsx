import TicketList from "./TicketList";

// The buyer's account tickets on this site. The (public) layout supplies the
// tenant's branding and keeps tag scripts off /account/* (isTrackedPath is an
// allowlist); the client asks GET /api/me/tickets.
export default function AccountTicketsPage() {
  return <TicketList />;
}
