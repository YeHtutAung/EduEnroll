// ─── Seat holder history line in the order's Account section (plan 4) ──────
//
// `from → to` names where a seat went, so it is shown only for the events that
// move a seat between accounts. The others (a link made or cancelled, a holder
// deleting their account, a void) show just the event and who did it.

export interface HolderHistoryEntry {
  at: string;
  event: string;
  by: string | null;
  from: string | null;
  to: string | null;
}

export const HOLDER_EVENT_LABEL: Record<string, string> = {
  link_created: "Share link created",
  link_cancelled: "Share link cancelled",
  claimed: "Seat claimed",
  given_back: "Seat given back",
  holder_deleted: "Holder deleted their account",
  voided: "Seat voided",
  order_moved: "Order moved to another account",
};

const MOVES_SEAT = new Set(["claimed", "given_back", "order_moved"]);

/** "<event> · by <actor> · <from> → <to>", without the time. */
export function holderHistoryLine(h: Omit<HolderHistoryEntry, "at"> & { at?: string }): string {
  let line = HOLDER_EVENT_LABEL[h.event] ?? h.event;
  if (h.by) line += ` · by ${h.by}`;
  if (MOVES_SEAT.has(h.event) && (h.from || h.to)) line += ` · ${h.from ?? "—"} → ${h.to ?? "—"}`;
  return line;
}
