"use client";

import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import type { TemplateId } from "@/types/database";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AppearanceConfig {
  template_id: TemplateId;
  primary_color: string;
  tagline: string;
  cta_button_text: string;
  logo_url: string;
  hero_url: string;
}

const DEFAULTS: AppearanceConfig = {
  template_id: "minimal",
  primary_color: "#2563eb",
  tagline: "",
  cta_button_text: "Enroll Now",
  logo_url: "",
  hero_url: "",
};

// ─── Template previews ────────────────────────────────────────────────────────

const TEMPLATES: { id: TemplateId; name: string; description: string }[] = [
  {
    id: "minimal",
    name: "Minimal",
    description: "Clean white layout, centered content, subtle borders.",
  },
  {
    id: "bold",
    name: "Bold",
    description: "Strong color header, large typography, high contrast.",
  },
  {
    id: "warm",
    name: "Warm",
    description: "Soft tinted background, rounded cards, friendly feel.",
  },
  {
    id: "professional",
    name: "Professional",
    description: "Two-column layout with sidebar, structured and clean.",
  },
];

function TemplateThumbnail({ id, primaryColor }: { id: TemplateId; primaryColor: string }) {
  if (id === "minimal") {
    return (
      <div className="h-28 w-full rounded-lg bg-gray-50 p-2 overflow-hidden border border-gray-200">
        <div className="mx-auto mb-1.5 h-1.5 w-12 rounded-full bg-gray-300" />
        <div className="mx-auto mb-2 h-1 w-20 rounded-full bg-gray-200" />
        <div className="grid grid-cols-2 gap-1">
          {[0, 1].map((i) => (
            <div key={i} className="rounded border border-gray-200 bg-white p-1.5">
              <div className="mb-1 h-1 w-6 rounded-full bg-gray-200" />
              <div className="mb-1 h-2 w-10 rounded bg-gray-300" />
              <div className="h-1 w-8 rounded-full" style={{ background: primaryColor + "60" }} />
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (id === "bold") {
    return (
      <div className="h-28 w-full rounded-lg overflow-hidden border border-gray-200">
        <div className="px-3 py-2" style={{ background: primaryColor }}>
          <div className="mb-1 h-1.5 w-16 rounded-full bg-white/60" />
          <div className="h-1 w-10 rounded-full bg-white/40" />
        </div>
        <div className="grid grid-cols-3 gap-1 bg-white p-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded overflow-hidden">
              <div className="h-2" style={{ background: primaryColor + "cc" }} />
              <div className="bg-gray-50 p-1">
                <div className="mb-1 h-2 w-full rounded bg-gray-300" />
                <div className="h-2.5 w-full rounded" style={{ background: primaryColor }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (id === "warm") {
    return (
      <div className="h-28 w-full rounded-lg p-2 overflow-hidden border border-gray-200" style={{ background: primaryColor + "10" }}>
        <div className="mx-auto mb-1.5 h-4 w-4 rounded-full" style={{ background: primaryColor + "40" }} />
        <div className="mx-auto mb-0.5 h-1.5 w-14 rounded-full bg-gray-400" />
        <div className="mx-auto mb-2 h-1 w-20 rounded-full bg-gray-300" />
        <div className="grid grid-cols-2 gap-1">
          {[0, 1].map((i) => (
            <div key={i} className="rounded-xl bg-white p-1.5 shadow-sm" style={{ borderTop: `2px solid ${primaryColor}80` }}>
              <div className="mb-1 h-1 w-5 rounded-full bg-gray-200" />
              <div className="mb-1 h-2 w-8 rounded bg-gray-300" />
              <div className="h-2 w-full rounded-lg" style={{ background: primaryColor + "90" }} />
            </div>
          ))}
        </div>
      </div>
    );
  }
  // professional
  return (
    <div className="h-28 w-full rounded-lg overflow-hidden border border-gray-200 bg-gray-50 p-2">
      <div className="flex items-center gap-1 mb-1.5 border-b border-gray-200 pb-1.5">
        <div className="h-3 w-3 rounded-full" style={{ background: primaryColor + "80" }} />
        <div className="h-1 w-10 rounded-full bg-gray-300" />
      </div>
      <div className="flex gap-1.5">
        <div className="w-10 shrink-0 rounded bg-white border border-gray-200 p-1">
          <div className="mb-1 h-1 w-full rounded-full bg-gray-300" />
          <div className="mb-1 h-1 w-full rounded-full bg-gray-200" />
          <div className="space-y-0.5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-0.5">
                <div className="h-1.5 w-1.5 rounded-full" style={{ background: primaryColor }} />
                <div className="h-0.5 flex-1 rounded-full bg-gray-200" />
              </div>
            ))}
          </div>
        </div>
        <div className="flex-1 rounded bg-white border border-gray-200 p-1">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center justify-between border-b border-gray-100 py-0.5 last:border-0">
              <div className="h-1 w-5 rounded-full bg-gray-200" />
              <div className="h-1 w-8 rounded-full bg-gray-300" />
              <div className="h-2.5 w-7 rounded" style={{ background: primaryColor + "cc" }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Image uploader ───────────────────────────────────────────────────────────

function ImageUploader({
  label,
  type,
  currentUrl,
  onUploaded,
  onRemove,
}: {
  label: string;
  type: "logo" | "hero";
  currentUrl: string;
  onUploaded: (url: string) => void;
  onRemove: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setUploading(true);
    setError(null);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("type", type);
    const res = await fetch("/api/admin/appearance/upload", { method: "POST", body: fd });
    const data = await res.json();
    setUploading(false);
    if (!res.ok) {
      setError(data.error ?? "Upload failed.");
    } else {
      onUploaded(data.url);
    }
  }

  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-gray-700">{label}</label>
      {currentUrl ? (
        <div className="relative inline-block">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={currentUrl}
            alt={label}
            className={`rounded-lg object-cover border border-gray-200 ${type === "logo" ? "h-16 w-16" : "h-24 w-full max-w-xs"}`}
          />
          <button
            type="button"
            onClick={onRemove}
            className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white text-xs shadow hover:bg-red-600"
          >
            ×
          </button>
        </div>
      ) : (
        <div
          className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-300 bg-gray-50 py-6 px-4 transition-colors hover:border-gray-400"
          onClick={() => inputRef.current?.click()}
        >
          {uploading ? (
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
          ) : (
            <>
              <svg className="mb-1 h-6 w-6 text-gray-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
              </svg>
              <span className="text-xs text-gray-500">Click to upload</span>
              <span className="text-xs text-gray-400">JPEG, PNG, WebP · Max 5 MB</span>
            </>
          )}
        </div>
      )}
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/jpg,image/png,image/webp,image/gif"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
      />
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function AppearancePage() {
  const toast = useToast();
  const [config, setConfig] = useState<AppearanceConfig>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/admin/appearance")
      .then((r) => r.json())
      .then((data) => {
        setConfig({
          template_id: data.template_id ?? "minimal",
          primary_color: data.primary_color ?? "#2563eb",
          tagline: data.tagline ?? "",
          cta_button_text: data.cta_button_text ?? "Enroll Now",
          logo_url: data.logo_url ?? "",
          hero_url: data.hero_url ?? "",
        });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setSaving(true);
    const res = await fetch("/api/admin/appearance", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...config,
        tagline: config.tagline || null,
        logo_url: config.logo_url || null,
        hero_url: config.hero_url || null,
      }),
    });
    setSaving(false);
    if (res.ok) {
      toast.success("Appearance saved!");
    } else {
      const data = await res.json().catch(() => ({}));
      toast.error(data.error ?? "Failed to save.");
    }
  }

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse">
          <div className="mb-6 h-8 w-48 rounded bg-gray-200" />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-36 rounded-xl bg-gray-100" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl p-6 sm:p-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Enrollment Page</h1>
        <p className="mt-1 text-sm text-gray-500">
          Customize how your public enrollment page looks. Changes apply immediately after saving.
        </p>
      </div>

      <div className="space-y-8">
        {/* ── Template picker ── */}
        <section>
          <h2 className="mb-4 text-base font-semibold text-gray-800">Choose a Template</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setConfig((c) => ({ ...c, template_id: t.id }))}
                className={`rounded-xl border-2 p-3 text-left transition-all ${
                  config.template_id === t.id
                    ? "shadow-md"
                    : "border-gray-200 hover:border-gray-300"
                }`}
                style={config.template_id === t.id ? { borderColor: config.primary_color } : undefined}
              >
                <TemplateThumbnail id={t.id} primaryColor={config.primary_color} />
                <p className="mt-2 text-sm font-semibold text-gray-800">{t.name}</p>
                <p className="text-xs text-gray-400 leading-snug">{t.description}</p>
              </button>
            ))}
          </div>
        </section>

        {/* ── Colors & Text ── */}
        <section className="rounded-xl border border-gray-200 bg-white p-6">
          <h2 className="mb-5 text-base font-semibold text-gray-800">Colors & Text</h2>
          <div className="grid gap-5 sm:grid-cols-2">
            {/* Primary color */}
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Primary Color</label>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={config.primary_color}
                  onChange={(e) => setConfig((c) => ({ ...c, primary_color: e.target.value }))}
                  className="h-10 w-12 cursor-pointer rounded-lg border border-gray-300 p-0.5"
                />
                <input
                  type="text"
                  value={config.primary_color}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (/^#[0-9a-fA-F]{0,6}$/.test(v)) setConfig((c) => ({ ...c, primary_color: v }));
                  }}
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono"
                  placeholder="#2563eb"
                />
              </div>
            </div>

            {/* CTA button text */}
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Button Text</label>
              <input
                type="text"
                value={config.cta_button_text}
                onChange={(e) => setConfig((c) => ({ ...c, cta_button_text: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                placeholder="Enroll Now"
                maxLength={40}
              />
            </div>

            {/* Tagline */}
            <div className="sm:col-span-2">
              <label className="mb-1.5 block text-sm font-medium text-gray-700">
                Tagline <span className="font-normal text-gray-400">(optional)</span>
              </label>
              <input
                type="text"
                value={config.tagline}
                onChange={(e) => setConfig((c) => ({ ...c, tagline: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                placeholder="e.g. Start your Japanese language journey"
                maxLength={100}
              />
            </div>
          </div>
        </section>

        {/* ── Images ── */}
        <section className="rounded-xl border border-gray-200 bg-white p-6">
          <h2 className="mb-5 text-base font-semibold text-gray-800">Images</h2>
          <div className="grid gap-6 sm:grid-cols-2">
            <ImageUploader
              label="School Logo"
              type="logo"
              currentUrl={config.logo_url}
              onUploaded={(url) => setConfig((c) => ({ ...c, logo_url: url }))}
              onRemove={() => setConfig((c) => ({ ...c, logo_url: "" }))}
            />
            <ImageUploader
              label="Hero / Banner Image"
              type="hero"
              currentUrl={config.hero_url}
              onUploaded={(url) => setConfig((c) => ({ ...c, hero_url: url }))}
              onRemove={() => setConfig((c) => ({ ...c, hero_url: "" }))}
            />
          </div>
        </section>

        {/* ── Save ── */}
        <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-6 py-4">
          <p className="text-sm text-gray-500">Changes apply to all your enrollment pages.</p>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
            style={{ background: config.primary_color }}
          >
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
