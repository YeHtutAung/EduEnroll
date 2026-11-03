import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PRIVACY_POLICY,
  TERMS_OF_SALE,
  type Bi,
  type LegalDocumentData,
} from "@/components/legal/content";
import LegalDocument from "@/components/legal/LegalDocument";
import { TERMS_VERSION } from "@/lib/legal/terms";

const MYANMAR = /[က-႟]/;

/** Every bilingual string in a document, labelled for the failure message. */
function allPairs(doc: LegalDocumentData): [string, Bi][] {
  const pairs: [string, Bi][] = [
    ["title", doc.title],
    ["subtitle", doc.subtitle],
    ["intro", doc.intro],
  ];
  for (const s of doc.sections) {
    pairs.push([`${s.title.en} / title`, s.title]);
    if (s.intro) pairs.push([`${s.title.en} / intro`, s.intro]);
    s.items?.forEach((item, i) => pairs.push([`${s.title.en} / item ${i + 1}`, item]));
    if (s.outro) pairs.push([`${s.title.en} / outro`, s.outro]);
  }
  return pairs;
}

describe.each([
  ["Terms of Sale", TERMS_OF_SALE],
  ["Privacy Policy", PRIVACY_POLICY],
])("%s content", (_name, doc) => {
  // The request was: every part of both documents in Myanmar as well.
  it("has a Myanmar translation for every English string", () => {
    const missing = allPairs(doc)
      .filter(([, pair]) => pair.en.trim() === "" || !MYANMAR.test(pair.mm))
      .map(([label]) => label);
    expect(missing).toEqual([]);
  });

  it("numbers its sections 1..n in order, in both languages", () => {
    doc.sections.forEach((s, i) => {
      expect(s.title.en.startsWith(`${i + 1}. `)).toBe(true);
    });
    const mmDigits = "၀၁၂၃၄၅၆၇၈၉";
    doc.sections.forEach((s, i) => {
      const n = String(i + 1).replace(/\d/g, (d) => mmDigits[Number(d)]);
      expect(s.title.mm.startsWith(`${n}။`)).toBe(true);
    });
  });
});

describe("Terms of Sale", () => {
  it("shows the same version that orders record", () => {
    expect(TERMS_OF_SALE.subtitle.en).toContain(TERMS_VERSION);
  });

  // Buyers agree to this wording, so it needs a version newer than the one they
  // accepted before it was added.
  it("discloses sharing with Meta, in a version newer than before it was added", () => {
    const section = TERMS_OF_SALE.sections.find((s) => /Advertising/.test(s.title.en))!;
    const text = section.items!.map((i) => i.en).join(" ");
    expect(text).toMatch(/email/);
    expect(text).toMatch(/phone/);
    expect(text).toMatch(/hashed/);
    expect(text).toMatch(/Meta/);
    expect(section.items!.every((i) => MYANMAR.test(i.mm))).toBe(true);
    expect(TERMS_VERSION > "2026-09-28").toBe(true);
  });
});

describe("Privacy Policy", () => {
  it("keeps all twelve sections of the English policy", () => {
    expect(PRIVACY_POLICY.sections).toHaveLength(12);
  });

  // Organisers' pages can run Meta's pixel and Google Tag Manager, and paid
  // orders send Meta hashed contact details. The policy must not deny that.
  it("says the referring site can go to Meta with a purchase", () => {
    const cookies = PRIVACY_POLICY.sections.find((s) => s.title.en.startsWith("7."))!;
    expect(cookies.intro!.en).toMatch(/website that sent you/);
    expect(cookies.intro!.mm).toMatch(/ရောက်ရှိလာသော/);
  });

  it("does not claim there is no advertising tracking", () => {
    const cookies = PRIVACY_POLICY.sections.find((s) => s.title.en.startsWith("7."))!;
    expect(cookies.intro!.en).not.toMatch(/do not use advertising cookies/);
    expect(cookies.intro!.en).toMatch(/Google Tag Manager/);
    expect(cookies.intro!.en).toMatch(/Meta/);
    expect(cookies.intro!.mm).toMatch(/Google Tag Manager/);
    expect(cookies.intro!.mm).toMatch(MYANMAR);
  });

  it("tells buyers Meta can receive their email and phone in hashed form", () => {
    const sharing = PRIVACY_POLICY.sections.find((s) => s.title.en.startsWith("4."))!;
    const meta = sharing.items!.find((i) => /hashed/.test(i.en))!;
    expect(meta.en).toMatch(/email/);
    expect(meta.en).toMatch(/phone/);
    expect(meta.en).toMatch(/Meta/);
    expect(meta.en).toMatch(/country/);
    expect(meta.mm).toMatch(MYANMAR);
  });

  it("tells buyers the scanning provider gets the ticket reference and ID only", () => {
    const sharing = PRIVACY_POLICY.sections.find((s) => s.title.en.startsWith("4."))!;
    const scanning = sharing.items!.find((i) => i.en.includes("entry-scanning"))!;
    expect(scanning.en).toMatch(/order reference and ticket ID only/);
    expect(scanning.mm).toMatch(MYANMAR);
  });
});

describe("LegalDocument", () => {
  it("renders both languages of every section", () => {
    const html = renderToStaticMarkup(<LegalDocument doc={PRIVACY_POLICY} />);
    for (const s of PRIVACY_POLICY.sections) {
      expect(html).toContain(s.title.en.replace(/'/g, "&#x27;"));
      expect(html).toContain(s.title.mm);
    }
  });

  it("renders the contact card only where the section asks for it", () => {
    expect(renderToStaticMarkup(<LegalDocument doc={PRIVACY_POLICY} />)).toContain(
      'href="mailto:support@kuunyi.com"',
    );
    expect(renderToStaticMarkup(<LegalDocument doc={TERMS_OF_SALE} />)).not.toContain(
      'href="mailto:support@kuunyi.com"',
    );
  });
});

describe("Terms of Sale wording (owner review, 2026-09-21)", () => {
  it("uses the owner's Myanmar intro, word for word", () => {
    expect(TERMS_OF_SALE.intro.mm).toBe(
      "KuuNyi သည် သင့်အော်ဒါတွင် ဖော်ပြထားသော စီစဉ်သူ (“စီစဉ်သူ”) အသုံးပြုသည့် အော်ဒါမှာယူခြင်းနှင့် လက်မှတ်ရောင်းချခြင်း ပလက်ဖောင်းကို လည်ပတ်ပါသည်။ ပွဲကို စီစဉ်သူက ကျင်းပပါသည်။ အော်ဒါမှာယူခြင်းဖြင့် ဤစည်းကမ်းချက်များနှင့် မမှာယူမီ စီစဉ်သူ ပြသခဲ့သော ပွဲစည်းကမ်းများကို သဘောတူပါသည်။",
    );
  });

  it("says 'Scan ဖတ်', never 'စကင်ဖတ်', anywhere in either document", () => {
    for (const doc of [TERMS_OF_SALE, PRIVACY_POLICY]) {
      const leftovers = allPairs(doc).filter(([, p]) => p.mm.includes("စကင်")).map(([l]) => l);
      expect(leftovers).toEqual([]);
    }
  });

  // Trimmed to three sections at the owner's request (2026-09-28): the
  // refunds, lost-tickets, event-changes, your-information, your-order and
  // contact sections were dropped.
  it("has the three sections the owner kept, plus advertising (2026-11-04)", () => {
    expect(TERMS_OF_SALE.sections.map((s) => s.title.en)).toEqual([
      "1. Verification",
      "2. Tickets and entry",
      "3. Resale and transfer",
      "4. Advertising",
    ]);
  });

  it("requires the e-ticket from the confirmation email at the gate", () => {
    const verification = TERMS_OF_SALE.sections.find((s) => s.title.en.endsWith("Verification"))!;
    const text = JSON.stringify(verification);
    expect(text).toMatch(/e-ticket/i);
    expect(text).toMatch(/email/i);
  });

  // Owner's wording: "keep it safe", not "keep it secret".
  it("tells buyers to keep the QR safe, not secret", () => {
    const entry = TERMS_OF_SALE.sections.find((s) => s.title.en.endsWith("Tickets and entry"))!;
    const qrItem = entry.items!.find((i) => i.en.startsWith("Keep your QR code private"))!;
    expect(qrItem.mm).toContain("လုံခြုံစွာ");
    expect(qrItem.mm).not.toContain("လျှို့ဝှက်");
  });

  it("carries no KuuNyi contact details", () => {
    expect(JSON.stringify(TERMS_OF_SALE)).not.toMatch(/support@kuunyi\.com/i);
  });
});
