import { describe, expect, it } from "vitest";
import { groupSizeOptions, sizeChartUrlFor } from "@/lib/enrollment/sizeChart";

const jersey = {
  field_label: "Jersey Size",
  field_type: "select",
  options: ["Kids 6", "Kids 10", "S", "M", "L"],
};

describe("sizeChartUrlFor", () => {
  it("matches The Beats Run's Jersey Size field", () => {
    expect(sizeChartUrlFor("beatsrun", jersey)).toBe("/tenants/beatsrun/size-chart.webp");
  });

  it("ignores case and surrounding spaces in the label", () => {
    expect(sizeChartUrlFor("beatsrun", { ...jersey, field_label: "  jersey size " })).not.toBeNull();
  });

  it("also matches when the organiser switched the field to radio", () => {
    expect(sizeChartUrlFor("beatsrun", { ...jersey, field_type: "radio" })).not.toBeNull();
  });

  it("never matches another tenant's field with the same label", () => {
    expect(sizeChartUrlFor("skyfestival", jersey)).toBeNull();
    expect(sizeChartUrlFor("brave", jersey)).toBeNull();
  });

  it("never matches The Beats Run's other fields", () => {
    expect(sizeChartUrlFor("beatsrun", { ...jersey, field_label: "Phone", field_type: "phone", options: null })).toBeNull();
    expect(sizeChartUrlFor("beatsrun", { ...jersey, field_label: "Shoe Size" })).toBeNull();
  });

  it("needs a choice field with options", () => {
    expect(sizeChartUrlFor("beatsrun", { ...jersey, field_type: "text" })).toBeNull();
    expect(sizeChartUrlFor("beatsrun", { ...jersey, options: [] })).toBeNull();
    expect(sizeChartUrlFor("beatsrun", { ...jersey, options: null })).toBeNull();
  });

  it("returns null when the tenant is unknown", () => {
    expect(sizeChartUrlFor(null, jersey)).toBeNull();
    expect(sizeChartUrlFor(undefined, jersey)).toBeNull();
  });
});

describe("groupSizeOptions", () => {
  it("splits the dev list into kids and adult rows, keeping saved values", () => {
    const { kids, adult } = groupSizeOptions(["Kids 6", "Kids 10", "XS", "S", "M", "L", "XL", "2XL", "3XL"]);
    expect(kids).toEqual([
      { value: "Kids 6", label: "6" },
      { value: "Kids 10", label: "10" },
    ]);
    expect(adult.map((o) => o.value)).toEqual(["XS", "S", "M", "L", "XL", "2XL", "3XL"]);
    expect(adult.every((o) => o.label === o.value)).toBe(true);
  });

  it("treats bare ages as kids and FREE as adult", () => {
    const { kids, adult } = groupSizeOptions(["6", "8", "10", "12", "14", "S", "FREE", "2XL"]);
    expect(kids.map((o) => o.label)).toEqual(["6", "8", "10", "12", "14"]);
    expect(adult.map((o) => o.label)).toEqual(["S", "FREE", "2XL"]);
  });

  it("recognises Kid, Baby and Child prefixes", () => {
    const { kids } = groupSizeOptions(["Kid 8", "Baby 12", "Child-14", "kids: 6"]);
    expect(kids.map((o) => o.label)).toEqual(["8", "12", "14", "6"]);
  });

  it("does not strip a word that only starts with 'kid'", () => {
    const { kids, adult } = groupSizeOptions(["Kidsize", "Kids"]);
    expect(kids).toEqual([]);
    expect(adult.map((o) => o.value)).toEqual(["Kidsize", "Kids"]);
  });

  it("puts everything in one row when there are no kids sizes", () => {
    const { kids, adult } = groupSizeOptions(["S", "M", "L"]);
    expect(kids).toEqual([]);
    expect(adult).toHaveLength(3);
  });
});
