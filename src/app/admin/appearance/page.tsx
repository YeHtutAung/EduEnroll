"use client";

import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import type { AdminTheme, TemplateId } from "@/types/database";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AppearanceConfig {
  admin_theme: AdminTheme;
  template_id: TemplateId;
  primary_color: string;
  tagline: string;
  cta_button_text: string;
  logo_url: string;
  hero_url: string;
}

const DEFAULTS: AppearanceConfig = {
  admin_theme: "professional",
  template_id: "ls-classic",
  primary_color: "#2563eb",
  tagline: "",
  cta_button_text: "Enroll Now",
  logo_url: "",
  hero_url: "",
};

// ─── Admin theme options ──────────────────────────────────────────────────────

const ADMIN_THEMES: { id: AdminTheme; name: string; description: string; sidebarBg: string; textColor: string; accentBg: string }[] = [
  { id: "professional", name: "Professional", description: "Dark navy sidebar, blue active state.", sidebarBg: "#0f1225", textColor: "#ffffff", accentBg: "#1a3f8a" },
  { id: "minimal",      name: "Minimal",      description: "Light gray sidebar, clean and airy.", sidebarBg: "#f8fafc", textColor: "#1e293b", accentBg: "#dbeafe" },
  { id: "bold",         name: "Bold",         description: "Near-black sidebar, amber highlight.",  sidebarBg: "#09090b", textColor: "#fafafa", accentBg: "#fbbf24" },
  { id: "warm",         name: "Warm",         description: "Deep brown/red sidebar, warm feel.",   sidebarBg: "#7c2d12", textColor: "#fff7ed", accentBg: "#ea580c" },
];

function AdminThemeThumbnail({ theme }: { theme: typeof ADMIN_THEMES[number] }) {
  return (
    <div className="h-24 w-full rounded-lg overflow-hidden border border-gray-200 flex">
      {/* Sidebar mock */}
      <div className="w-10 shrink-0 flex flex-col gap-1 p-1.5" style={{ backgroundColor: theme.sidebarBg }}>
        <div className="h-1.5 w-full rounded-full opacity-60" style={{ backgroundColor: theme.textColor }} />
        <div className="h-1.5 w-full rounded" style={{ backgroundColor: theme.accentBg }} />
        <div className="h-1.5 w-3/4 rounded-full opacity-30" style={{ backgroundColor: theme.textColor }} />
        <div className="h-1.5 w-3/4 rounded-full opacity-30" style={{ backgroundColor: theme.textColor }} />
      </div>
      {/* Content mock */}
      <div className="flex-1 bg-gray-50 p-1.5">
        <div className="mb-1 h-1.5 w-16 rounded bg-gray-300" />
        <div className="grid grid-cols-2 gap-1">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-3 rounded bg-gray-200" />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Public enrollment template options ──────────────────────────────────────

const LS_TEMPLATES: { id: TemplateId; name: string; description: string }[] = [
  { id: "ls-classic", name: "Classic",  description: "Dark navy & gold, elegant luxury feel." },
  { id: "ls-modern",  name: "Modern",   description: "White & bold, high contrast with progress bar." },
  { id: "ls-warm",    name: "Warm",     description: "Cream background, warm serif typography." },
];

const EV_TEMPLATES: { id: TemplateId; name: string; description: string }[] = [
  { id: "ev-luxury",    name: "Luxury",    description: "Dark theatrical, large typography & gold accents." },
  { id: "ev-festival",  name: "Festival",  description: "Dark glass, vibrant gradient orbs, energetic." },
  { id: "ev-corporate", name: "Corporate", description: "Clean white cards, structured & professional." },
];

function PublicTemplateThumbnail({ id, primaryColor }: { id: TemplateId; primaryColor: string }) {
  if (id === "ls-classic") {
    return (
      <div className="h-24 w-full rounded-lg overflow-hidden border border-gray-800 bg-[#0a0e1a]">
        <div className="flex items-center justify-center h-8 border-b border-white/10">
          <div className="h-0.5 w-6 rounded-full" style={{ backgroundColor: primaryColor }} />
        </div>
        <div className="grid grid-cols-3 gap-px p-1.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded bg-white/5 p-1 border border-white/10">
              <div className="h-1 w-4 rounded-full mb-0.5" style={{ backgroundColor: primaryColor + "80" }} />
              <div className="h-2 w-full rounded bg-white/20" />
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (id === "ls-modern") {
    return (
      <div className="h-24 w-full rounded-lg overflow-hidden border border-gray-200">
        <div className="h-6 px-2 flex items-center" style={{ backgroundColor: primaryColor }}>
          <div className="h-1 w-10 rounded-full bg-white/60" />
        </div>
        <div className="grid grid-cols-3 gap-1 bg-gray-50 p-1.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded bg-white border border-gray-100 p-1">
              <div className="h-0.5 w-full mb-1 rounded-full" style={{ backgroundColor: primaryColor }} />
              <div className="h-2 w-full rounded bg-gray-200" />
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (id === "ls-warm") {
    return (
      <div className="h-24 w-full rounded-lg overflow-hidden border border-amber-100" style={{ backgroundColor: "#fdf8f2" }}>
        <div className="h-8 flex items-center justify-center border-b border-amber-100">
          <div className="h-1 w-12 rounded-full" style={{ backgroundColor: primaryColor }} />
        </div>
        <div className="grid grid-cols-2 gap-1 p-1.5">
          {[0, 1].map((i) => (
            <div key={i} className="rounded-xl bg-white p-1 border border-amber-100">
              <div className="h-2 w-full rounded bg-gray-200 mb-1" />
              <div className="h-2 w-full rounded" style={{ backgroundColor: primaryColor + "90" }} />
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (id === "ev-luxury") {
    return (
      <div className="h-24 w-full rounded-lg overflow-hidden border border-gray-700 bg-[#080808]">
        <div className="flex items-center justify-center h-10 border-b border-white/5">
          <div className="h-4 w-20 rounded" style={{ background: `linear-gradient(135deg, ${primaryColor}, ${primaryColor}99)`, opacity: 0.8 }} />
        </div>
        <div className="flex gap-px p-1.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex-1 bg-[#111] p-1 rounded-sm border border-white/10">
              <div className="h-0.5 w-full mb-1" style={{ backgroundColor: primaryColor + "40" }} />
              <div className="h-2 w-full bg-white/10 rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (id === "ev-festival") {
    return (
      <div className="h-24 w-full rounded-lg overflow-hidden border border-purple-900" style={{ background: "linear-gradient(160deg, #0d0d14, #1a0a2e)" }}>
        <div className="flex items-center justify-center h-10">
          <div className="h-3 w-16 rounded font-black text-white text-[8px] flex items-center justify-center" style={{ backgroundColor: primaryColor + "cc" }}>EVENT</div>
        </div>
        <div className="grid grid-cols-3 gap-px p-1.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-lg p-1" style={{ background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.1)" }}>
              <div className="h-2 w-full rounded" style={{ backgroundColor: primaryColor + "80" }} />
            </div>
          ))}
        </div>
      </div>
    );
  }
  // ev-corporate
  return (
    <div className="h-24 w-full rounded-lg overflow-hidden border border-gray-200 bg-gray-50">
      <div className="h-6 bg-white border-b border-gray-200 px-1.5 flex items-center gap-1.5">
        <div className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: primaryColor }} />
        <div className="h-1 w-10 rounded-full bg-gray-300" />
      </div>
      <div className="grid grid-cols-3 gap-1 p-1.5">
        {[0, 1, 2].map((i) => (
          <div key={i} className="bg-white rounded border border-gray-200 p-1">
            <div className="h-0.5 w-full mb-1" style={{ backgroundColor: primaryColor }} />
            <div className="h-2 w-full rounded bg-gray-200" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Image uploader ───────────────────────────────────────────────────────────

function ImageUploader({
  label, type, currentUrl, onUploaded, onRemove,
}: {
  label: string; type: "logo" | "hero"; currentUrl: string;
  onUploaded: (url: string) => void; onRemove: () => void;
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
    if (!res.ok) setError(data.error ?? "Upload failed.");
    else onUploaded(data.url);
  }

  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-gray-700">{label}</label>
      {currentUrl ? (
        <div className="relative inline-block">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={currentUrl} alt={label}
            className={`rounded-lg object-cover border border-gray-200 ${type === "logo" ? "h-16 w-16" : "h-24 w-full max-w-xs"}`} />
          <button type="button" onClick={onRemove}
            className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white text-xs shadow hover:bg-red-600">
            ×
          </button>
        </div>
      ) : (
        <div className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-300 bg-gray-50 py-6 px-4 transition-colors hover:border-gray-400"
          onClick={() => inputRef.current?.click()}>
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
      <input ref={inputRef} type="file" accept="image/jpeg,image/jpg,image/png,image/webp,image/gif" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
    </div>
  );
}

// ─── Section header ───────────────────────────────────────────────────────────

function SectionHeader({ number, title, subtitle }: { number: number; title: string; subtitle: string }) {
  return (
    <div className="flex items-start gap-4 mb-5">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-900 text-sm font-bold text-white mt-0.5">
        {number}
      </div>
      <div>
        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
        <p className="text-sm text-gray-500">{subtitle}</p>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function AppearancePage() {
  const toast = useToast();
  const [config, setConfig] = useState<AppearanceConfig>(DEFAULTS);
  const [orgType, setOrgType] = useState<string>("language_school");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch("/api/admin/appearance").then((r) => r.json()),
      fetch("/api/admin/org").then((r) => r.json()).catch(() => ({})),
    ]).then(([appr, org]) => {
      setConfig({
        admin_theme: appr.admin_theme ?? "professional",
        template_id: appr.template_id ?? "ls-classic",
        primary_color: appr.primary_color ?? "#2563eb",
        tagline: appr.tagline ?? "",
        cta_button_text: appr.cta_button_text ?? "Enroll Now",
        logo_url: appr.logo_url ?? "",
        hero_url: appr.hero_url ?? "",
      });
      if (org.org_type) setOrgType(org.org_type);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setSaving(true);
    const res = await fetch("/api/admin/appearance", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        admin_theme: config.admin_theme,
        template_id: config.template_id,
        primary_color: config.primary_color,
        tagline: config.tagline || null,
        cta_button_text: config.cta_button_text,
        logo_url: config.logo_url || null,
        hero_url: config.hero_url || null,
      }),
    });
    setSaving(false);
    if (res.ok) toast.success("Appearance saved!");
    else {
      const data = await res.json().catch(() => ({}));
      toast.error(data.error ?? "Failed to save.");
    }
  }

  if (loading) {
    return (
      <div className="p-8 animate-pulse">
        <div className="mb-6 h-8 w-48 rounded bg-gray-200" />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (<div key={i} className="h-36 rounded-xl bg-gray-100" />))}
        </div>
      </div>
    );
  }

  const publicTemplates = orgType === "event" ? EV_TEMPLATES : LS_TEMPLATES;

  return (
    <div className="mx-auto max-w-3xl p-6 sm:p-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Appearance</h1>
        <p className="mt-1 text-sm text-gray-500">
          Customize your admin portal theme and public enrollment page template.
        </p>
      </div>

      <div className="space-y-10">

        {/* ── Section 1: Admin Portal Theme ── */}
        <section className="rounded-xl border border-gray-200 bg-white p-6">
          <SectionHeader
            number={1}
            title="Admin Portal Theme"
            subtitle="Controls the sidebar and layout colors across all admin pages."
          />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {ADMIN_THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setConfig((c) => ({ ...c, admin_theme: t.id }))}
                className={`rounded-xl border-2 p-3 text-left transition-all ${
                  config.admin_theme === t.id ? "shadow-md" : "border-gray-200 hover:border-gray-300"
                }`}
                style={config.admin_theme === t.id ? { borderColor: config.primary_color } : undefined}
              >
                <AdminThemeThumbnail theme={t} />
                <p className="mt-2 text-sm font-semibold text-gray-800">{t.name}</p>
                <p className="text-xs text-gray-400 leading-snug">{t.description}</p>
              </button>
            ))}
          </div>
          <p className="mt-4 text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2">
            ⚡ Theme changes apply after the next page load.
          </p>
        </section>

        {/* ── Section 2: Public Enrollment Template ── */}
        <section className="rounded-xl border border-gray-200 bg-white p-6">
          <SectionHeader
            number={2}
            title="Public Enrollment Page"
            subtitle="Choose the template and style for your public-facing enrollment page."
          />

          {/* Template picker */}
          <div className="mb-6">
            <p className="text-sm font-medium text-gray-700 mb-3">Template</p>
            <div className={`grid gap-3 ${publicTemplates.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}>
              {publicTemplates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setConfig((c) => ({ ...c, template_id: t.id }))}
                  className={`rounded-xl border-2 p-3 text-left transition-all ${
                    config.template_id === t.id ? "shadow-md" : "border-gray-200 hover:border-gray-300"
                  }`}
                  style={config.template_id === t.id ? { borderColor: config.primary_color } : undefined}
                >
                  <PublicTemplateThumbnail id={t.id} primaryColor={config.primary_color} />
                  <p className="mt-2 text-sm font-semibold text-gray-800">{t.name}</p>
                  <p className="text-xs text-gray-400 leading-snug">{t.description}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Colors & Text */}
          <div className="border-t border-gray-100 pt-5 mb-5">
            <p className="text-sm font-medium text-gray-700 mb-4">Colors & Text</p>
            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">Primary Color</label>
                <div className="flex items-center gap-3">
                  <input type="color" value={config.primary_color}
                    onChange={(e) => setConfig((c) => ({ ...c, primary_color: e.target.value }))}
                    className="h-10 w-12 cursor-pointer rounded-lg border border-gray-300 p-0.5" />
                  <input type="text" value={config.primary_color}
                    onChange={(e) => { const v = e.target.value; if (/^#[0-9a-fA-F]{0,6}$/.test(v)) setConfig((c) => ({ ...c, primary_color: v })); }}
                    className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono" placeholder="#2563eb" />
                </div>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">Button Text</label>
                <input type="text" value={config.cta_button_text}
                  onChange={(e) => setConfig((c) => ({ ...c, cta_button_text: e.target.value }))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="Enroll Now" maxLength={40} />
              </div>
              <div className="sm:col-span-2">
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  Tagline <span className="font-normal text-gray-400">(optional)</span>
                </label>
                <input type="text" value={config.tagline}
                  onChange={(e) => setConfig((c) => ({ ...c, tagline: e.target.value }))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  placeholder="e.g. Start your Japanese language journey" maxLength={100} />
              </div>
            </div>
          </div>

          {/* Images */}
          <div className="border-t border-gray-100 pt-5">
            <p className="text-sm font-medium text-gray-700 mb-4">Images</p>
            <div className="grid gap-6 sm:grid-cols-2">
              <ImageUploader label="Logo" type="logo" currentUrl={config.logo_url}
                onUploaded={(url) => setConfig((c) => ({ ...c, logo_url: url }))}
                onRemove={() => setConfig((c) => ({ ...c, logo_url: "" }))} />
              <ImageUploader label="Hero / Banner" type="hero" currentUrl={config.hero_url}
                onUploaded={(url) => setConfig((c) => ({ ...c, hero_url: url }))}
                onRemove={() => setConfig((c) => ({ ...c, hero_url: "" }))} />
            </div>
          </div>
        </section>

        {/* ── Save ── */}
        <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-6 py-4">
          <p className="text-sm text-gray-500">Changes apply to all your enrollment pages.</p>
          <button type="button" onClick={handleSave} disabled={saving}
            className="rounded-lg px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
            style={{ background: config.primary_color }}>
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
