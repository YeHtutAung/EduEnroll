// ─── Myanmar label mappings by org type ──────────────────────────────────────
// Used for dynamic Myanmar subtitles across admin pages.
//
// The `priorityWindow*`, `interestList*`, `sendInvitations`, and
// `resendGraceWarning` keys below (added for the event-interest priority
// window admin UI) are UNVERIFIED machine-assisted Myanmar — they have not
// been checked by a native speaker. Flagging per project convention.

const MM_LABELS: Record<string, Record<string, string>> = {
  language_school: {
    createIntake: "သင်တန်းအသစ်ဖွင့်မည်",
    intakesAndClasses: "သင်တန်းနှင့် အတန်းများ",
    recentEnrollments: "နောက်ဆုံး စာရင်းသွင်းမှုများ",
    editForm: "စာရင်းသွင်းဖောင် ပြင်ဆင်ရန်",
    totalEnrolled: "စာရင်းသွင်းသူ စုစုပေါင်း",
    enrollmentTrend: "နေ့စဉ်စာရင်းသွင်းမှု",
    classDistribution: "အတန်းအလိုက်ခွဲခြမ်း",
    seatFillRate: "နေရာပြည့်နှုန်း",
    thisIntake: "ယခုသင်တန်း",
    studentsSubtitle: "ကျောင်းသားများ",
    announcementPlaceholder:
      "မင်္ဂလာပါ။ သင်တန်းနှင့် ပတ်သက်သော အကြောင်းကြားချက်…\n\nHello. This is an announcement regarding your class…",
  },
  event: {
    createIntake: "ပွဲအသစ်ဖန်တီးမည်",
    intakesAndClasses: "ပွဲများနှင့် လက်မှတ်အမျိုးအစားများ",
    recentEnrollments: "နောက်ဆုံး မှတ်ပုံတင်မှုများ",
    editForm: "မှတ်ပုံတင်ဖောင် ပြင်ဆင်ရန်",
    totalEnrolled: "မှတ်ပုံတင်သူ စုစုပေါင်း",
    enrollmentTrend: "နေ့စဉ်မှတ်ပုံတင်မှု",
    classDistribution: "လက်မှတ်အမျိုးအစားအလိုက်ခွဲခြမ်း",
    seatFillRate: "လက်မှတ်ရောင်းအားနှုန်း",
    thisIntake: "ယခုပွဲ",
    studentsSubtitle: "တက်ရောက်သူများ",
    announcementPlaceholder:
      "မင်္ဂလာပါ။ ပွဲနှင့် ပတ်သက်သော အကြောင်းကြားချက်…\n\nHello. This is an announcement regarding your event…",
    priorityWindowHelp:
      "စာရင်းပေးထားသူများသည် ဤအချိန်မှစ၍ ဝင်ရောက်ဝယ်ယူနိုင်ပါမည်။ အများပြည်သူမူကား လက်မှတ်အမျိုးအစားတစ်ခုစီ၏ ကိုယ်ပိုင်ရောင်းချချိန်မှသာ ဝင်ရောက်နိုင်ပါမည်။",
    interestListSubtitle: "စိတ်ဝင်စားသူ စာရင်း",
    sendInvitations: "ဖိတ်ကြားချက်များ ပို့မည်",
    resendGraceWarning:
      "ယခင်လင့်ခ်သည် အကျုံးဝင်ကာလအတွင်း ရှိနေဆဲဖြစ်သည်။ ပြန်ပို့ခြင်းက ထိုကာလကို တိုတောင်းစေပါမည်။",
  },
  training_center: {
    createIntake: "သင်တန်းအသစ်ဖွင့်မည်",
    intakesAndClasses: "သင်တန်းနှင့် အမျိုးအစားများ",
    recentEnrollments: "နောက်ဆုံး စာရင်းသွင်းမှုများ",
    editForm: "စာရင်းသွင်းဖောင် ပြင်ဆင်ရန်",
    totalEnrolled: "စာရင်းသွင်းသူ စုစုပေါင်း",
    enrollmentTrend: "နေ့စဉ်စာရင်းသွင်းမှု",
    classDistribution: "အမျိုးအစားအလိုက်ခွဲခြမ်း",
    seatFillRate: "နေရာပြည့်နှုန်း",
    thisIntake: "ယခုသင်တန်း",
    studentsSubtitle: "သင်တန်းသားများ",
    announcementPlaceholder:
      "မင်္ဂလာပါ။ သင်တန်းနှင့် ပတ်သက်သော အကြောင်းကြားချက်…\n\nHello. This is an announcement regarding your training…",
    priorityWindowHelp:
      "စာရင်းပေးထားသူများသည် ဤအချိန်မှစ၍ ဝင်ရောက်စာရင်းသွင်းနိုင်ပါမည်။ အများပြည်သူမူကား အတန်းအမျိုးအစားတစ်ခုစီ၏ ကိုယ်ပိုင်ဖွင့်လှစ်ချိန်မှသာ ဝင်ရောက်နိုင်ပါမည်။",
    interestListSubtitle: "စိတ်ဝင်စားသူ စာရင်း",
    sendInvitations: "ဖိတ်ကြားချက်များ ပို့မည်",
    resendGraceWarning:
      "ယခင်လင့်ခ်သည် အကျုံးဝင်ကာလအတွင်း ရှိနေဆဲဖြစ်သည်။ ပြန်ပို့ခြင်းက ထိုကာလကို တိုတောင်းစေပါမည်။",
  },
};

export function mm(orgType: string, key: string): string {
  return MM_LABELS[orgType]?.[key] ?? MM_LABELS.language_school[key] ?? "";
}
