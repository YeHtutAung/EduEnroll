"use client";

export default function BillingPage() {
  return (
    <div className="min-h-screen bg-[#f0f4ff] px-6 py-8 lg:px-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Billing</h1>
        <p className="text-sm font-myanmar text-gray-400 mt-0.5">ငွေတောင်းခံခြင်း</p>
      </div>

      <div className="mt-8 bg-white rounded-2xl border border-gray-100 shadow-sm p-8 max-w-lg">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center">
            <svg
              className="w-5 h-5 text-[#1a6b3c]"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <div>
            <h2 className="text-base font-bold text-gray-900">Free Beta</h2>
            <p className="text-sm text-[#1a6b3c] font-medium">Active</p>
          </div>
        </div>

        <p className="text-sm text-gray-600 leading-relaxed">
          Pricing coming soon. You will be notified before any charges apply.
        </p>
        <p className="text-sm text-gray-400 font-myanmar mt-2 leading-relaxed">
          စျေးနှုန်းများ မကြာမီ ထွက်ရှိပါမည်။ ကောက်ခံမှု မပြုမီ ကြိုတင်အကြောင်းကြားပါမည်။
        </p>

        <div className="mt-6 pt-5 border-t border-gray-100">
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-500">Current Plan</span>
            <span className="font-semibold text-gray-900 bg-emerald-100 text-emerald-700 px-3 py-1 rounded-full text-xs">
              Free Beta
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
