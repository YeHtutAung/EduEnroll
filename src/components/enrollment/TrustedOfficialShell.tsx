// src/components/enrollment/TrustedOfficialShell.tsx
// Shared shell for Screens 2–4 of the Trusted Official checkout flow.
// Renders brand row + step progress bar + cream background.

interface TrustedOfficialShellProps {
  logoUrl?: string | null;
  orgName: string;
  brandColor?: string | null;
  step?: 1 | 2 | "complete";
  children: React.ReactNode;
}

export default function TrustedOfficialShell({
  logoUrl,
  orgName,
  brandColor,
  step,
  children,
}: TrustedOfficialShellProps) {
  const brand = brandColor || "#0f1f42";
  const seg1Gold = step === 1 || step === 2 || step === "complete";
  const seg2Gold = step === 2 || step === "complete";

  return (
    <div
      className="min-h-screen"
      style={{ background: "#f7f5ef", fontFamily: "var(--font-inter), sans-serif" }}
    >
      {/* Brand row */}
      <div className="px-5 pt-5 pb-3 flex items-center gap-2.5">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt="" className="w-[30px] h-[30px] rounded-[6px] object-cover" />
        ) : (
          <div
            className="w-[30px] h-[30px] rounded-[6px] flex items-center justify-center text-[11px] font-black"
            style={{ background: brand, color: "#d4af5a" }}
          >
            {orgName.charAt(0)}
          </div>
        )}
        <span className="text-[12.5px] font-semibold" style={{ color: brand }}>
          {orgName}
        </span>
      </div>

      {/* Step label + progress bar */}
      {step !== "complete" && (
        <div className="px-5 mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <span
              className="text-[10px] font-bold uppercase tracking-[1.5px]"
              style={{ color: brand }}
            >
              Step {step} of 2
            </span>
            <span className="text-[10px]" style={{ color: "#8b8f9a" }}>
              {step === 1 ? "Attendee details" : "Payment"}
            </span>
          </div>
          <div className="flex gap-[5px]">
            <div
              className="h-[4px] flex-1 rounded-[2px]"
              style={{ background: seg1Gold ? "#b7912b" : "#e9e6dc" }}
            />
            <div
              className="h-[4px] flex-1 rounded-[2px]"
              style={{ background: seg2Gold ? "#b7912b" : "#e9e6dc" }}
            />
          </div>
        </div>
      )}

      {/* Screen content */}
      <div className="px-5 pb-10">{children}</div>
    </div>
  );
}
