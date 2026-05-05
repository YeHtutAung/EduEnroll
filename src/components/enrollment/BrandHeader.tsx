"use client";

interface BrandHeaderProps {
  schoolName: string;
  primaryColor: string;
  logoUrl?: string | null;
}

export default function BrandHeader({ schoolName, primaryColor, logoUrl }: BrandHeaderProps) {
  const initial = schoolName.charAt(0).toUpperCase();

  return (
    <header
      className="sticky top-0 z-40 bg-white shadow-sm"
      style={{ borderBottom: `3px solid ${primaryColor}` }}
    >
      <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3 sm:px-6">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt="" className="h-8 w-8 shrink-0 rounded object-contain" />
        ) : (
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-sm font-bold text-white"
            style={{ backgroundColor: primaryColor }}
          >
            {initial}
          </div>
        )}
        <span className="truncate text-sm font-semibold text-gray-900 sm:text-base">{schoolName}</span>
      </div>
    </header>
  );
}
