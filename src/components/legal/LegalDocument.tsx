// ─── A legal document, English with Myanmar under each part ─────────────────
//
// Renders the intro and sections of a LegalDocumentData. The title and
// subtitle are left to the caller: the full page and the pop-up head them
// differently. No hooks, so it renders on the server for /terms and /privacy
// and inside the client pop-up alike.

import type { Bi, LegalDocumentData, LegalSectionData } from "./content";

export default function LegalDocument({
  doc,
  compact = false,
}: {
  doc: LegalDocumentData;
  /** Tighter type and spacing for the pop-up. */
  compact?: boolean;
}) {
  return (
    <div className={compact ? "text-[13.5px] leading-[1.7]" : "text-[14.5px] leading-[1.8]"}>
      <div
        className={`rounded border border-gray-200 border-l-[3px] border-l-[#6d28d9] bg-white text-gray-500 ${
          compact ? "mb-6 px-4 py-3" : "mb-12 px-6 py-5 text-[15px] leading-[1.7]"
        }`}
      >
        <Pair value={doc.intro} />
      </div>

      <div className={`${compact ? "space-y-6" : "space-y-10"} text-[#3a3a36]`}>
        {doc.sections.map((section) => (
          <Section key={section.title.en} section={section} compact={compact} />
        ))}
      </div>
    </div>
  );
}

function Section({ section, compact }: { section: LegalSectionData; compact: boolean }) {
  return (
    <section>
      <h2 className={`${compact ? "text-base" : "text-xl"} font-semibold tracking-tight text-gray-900`}>
        {section.title.en}
      </h2>
      <p className={`font-myanmar ${compact ? "text-sm" : "text-base"} mb-3 text-gray-600`}>{section.title.mm}</p>

      {section.intro && <Pair value={section.intro} />}

      {section.items && (
        <ul className="my-3 space-y-2">
          {section.items.map((item) => (
            <li key={item.en} className="relative pl-5">
              <span className="absolute left-0 text-xs text-gray-500">&mdash;</span>
              <Pair value={item} />
            </li>
          ))}
        </ul>
      )}

      {section.contact && (
        <div className="mt-4 rounded-md border border-gray-200 bg-white p-5">
          <p className="text-sm font-semibold text-gray-900">KuuNyi</p>
          <p className="mt-2 text-sm">
            Email:{" "}
            <a href="mailto:support@kuunyi.com" className="text-[#6d28d9] hover:underline">
              support@kuunyi.com
            </a>
          </p>
          <p className="text-sm">
            Website:{" "}
            <a
              href="https://www.kuunyi.com"
              className="text-[#6d28d9] hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              www.kuunyi.com
            </a>
          </p>
        </div>
      )}

      {section.outro && (
        <div className="mt-3">
          <Pair value={section.outro} />
        </div>
      )}
    </section>
  );
}

/** English, with its Myanmar translation directly beneath it. */
function Pair({ value }: { value: Bi }) {
  return (
    <>
      <span className="block">{value.en}</span>
      <span className="font-myanmar mt-1 block text-gray-500">{value.mm}</span>
    </>
  );
}
