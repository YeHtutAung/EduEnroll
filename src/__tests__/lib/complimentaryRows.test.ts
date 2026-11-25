import { describe, expect, it } from "vitest";
import {
  complimentaryKey,
  normalisePhone,
  parseComplimentaryRows,
  parseCsv,
} from "@/lib/complimentary/rows";

const SIZES = ["Kids 6", "Kids 10", "XS", "S", "M", "L", "XL", "2XL", "3XL"];
const TIERS = new Map([
  ["5KM", "Early Bird - 5KM"],
  ["10KM", "Early Bird - 10KM"],
]);
const HEADER = "name,phone,email,distance,size";

function parse(csv: string) {
  return parseComplimentaryRows(parseCsv(csv), TIERS, SIZES);
}

describe("parseCsv", () => {
  it("reads quoted fields, doubled quotes, CRLF and a BOM", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
    ]);
  });

  it("refuses a quote that is never closed instead of swallowing the rest", () => {
    expect(() => parseCsv('name,note\nA,"unfinished note\nB,fine\nC,fine\n')).toThrow(
      "unclosed quote starting on line 2",
    );
  });

  it("drops blank lines and keeps a last line without a newline", () => {
    expect(parseCsv("a,b\n\n,\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});

describe("normalisePhone", () => {
  it("strips spaces, dashes and dots", () => {
    expect(normalisePhone("09 795-761.189")).toBe("09795761189");
  });
});

describe("parseComplimentaryRows", () => {
  it("returns clean rows, mapping distance to tier and size to the event's spelling", () => {
    const result = parse(`${HEADER}\n  Aung  Aung ,09-250 240177,Someone@Gmail.com,10km,xl\n`);
    expect(result).toEqual({
      ok: true,
      rows: [
        {
          line: 2,
          name: "Aung Aung",
          phone: "09250240177",
          email: "someone@gmail.com",
          distance: "10km",
          tierLevel: "Early Bird - 10KM",
          size: "XL",
        },
      ],
    });
  });

  it("accepts columns in any order and extra columns", () => {
    const result = parse("note,size,distance,email,phone,name\nwarm-up,M,5KM,a@b.co,09123456789,Mya");
    expect(result.ok && result.rows[0]).toMatchObject({ name: "Mya", size: "M", tierLevel: "Early Bird - 5KM" });
  });

  it("refuses sizes that are not exactly one of the choices", () => {
    const result = parse(`${HEADER}\nA,09123456789,a@b.co,5KM,M size\nB,09123456789,b@b.co,5KM,L or XL`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0]).toContain('Line 2: size "M size"');
      expect(result.errors[1]).toContain('Line 3: size "L or XL"');
    }
  });

  it("refuses a phone a spreadsheet turned into a number", () => {
    const result = parse(`${HEADER}\nA,9.954138859,a@b.co,5KM,M`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("not a Myanmar mobile number");
  });

  it("refuses a distance with no tier and a bad email", () => {
    const result = parse(`${HEADER}\nA,09123456789,not-an-email,21KM,M`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain('distance "21KM" has no --tier mapping');
      expect(result.errors[0]).toContain("is not an email address");
    }
  });

  it("refuses the same email twice, in any case", () => {
    const result = parse(`${HEADER}\nA,09123456789,a@b.co,5KM,M\nB,09123456780,A@B.CO,10KM,L`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual(["Line 3: email repeats line 2"]);
  });

  it("needs no size when the event asks none per ticket", () => {
    const noColumn = parseComplimentaryRows(
      parseCsv("name,phone,email,distance\nA,09123456789,a@b.co,5KM"),
      TIERS,
      null,
    );
    expect(noColumn.ok && noColumn.rows[0]).toMatchObject({ name: "A", size: "" });

    // A size column is ignored rather than checked against nothing.
    const withColumn = parseComplimentaryRows(parseCsv(`${HEADER}\nA,09123456789,a@b.co,5KM,whatever`), TIERS, null);
    expect(withColumn.ok && withColumn.rows[0].size).toBe("");
  });

  it("reports missing columns and empty lists", () => {
    const noSize = parse("name,phone,email,distance\nA,09123456789,a@b.co,5KM");
    expect(noSize.ok || noSize.errors[0]).toContain("Missing column(s): size");
    const empty = parse(HEADER);
    expect(empty.ok || empty.errors[0]).toBe("The list has a header but no people.");
  });
});

describe("complimentaryKey", () => {
  it("is one key per event and email, whatever the case", () => {
    expect(complimentaryKey("intake-1", "A@B.co")).toBe("comp:intake-1:a@b.co");
  });
});
