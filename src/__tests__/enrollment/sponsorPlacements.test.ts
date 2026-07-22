import { describe, expect, it } from "vitest";
import { resolveSponsorPlacements } from "@/lib/sponsors";

// ─── Absent sponsor config must render NOTHING ──────────────────────────────
//
// This resolver used to fall back to DEFAULT_SPONSOR_PLACEMENTS, and the first
// two cases below asserted that fallback — so the tests encoded the bug rather
// than catching it.
//
// A tenant who had cleared their sponsors, or whose config failed to load, got
// "Northwind", "Vertex", "Lumen" and "Nexa" printed on real customers'
// e-tickets. Inventing a sponsor misrepresents a commercial relationship on a
// document the buyer keeps, and it also hid a real fault: the enrolment API was
// querying `tenant_appearances` (plural, non-existent), which produced a null
// config that rendered as plausible content instead of an error.

describe("resolveSponsorPlacements", () => {
  it("renders nothing when no config exists", () => {
    const placements = resolveSponsorPlacements(null);

    expect(placements.presenting).toBeNull();
    expect(placements.partners).toEqual([]);
    expect(placements.supported_by).toEqual([]);
  });

  it("renders nothing for undefined or non-object config", () => {
    for (const bad of [undefined, "", 0, "nonsense", 42]) {
      const placements = resolveSponsorPlacements(bad);
      expect(placements.presenting).toBeNull();
      expect(placements.partners).toEqual([]);
      expect(placements.supported_by).toEqual([]);
    }
  });

  it("never emits a placeholder name from the sample data", () => {
    // The specific regression: these are the demo wordmarks that reached
    // production e-tickets.
    const samples = ["Northwind", "Vertex", "Lumen", "Nexa", "Orbit"];
    for (const config of [null, undefined, {}, { partners: null }]) {
      const p = resolveSponsorPlacements(config);
      const names = [p.presenting?.name, ...p.partners.map((s) => s.name),
                     ...p.supported_by.map((s) => s.name)].filter(Boolean);
      for (const name of names) expect(samples).not.toContain(name);
    }
  });

  it("honours an explicitly cleared config", () => {
    // Exactly what the admin panel saves when every sponsor is removed.
    const placements = resolveSponsorPlacements({
      partners: [],
      presenting: null,
      supported_by: [],
    });

    expect(placements.presenting).toBeNull();
    expect(placements.partners).toEqual([]);
    expect(placements.supported_by).toEqual([]);
  });

  it("accepts real logo assets and outbound URLs", () => {
    const placements = resolveSponsorPlacements({
      presenting: { name: "Acme", logo_url: "/sponsors/acme.svg", url: "https://acme.example" },
      partners: [{ name: "Vertex", logo_url: "/sponsors/vertex.svg" }],
      supported_by: [],
    });

    expect(placements.presenting).toMatchObject({ name: "Acme", logo_url: "/sponsors/acme.svg" });
    expect(placements.partners[0].logo_url).toBe("/sponsors/vertex.svg");
    expect(placements.supported_by).toEqual([]);
  });

  it("drops malformed entries without substituting samples", () => {
    const placements = resolveSponsorPlacements({
      presenting: null,
      partners: [{ name: "Valid" }, { logo_url: "/missing-name.svg" }],
      supported_by: "invalid",
    });

    expect(placements.presenting).toBeNull();
    expect(placements.partners.map((s) => s.name)).toEqual(["Valid"]);
    // Previously this yielded 3 sample sponsors because the field was not an array.
    expect(placements.supported_by).toEqual([]);
  });
});
