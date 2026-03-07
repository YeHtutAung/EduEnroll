"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useToast } from "@/components/ui/Toast";

// ─── Types ───────────────────────────────────────────────────────────────────

interface FormField {
  id: string;
  intake_id: string;
  field_key: string;
  field_label: string;
  field_type: FieldType;
  is_required: boolean;
  options: string[] | null;
  sort_order: number;
  is_default: boolean;
}

type FieldType =
  | "text"
  | "select"
  | "radio"
  | "file"
  | "date"
  | "checkbox"
  | "phone"
  | "address";

interface FieldTypeOption {
  type: FieldType;
  label: string;
  icon: string;
}

const FIELD_TYPES: FieldTypeOption[] = [
  { type: "text", label: "Text", icon: "T" },
  { type: "select", label: "Dropdown", icon: "▾" },
  { type: "radio", label: "Radio", icon: "◉" },
  { type: "file", label: "File Upload", icon: "📎" },
  { type: "date", label: "Date", icon: "📅" },
  { type: "checkbox", label: "Checkbox", icon: "☑" },
  { type: "phone", label: "Phone", icon: "📞" },
  { type: "address", label: "Address", icon: "📍" },
];

// ─── Sortable Field Item ─────────────────────────────────────────────────────

function SortableField({
  field,
  isSelected,
  onSelect,
}: {
  field: FormField;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: field.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const typeInfo = FIELD_TYPES.find((t) => t.type === field.field_type);

  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={onSelect}
      className={`group flex items-center gap-3 px-4 py-3 rounded-xl border-2 cursor-pointer transition-all ${
        isSelected
          ? "border-[#1a3f8a] bg-blue-50/50 shadow-sm"
          : "border-gray-200 bg-white hover:border-gray-300"
      }`}
    >
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        className="text-gray-300 hover:text-gray-500 cursor-grab active:cursor-grabbing shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
        <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
          <circle cx="5" cy="3" r="1.5" />
          <circle cx="11" cy="3" r="1.5" />
          <circle cx="5" cy="8" r="1.5" />
          <circle cx="11" cy="8" r="1.5" />
          <circle cx="5" cy="13" r="1.5" />
          <circle cx="11" cy="13" r="1.5" />
        </svg>
      </button>

      {/* Type icon */}
      <span className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center text-sm shrink-0">
        {typeInfo?.icon ?? "?"}
      </span>

      {/* Label */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-800 truncate">{field.field_label}</p>
        <p className="text-xs text-gray-400">
          {typeInfo?.label ?? field.field_type}
          {field.is_required && " · Required"}
        </p>
      </div>

      {/* Lock icon for defaults */}
      {field.is_default && (
        <span className="text-gray-300 shrink-0" title="Default field (cannot delete)">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
          </svg>
        </span>
      )}
    </div>
  );
}

// ─── Field Config Panel ──────────────────────────────────────────────────────

function FieldConfigPanel({
  field,
  onUpdate,
  onDelete,
}: {
  field: FormField;
  onUpdate: (updates: Partial<FormField>) => void;
  onDelete: () => void;
}) {
  const hasOptions = field.field_type === "select" || field.field_type === "radio";
  const [optionInput, setOptionInput] = useState("");

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700">Field Settings</h3>
        {field.is_default && (
          <span className="text-xs text-gray-400 flex items-center gap-1">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
            </svg>
            Default
          </span>
        )}
      </div>

      {/* Label */}
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Label</label>
        <input
          type="text"
          value={field.field_label}
          onChange={(e) => onUpdate({ field_label: e.target.value })}
          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1a3f8a] focus:border-transparent"
        />
      </div>

      {/* Field Type */}
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Type</label>
        <select
          value={field.field_type}
          onChange={(e) => onUpdate({ field_type: e.target.value as FieldType })}
          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1a3f8a] focus:border-transparent bg-white"
        >
          {FIELD_TYPES.map((t) => (
            <option key={t.type} value={t.type}>
              {t.icon} {t.label}
            </option>
          ))}
        </select>
      </div>

      {/* Required toggle */}
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-gray-500">Required</label>
        <button
          onClick={() => onUpdate({ is_required: !field.is_required })}
          className={`relative w-10 h-5 rounded-full transition-colors ${
            field.is_required ? "bg-[#1a3f8a]" : "bg-gray-200"
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
              field.is_required ? "translate-x-5" : ""
            }`}
          />
        </button>
      </div>

      {/* Options for select/radio */}
      {hasOptions && (
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Options</label>
          <div className="space-y-1.5 mb-2">
            {(field.options ?? []).map((opt, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="flex-1 text-sm text-gray-700 px-3 py-1.5 bg-gray-50 rounded-lg">
                  {opt}
                </span>
                <button
                  onClick={() => {
                    const next = (field.options ?? []).filter((_, j) => j !== i);
                    onUpdate({ options: next });
                  }}
                  className="text-gray-300 hover:text-red-500 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={optionInput}
              onChange={(e) => setOptionInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && optionInput.trim()) {
                  onUpdate({ options: [...(field.options ?? []), optionInput.trim()] });
                  setOptionInput("");
                }
              }}
              placeholder="Add option..."
              className="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1a3f8a]"
            />
            <button
              onClick={() => {
                if (optionInput.trim()) {
                  onUpdate({ options: [...(field.options ?? []), optionInput.trim()] });
                  setOptionInput("");
                }
              }}
              className="px-3 py-1.5 text-xs font-medium bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
            >
              Add
            </button>
          </div>
        </div>
      )}

      {/* Delete button */}
      {!field.is_default && (
        <button
          onClick={onDelete}
          className="w-full mt-2 px-4 py-2 text-sm font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors"
        >
          Delete Field
        </button>
      )}
    </div>
  );
}

// ─── Live Preview ────────────────────────────────────────────────────────────

function FieldPreview({ field }: { field: FormField }) {
  const label = (
    <label className="block text-sm font-medium text-gray-700 mb-1">
      {field.field_label}
      {field.is_required && <span className="text-red-500 ml-0.5">*</span>}
    </label>
  );

  switch (field.field_type) {
    case "select":
      return (
        <div>
          {label}
          <select className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white" disabled>
            <option>Select...</option>
            {(field.options ?? []).map((o, i) => (
              <option key={i}>{o}</option>
            ))}
          </select>
        </div>
      );
    case "radio":
      return (
        <div>
          {label}
          <div className="space-y-1.5 mt-1">
            {(field.options ?? []).length > 0 ? (
              (field.options ?? []).map((o, i) => (
                <label key={i} className="flex items-center gap-2 text-sm text-gray-600">
                  <input type="radio" disabled className="accent-[#1a3f8a]" /> {o}
                </label>
              ))
            ) : (
              <p className="text-xs text-gray-400 italic">No options defined</p>
            )}
          </div>
        </div>
      );
    case "checkbox":
      return (
        <div>
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <input type="checkbox" disabled className="accent-[#1a3f8a] w-4 h-4" />
            {field.field_label}
            {field.is_required && <span className="text-red-500">*</span>}
          </label>
        </div>
      );
    case "file":
      return (
        <div>
          {label}
          <div className="border-2 border-dashed border-gray-200 rounded-lg p-4 text-center">
            <p className="text-xs text-gray-400">Click or drag to upload</p>
          </div>
        </div>
      );
    case "date":
      return (
        <div>
          {label}
          <input type="date" disabled className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white" />
        </div>
      );
    case "address":
      return (
        <div>
          {label}
          <textarea disabled rows={2} className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white resize-none" placeholder="Address..." />
        </div>
      );
    case "phone":
      return (
        <div>
          {label}
          <input type="tel" disabled placeholder="09xxxxxxxxx" className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white" />
        </div>
      );
    default:
      return (
        <div>
          {label}
          <input type="text" disabled placeholder={field.field_label} className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white" />
        </div>
      );
  }
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function FormBuilderPage() {
  const params = useParams();
  const intakeId = params.id as string;
  const toast = useToast();

  const [fields, setFields] = useState<FormField[]>([]);
  const [intakeName, setIntakeName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Track fields to delete
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  // Track new fields (no server id yet)
  const [tempCounter, setTempCounter] = useState(0);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const selectedField = fields.find((f) => f.id === selectedId) ?? null;

  // ── Fetch ──────────────────────────────────────────────────────────────────

  const fetchFields = useCallback(async () => {
    setLoading(true);
    try {
      const [fieldsRes, intakeRes] = await Promise.all([
        fetch(`/api/intakes/${intakeId}/form-fields`),
        fetch(`/api/intakes/${intakeId}`),
      ]);
      if (fieldsRes.ok) setFields(await fieldsRes.json());
      if (intakeRes.ok) {
        const intake = await intakeRes.json();
        setIntakeName(intake.name ?? "");
      }
    } catch {
      toast.error("Failed to load form fields.");
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intakeId]);

  useEffect(() => {
    fetchFields();
  }, [fetchFields]);

  // ── Handlers ───────────────────────────────────────────────────────────────

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    setFields((prev) => {
      const oldIndex = prev.findIndex((f) => f.id === active.id);
      const newIndex = prev.findIndex((f) => f.id === over.id);
      const reordered = arrayMove(prev, oldIndex, newIndex);
      return reordered.map((f, i) => ({ ...f, sort_order: i + 1 }));
    });
    setDirty(true);
  }

  function addField(type: FieldType) {
    const typeInfo = FIELD_TYPES.find((t) => t.type === type);
    const newId = `temp-${tempCounter}`;
    setTempCounter((c) => c + 1);

    const newField: FormField = {
      id: newId,
      intake_id: intakeId,
      field_key: `custom_${type}_${Date.now()}`,
      field_label: typeInfo?.label ?? type,
      field_type: type,
      is_required: false,
      options: type === "select" || type === "radio" ? [] : null,
      sort_order: fields.length + 1,
      is_default: false,
    };

    setFields((prev) => [...prev, newField]);
    setSelectedId(newId);
    setDirty(true);
  }

  function updateField(id: string, updates: Partial<FormField>) {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...updates } : f)));
    setDirty(true);
  }

  function deleteField(id: string) {
    const field = fields.find((f) => f.id === id);
    if (!field || field.is_default) return;

    // Track server-side fields for deletion
    if (!id.startsWith("temp-")) {
      setDeletedIds((prev) => [...prev, id]);
    }

    setFields((prev) => prev.filter((f) => f.id !== id));
    if (selectedId === id) setSelectedId(null);
    setDirty(true);
  }

  // ── Save ───────────────────────────────────────────────────────────────────

  async function handleSave() {
    setSaving(true);
    try {
      // 1. Delete removed fields
      for (const id of deletedIds) {
        await fetch(`/api/intakes/${intakeId}/form-fields`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
      }

      // 2. Create new fields
      for (const field of fields) {
        if (field.id.startsWith("temp-")) {
          const res = await fetch(`/api/intakes/${intakeId}/form-fields`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              field_key: field.field_key,
              field_label: field.field_label,
              field_type: field.field_type,
              is_required: field.is_required,
              options: field.options,
              sort_order: field.sort_order,
            }),
          });
          if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error ?? "Failed to create field.");
          }
        }
      }

      // 3. Update existing fields (sort_order, label, type, required, options)
      for (const field of fields) {
        if (!field.id.startsWith("temp-")) {
          await fetch(`/api/intakes/${intakeId}/form-fields`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: field.id,
              field_label: field.field_label,
              field_type: field.field_type,
              is_required: field.is_required,
              options: field.options,
              sort_order: field.sort_order,
            }),
          });
        }
      }

      toast.success("Form saved successfully.");
      setDirty(false);
      setDeletedIds([]);
      // Refetch to get server IDs for new fields
      await fetchFields();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  // ── Loading ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-[#f0f4ff] flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-[#1a3f8a] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#f0f4ff] px-6 py-8 lg:px-8">
      {/* Header */}
      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm text-gray-400 mb-1">
            <Link href="/admin/intakes" className="hover:text-[#1a3f8a] transition-colors">
              Intakes
            </Link>
            <span>/</span>
            <Link href={`/admin/intakes/${intakeId}`} className="hover:text-[#1a3f8a] transition-colors">
              {intakeName}
            </Link>
            <span>/</span>
            <span className="text-gray-600">Form Builder</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Edit Enrollment Form</h1>
          <p className="text-sm font-myanmar text-gray-400 mt-0.5">
            စာရင်းသွင်းဖောင် ပြင်ဆင်ရန်
          </p>
        </div>
        <button
          onClick={handleSave}
          disabled={!dirty || saving}
          className="flex items-center gap-2 px-5 py-2.5 bg-[#1a3f8a] text-white text-sm font-medium rounded-xl hover:bg-blue-900 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
        >
          {saving ? (
            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          )}
          {saving ? "Saving..." : "Save Form"}
        </button>
      </div>

      {/* Main layout */}
      <div className="grid grid-cols-12 gap-6">
        {/* Left: Field type palette */}
        <div className="col-span-12 lg:col-span-3">
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
              Add Field
            </h2>
            <div className="grid grid-cols-2 gap-2">
              {FIELD_TYPES.map((ft) => (
                <button
                  key={ft.type}
                  onClick={() => addField(ft.type)}
                  className="flex flex-col items-center gap-1.5 px-3 py-3 rounded-xl border border-gray-200 hover:border-[#1a3f8a] hover:bg-blue-50/50 transition-all text-center"
                >
                  <span className="text-lg">{ft.icon}</span>
                  <span className="text-xs font-medium text-gray-600">{ft.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Config panel */}
          {selectedField && (
            <div className="mt-4 bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
              <FieldConfigPanel
                field={selectedField}
                onUpdate={(updates) => updateField(selectedField.id, updates)}
                onDelete={() => deleteField(selectedField.id)}
              />
            </div>
          )}
        </div>

        {/* Center: Sortable field list */}
        <div className="col-span-12 lg:col-span-5">
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
              Form Fields ({fields.length})
            </h2>

            {fields.length === 0 ? (
              <div className="py-12 text-center">
                <p className="text-sm text-gray-400">No fields yet. Click a type to add one.</p>
              </div>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={fields.map((f) => f.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-2">
                    {fields.map((field) => (
                      <SortableField
                        key={field.id}
                        field={field}
                        isSelected={selectedId === field.id}
                        onSelect={() =>
                          setSelectedId(selectedId === field.id ? null : field.id)
                        }
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}
          </div>
        </div>

        {/* Right: Live preview */}
        <div className="col-span-12 lg:col-span-4">
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 sticky top-8">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">
              Live Preview
            </h2>
            <div className="space-y-4">
              {fields.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-8">
                  Add fields to see preview
                </p>
              ) : (
                fields.map((field) => <FieldPreview key={field.id} field={field} />)
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
