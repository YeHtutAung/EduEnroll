"use client";

import { useState } from "react";
import { SECTION_KEYS, type ImageRef, type MarketingContent, type SectionKey } from "@/lib/marketing/content";
import { getAt, moveItem, removeAt, setAt } from "@/lib/marketing/editorOps";
import { imageSlots, textGroups } from "@/lib/marketing/textFields";
import { buttonClass, inputClass, RowActions, TextInput, Thumb, UploadButton } from "./fields";

export type TabProps = { content: MarketingContent; onChange: (next: MarketingContent) => void };

const SECTION_LABELS: Record<SectionKey, string> = {
  organizers: "Trusted by",
  payments: "Accepted payments",
  solutions: "Solutions cards",
  pos: "Cashless bars & food stalls",
  howItWorks: "How it works",
  industries: "Industries",
  cta: "Call to action",
};

const newId = () => crypto.randomUUID();

export function TextsTab({ content, onChange }: TabProps) {
  const text = (path: string) => getAt(content, path) as string;
  const set = (path: string) => (v: string) => onChange(setAt(content, path, v));

  return (
    <div className="space-y-6">
      {textGroups(content).map((group) => (
        <section key={group.title} className="rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="mb-4 text-sm font-bold text-gray-900">{group.title}</h3>
          <div className="space-y-4">
            {group.fields.map((field) => (
              <div key={field.path}>
                {field.localized ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    <TextInput label={`${field.label} (English)`} value={text(`${field.path}.en`)} onChange={set(`${field.path}.en`)} multiline={field.multiline} />
                    <TextInput label={`${field.label} (Myanmar)`} value={text(`${field.path}.mm`)} onChange={set(`${field.path}.mm`)} multiline={field.multiline} myanmar />
                  </div>
                ) : (
                  <TextInput label={field.label} value={text(field.path)} onChange={set(field.path)} multiline={field.multiline} />
                )}
                {field.hiddenPath && (
                  <label className="mt-2 inline-flex items-center gap-2 text-xs text-gray-600">
                    <input
                      type="checkbox"
                      checked={getAt(content, field.hiddenPath) as boolean}
                      onChange={(e) => onChange(setAt(content, field.hiddenPath!, e.target.checked))}
                    />
                    Hide this item
                  </label>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function LogosTab({ content, onChange }: TabProps) {
  const items = content.organizers.items;
  const setItems = (next: typeof items) => onChange(setAt(content, "organizers.items", next));
  const [name, setName] = useState("");

  return (
    <div className="space-y-3">
      {items.map((item, i) => (
        <div key={item.id} className={`flex flex-wrap items-center gap-4 rounded-xl border border-gray-200 bg-white p-4 ${item.hidden ? "opacity-60" : ""}`}>
          <Thumb image={item.image} alt={item.name} />
          <div className="min-w-[200px] flex-1">
            <TextInput label="Name" value={item.name} onChange={(v) => setItems(setAt(items, `${i}.name`, v))} />
          </div>
          <UploadButton label="Replace logo" onUploaded={(image) => setItems(setAt(items, `${i}.image`, image))} />
          <RowActions
            index={i}
            count={items.length}
            hidden={item.hidden}
            onMove={(d) => setItems(moveItem(items, i, d))}
            onToggleHidden={() => setItems(setAt(items, `${i}.hidden`, !item.hidden))}
            onRemove={() => setItems(removeAt(items, i))}
          />
        </div>
      ))}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-dashed border-gray-300 bg-white p-4">
        <div className="min-w-[200px] flex-1">
          <TextInput label="New partner name" value={name} onChange={setName} />
        </div>
        {name.trim() ? (
          <UploadButton
            label="Upload logo and add"
            onUploaded={(image: ImageRef) => {
              setItems([...items, { id: newId(), name: name.trim(), image, hidden: false }]);
              setName("");
            }}
          />
        ) : (
          <button type="button" className={buttonClass} disabled>Upload logo and add</button>
        )}
      </div>
    </div>
  );
}

export function ImagesTab({ content, onChange }: TabProps) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {imageSlots(content).map((slot) => {
        const image = getAt(content, slot.path) as ImageRef | null;
        return (
          <div key={slot.path} className="flex items-center gap-4 rounded-xl border border-gray-200 bg-white p-4">
            {image ? (
              <Thumb image={image} alt={slot.label} />
            ) : (
              <span className="flex h-16 w-24 items-center justify-center rounded-lg bg-gray-100 p-1 text-center text-xs text-gray-500">
                Payment logos
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="mb-2 truncate text-sm font-medium text-gray-800">{slot.label}</p>
              <div className="flex flex-wrap gap-2">
                <UploadButton label="Replace" onUploaded={(next) => onChange(setAt(content, slot.path, next))} />
                {slot.canClear && image && (
                  <button type="button" className={buttonClass} onClick={() => onChange(setAt(content, slot.path, null))}>
                    Use payment logos
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function PaymentsTab({ content, onChange }: TabProps) {
  const items = content.payments.items;
  const setItems = (next: typeof items) => onChange(setAt(content, "payments.items", next));
  const [name, setName] = useState("");

  return (
    <div className="space-y-3">
      {items.some((p) => p.hidden) && (
        <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Hiding a payment doesn&apos;t change the wording. Check the Texts tab for lines that still mention it, such as
          the step &quot;Pays with KBZPay, MMQR or card&quot;.
        </p>
      )}
      {items.map((item, i) => (
        <div key={item.id} className={`rounded-xl border border-gray-200 bg-white p-4 ${item.hidden ? "opacity-60" : ""}`}>
          <div className="flex flex-wrap items-end gap-4">
            <div className="min-w-[200px] flex-1">
              <TextInput label="Name" value={item.name} onChange={(v) => setItems(setAt(items, `${i}.name`, v))} />
            </div>
            <RowActions
              index={i}
              count={items.length}
              hidden={item.hidden}
              onMove={(d) => setItems(moveItem(items, i, d))}
              onToggleHidden={() => setItems(setAt(items, `${i}.hidden`, !item.hidden))}
              onRemove={() => setItems(removeAt(items, i))}
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {item.images.map((image, j) => (
              <span key={`${image.path}-${j}`} className="inline-flex items-center gap-1.5">
                <Thumb image={image} alt={j === 0 ? item.name : ""} />
                <button
                  type="button"
                  className={buttonClass}
                  disabled={item.images.length === 1}
                  onClick={() => setItems(setAt(items, `${i}.images`, removeAt(item.images, j)))}
                  aria-label={`Remove image ${j + 1} of ${item.name}`}
                >
                  ×
                </button>
              </span>
            ))}
            {item.images.length < 4 && (
              <UploadButton label="Add image" onUploaded={(image) => setItems(setAt(items, `${i}.images`, [...item.images, image]))} />
            )}
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-dashed border-gray-300 bg-white p-4">
        <div className="min-w-[200px] flex-1">
          <TextInput label="New payment name" value={name} onChange={setName} />
        </div>
        {name.trim() ? (
          <UploadButton
            label="Upload logo and add"
            onUploaded={(image) => {
              setItems([...items, { id: newId(), name: name.trim(), images: [image], hidden: false }]);
              setName("");
            }}
          />
        ) : (
          <button type="button" className={buttonClass} disabled>Upload logo and add</button>
        )}
      </div>
    </div>
  );
}

export function SectionsSeoTab({ content, onChange }: TabProps) {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h3 className="mb-3 text-sm font-bold text-gray-900">Show on the page</h3>
        <div className="space-y-2">
          {SECTION_KEYS.map((key) => (
            <label key={key} className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={content.sections[key]}
                onChange={(e) => onChange(setAt(content, `sections.${key}`, e.target.checked))}
              />
              {SECTION_LABELS[key]}
            </label>
          ))}
        </div>
        <p className="mt-3 text-xs text-gray-500">The hero and footer always show.</p>
      </section>
      <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-5">
        <h3 className="text-sm font-bold text-gray-900">Search and sharing</h3>
        <TextInput label="Page title" value={content.seo.title} onChange={(v) => onChange(setAt(content, "seo.title", v))} />
        <TextInput label="Description" value={content.seo.description} multiline onChange={(v) => onChange(setAt(content, "seo.description", v))} />
      </section>
    </div>
  );
}

export function RestorePanel({
  versions, disabled, onRestore,
}: {
  versions: { id: string; publishedAt: string | null }[];
  disabled: boolean;
  onRestore: (id: string) => void;
}) {
  const [selected, setSelected] = useState("");
  if (!versions.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select className={`${inputClass} w-auto`} value={selected} onChange={(e) => setSelected(e.target.value)} aria-label="Previous version">
        <option value="">Previous versions…</option>
        {versions.map((v) => (
          <option key={v.id} value={v.id}>
            {v.publishedAt ? new Date(v.publishedAt).toLocaleString() : v.id}
          </option>
        ))}
      </select>
      <button type="button" className={buttonClass} disabled={disabled || !selected} onClick={() => onRestore(selected)}>
        Restore to draft
      </button>
    </div>
  );
}
