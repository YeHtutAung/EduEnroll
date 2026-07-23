import { afterEach, describe, expect, it, vi } from "vitest";
import { savePayNowQrImage } from "@/components/payments/PayNowQrSaveButton";
import { readFileSync } from "fs";
import path from "path";

const originalNavigator = globalThis.navigator;
const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalFile = globalThis.File;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
  Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, "File", { configurable: true, value: originalFile });
});

function arrangeImageFetch() {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    blob: async () => new Blob(["png"], { type: "image/png" }),
  })));
  vi.stubGlobal("File", class File extends Blob {
    name: string;
    constructor(parts: BlobPart[], name: string, options?: FilePropertyBag) {
      super(parts, options);
      this.name = name;
    }
  });
}

describe("PayNow QR save", () => {
  it("uses the native mobile share sheet with a PNG file", async () => {
    arrangeImageFetch();
    const share = vi.fn(async () => undefined);
    const canShare = vi.fn(() => true);
    vi.stubGlobal("navigator", { share, canShare });

    await expect(savePayNowQrImage("data:image/png;base64,cG5n", "F-1")).resolves.toBe("shared");
    expect(canShare).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledTimes(1);
    const file = share.mock.calls[0][0].files[0] as File;
    expect(file.name).toBe("PayNow-F-1.png");
    expect(file.type).toBe("image/png");
  });

  it("downloads the PNG when file sharing is unavailable", async () => {
    arrangeImageFetch();
    const click = vi.fn();
    const remove = vi.fn();
    const appendChild = vi.fn();
    const anchor = { href: "", download: "", rel: "", click, remove };
    const createObjectURL = vi.fn(() => "blob:qr");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", {
      createElement: vi.fn(() => anchor),
      body: { appendChild },
    });
    vi.stubGlobal("window", { setTimeout: (fn: () => void) => { fn(); return 1; } });
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });

    await expect(savePayNowQrImage("data:image/png;base64,cG5n", "F/2")).resolves.toBe("downloaded");
    expect(anchor.download).toBe("PayNow-F-2.png");
    expect(anchor.href).toBe("blob:qr");
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(click).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:qr");
  });

  it("does not start a download when the user cancels the share sheet", async () => {
    arrangeImageFetch();
    const abort = new DOMException("cancelled", "AbortError");
    const share = vi.fn(async () => { throw abort; });
    vi.stubGlobal("navigator", { share, canShare: () => true });

    await expect(savePayNowQrImage("data:image/png;base64,cG5n", "F-3")).resolves.toBe("cancelled");
  });

  it("wires the save action into every customer-facing PayNow QR view", () => {
    const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
    const checkout = read("src/app/(public)/enroll/[slug]/checkout/payment/page.tsx");
    const legacy = read("src/app/(public)/enroll/payment/[ref]/page.tsx");

    expect(checkout.match(/<PayNowQrSaveButton/g)).toHaveLength(2);
    expect(legacy.match(/<PayNowQrSaveButton/g)).toHaveLength(1);
    expect(checkout.match(/QRCode\.toDataURL\([\s\S]*?width:\s*360/g)).toHaveLength(2);
    expect(legacy).toMatch(/QRCode\.toDataURL\([\s\S]*?width:\s*360/);
  });
});
