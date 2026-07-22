import type { Sponsor, SponsorPlacements } from "@/types/database";

function isSponsor(value: unknown): value is Sponsor {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as Sponsor).name === "string" &&
    (value as Sponsor).name.trim(),
  );
}

const EMPTY: SponsorPlacements = { presenting: null, partners: [], supported_by: [] };

/**
 * Resolves a tenant's stored sponsor config into what should actually be shown.
 *
 * Absent, malformed or partial config resolves to NOTHING — never to sample
 * sponsors. This used to fall back to DEFAULT_SPONSOR_PLACEMENTS, so a tenant
 * with no sponsors configured, or whose config failed to load, got "Northwind",
 * "Vertex", "Lumen" and "Nexa" printed on real customers' e-tickets. Inventing
 * a sponsor is worse than showing none: it misrepresents a commercial
 * relationship on a document the buyer keeps and may reproduce a real mark.
 *
 * It also made failures invisible. A wrong table name in the enrolment API
 * produced a null config, and that rendered as plausible-looking content
 * instead of as the fault it was.
 *
 * The sample constant it fell back to has been deleted outright rather than
 * kept for previews: it had no runtime consumer, and a fallback that names
 * invented sponsors has no safe caller.
 */
export function resolveSponsorPlacements(
  config?: SponsorPlacements | null | unknown,
): SponsorPlacements {
  if (!config || typeof config !== "object") return EMPTY;
  const value = config as Partial<SponsorPlacements>;
  return {
    presenting: isSponsor(value.presenting) ? value.presenting : null,
    partners: Array.isArray(value.partners) ? value.partners.filter(isSponsor).slice(0, 12) : [],
    supported_by: Array.isArray(value.supported_by)
      ? value.supported_by.filter(isSponsor).slice(0, 6)
      : [],
  };
}
