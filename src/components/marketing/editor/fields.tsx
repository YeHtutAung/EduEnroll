"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import { marketingImageSrc, type ImageRef } from "@/lib/marketing/content";

export const inputClass =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6d28d9]/40";
export const buttonClass =
  "rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40";

export function TextInput({
  label, value, onChange, multiline, myanmar,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  myanmar?: boolean;
}) {
  const cls = `${inputClass} ${myanmar ? "font-myanmar" : ""}`;
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-500">{label}</span>
      {multiline ? (
        <textarea className={cls} rows={3} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className={cls} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}

export function Thumb({ image, alt }: { image: ImageRef; alt: string }) {
  return (
    <Image
      src={marketingImageSrc(image)}
      alt={alt}
      width={image.width}
      height={image.height}
      unoptimized
      className="h-16 w-24 rounded-lg border border-gray-200 bg-white object-contain"
    />
  );
}

export async function uploadMarketingImage(file: File): Promise<ImageRef> {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch("/api/superadmin/marketing/upload", { method: "POST", body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Upload failed.");
  return data.image;
}

/** A button that uploads one image and hands back its reference. */
export function UploadButton({ label, onUploaded }: { label: string; onUploaded: (image: ImageRef) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      onUploaded(await uploadMarketingImage(file));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => onFile(e.target.files?.[0])}
      />
      <button type="button" className={buttonClass} disabled={busy} onClick={() => input.current?.click()}>
        {busy ? "Uploading…" : label}
      </button>
      {error && <span role="alert" className="text-xs text-red-600">{error}</span>}
    </span>
  );
}

export function RowActions({
  index, count, hidden, onMove, onToggleHidden, onRemove,
}: {
  index: number;
  count: number;
  hidden: boolean;
  onMove: (delta: -1 | 1) => void;
  onToggleHidden: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <button type="button" className={buttonClass} disabled={index === 0} onClick={() => onMove(-1)} aria-label="Move up">↑</button>
      <button type="button" className={buttonClass} disabled={index === count - 1} onClick={() => onMove(1)} aria-label="Move down">↓</button>
      <button type="button" className={buttonClass} onClick={onToggleHidden}>{hidden ? "Show" : "Hide"}</button>
      <button type="button" className={buttonClass} onClick={onRemove}>Remove</button>
    </div>
  );
}
