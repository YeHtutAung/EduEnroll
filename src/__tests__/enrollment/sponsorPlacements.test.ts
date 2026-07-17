import { describe, expect, it } from "vitest";
import { resolveSponsorPlacements } from "@/lib/sponsors";

describe("resolveSponsorPlacements", () => {
  it("provides the handoff placeholder wordmarks when no event config exists", () => {
    const placements = resolveSponsorPlacements(null);
    expect(placements.presenting?.name).toBe("Northwind");
    expect(placements.partners.map((sponsor) => sponsor.name)).toEqual([
      "Vertex",
      "Lumen",
      "Nexa",
      "Orbit",
    ]);
    expect(placements.supported_by).toHaveLength(3);
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

  it("filters malformed sponsors instead of breaking the public flow", () => {
    const placements = resolveSponsorPlacements({
      presenting: null,
      partners: [{ name: "Valid" }, { logo_url: "/missing-name.svg" }],
      supported_by: "invalid",
    });
    expect(placements.presenting).toBeNull();
    expect(placements.partners.map((sponsor) => sponsor.name)).toEqual(["Valid"]);
    expect(placements.supported_by).toHaveLength(3);
  });
});
