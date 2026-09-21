import type { Metadata } from "next";
import { TERMS_VERSION } from "@/lib/legal/terms";

export const metadata: Metadata = {
  title: "Terms of Sale - KuuNyi",
  description:
    "The terms that apply when you buy a ticket or place an order through KuuNyi.",
};

// Wording changes here must bump TERMS_VERSION in src/lib/legal/terms.ts, so
// orders from pages loaded before the change are asked to reload and re-accept.

export default function TermsOfSalePage() {
  return (
    <div className="mx-auto max-w-[740px] py-10 sm:py-16">
      <p className="mb-4 text-[11px] font-mono uppercase tracking-[0.2em] text-gray-500">
        Legal Document
      </p>

      <h1 className="text-3xl sm:text-[40px] font-semibold leading-tight tracking-tight text-gray-900 mb-1">
        Terms of Sale
      </h1>
      <p className="font-myanmar text-xl text-gray-700 mb-3">ရောင်းချမှုဆိုင်ရာ စည်းကမ်းချက်များ</p>

      <p className="text-xs font-mono text-gray-500 mb-12 pb-8 border-b border-gray-200">
        Version {TERMS_VERSION}
      </p>

      <div className="mb-12 rounded border border-gray-200 border-l-[3px] border-l-[#6d28d9] bg-white px-6 py-5 text-[15px] leading-[1.7] text-gray-500">
        <p>
          KuuNyi (&ldquo;we&rdquo;, &ldquo;us&rdquo;) runs the ordering and ticketing platform used by
          the organiser named on your order (the &ldquo;organiser&rdquo;). The organiser runs the event
          or course. By placing an order you agree to these terms, our{" "}
          <a href="/privacy" className="text-[#6d28d9] hover:underline">Privacy Policy</a>, and any
          event rules the organiser showed you before you ordered.
        </p>
        <p className="font-myanmar mt-3">
          KuuNyi သည် သင့်အော်ဒါတွင် ဖော်ပြထားသော စီစဉ်သူ (&ldquo;စီစဉ်သူ&rdquo;) အသုံးပြုသည့်
          အော်ဒါမှာယူခြင်းနှင့် လက်မှတ်ရောင်းချခြင်း ပလက်ဖောင်းကို လည်ပတ်ပါသည်။ ပွဲ သို့မဟုတ်
          သင်တန်းကို စီစဉ်သူက ကျင်းပပါသည်။ အော်ဒါမှာယူခြင်းဖြင့် ဤစည်းကမ်းချက်များ၊ ကျွန်ုပ်တို့၏
          ကိုယ်ရေးအချက်အလက်မူဝါဒနှင့် မှာယူမီ စီစဉ်သူ ပြသခဲ့သော ပွဲစည်းကမ်းများကို သဘောတူပါသည်။
        </p>
      </div>

      <div className="space-y-10 text-[14.5px] leading-[1.8] text-[#3a3a36]">
        <Section
          title="1. Your order"
          titleMm="၁။ သင့်အော်ဒါ"
          en={[
            "Placing an order reserves your tickets or seats for a limited time. The order is confirmed only once your payment has been received and verified.",
            "Unpaid orders expire automatically after the time shown on the payment page, and the tickets or seats are released.",
            "The price you pay, including any platform fee, is shown before you pay.",
          ]}
          mm={[
            "အော်ဒါမှာယူလိုက်သည်နှင့် လက်မှတ် သို့မဟုတ် နေရာကို အချိန်အကန့်အသတ်ဖြင့် ထိန်းသိမ်းပေးထားပါသည်။ ငွေပေးချေမှုကို လက်ခံရရှိပြီး အတည်ပြုမှသာ အော်ဒါ အတည်ဖြစ်ပါသည်။",
            "ငွေမပေးချေရသေးသော အော်ဒါများသည် ငွေပေးချေရမည့် စာမျက်နှာတွင် ပြထားသော အချိန်ကျော်လွန်ပါက အလိုအလျောက် ပျက်ပြယ်ပြီး လက်မှတ် သို့မဟုတ် နေရာများကို ပြန်လည်ရောင်းချပါမည်။",
            "ပလက်ဖောင်းဝန်ဆောင်ခ အပါအဝင် ပေးချေရမည့် စုစုပေါင်းငွေပမာဏကို ငွေမပေးချေမီ ပြသပါသည်။",
          ]}
        />

        <Section
          title="2. Tickets and entry"
          titleMm="၂။ လက်မှတ်နှင့် ဝင်ခွင့်"
          en={[
            "Each ticket admits one person, once. Its QR code can be scanned for entry only one time; the first scan is the one that counts.",
            "Keep your QR code private. Anyone holding a copy — a screenshot, a forwarded email, a printout — can use it before you, and we cannot admit the same ticket twice.",
            "If you are sent an updated e-ticket, use the latest one. Earlier copies may no longer be accepted at the gate.",
          ]}
          mm={[
            "လက်မှတ်တစ်စောင်လျှင် လူတစ်ဦး၊ တစ်ကြိမ်သာ ဝင်ခွင့်ရှိပါသည်။ QR ကုဒ်ကို ဝင်ပေါက်တွင် တစ်ကြိမ်သာ စကင်ဖတ်နိုင်ပြီး ပထမဆုံး စကင်ဖတ်ခြင်းကိုသာ အတည်ပြုပါသည်။",
            "သင့် QR ကုဒ်ကို လျှို့ဝှက်စွာ ထိန်းသိမ်းပါ။ ဓာတ်ပုံရိုက်ကူးထားခြင်း၊ ထပ်ဆင့်ပို့ထားသော အီးမေးလ်၊ ပုံနှိပ်ထားခြင်း စသည့် မိတ္တူရှိသူ မည်သူမဆို သင့်ထက်အရင် အသုံးပြုနိုင်ပြီး လက်မှတ်တစ်စောင်တည်းကို နှစ်ကြိမ် ဝင်ခွင့်မပြုနိုင်ပါ။",
            "ပြင်ဆင်ထားသော E-Ticket အသစ် ပို့ပေးခံရပါက နောက်ဆုံးရရှိသည့် လက်မှတ်ကို အသုံးပြုပါ။ ယခင်မိတ္တူများကို ဝင်ပေါက်တွင် လက်မခံတော့နိုင်ပါ။",
          ]}
        />

        <Section
          title="3. Refunds"
          titleMm="၃။ ငွေပြန်အမ်းခြင်း"
          en={[
            "Refunds are decided by the organiser. Unless the organiser's event rules say otherwise, tickets are non-refundable, including if you cannot attend.",
            "If the organiser cancels the event, the organiser is responsible for contacting you about refunds.",
            "The platform fee pays for the ordering and ticketing service and is refunded only when the organiser's refund includes it.",
          ]}
          mm={[
            "ငွေပြန်အမ်းခြင်းကို စီစဉ်သူက ဆုံးဖြတ်ပါသည်။ စီစဉ်သူ၏ ပွဲစည်းကမ်းများတွင် အခြားနည်း ဖော်ပြထားခြင်းမရှိပါက သင်တက်ရောက်နိုင်ခြင်း မရှိသည့်အခါ အပါအဝင် လက်မှတ်ခကို ပြန်မအမ်းပါ။",
            "စီစဉ်သူက ပွဲကို ပယ်ဖျက်ပါက ငွေပြန်အမ်းခြင်းနှင့်ပတ်သက်၍ သင့်ထံ ဆက်သွယ်ရန် စီစဉ်သူတွင် တာဝန်ရှိပါသည်။",
            "ပလက်ဖောင်းဝန်ဆောင်ခသည် အော်ဒါနှင့် လက်မှတ်ဝန်ဆောင်မှုအတွက် ဖြစ်ပြီး စီစဉ်သူ၏ ငွေပြန်အမ်းမှုတွင် ပါဝင်မှသာ ပြန်အမ်းပါသည်။",
          ]}
        />

        <Section
          title="4. Resale and transfer"
          titleMm="၄။ ပြန်လည်ရောင်းချခြင်းနှင့် လွှဲပြောင်းခြင်း"
          en={[
            "Tickets are for personal use. Reselling tickets for profit is not allowed, and the organiser may refuse entry to tickets obtained through unauthorised resale.",
            "Whoever presents a valid, unused QR code is admitted. If you give a ticket to someone else, you are responsible for how it is used.",
          ]}
          mm={[
            "လက်မှတ်များသည် ကိုယ်တိုင်အသုံးပြုရန်ဖြစ်ပါသည်။ အမြတ်အစွန်းအတွက် ပြန်လည်ရောင်းချခြင်းကို ခွင့်မပြုပါ။ ခွင့်ပြုချက်မရှိဘဲ ပြန်လည်ရောင်းချထားသော လက်မှတ်များကို စီစဉ်သူက ဝင်ခွင့်ငြင်းပယ်နိုင်ပါသည်။",
            "မှန်ကန်ပြီး မသုံးရသေးသော QR ကုဒ်ကို ပြသသူ မည်သူမဆို ဝင်ခွင့်ရပါသည်။ လက်မှတ်ကို အခြားသူထံ ပေးပါက ၎င်းအသုံးပြုပုံအတွက် သင်တာဝန်ရှိပါသည်။",
          ]}
        />

        <Section
          title="5. Lost tickets"
          titleMm="၅။ လက်မှတ်ပျောက်ဆုံးခြင်း"
          en={[
            "You can open your ticket again at any time from the link in your confirmation email or on your payment page.",
            "A ticket that has already been scanned cannot be reissued or used again.",
          ]}
          mm={[
            "အတည်ပြုအီးမေးလ်ရှိ လင့်ခ် သို့မဟုတ် ငွေပေးချေသည့် စာမျက်နှာမှ သင့်လက်မှတ်ကို အချိန်မရွေး ပြန်ဖွင့်ကြည့်နိုင်ပါသည်။",
            "စကင်ဖတ်ပြီးသော လက်မှတ်ကို ထပ်မံထုတ်ပေးခြင်း သို့မဟုတ် ထပ်မံအသုံးပြုခြင်း မပြုနိုင်ပါ။",
          ]}
        />

        <Section
          title="6. Changes to the event"
          titleMm="၆။ ပွဲအစီအစဉ် ပြောင်းလဲခြင်း"
          en={[
            "The organiser may change the date, time, venue or programme of the event. The organiser, not KuuNyi, is responsible for the event itself and for telling you about changes.",
          ]}
          mm={[
            "စီစဉ်သူသည် ပွဲ၏ ရက်စွဲ၊ အချိန်၊ နေရာ သို့မဟုတ် အစီအစဉ်ကို ပြောင်းလဲနိုင်ပါသည်။ ပွဲကိုယ်တိုင်နှင့် ပြောင်းလဲမှုများကို အသိပေးခြင်းအတွက် KuuNyi မဟုတ်ဘဲ စီစဉ်သူတွင် တာဝန်ရှိပါသည်။",
          ]}
        />

        <Section
          title="7. Your information"
          titleMm="၇။ သင့်အချက်အလက်များ"
          en={[
            "We share your order details and contact information with the organiser so they can run the event and contact you.",
            "If the organiser uses a separate entry-scanning service, we give that service your order reference and ticket ID only — not your name or contact details. See our Privacy Policy for more.",
          ]}
          mm={[
            "ပွဲကျင်းပရန်နှင့် သင့်ထံ ဆက်သွယ်နိုင်ရန် သင့်အော်ဒါအသေးစိတ်နှင့် ဆက်သွယ်ရန် အချက်အလက်များကို စီစဉ်သူထံ မျှဝေပါသည်။",
            "စီစဉ်သူက သီးခြား ဝင်ပေါက်စကင်ဖတ်ခြင်း ဝန်ဆောင်မှုကို အသုံးပြုပါက ထိုဝန်ဆောင်မှုထံ သင့်အော်ဒါနံပါတ်နှင့် လက်မှတ် ID ကိုသာ ပေးပါသည်၊ သင့်အမည် သို့မဟုတ် ဆက်သွယ်ရန် အချက်အလက်များ မပါဝင်ပါ။ အသေးစိတ်ကို ကိုယ်ရေးအချက်အလက်မူဝါဒတွင် ကြည့်ပါ။",
          ]}
        />

        <Section
          title="8. Contact"
          titleMm="၈။ ဆက်သွယ်ရန်"
          en={[
            "For questions about the event, contact the organiser. For problems with your order or ticket on the platform, contact support@kuunyi.com.",
          ]}
          mm={[
            "ပွဲနှင့်ပတ်သက်သော မေးခွန်းများအတွက် စီစဉ်သူထံ ဆက်သွယ်ပါ။ ပလက်ဖောင်းပေါ်ရှိ အော်ဒါ သို့မဟုတ် လက်မှတ်ဆိုင်ရာ ပြဿနာများအတွက် support@kuunyi.com သို့ ဆက်သွယ်ပါ။",
          ]}
        />
      </div>
    </div>
  );
}

function Section({
  title,
  titleMm,
  en,
  mm,
}: {
  title: string;
  titleMm: string;
  en: string[];
  mm: string[];
}) {
  return (
    <section>
      <h2 className="text-xl font-semibold tracking-tight text-gray-900">{title}</h2>
      <p className="font-myanmar text-base text-gray-600 mb-3">{titleMm}</p>
      <ul className="space-y-2">
        {en.map((item, i) => (
          <li key={i} className="relative pl-5">
            <span className="absolute left-0 text-xs text-gray-500">&mdash;</span>
            {item}
            {mm[i] && <span className="font-myanmar mt-1 block text-gray-500">{mm[i]}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
