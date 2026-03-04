export const metadata = {
  title: "Dashboard — Nihon Moment Admin",
};

export default function DashboardPage() {
  return (
    <div className="min-h-full flex flex-col items-center justify-center p-10 text-center">
      {/* School mark */}
      <div className="w-16 h-16 rounded-2xl bg-red-700 flex items-center justify-center mb-6 shadow-lg">
        <span className="text-white text-3xl font-bold select-none">日</span>
      </div>

      <h1 className="text-3xl font-bold text-slate-900 tracking-tight">
        Nihon Moment
      </h1>
      <p className="text-lg font-myanmar text-slate-500 mt-1">
        နီဟုန်မိုမန့် — ဂျပန်ဘာသာသင်တန်း
      </p>

      <div className="mt-10 rounded-2xl border-2 border-dashed border-slate-300 bg-white px-12 py-10 max-w-md">
        <p className="text-xl font-semibold text-slate-700">Dashboard</p>
        <p className="text-base font-myanmar text-slate-500 mt-1">ဒက်ရှ်ဘုတ်</p>

        <div className="mt-4 inline-flex items-center gap-2 rounded-full bg-amber-50 border border-amber-200 px-4 py-1.5 text-sm text-amber-700">
          <svg
            className="h-4 w-4 shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <span>Coming soon</span>
        </div>

        <p className="mt-5 text-slate-600 font-medium">
          Sprint 3 မှ ဆောင်ရွက်မည်
        </p>
        <p className="mt-1 text-sm text-slate-400 font-myanmar">
          ဒက်ရှ်ဘုတ် အင်္ဂါရပ်များကို Sprint 3 တွင် ထည့်သွင်းဆောင်ရွက်မည်
          ဖြစ်ပါသည်။
        </p>
      </div>
    </div>
  );
}
