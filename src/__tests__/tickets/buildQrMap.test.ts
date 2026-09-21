import { describe, expect, it, vi } from "vitest";

const { toDataURL } = vi.hoisted(() => ({
  toDataURL: vi.fn(async (text: string) => `data:image/png;base64,${Buffer.from(text).toString("base64")}`),
}));

vi.mock("qrcode", () => ({ default: { toDataURL } }));

const { buildQrMap } = await import("@/lib/tickets/render/ticketPng");

describe("buildQrMap", () => {
  it("encodes each ticket's qr payload, not its jwt, at the fixed 240px size", async () => {
    const map = await buildQrMap([
      { jti: "t-1", tier: "GA", admits: 1, jwt: "jwt-1", qr: "t-1" },
      { jti: "t-2", tier: "GA", admits: 1, jwt: "jwt-2", qr: "jwt-2" },
    ]);

    expect(toDataURL).toHaveBeenCalledWith("t-1", { width: 240, margin: 1 });
    expect(toDataURL).toHaveBeenCalledWith("jwt-2", { width: 240, margin: 1 });
    expect(toDataURL).not.toHaveBeenCalledWith("jwt-1", expect.anything());
    expect(Object.keys(map).sort()).toEqual(["t-1", "t-2"]);
  });
});
