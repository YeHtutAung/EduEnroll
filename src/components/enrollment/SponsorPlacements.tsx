import type { Sponsor, SponsorMark } from "@/types/database";

const NAVY = "#0f1f42";
const GOLD = "#d4af5a";

function safeExternalUrl(url?: string | null): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function safeLogoUrl(url?: string | null): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("/")) return url;
  return safeExternalUrl(url);
}

function SponsorLink({
  sponsor,
  className,
  children,
}: {
  sponsor: Sponsor;
  className?: string;
  children: React.ReactNode;
}) {
  const href = safeExternalUrl(sponsor.url);
  if (!href) return <div className={className}>{children}</div>;
  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Visit ${sponsor.name}`}
    >
      {children}
    </a>
  );
}

function PlaceholderMark({ sponsor, size }: { sponsor: Sponsor; size: number }) {
  const shape: SponsorMark = sponsor.mark ?? "square";
  const color = sponsor.mark_color || (shape === "circle" ? GOLD : NAVY);
  const initial = sponsor.name.trim().charAt(0).toUpperCase();
  const style: React.CSSProperties = {
    width: size,
    height: size,
    flex: `0 0 ${size}px`,
    background: shape === "ring" ? "transparent" : color,
    border: shape === "ring" ? `${Math.max(2, Math.round(size / 5))}px solid ${color}` : undefined,
    borderRadius:
      shape === "circle" || shape === "ring" ? "50%" : Math.max(2, Math.round(size / 5)),
    transform: shape === "diamond" ? "rotate(45deg) scale(.76)" : undefined,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: NAVY,
    fontSize: Math.max(7, Math.round(size * 0.55)),
    fontWeight: 800,
    lineHeight: 1,
  };

  return (
    <span aria-hidden="true" style={style}>
      {shape === "circle" && size >= 18 ? initial : ""}
    </span>
  );
}

function SponsorArtwork({
  sponsor,
  markSize,
  maxLogoWidth,
  light = false,
}: {
  sponsor: Sponsor;
  markSize: number;
  maxLogoWidth: number;
  light?: boolean;
}) {
  const logoUrl = safeLogoUrl(sponsor.logo_url);
  if (logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt={sponsor.name}
        style={{
          maxWidth: maxLogoWidth,
          maxHeight: markSize,
          width: "auto",
          height: "auto",
          objectFit: "contain",
        }}
      />
    );
  }

  return (
    <>
      <PlaceholderMark sponsor={sponsor} size={markSize} />
      <span style={{ color: light ? "#ffffff" : NAVY }}>{sponsor.name}</span>
    </>
  );
}

export function PresentingSponsorBanner({ sponsor }: { sponsor: Sponsor | null }) {
  if (!sponsor) return null;
  return (
    <div className="mx-[22px] mb-4 rounded-[10px] bg-[#0f1f42] px-[14px] py-3">
      <p className="mb-1 text-[8px] font-bold tracking-[1.5px] text-[#d4af5a]">PRESENTED BY</p>
      <SponsorLink
        sponsor={sponsor}
        className="inline-flex min-h-5 items-center gap-[7px] no-underline"
      >
        <span className="inline-flex items-center gap-[7px] text-[13px] font-extrabold tracking-[-0.3px]">
          <SponsorArtwork sponsor={sponsor} markSize={20} maxLogoWidth={164} light />
        </span>
      </SponsorLink>
    </div>
  );
}

export function SponsorLogoWall({ sponsors }: { sponsors: Sponsor[] }) {
  if (sponsors.length === 0) return null;
  return (
    <section className="mx-[22px] mt-[22px]" aria-labelledby="sponsor-partners-heading">
      <h2
        id="sponsor-partners-heading"
        className="mb-3 text-center text-[9px] font-bold tracking-[1.8px] text-[#9a9484]"
      >
        OUR PARTNERS
      </h2>
      <div className="grid grid-cols-2 gap-[9px] min-[420px]:grid-cols-4">
        {sponsors.map((sponsor, index) => (
          <SponsorLink
            key={`${sponsor.name}-${index}`}
            sponsor={sponsor}
            className="flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-lg border border-[#e3e0d6] bg-white px-2 no-underline transition-colors hover:border-[#d4af5a] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4af5a]"
          >
            <span className="inline-flex min-w-0 items-center justify-center gap-1.5 overflow-hidden text-[12px] font-extrabold tracking-[-0.3px]">
              <SponsorArtwork sponsor={sponsor} markSize={14} maxLogoWidth={108} />
            </span>
          </SponsorLink>
        ))}
      </div>
    </section>
  );
}

export function TicketPresentingSponsor({ sponsor }: { sponsor: Sponsor | null }) {
  if (!sponsor) return null;
  return (
    <SponsorLink sponsor={sponsor} className="flex min-w-0 flex-col items-end no-underline">
      <span className="mb-[3px] text-[6.5px] font-bold tracking-[1px] text-[#8a90a5]">
        PRESENTED BY
      </span>
      <span className="inline-flex max-w-[128px] items-center justify-end gap-1 overflow-hidden text-[9.5px] font-extrabold tracking-[-0.2px]">
        <SponsorArtwork sponsor={sponsor} markSize={12} maxLogoWidth={94} light />
      </span>
    </SponsorLink>
  );
}

export function SupportedByStrip({
  sponsors,
  className = "",
}: {
  sponsors: Sponsor[];
  className?: string;
}) {
  if (sponsors.length === 0) return null;
  return (
    <section
      className={`rounded-[9px] border border-[#e3e0d6] bg-white px-[13px] py-[11px] ${className}`}
      aria-labelledby="supported-by-heading"
    >
      <h2
        id="supported-by-heading"
        className="mb-2 text-center text-[8px] font-bold tracking-[1.5px] text-[#aca795]"
      >
        SUPPORTED BY
      </h2>
      <div className="flex flex-wrap items-center justify-center gap-x-[10px] gap-y-2">
        {sponsors.map((sponsor, index) => (
          <SponsorLink
            sponsor={sponsor}
            key={`${sponsor.name}-${index}`}
            className="inline-flex items-center gap-1 no-underline"
          >
            <span className="inline-flex items-center gap-1 text-[10px] font-extrabold tracking-[-0.2px]">
              <SponsorArtwork sponsor={sponsor} markSize={11} maxLogoWidth={78} />
            </span>
          </SponsorLink>
        ))}
      </div>
    </section>
  );
}
