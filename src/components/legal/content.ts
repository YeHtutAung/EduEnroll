// ─── Legal documents: the words, in English and Myanmar ─────────────────────
//
// Single source for /terms, /privacy and the pop-ups on the order forms, so
// the page and the pop-up can never say different things.
//
// Every string is a pair. src/__tests__/legal/legalContent.test.ts fails if a
// Myanmar half is missing or contains no Myanmar script.
//
// Changing the TERMS OF SALE here changes what buyers agree to: bump
// TERMS_VERSION in src/lib/legal/terms.ts. The Privacy Policy is shown to
// buyers as information only, so its wording is not part of the acceptance.

import { TERMS_VERSION } from "@/lib/legal/terms";

export type Bi = { en: string; mm: string };

export type LegalSectionData = {
  title: Bi;
  intro?: Bi;
  items?: Bi[];
  outro?: Bi;
  /** Render the KuuNyi contact card after the text. */
  contact?: boolean;
};

export type LegalDocumentData = {
  title: Bi;
  /** Shown under the title, e.g. the version or last-updated line. */
  subtitle: Bi;
  intro: Bi;
  sections: LegalSectionData[];
};

// ─── Terms of Sale ──────────────────────────────────────────────────────────

export const TERMS_OF_SALE: LegalDocumentData = {
  title: { en: "Terms of Sale", mm: "ရောင်းချမှုဆိုင်ရာ စည်းကမ်းချက်များ" },
  // From the constant orders record, so the page can never show one version
  // while buyers are recorded as accepting another.
  subtitle: { en: `Version ${TERMS_VERSION}`, mm: `ဗားရှင်း ${TERMS_VERSION}` },
  intro: {
    en:
      "KuuNyi (“we”, “us”) runs the ordering and ticketing platform used by the organiser named on your order (the “organiser”). The organiser runs the event or course. By placing an order you agree to these terms and to any event rules the organiser showed you before you ordered. How we handle your information is described in our Privacy Policy.",
    mm:
      "KuuNyi သည် သင့်အော်ဒါတွင် ဖော်ပြထားသော စီစဉ်သူ (“စီစဉ်သူ”) အသုံးပြုသည့် အော်ဒါမှာယူခြင်းနှင့် လက်မှတ်ရောင်းချခြင်း ပလက်ဖောင်းကို လည်ပတ်ပါသည်။ ပွဲ သို့မဟုတ် သင်တန်းကို စီစဉ်သူက ကျင်းပပါသည်။ အော်ဒါမှာယူခြင်းဖြင့် ဤစည်းကမ်းချက်များနှင့် မှာယူမီ စီစဉ်သူ ပြသခဲ့သော ပွဲစည်းကမ်းများကို သဘောတူပါသည်။ သင့်အချက်အလက်များကို ကိုင်တွယ်ပုံကို ကျွန်ုပ်တို့၏ ကိုယ်ရေးအချက်အလက်မူဝါဒတွင် ဖော်ပြထားပါသည်။",
  },
  sections: [
    {
      title: { en: "1. Your order", mm: "၁။ သင့်အော်ဒါ" },
      items: [
        {
          en: "Placing an order reserves your tickets or seats for a limited time. The order is confirmed only once your payment has been received and verified.",
          mm: "အော်ဒါမှာယူလိုက်သည်နှင့် လက်မှတ် သို့မဟုတ် နေရာကို အချိန်အကန့်အသတ်ဖြင့် ထိန်းသိမ်းပေးထားပါသည်။ ငွေပေးချေမှုကို လက်ခံရရှိပြီး အတည်ပြုမှသာ အော်ဒါ အတည်ဖြစ်ပါသည်။",
        },
        {
          en: "Unpaid orders expire automatically after the time shown on the payment page, and the tickets or seats are released.",
          mm: "ငွေမပေးချေရသေးသော အော်ဒါများသည် ငွေပေးချေရမည့် စာမျက်နှာတွင် ပြထားသော အချိန်ကျော်လွန်ပါက အလိုအလျောက် ပျက်ပြယ်ပြီး လက်မှတ် သို့မဟုတ် နေရာများကို ပြန်လည်ရောင်းချပါမည်။",
        },
        {
          en: "The price you pay, including any platform fee, is shown before you pay.",
          mm: "ပလက်ဖောင်းဝန်ဆောင်ခ အပါအဝင် ပေးချေရမည့် စုစုပေါင်းငွေပမာဏကို ငွေမပေးချေမီ ပြသပါသည်။",
        },
      ],
    },
    {
      title: { en: "2. Tickets and entry", mm: "၂။ လက်မှတ်နှင့် ဝင်ခွင့်" },
      items: [
        {
          en: "Each ticket admits one person, once. Its QR code can be scanned for entry only one time; the first scan is the one that counts.",
          mm: "လက်မှတ်တစ်စောင်လျှင် လူတစ်ဦး၊ တစ်ကြိမ်သာ ဝင်ခွင့်ရှိပါသည်။ QR ကုဒ်ကို ဝင်ပေါက်တွင် တစ်ကြိမ်သာ စကင်ဖတ်နိုင်ပြီး ပထမဆုံး စကင်ဖတ်ခြင်းကိုသာ အတည်ပြုပါသည်။",
        },
        {
          en: "Keep your QR code private. Anyone holding a copy — a screenshot, a forwarded email, a printout — can use it before you, and we cannot admit the same ticket twice.",
          mm: "သင့် QR ကုဒ်ကို လျှို့ဝှက်စွာ ထိန်းသိမ်းပါ။ ဓာတ်ပုံရိုက်ကူးထားခြင်း၊ ထပ်ဆင့်ပို့ထားသော အီးမေးလ်၊ ပုံနှိပ်ထားခြင်း စသည့် မိတ္တူရှိသူ မည်သူမဆို သင့်ထက်အရင် အသုံးပြုနိုင်ပြီး လက်မှတ်တစ်စောင်တည်းကို နှစ်ကြိမ် ဝင်ခွင့်မပြုနိုင်ပါ။",
        },
        {
          en: "If you are sent an updated e-ticket, use the latest one. Earlier copies may no longer be accepted at the gate.",
          mm: "ပြင်ဆင်ထားသော E-Ticket အသစ် ပို့ပေးခံရပါက နောက်ဆုံးရရှိသည့် လက်မှတ်ကို အသုံးပြုပါ။ ယခင်မိတ္တူများကို ဝင်ပေါက်တွင် လက်မခံတော့နိုင်ပါ။",
        },
      ],
    },
    {
      title: { en: "3. Refunds", mm: "၃။ ငွေပြန်အမ်းခြင်း" },
      items: [
        {
          en: "Refunds are decided by the organiser. Unless the organiser's event rules say otherwise, tickets are non-refundable, including if you cannot attend.",
          mm: "ငွေပြန်အမ်းခြင်းကို စီစဉ်သူက ဆုံးဖြတ်ပါသည်။ စီစဉ်သူ၏ ပွဲစည်းကမ်းများတွင် အခြားနည်း ဖော်ပြထားခြင်းမရှိပါက သင်တက်ရောက်နိုင်ခြင်း မရှိသည့်အခါ အပါအဝင် လက်မှတ်ခကို ပြန်မအမ်းပါ။",
        },
        {
          en: "If the organiser cancels the event, the organiser is responsible for contacting you about refunds.",
          mm: "စီစဉ်သူက ပွဲကို ပယ်ဖျက်ပါက ငွေပြန်အမ်းခြင်းနှင့်ပတ်သက်၍ သင့်ထံ ဆက်သွယ်ရန် စီစဉ်သူတွင် တာဝန်ရှိပါသည်။",
        },
        {
          en: "The platform fee pays for the ordering and ticketing service and is refunded only when the organiser's refund includes it.",
          mm: "ပလက်ဖောင်းဝန်ဆောင်ခသည် အော်ဒါနှင့် လက်မှတ်ဝန်ဆောင်မှုအတွက် ဖြစ်ပြီး စီစဉ်သူ၏ ငွေပြန်အမ်းမှုတွင် ပါဝင်မှသာ ပြန်အမ်းပါသည်။",
        },
      ],
    },
    {
      title: { en: "4. Resale and transfer", mm: "၄။ ပြန်လည်ရောင်းချခြင်းနှင့် လွှဲပြောင်းခြင်း" },
      items: [
        {
          en: "Tickets are for personal use. Reselling tickets for profit is not allowed, and the organiser may refuse entry to tickets obtained through unauthorised resale.",
          mm: "လက်မှတ်များသည် ကိုယ်တိုင်အသုံးပြုရန်ဖြစ်ပါသည်။ အမြတ်အစွန်းအတွက် ပြန်လည်ရောင်းချခြင်းကို ခွင့်မပြုပါ။ ခွင့်ပြုချက်မရှိဘဲ ပြန်လည်ရောင်းချထားသော လက်မှတ်များကို စီစဉ်သူက ဝင်ခွင့်ငြင်းပယ်နိုင်ပါသည်။",
        },
        {
          en: "Whoever presents a valid, unused QR code is admitted. If you give a ticket to someone else, you are responsible for how it is used.",
          mm: "မှန်ကန်ပြီး မသုံးရသေးသော QR ကုဒ်ကို ပြသသူ မည်သူမဆို ဝင်ခွင့်ရပါသည်။ လက်မှတ်ကို အခြားသူထံ ပေးပါက ၎င်းအသုံးပြုပုံအတွက် သင်တာဝန်ရှိပါသည်။",
        },
      ],
    },
    {
      title: { en: "5. Lost tickets", mm: "၅။ လက်မှတ်ပျောက်ဆုံးခြင်း" },
      items: [
        {
          en: "You can open your ticket again at any time from the link in your confirmation email or on your payment page.",
          mm: "အတည်ပြုအီးမေးလ်ရှိ လင့်ခ် သို့မဟုတ် ငွေပေးချေသည့် စာမျက်နှာမှ သင့်လက်မှတ်ကို အချိန်မရွေး ပြန်ဖွင့်ကြည့်နိုင်ပါသည်။",
        },
        {
          en: "A ticket that has already been scanned cannot be reissued or used again.",
          mm: "စကင်ဖတ်ပြီးသော လက်မှတ်ကို ထပ်မံထုတ်ပေးခြင်း သို့မဟုတ် ထပ်မံအသုံးပြုခြင်း မပြုနိုင်ပါ။",
        },
      ],
    },
    {
      title: { en: "6. Changes to the event", mm: "၆။ ပွဲအစီအစဉ် ပြောင်းလဲခြင်း" },
      items: [
        {
          en: "The organiser may change the date, time, venue or programme of the event. The organiser, not KuuNyi, is responsible for the event itself and for telling you about changes.",
          mm: "စီစဉ်သူသည် ပွဲ၏ ရက်စွဲ၊ အချိန်၊ နေရာ သို့မဟုတ် အစီအစဉ်ကို ပြောင်းလဲနိုင်ပါသည်။ ပွဲကိုယ်တိုင်နှင့် ပြောင်းလဲမှုများကို အသိပေးခြင်းအတွက် KuuNyi မဟုတ်ဘဲ စီစဉ်သူတွင် တာဝန်ရှိပါသည်။",
        },
      ],
    },
    {
      title: { en: "7. Your information", mm: "၇။ သင့်အချက်အလက်များ" },
      items: [
        {
          en: "We share your order details and contact information with the organiser so they can run the event and contact you.",
          mm: "ပွဲကျင်းပရန်နှင့် သင့်ထံ ဆက်သွယ်နိုင်ရန် သင့်အော်ဒါအသေးစိတ်နှင့် ဆက်သွယ်ရန် အချက်အလက်များကို စီစဉ်သူထံ မျှဝေပါသည်။",
        },
        {
          en: "If the organiser uses a separate entry-scanning service, we give that service your order reference and ticket ID only — not your name or contact details. See our Privacy Policy for more.",
          mm: "စီစဉ်သူက သီးခြား ဝင်ပေါက်စကင်ဖတ်ခြင်း ဝန်ဆောင်မှုကို အသုံးပြုပါက ထိုဝန်ဆောင်မှုထံ သင့်အော်ဒါနံပါတ်နှင့် လက်မှတ် ID ကိုသာ ပေးပါသည်၊ သင့်အမည် သို့မဟုတ် ဆက်သွယ်ရန် အချက်အလက်များ မပါဝင်ပါ။ အသေးစိတ်ကို ကိုယ်ရေးအချက်အလက်မူဝါဒတွင် ကြည့်ပါ။",
        },
      ],
    },
    {
      title: { en: "8. Contact", mm: "၈။ ဆက်သွယ်ရန်" },
      items: [
        {
          en: "For questions about the event, contact the organiser. For problems with your order or ticket on the platform, contact support@kuunyi.com.",
          mm: "ပွဲနှင့်ပတ်သက်သော မေးခွန်းများအတွက် စီစဉ်သူထံ ဆက်သွယ်ပါ။ ပလက်ဖောင်းပေါ်ရှိ အော်ဒါ သို့မဟုတ် လက်မှတ်ဆိုင်ရာ ပြဿနာများအတွက် support@kuunyi.com သို့ ဆက်သွယ်ပါ။",
        },
      ],
    },
  ],
};

// ─── Privacy Policy ─────────────────────────────────────────────────────────

export const PRIVACY_POLICY: LegalDocumentData = {
  title: { en: "Privacy Policy", mm: "ကိုယ်ရေးအချက်အလက် မူဝါဒ" },
  subtitle: {
    en: "Last updated: September 2026 · Effective: September 2026",
    mm: "နောက်ဆုံးပြင်ဆင်သည့်ရက် - ၂၀၂၆ ခုနှစ် စက်တင်ဘာလ · စတင်အသက်ဝင်သည့်ရက် - ၂၀၂၆ ခုနှစ် စက်တင်ဘာလ",
  },
  intro: {
    en:
      "KuuNyi (“we”, “our”, or “us”) is committed to protecting your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our enrollment management platform at kuunyi.com and any associated subdomains.",
    mm:
      "KuuNyi (“ကျွန်ုပ်တို့”) သည် သင်၏ ကိုယ်ရေးအချက်အလက်များကို ကာကွယ်ရန် ကတိပြုပါသည်။ ဤမူဝါဒသည် kuunyi.com နှင့် ဆက်စပ် subdomain များရှိ ကျွန်ုပ်တို့၏ စာရင်းသွင်းမှု စီမံခန့်ခွဲရေး ပလက်ဖောင်းကို အသုံးပြုသည့်အခါ သင့်အချက်အလက်များကို မည်သို့ စုဆောင်း၊ အသုံးပြု၊ ထုတ်ဖော်ပြီး ကာကွယ်ကြောင်း ရှင်းပြထားပါသည်။",
  },
  sections: [
    {
      title: { en: "1. Information We Collect", mm: "၁။ ကျွန်ုပ်တို့ စုဆောင်းသော အချက်အလက်များ" },
      intro: {
        en: "We collect information you provide directly to us when using the KuuNyi platform:",
        mm: "KuuNyi ပလက်ဖောင်းကို အသုံးပြုသည့်အခါ သင်ကိုယ်တိုင် ပေးအပ်သော အချက်အလက်များကို စုဆောင်းပါသည်-",
      },
      items: [
        {
          en: "Account information — name, email address, and password when you register an organization",
          mm: "အကောင့်အချက်အလက် — အဖွဲ့အစည်းကို စာရင်းသွင်းသည့်အခါ အမည်၊ အီးမေးလ်လိပ်စာနှင့် စကားဝှက်",
        },
        {
          en: "Organization information — school or business name, subdomain, and organization type",
          mm: "အဖွဲ့အစည်းအချက်အလက် — ကျောင်း သို့မဟုတ် လုပ်ငန်းအမည်၊ subdomain နှင့် အဖွဲ့အစည်းအမျိုးအစား",
        },
        {
          en: "Enrollment data — student names, contact information, NRC numbers, and form responses submitted through enrollment forms",
          mm: "စာရင်းသွင်းမှု အချက်အလက် — စာရင်းသွင်းပုံစံများမှ တင်သွင်းသော အမည်၊ ဆက်သွယ်ရန် အချက်အလက်၊ မှတ်ပုံတင်အမှတ်နှင့် ပုံစံဖြည့်စွက်ချက်များ",
        },
        {
          en: "Payment records — payment proof images and payment status information",
          mm: "ငွေပေးချေမှု မှတ်တမ်း — ငွေလွှဲပြေစာ ဓာတ်ပုံများနှင့် ငွေပေးချေမှု အခြေအနေ",
        },
        {
          en: "Ticket data — ticket IDs, and the time and gate at which a ticket was scanned for entry",
          mm: "လက်မှတ် အချက်အလက် — လက်မှတ် ID နှင့် ဝင်ပေါက်တွင် လက်မှတ်ကို စကင်ဖတ်ခဲ့သည့် အချိန်နှင့် ဝင်ပေါက်",
        },
        {
          en: "Consent records — when you accepted the Terms of Sale and event rules, and which version",
          mm: "သဘောတူညီချက် မှတ်တမ်း — ရောင်းချမှုစည်းကမ်းချက်များနှင့် ပွဲစည်းကမ်းများကို သဘောတူခဲ့သည့် အချိန်နှင့် ဗားရှင်း",
        },
        {
          en: "Messenger data — Facebook Page IDs and access tokens for organizations using the Messenger bot integration",
          mm: "Messenger အချက်အလက် — Messenger bot ကို ချိတ်ဆက်အသုံးပြုသော အဖွဲ့အစည်းများ၏ Facebook Page ID နှင့် access token များ",
        },
        {
          en: "Usage data — pages visited, actions taken, and timestamps within the platform",
          mm: "အသုံးပြုမှု အချက်အလက် — ပလက်ဖောင်းအတွင်း ကြည့်ရှုခဲ့သော စာမျက်နှာများ၊ ဆောင်ရွက်ခဲ့သော လုပ်ဆောင်ချက်များနှင့် အချိန်မှတ်တမ်းများ",
        },
      ],
    },
    {
      title: { en: "2. How We Use Your Information", mm: "၂။ သင့်အချက်အလက်များကို အသုံးပြုပုံ" },
      intro: {
        en: "We use the information we collect to:",
        mm: "စုဆောင်းထားသော အချက်အလက်များကို အောက်ပါအတွက် အသုံးပြုပါသည်-",
      },
      items: [
        {
          en: "Provide, operate, and maintain the KuuNyi platform",
          mm: "KuuNyi ပလက်ဖောင်းကို ပံ့ပိုး၊ လည်ပတ်ပြီး ထိန်းသိမ်းရန်",
        },
        {
          en: "Process enrollments and manage student records on behalf of organizations",
          mm: "အဖွဲ့အစည်းများကိုယ်စား စာရင်းသွင်းမှုများကို ဆောင်ရွက်ပြီး မှတ်တမ်းများကို စီမံရန်",
        },
        {
          en: "Send enrollment confirmation and status notification emails",
          mm: "အတည်ပြုချက်နှင့် အခြေအနေ အသိပေး အီးမေးလ်များ ပို့ရန်",
        },
        {
          en: "Enable Facebook Messenger chatbot functionality for connected organizations",
          mm: "ချိတ်ဆက်ထားသော အဖွဲ့အစည်းများအတွက် Facebook Messenger chatbot ကို အသုံးပြုနိုင်စေရန်",
        },
        {
          en: "Improve and develop new features for the platform",
          mm: "ပလက်ဖောင်းကို တိုးတက်စေပြီး လုပ်ဆောင်ချက်အသစ်များ ဖန်တီးရန်",
        },
        {
          en: "Respond to support requests and inquiries",
          mm: "အကူအညီတောင်းခံမှုများနှင့် မေးမြန်းချက်များကို ပြန်လည်ဖြေကြားရန်",
        },
        {
          en: "Ensure the security and integrity of the platform",
          mm: "ပလက်ဖောင်း၏ လုံခြုံရေးနှင့် ခိုင်မာမှုကို သေချာစေရန်",
        },
      ],
    },
    {
      title: { en: "3. Data Storage and Security", mm: "၃။ အချက်အလက် သိမ်းဆည်းခြင်းနှင့် လုံခြုံရေး" },
      intro: {
        en:
          "Your data is stored securely using Supabase (PostgreSQL) hosted infrastructure. We implement industry-standard security measures including:",
        mm:
          "သင့်အချက်အလက်များကို Supabase (PostgreSQL) hosting အခြေခံအဆောက်အအုံတွင် လုံခြုံစွာ သိမ်းဆည်းထားပါသည်။ အောက်ပါ စံချိန်မီ လုံခြုံရေး အစီအမံများကို ကျင့်သုံးပါသည်-",
      },
      items: [
        { en: "Encrypted data transmission via HTTPS/TLS", mm: "HTTPS/TLS ဖြင့် ကုဒ်ဝှက်ထားသော ဒေတာပေးပို့ခြင်း" },
        {
          en: "Row-level security policies on all database tables",
          mm: "ဒေတာဘေ့စ် ဇယားအားလုံးတွင် row-level security မူဝါဒများ",
        },
        { en: "Secure authentication via Supabase Auth", mm: "Supabase Auth ဖြင့် လုံခြုံသော အကောင့်ဝင်ရောက်ခြင်း" },
        {
          en: "Role-based access controls limiting data access by user role",
          mm: "အသုံးပြုသူ၏ အခန်းကဏ္ဍအလိုက် ဒေတာဝင်ရောက်ခွင့်ကို ကန့်သတ်ခြင်း",
        },
        {
          en: "Audit logging for sensitive operations such as bank account changes",
          mm: "ဘဏ်အကောင့် ပြောင်းလဲခြင်းကဲ့သို့ အရေးကြီးသော လုပ်ဆောင်ချက်များအတွက် စစ်ဆေးမှတ်တမ်း",
        },
      ],
      outro: {
        en:
          "While we implement strong security measures, no method of transmission over the internet is 100% secure. We cannot guarantee absolute security of your data.",
        mm:
          "ခိုင်မာသော လုံခြုံရေး အစီအမံများ ကျင့်သုံးသော်လည်း အင်တာနက်ပေါ်ရှိ ပေးပို့မှုနည်းလမ်းတိုင်းသည် ၁၀၀ ရာခိုင်နှုန်း လုံခြုံသည် မဟုတ်ပါ။ သင့်အချက်အလက်များ၏ လုံးဝလုံခြုံမှုကို အာမမခံနိုင်ပါ။",
      },
    },
    {
      title: { en: "4. Data Sharing and Disclosure", mm: "၄။ အချက်အလက် မျှဝေခြင်းနှင့် ထုတ်ဖော်ခြင်း" },
      intro: {
        en:
          "We do not sell, trade, or rent your personal information to third parties. We may share your information only in the following circumstances:",
        mm:
          "သင့်ကိုယ်ရေးအချက်အလက်များကို ပြင်ပအဖွဲ့အစည်းများထံ ရောင်းချခြင်း၊ ဖလှယ်ခြင်း သို့မဟုတ် ငှားရမ်းခြင်း မပြုပါ။ အောက်ပါ အခြေအနေများတွင်သာ မျှဝေနိုင်ပါသည်-",
      },
      items: [
        {
          en: "With the organiser of the event or course you order from, who receives your order details and contact information so they can run it and contact you",
          mm: "သင်မှာယူသော ပွဲ သို့မဟုတ် သင်တန်း၏ စီစဉ်သူထံ — ပွဲကျင်းပရန်နှင့် သင့်ထံ ဆက်သွယ်နိုင်ရန် သင့်အော်ဒါအသေးစိတ်နှင့် ဆက်သွယ်ရန် အချက်အလက်များ",
        },
        {
          en: "With an organiser's entry-scanning provider, if they use one — your order reference and ticket ID only, never your name or contact details",
          mm: "စီစဉ်သူ အသုံးပြုသော ဝင်ပေါက်စကင်ဖတ်ခြင်း ဝန်ဆောင်မှု ရှိပါက ၎င်းထံ — သင့်အော်ဒါနံပါတ်နှင့် လက်မှတ် ID သာ၊ သင့်အမည် သို့မဟုတ် ဆက်သွယ်ရန် အချက်အလက် လုံးဝမပါဝင်ပါ",
        },
        {
          en: "With the payment provider you choose to pay with, to process your payment",
          mm: "သင့်ငွေပေးချေမှုကို ဆောင်ရွက်ရန် သင်ရွေးချယ်သော ငွေပေးချေမှု ဝန်ဆောင်မှုပေးသူထံ",
        },
        {
          en: "With service providers who assist in operating our platform (Supabase, Vercel, Resend) under strict data processing agreements",
          mm: "ပလက်ဖောင်း လည်ပတ်ရန် ကူညီသော ဝန်ဆောင်မှုပေးသူများ (Supabase, Vercel, Resend) ထံ — တင်းကျပ်သော ဒေတာ စီမံဆောင်ရွက်မှု သဘောတူညီချက်များဖြင့်",
        },
        {
          en: "With Facebook/Meta when you use the Messenger bot integration — governed by Meta's own Privacy Policy",
          mm: "Messenger bot ကို အသုံးပြုပါက Facebook/Meta ထံ — Meta ၏ ကိုယ်ပိုင် ကိုယ်ရေးအချက်အလက်မူဝါဒဖြင့် ထိန်းချုပ်ပါသည်",
        },
        {
          en: "When required by law, court order, or governmental authority",
          mm: "ဥပဒေ၊ တရားရုံးအမိန့် သို့မဟုတ် အစိုးရအာဏာပိုင်များက တောင်းဆိုသည့်အခါ",
        },
        {
          en: "To protect the rights, property, or safety of KuuNyi, our users, or the public",
          mm: "KuuNyi၊ ကျွန်ုပ်တို့၏ အသုံးပြုသူများ သို့မဟုတ် အများပြည်သူ၏ အခွင့်အရေး၊ ပိုင်ဆိုင်မှု သို့မဟုတ် ဘေးကင်းရေးကို ကာကွယ်ရန်",
        },
      ],
    },
    {
      title: { en: "5. Multi-Tenant Data Isolation", mm: "၅။ အဖွဲ့အစည်းအလိုက် ဒေတာ ခွဲခြားထားခြင်း" },
      intro: {
        en:
          "KuuNyi is a multi-tenant platform. Each organization's data is logically separated and isolated. Organization administrators cannot access data belonging to other organizations. Students and enrollees can only access their own enrollment information.",
        mm:
          "KuuNyi သည် အဖွဲ့အစည်းများစွာ အတူတကွ အသုံးပြုသော ပလက်ဖောင်း ဖြစ်ပါသည်။ အဖွဲ့အစည်းတစ်ခုစီ၏ ဒေတာကို သီးခြား ခွဲခြားထားပါသည်။ အဖွဲ့အစည်း စီမံခန့်ခွဲသူများသည် အခြားအဖွဲ့အစည်းများ၏ ဒေတာကို မကြည့်ရှုနိုင်ပါ။ စာရင်းသွင်းသူများသည် ၎င်းတို့၏ ကိုယ်ပိုင် စာရင်းသွင်းမှု အချက်အလက်ကိုသာ ကြည့်ရှုနိုင်ပါသည်။",
      },
    },
    {
      title: { en: "6. Facebook Messenger Integration", mm: "၆။ Facebook Messenger ချိတ်ဆက်မှု" },
      intro: {
        en: "If your organization uses the KuuNyi Messenger bot integration:",
        mm: "သင့်အဖွဲ့အစည်းက KuuNyi Messenger bot ကို ချိတ်ဆက်အသုံးပြုပါက-",
      },
      items: [
        {
          en: "We collect and store your Facebook Page ID and Page Access Token to enable bot functionality",
          mm: "bot လုပ်ဆောင်နိုင်ရန် သင့် Facebook Page ID နှင့် Page Access Token ကို စုဆောင်းသိမ်းဆည်းပါသည်",
        },
        {
          en: "Messages sent through Messenger are processed to respond to enrollment and status inquiries",
          mm: "Messenger မှ ပို့သော မက်ဆေ့ချ်များကို စာရင်းသွင်းမှုနှင့် အခြေအနေ မေးမြန်းချက်များကို ဖြေကြားရန် ဆောင်ရွက်ပါသည်",
        },
        {
          en: "We do not store full Messenger conversation histories beyond what is needed to process requests",
          mm: "တောင်းဆိုချက်များကို ဆောင်ရွက်ရန် လိုအပ်သည်ထက် ပိုသော Messenger စကားပြောမှတ်တမ်း အပြည့်အစုံကို မသိမ်းဆည်းပါ",
        },
        {
          en: "This integration is governed by both this Privacy Policy and Meta's Platform Terms",
          mm: "ဤချိတ်ဆက်မှုသည် ဤကိုယ်ရေးအချက်အလက်မူဝါဒနှင့် Meta ၏ Platform Terms နှစ်ခုလုံး၏ အောက်တွင် ရှိပါသည်",
        },
      ],
    },
    {
      title: { en: "7. Cookies and Tracking", mm: "၇။ Cookie နှင့် ခြေရာခံခြင်း" },
      intro: {
        en:
          "KuuNyi uses essential cookies to maintain your login session and platform functionality. We do not use advertising cookies or third-party tracking technologies. Session cookies are deleted when you close your browser.",
        mm:
          "KuuNyi သည် အကောင့်ဝင်ထားမှုနှင့် ပလက်ဖောင်း လုပ်ဆောင်ချက်များအတွက် မရှိမဖြစ် cookie များကိုသာ အသုံးပြုပါသည်။ ကြော်ငြာ cookie များ သို့မဟုတ် ပြင်ပ ခြေရာခံနည်းပညာများကို မသုံးပါ။ Session cookie များသည် browser ကို ပိတ်လိုက်သည့်အခါ ပျက်သွားပါသည်။",
      },
    },
    {
      title: { en: "8. Data Retention", mm: "၈။ အချက်အလက် ထိန်းသိမ်းထားသည့် ကာလ" },
      intro: {
        en:
          "We retain your data for as long as your account is active or as needed to provide services. Organization owners may request deletion of their account and associated data at any time by contacting us. Enrollment records may be retained for up to 12 months after account closure for legal compliance purposes.",
        mm:
          "သင့်အကောင့် အသုံးပြုနေသရွေ့ သို့မဟုတ် ဝန်ဆောင်မှုပေးရန် လိုအပ်သရွေ့ သင့်ဒေတာကို ထိန်းသိမ်းထားပါသည်။ အဖွဲ့အစည်း ပိုင်ရှင်များသည် ကျွန်ုပ်တို့ထံ ဆက်သွယ်၍ ၎င်းတို့၏ အကောင့်နှင့် ဆက်စပ်ဒေတာများကို အချိန်မရွေး ဖျက်ပေးရန် တောင်းဆိုနိုင်ပါသည်။ ဥပဒေနှင့် ကိုက်ညီစေရန် အကောင့်ပိတ်ပြီးနောက် စာရင်းသွင်းမှု မှတ်တမ်းများကို ၁၂ လအထိ ထိန်းသိမ်းထားနိုင်ပါသည်။",
      },
    },
    {
      title: { en: "9. Your Rights", mm: "၉။ သင်၏ အခွင့်အရေးများ" },
      intro: { en: "You have the right to:", mm: "သင့်တွင် အောက်ပါ အခွင့်အရေးများ ရှိပါသည်-" },
      items: [
        {
          en: "Access the personal information we hold about you",
          mm: "ကျွန်ုပ်တို့ ထိန်းသိမ်းထားသော သင့်ကိုယ်ရေးအချက်အလက်များကို ကြည့်ရှုရန်",
        },
        {
          en: "Request correction of inaccurate or incomplete data",
          mm: "မမှန်ကန် သို့မဟုတ် မပြည့်စုံသော အချက်အလက်များကို ပြင်ဆင်ပေးရန် တောင်းဆိုရန်",
        },
        { en: "Request deletion of your personal data", mm: "သင့်ကိုယ်ရေးအချက်အလက်များကို ဖျက်ပေးရန် တောင်းဆိုရန်" },
        {
          en: "Export your organization's enrollment data at any time",
          mm: "သင့်အဖွဲ့အစည်း၏ စာရင်းသွင်းမှု ဒေတာကို အချိန်မရွေး ထုတ်ယူရန်",
        },
        {
          en: "Withdraw consent for data processing where applicable",
          mm: "သက်ဆိုင်သည့်နေရာတွင် ဒေတာ ဆောင်ရွက်ခြင်းအတွက် ပေးထားသော သဘောတူညီချက်ကို ပြန်လည်ရုပ်သိမ်းရန်",
        },
      ],
      outro: {
        en: "To exercise any of these rights, please contact us using the details below.",
        mm: "ဤအခွင့်အရေးများကို အသုံးပြုလိုပါက အောက်ပါ လိပ်စာဖြင့် ဆက်သွယ်ပါ။",
      },
    },
    {
      title: { en: "10. Children's Privacy", mm: "၁၀။ ကလေးသူငယ်များ၏ ကိုယ်ရေးအချက်အလက်" },
      intro: {
        en:
          "KuuNyi is not directed to children under the age of 13. We do not knowingly collect personal information from children under 13. If you believe a child has provided us with personal information, please contact us and we will delete it promptly.",
        mm:
          "KuuNyi သည် အသက် ၁၃ နှစ်အောက် ကလေးများအတွက် ရည်ရွယ်ထားခြင်း မရှိပါ။ အသက် ၁၃ နှစ်အောက် ကလေးများထံမှ ကိုယ်ရေးအချက်အလက်များကို သိလျက်နှင့် မစုဆောင်းပါ။ ကလေးတစ်ဦးက ကျွန်ုပ်တို့ထံ ကိုယ်ရေးအချက်အလက် ပေးထားသည်ဟု ယူဆပါက ဆက်သွယ်ပါ၊ ချက်ချင်း ဖျက်ပေးပါမည်။",
      },
    },
    {
      title: { en: "11. Changes to This Policy", mm: "၁၁။ ဤမူဝါဒ ပြောင်းလဲခြင်း" },
      intro: {
        en:
          "We may update this Privacy Policy from time to time. We will notify organization administrators of material changes via email. Continued use of the platform after changes constitutes acceptance of the updated policy. The “Last updated” date at the top of this page reflects the most recent revision.",
        mm:
          "ဤကိုယ်ရေးအချက်အလက်မူဝါဒကို အခါအားလျော်စွာ ပြင်ဆင်နိုင်ပါသည်။ အရေးကြီးသော ပြောင်းလဲမှုများကို အဖွဲ့အစည်း စီမံခန့်ခွဲသူများထံ အီးမေးလ်ဖြင့် အကြောင်းကြားပါမည်။ ပြောင်းလဲပြီးနောက် ပလက်ဖောင်းကို ဆက်လက်အသုံးပြုခြင်းသည် ပြင်ဆင်ထားသော မူဝါဒကို လက်ခံခြင်း ဖြစ်ပါသည်။ ဤစာမျက်နှာ ထိပ်ရှိ “နောက်ဆုံးပြင်ဆင်သည့်ရက်” သည် နောက်ဆုံးပြင်ဆင်မှုကို ဖော်ပြပါသည်။",
      },
    },
    {
      title: { en: "12. Contact Us", mm: "၁၂။ ဆက်သွယ်ရန်" },
      intro: {
        en:
          "If you have questions, concerns, or requests regarding this Privacy Policy or how we handle your data, please contact us:",
        mm:
          "ဤကိုယ်ရေးအချက်အလက်မူဝါဒ သို့မဟုတ် သင့်ဒေတာကို ကိုင်တွယ်ပုံနှင့်ပတ်သက်၍ မေးခွန်း၊ စိုးရိမ်မှု သို့မဟုတ် တောင်းဆိုချက်များ ရှိပါက ဆက်သွယ်ပါ-",
      },
      contact: true,
      outro: {
        en: "We aim to respond to all privacy inquiries within 5 business days.",
        mm: "ကိုယ်ရေးအချက်အလက်ဆိုင်ရာ မေးမြန်းချက်အားလုံးကို အလုပ်ရက် ၅ ရက်အတွင်း ပြန်လည်ဖြေကြားရန် ကြိုးစားပါသည်။",
      },
    },
  ],
};
