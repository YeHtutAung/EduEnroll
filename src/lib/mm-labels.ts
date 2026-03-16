// ─── Myanmar label mappings by org type ──────────────────────────────────────
// Used for dynamic Myanmar subtitles across admin pages.

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
    announcementPlaceholder:
      "မင်္ဂလာပါ။ ပွဲနှင့် ပတ်သက်သော အကြောင်းကြားချက်…\n\nHello. This is an announcement regarding your event…",
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
    announcementPlaceholder:
      "မင်္ဂလာပါ။ သင်တန်းနှင့် ပတ်သက်သော အကြောင်းကြားချက်…\n\nHello. This is an announcement regarding your training…",
  },
};

export function mm(orgType: string, key: string): string {
  return MM_LABELS[orgType]?.[key] ?? MM_LABELS.language_school[key] ?? "";
}
