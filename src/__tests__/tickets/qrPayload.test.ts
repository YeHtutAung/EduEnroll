import { describe, expect, it, vi } from "vitest";
import { isTicketQrFormat, ticketQrPayload } from "@/lib/tickets/qrPayload";

const JTI = "a176b9d2-8ded-47f4-b69d-de9acc4784f2";

describe("ticketQrPayload", () => {
  it("encodes the signed token for a jwt event", () => {
    expect(ticketQrPayload("jwt", JTI, () => "signed-token")).toBe("signed-token");
  });

  it("encodes the bare ticket UUID for a uuid event, without signing", () => {
    const sign = vi.fn(() => "signed-token");
    expect(ticketQrPayload("uuid", JTI, sign)).toBe(JTI);
    expect(sign).not.toHaveBeenCalled();
  });

  // Guessing either way puts a QR on the ticket that one of the two scanners
  // cannot read, so a value this code does not know must stop, not default.
  it.each([null, undefined, "", "JWT", "barcode"])("refuses an unknown format %j", (format) => {
    expect(() => ticketQrPayload(format as never, JTI, () => "signed-token")).toThrow(
      /unknown ticket QR format/,
    );
  });
});

describe("isTicketQrFormat", () => {
  it("accepts exactly the two stored values", () => {
    expect(isTicketQrFormat("jwt")).toBe(true);
    expect(isTicketQrFormat("uuid")).toBe(true);
    expect(isTicketQrFormat("UUID")).toBe(false);
    expect(isTicketQrFormat(null)).toBe(false);
  });
});
