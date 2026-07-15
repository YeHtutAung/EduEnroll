import type { Sponsor, SponsorPlacements } from "@/types/database";
import { DEFAULT_SPONSOR_PLACEMENTS } from "@/types/database";

function isSponsor(value: unknown): value is Sponsor {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as Sponsor).name === "string" &&
    (value as Sponsor).name.trim(),
  );
}

export function resolveSponsorPlacements(
  config?: SponsorPlacements | null | unknown,
): SponsorPlacements {
  if (!config || typeof config !== "object") return DEFAULT_SPONSOR_PLACEMENTS;
  const value = config as Partial<SponsorPlacements>;
  return {
    presenting:
      value.presenting === null
        ? null
        : isSponsor(value.presenting)
          ? value.presenting
          : DEFAULT_SPONSOR_PLACEMENTS.presenting,
    partners: Array.isArray(value.partners)
      ? value.partners.filter(isSponsor).slice(0, 12)
      : DEFAULT_SPONSOR_PLACEMENTS.partners,
    supported_by: Array.isArray(value.supported_by)
      ? value.supported_by.filter(isSponsor).slice(0, 6)
      : DEFAULT_SPONSOR_PLACEMENTS.supported_by,
  };
}
