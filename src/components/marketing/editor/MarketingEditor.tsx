"use client";

import { useCallback, useEffect, useState } from "react";
import LoadingSpinner from "@/components/ui/LoadingSpinner";
import type { MarketingContent } from "@/lib/marketing/content";
import { buttonClass } from "./fields";
import { ImagesTab, LogosTab, PaymentsTab, RestorePanel, SectionsSeoTab, TextsTab } from "./tabs";

const API = "/api/superadmin/marketing";

const TABS = [
  ["texts", "Texts", TextsTab],
  ["logos", "Partner logos", LogosTab],
  ["images", "Images", ImagesTab],
  ["payments", "Accepted payments", PaymentsTab],
  ["sections", "Sections & SEO", SectionsSeoTab],
] as const;

type Loaded = {
  content: MarketingContent;
  revision: number;
  basePublishedId: string | null;
  publishedAt: string | null;
  versions: { id: string; publishedAt: string | null }[];
};
type Notice = { kind: "ok" | "error"; text: string; errors?: string[]; stale?: boolean };

export default function MarketingEditor() {
  const [state, setState] = useState<Loaded | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("texts");

  const load = useCallback(async () => {
    setLoadFailed(false);
    const res = await fetch(API, { cache: "no-store" }).catch(() => null);
    if (res?.status === 503) return setNotConfigured(true);
    if (!res?.ok) return setLoadFailed(true);
    const data = await res.json();
    setState({
      content: data.draft.content,
      revision: data.draft.revision,
      basePublishedId: data.draft.basePublishedId,
      publishedAt: data.published?.publishedAt ?? null,
      versions: data.versions,
    });
    setDirty(false);
    if (data.draft.contentInvalid) {
      setNotice({ kind: "error", text: "The saved content couldn't be read, so this shows the default page. Saving replaces it." });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function send(path: string, method: string, body: unknown): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`${API}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice({ kind: "error", text: data.error ?? "Something went wrong.", errors: data.errors, stale: res.status === 409 });
        return null;
      }
      return data;
    } catch {
      setNotice({ kind: "error", text: "Couldn't reach the server. Nothing was changed." });
      return null;
    } finally {
      setBusy(false);
    }
  }

  const target = () =>
    state!.revision === 0
      ? { expectedRevision: 0, basePublishedId: state!.basePublishedId }
      : { expectedRevision: state!.revision };

  async function save() {
    const data = await send("/draft", "PUT", { content: state!.content, ...target() });
    if (!data) return;
    setState({ ...state!, revision: data.revision as number, basePublishedId: null });
    setDirty(false);
    setNotice({ kind: "ok", text: "Draft saved." });
  }

  async function publish() {
    if (!window.confirm("Publish this draft to the live homepage?")) return;
    const data = await send("/publish", "POST", { expectedRevision: state!.revision });
    if (!data) return;
    await load();
    setNotice({ kind: "ok", text: "Published." });
  }

  async function restore(versionId: string) {
    const data = await send("/restore", "POST", { versionId, ...target() });
    if (!data) return;
    setState({ ...state!, content: data.content as MarketingContent, revision: data.revision as number, basePublishedId: null });
    setDirty(false);
    setNotice({ kind: "ok", text: "Restored to the draft. Preview it, then publish when ready." });
  }

  if (notConfigured) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16 text-center text-sm text-gray-600">
        Marketing isn&apos;t configured yet: the database migration hasn&apos;t been applied in this environment. The public
        page is showing its default content.
      </div>
    );
  }
  if (loadFailed) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16 text-center text-sm text-gray-600">
        <p>Couldn&apos;t load the marketing content.</p>
        <button type="button" className={`${buttonClass} mt-4`} onClick={load}>Try again</button>
      </div>
    );
  }
  if (!state) {
    return (
      <div className="flex h-96 items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  const Active = TABS.find(([key]) => key === tab)![2];
  const saved = state.revision > 0 && !dirty;

  return (
    <div className="mx-auto max-w-7xl space-y-5 px-6 py-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-gray-900">Marketing page</h2>
          <p className="text-sm text-gray-500">
            {dirty ? "Unsaved changes" : state.revision > 0 ? "Draft saved, not published" : "No draft yet"}
            {" · "}
            {state.publishedAt ? `Published ${new Date(state.publishedAt).toLocaleString()}` : "Showing default content"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RestorePanel versions={state.versions} disabled={busy || dirty} onRestore={restore} />
          <button type="button" className={buttonClass} disabled={busy || !dirty} onClick={save}>Save draft</button>
          {saved ? (
            <a href="/superadmin/marketing/preview" target="_blank" rel="noopener" className={buttonClass}>Preview</a>
          ) : (
            <button type="button" className={buttonClass} disabled title="Save the draft first">Preview</button>
          )}
          <button
            type="button"
            className="rounded-lg bg-[#6d28d9] px-4 py-1.5 text-sm font-semibold text-white hover:bg-[#5b21b6] disabled:opacity-40"
            disabled={busy || !saved}
            title={saved ? undefined : "Save the draft first"}
            onClick={publish}
          >
            Publish
          </button>
        </div>
      </header>

      {notice && (
        <div
          role={notice.kind === "error" ? "alert" : "status"}
          className={`rounded-lg px-4 py-3 text-sm ${notice.kind === "error" ? "border border-red-200 bg-red-50 text-red-800" : "border border-green-200 bg-green-50 text-green-800"}`}
        >
          <p>{notice.text}</p>
          {notice.errors && (
            <ul className="mt-2 list-disc pl-5 text-xs">
              {notice.errors.slice(0, 10).map((e) => <li key={e}>{e}</li>)}
            </ul>
          )}
          {notice.stale && (
            <button type="button" className={`${buttonClass} mt-2`} onClick={() => { setNotice(null); load(); }}>
              Reload (discards your unsaved changes)
            </button>
          )}
        </div>
      )}

      <nav role="tablist" className="flex flex-wrap gap-1 border-b border-gray-200">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`rounded-t-lg px-4 py-2 text-sm font-medium ${tab === key ? "border-b-2 border-[#6d28d9] text-[#6d28d9]" : "text-gray-500 hover:text-gray-800"}`}
          >
            {label}
          </button>
        ))}
      </nav>

      <Active
        content={state.content}
        onChange={(content) => {
          setState((s) => (s ? { ...s, content } : s));
          setDirty(true);
        }}
      />
    </div>
  );
}
