import Link from "next/link";
import Image from "next/image";
import { marketingImageSrc as src, type MarketingContent } from "@/lib/marketing/content";

export default function MarketingPage({ content }: { content: MarketingContent }) {
  const { sections, hero, organizers, payments, solutions, pos, howItWorks, industries, cta, footer } = content;

  const visibleOrganizers = organizers.items.filter((o) => !o.hidden);
  const visiblePayments = payments.items.filter((p) => !p.hidden);
  const visibleSolutions = solutions.items.filter((s) => !s.hidden);
  const visibleSteps = howItWorks.steps.filter((s) => !s.hidden);
  const visibleIndustries = industries.items.filter((i) => !i.hidden);

  const showOrganizers = sections.organizers && visibleOrganizers.length > 0;
  const showPayments = sections.payments && visiblePayments.length > 0;
  const showCards = sections.solutions && visibleSolutions.length > 0;
  const showHow = sections.howItWorks && visibleSteps.length > 0;
  const showIndustries = sections.industries && visibleIndustries.length > 0;

  return (
    <div className="min-h-screen bg-white text-slate-900">
      <style>{`
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-fade-up { animation: fadeUp 0.7s ease-out both; }
        .delay-100 { animation-delay: 100ms; }
        .delay-200 { animation-delay: 200ms; }
        .delay-300 { animation-delay: 300ms; }
        @media (prefers-reduced-motion: reduce) {
          .animate-fade-up { animation: none; }
        }
      `}</style>

      {/* ── Hero ───────────────────────────────────────────── */}
      <section className="relative min-h-[600px] h-[88vh] max-h-[900px] flex flex-col overflow-hidden bg-[#0f1225]">
        <Image
          src={src(hero.image)}
          alt=""
          fill
          priority
          sizes="100vw"
          className="object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-black/85 via-black/60 to-black/20" />
        <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-black/60 to-transparent" />

        {/* Navbar */}
        <header className="relative z-10">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 h-20 flex items-center justify-between">
            <Link href="/" className="flex items-center gap-2.5">
              <Image src="/kuunyi-logo.jpeg" alt="KuuNyi" width={32} height={32} className="rounded-lg" />
              <span className="text-lg font-bold text-white tracking-tight">KuuNyi</span>
            </Link>
            <nav className="flex items-center gap-1 sm:gap-2">
              <Link
                href="/login"
                className="text-sm font-medium text-white/90 hover:text-white px-3 sm:px-4 py-2 rounded-xl hover:bg-white/10 transition-colors"
              >
                {hero.signIn}
              </Link>
              <Link
                href="/register"
                className="text-sm font-semibold text-slate-900 bg-white hover:bg-slate-100 px-4 sm:px-5 py-2 rounded-xl transition-colors"
              >
                {hero.getStarted}
              </Link>
            </nav>
          </div>
        </header>

        {/* Copy */}
        <div className="relative z-10 flex-1 flex items-center">
          <div className="max-w-6xl w-full mx-auto px-4 sm:px-6 pb-10">
            <div className="max-w-2xl">
              <p className="animate-fade-up text-xs sm:text-sm font-semibold uppercase tracking-[0.2em] text-[#c4b5fd]">
                {hero.eyebrow}
              </p>
              <h1 className="animate-fade-up delay-100 mt-4 text-5xl sm:text-7xl font-extrabold text-white tracking-tight leading-[1.02]">
                {hero.headline.en}
              </h1>
              <p className="animate-fade-up delay-100 mt-5 font-myanmar text-lg sm:text-xl text-white/90 leading-relaxed">
                {hero.headline.mm}
              </p>
              <p className="animate-fade-up delay-200 mt-4 text-base sm:text-lg text-white/85 max-w-xl leading-relaxed">
                {hero.subtext}
              </p>
              <div className="animate-fade-up delay-300 mt-8 flex flex-col sm:flex-row gap-3">
                <Link
                  href="/register"
                  className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl bg-[#6d28d9] hover:bg-[#5b21b6] text-white font-semibold text-sm transition-colors"
                >
                  {hero.primaryCta}
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                  </svg>
                </Link>
                {showHow && (
                  <Link
                    href="#how"
                    className="inline-flex items-center justify-center px-7 py-3.5 rounded-xl bg-white/10 hover:bg-white/20 border border-white/30 text-white font-semibold text-sm backdrop-blur-sm transition-colors"
                  >
                    {hero.secondaryCta}
                  </Link>
                )}
              </div>
              <p className="animate-fade-up delay-300 mt-6 text-sm text-white/80">
                {hero.trust.en}
                <span className="block font-myanmar text-xs mt-1">
                  {hero.trust.mm}
                </span>
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Trusted by ─────────────────────────────────────── */}
      {showOrganizers && (
        <section className="py-16 sm:py-20">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <div className="text-center max-w-2xl mx-auto">
              <h2 className="text-xl sm:text-2xl font-extrabold uppercase tracking-[0.08em]">
                {organizers.heading.en}
              </h2>
              <p className="font-myanmar text-slate-500 text-sm sm:text-base mt-2">
                {organizers.heading.mm}
              </p>
              <p className="mt-3 text-slate-600">
                {organizers.intro}
              </p>
            </div>
            <ul className="mt-10 max-w-5xl mx-auto grid grid-cols-3 sm:grid-cols-6 gap-4 sm:gap-5">
              {visibleOrganizers.map((org) => (
                <li key={org.id} className="flex flex-col items-center text-center">
                  <div className="relative w-full aspect-square rounded-2xl overflow-hidden border border-slate-200 bg-white shadow-sm">
                    <Image
                      src={src(org.image)}
                      alt={org.name}
                      width={org.image.width}
                      height={org.image.height}
                      sizes="(min-width: 640px) 160px, 30vw"
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <span className="mt-2.5 text-xs sm:text-sm font-semibold text-slate-700 leading-tight">{org.name}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* ── Payments strip ─────────────────────────────────── */}
      {showPayments && (
        <section className="border-y border-slate-100 bg-slate-50/60">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10 sm:py-12">
            <p className="text-center text-xs sm:text-sm font-bold uppercase tracking-[0.18em] text-slate-900">
              {payments.heading.en}
            </p>
            <p className="text-center font-myanmar text-sm text-slate-500 mt-1">{payments.heading.mm}</p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-x-10 gap-y-6 sm:gap-x-14">
              {visiblePayments.flatMap((p) =>
                p.images.map((image, i) => (
                  <Image
                    key={`${p.id}-${i}`}
                    src={src(image)}
                    alt={i === 0 ? p.name : ""}
                    width={image.width}
                    height={image.height}
                    className="h-9 sm:h-10 w-auto object-contain"
                  />
                )),
              )}
            </div>
          </div>
        </section>
      )}

      {/* ── Solutions ──────────────────────────────────────── */}
      {(showCards || sections.pos) && (
        <section className="py-20 sm:py-28">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            {showCards && (
              <>
                <div className="max-w-2xl">
                  <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#6d28d9]">{solutions.eyebrow}</p>
                  <h2 className="mt-3 text-3xl sm:text-4xl font-extrabold tracking-tight">
                    {solutions.heading.en}
                  </h2>
                  <p className="font-myanmar text-slate-500 text-base mt-2">{solutions.heading.mm}</p>
                  <p className="mt-4 text-slate-600 leading-relaxed">
                    {solutions.intro}
                  </p>
                </div>
      
                <div className="mt-12 grid gap-6 sm:grid-cols-2">
                  {visibleSolutions.map((s) => (
                    <article
                      key={s.id}
                      className="group rounded-3xl overflow-hidden bg-white border border-slate-200 hover:shadow-[0_16px_40px_-12px_rgba(15,18,37,0.18)] transition-shadow"
                    >
                      <div className="relative aspect-[16/9] overflow-hidden bg-[#1e1b4b]">
                        {s.image ? (
                          <Image
                            src={src(s.image)}
                            alt=""
                            fill
                            sizes="(min-width: 640px) 50vw, 100vw"
                            className="object-cover group-hover:scale-[1.03] transition-transform duration-500"
                          />
                        ) : (
                          <div className="absolute inset-0 bg-gradient-to-br from-[#6d28d9] via-[#4c1d95] to-[#1e1b4b] flex items-center justify-center p-6">
                            <div className="grid grid-cols-2 gap-3 w-full max-w-xs">
                              {visiblePayments.slice(0, 4).map((p) => (
                                <div key={p.id} className="h-16 rounded-xl bg-white flex items-center justify-center gap-2 p-3">
                                  {p.images.map((image, i) => (
                                    <Image
                                      key={i}
                                      src={src(image)}
                                      alt=""
                                      width={image.width}
                                      height={image.height}
                                      className="max-h-full w-auto object-contain"
                                    />
                                  ))}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                      <div className="p-6 sm:p-8">
                        <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#6d28d9]">{s.label}</p>
                        <h3 className="mt-2 text-xl sm:text-2xl font-bold tracking-tight">{s.title.en}</h3>
                        <p className="font-myanmar text-sm text-slate-500 mt-1">{s.title.mm}</p>
                        <p className="mt-3 text-slate-600 leading-relaxed">{s.description}</p>
                      </div>
                    </article>
                  ))}
                </div>
              </>
            )}
  
            {/* Event Payment System — a separate KuuNyi product, in use since 2017. */}
            {sections.pos && (
              <article className="mt-6 grid md:grid-cols-2 rounded-3xl overflow-hidden bg-[#0f1225] text-white">
                <div className="relative aspect-[16/10] md:aspect-auto md:min-h-[360px]">
                  <Image
                    src={src(pos.image)}
                    alt=""
                    fill
                    sizes="(min-width: 768px) 50vw, 100vw"
                    className="object-cover"
                  />
                </div>
                <div className="p-6 sm:p-10 flex flex-col justify-center">
                  <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#c4b5fd]">{pos.eyebrow}</p>
                  <h3 className="mt-2 text-2xl sm:text-3xl font-bold tracking-tight">{pos.title.en}</h3>
                  <p className="font-myanmar text-sm text-slate-300 mt-1">{pos.title.mm}</p>
                  <p className="mt-4 text-slate-300 leading-relaxed">
                    {pos.description}
                  </p>
                  <ul className="mt-5 space-y-2 text-sm text-slate-300">
                    {pos.bullets.map((item) => (
                      <li key={item} className="flex gap-2.5">
                        <svg className="w-5 h-5 shrink-0 text-[#a78bfa]" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                        </svg>
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              </article>
            )}
          </div>
        </section>
      )}

      {/* ── How it works ───────────────────────────────────── */}
      {showHow && (
        <section id="how" className="relative py-20 sm:py-28 overflow-hidden scroll-mt-4 bg-[#0f1225]">
          <Image src={src(howItWorks.image)} alt="" fill sizes="100vw" className="object-cover" />
          <div className="absolute inset-0 bg-[#0f1225]/80" />
  
          <div className="relative max-w-6xl mx-auto px-4 sm:px-6">
            <div className="text-center">
              <h2 className="text-3xl sm:text-5xl font-extrabold text-white tracking-tight">{howItWorks.heading.en}</h2>
              <p className="font-myanmar text-[#c4b5fd] text-base sm:text-lg mt-2">{howItWorks.heading.mm}</p>
              <p className="text-white/80 mt-4 max-w-lg mx-auto">
                {howItWorks.intro}
              </p>
            </div>
  
            <ol className="mt-14 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
              {visibleSteps.map((s, i) => (
                <li key={s.id} className="text-center">
                  <span className="block text-5xl sm:text-6xl font-extrabold text-white">{String(i + 1).padStart(2, "0")}</span>
                  <span className="mt-3 block text-base font-semibold text-white">{s.title.en}</span>
                  <span className="mt-1 block font-myanmar text-sm text-white/75">{s.title.mm}</span>
                </li>
              ))}
            </ol>
          </div>
        </section>
      )}

      {/* ── Industries ─────────────────────────────────────── */}
      {showIndustries && (
        <section className="py-20 sm:py-28 bg-slate-50">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <div className="text-center max-w-2xl mx-auto">
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight">
                {industries.heading.en}
              </h2>
              <p className="font-myanmar text-slate-500 text-base mt-2">{industries.heading.mm}</p>
              <p className="mt-4 text-slate-600 leading-relaxed">
                {industries.intro}
              </p>
            </div>
  
            <div className="mt-12 grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-5">
              {visibleIndustries.map((ind) => (
                <div key={ind.id} className="group relative aspect-square sm:aspect-[4/3] rounded-2xl sm:rounded-3xl overflow-hidden bg-slate-800">
                  <Image
                    src={src(ind.image)}
                    alt=""
                    fill
                    sizes="(min-width: 1024px) 33vw, 50vw"
                    className="object-cover group-hover:scale-[1.04] transition-transform duration-500"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-transparent" />
                  <div className="absolute inset-x-0 bottom-0 p-4 sm:p-6">
                    <p className="text-base sm:text-xl font-bold text-white">{ind.name.en}</p>
                    <p className="font-myanmar text-xs sm:text-sm text-white/85 mt-0.5">{ind.name.mm}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── CTA ────────────────────────────────────────────── */}
      {sections.cta && (
        <section className="py-20 sm:py-24">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <div className="relative rounded-3xl overflow-hidden bg-[#0f1225] px-6 py-16 sm:px-14 sm:py-24 text-center">
              <Image src={src(cta.image)} alt="" fill sizes="(min-width: 1152px) 1152px, 100vw" className="object-cover" />
              <div className="absolute inset-0 bg-gradient-to-t from-[#1e1b4b]/95 via-[#1e1b4b]/75 to-[#1e1b4b]/55" />
              <div className="relative">
                <h2 className="text-3xl sm:text-5xl font-extrabold text-white tracking-tight">
                  {cta.heading.en}
                </h2>
                <p className="font-myanmar text-white/85 text-base sm:text-lg mt-3">
                  {cta.heading.mm}
                </p>
                <p className="text-white/80 mt-4 max-w-md mx-auto">
                  {cta.intro}
                </p>
                <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
                  <Link
                    href="/register"
                    className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl bg-white text-slate-900 hover:bg-slate-100 font-semibold text-sm transition-colors"
                  >
                    {cta.primary}
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                    </svg>
                  </Link>
                  <Link
                    href="/login"
                    className="w-full sm:w-auto inline-flex items-center justify-center px-7 py-3.5 rounded-xl border border-white/40 text-white hover:bg-white/10 font-semibold text-sm transition-colors"
                  >
                    {cta.secondary}
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ── Footer ─────────────────────────────────────────── */}
      <footer className="bg-[#0f1225] text-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-14 grid gap-10 sm:grid-cols-[1.5fr_1fr_1fr_1fr]">
          <div>
            <div className="flex items-center gap-2.5">
              <Image src="/kuunyi-logo.jpeg" alt="KuuNyi" width={28} height={28} className="rounded-lg" />
              <span className="text-base font-bold">KuuNyi</span>
            </div>
            <p className="mt-4 text-sm text-slate-300 max-w-xs leading-relaxed">
              {footer.tagline}
            </p>
          </div>
          {showHow && (
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">{footer.productHeading}</p>
              <ul className="mt-4 space-y-2.5 text-sm text-slate-300">
                <li><Link href="#how" className="hover:text-white">{footer.howItWorksLink}</Link></li>
              </ul>
            </div>
          )}
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">{footer.organisersHeading}</p>
            <ul className="mt-4 space-y-2.5 text-sm text-slate-300">
              <li><Link href="/register" className="hover:text-white">{footer.getStartedLink}</Link></li>
              <li><Link href="/login" className="hover:text-white">{footer.signInLink}</Link></li>
            </ul>
          </div>
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">{footer.legalHeading}</p>
            <ul className="mt-4 space-y-2.5 text-sm text-slate-300">
              <li><Link href="/privacy" className="hover:text-white">{footer.privacyLink}</Link></li>
            </ul>
          </div>
        </div>
        <div className="border-t border-white/10">
          <p className="max-w-6xl mx-auto px-4 sm:px-6 py-6 text-xs text-slate-400">
            &copy; {new Date().getFullYear()} {footer.copyright}
          </p>
        </div>
      </footer>
    </div>
  );
}
