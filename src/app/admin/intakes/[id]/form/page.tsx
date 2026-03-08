"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import StatusBadge from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/Toast";
import type { IntakeStatus } from "@/types/database";

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

interface IntakeItem {
  id: string;
  name: string;
  year: number;
  status: IntakeStatus;
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
  readOnly,
}: {
  field: FormField;
  isSelected: boolean;
  onSelect: () => void;
  readOnly: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: field.id, disabled: readOnly });

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
      onClick={readOnly ? undefined : onSelect}
      className={`group flex items-center gap-3 px-4 py-3 rounded-xl border-2 transition-all ${
        readOnly ? "cursor-default opacity-75" : "cursor-pointer"
      } ${
        isSelected && !readOnly
          ? "border-[#1a3f8a] bg-blue-50/50 shadow-sm"
          : "border-gray-200 bg-white hover:border-gray-300"
      }`}
    >
      {/* Drag handle */}
      {!readOnly && (
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
      )}

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

      {/* Default badge */}
      {field.is_default && (
        <span className="text-xs text-gray-400 shrink-0 px-2 py-0.5 bg-gray-100 rounded-full">
          Default
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
      <h3 className="text-sm font-semibold text-gray-700">Field Settings</h3>

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
      <button
        onClick={onDelete}
        className="w-full mt-2 px-4 py-2 text-sm font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors"
      >
        Delete Field
      </button>
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

// ─── Apply to Other Intakes Modal ────────────────────────────────────────────

function ApplyModal({
  sourceIntakeId,
  onClose,
  onSuccess,
}: {
  sourceIntakeId: string;
  onClose: () => void;
  onSuccess: (count: number) => void;
}) {
  const toast = useToast();
  const [intakes, setIntakes] = useState<IntakeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const applyingRef = useRef(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch("/api/intakes")
      .then((r) => r.json())
      .then((data: IntakeItem[]) => {
        setIntakes(data.filter((i) => i.id !== sourceIntakeId));
      })
      .catch(() => toast.error("Failed to load intakes."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceIntakeId]);

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleApply() {
    if (applyingRef.current) return;
    if (selected.size === 0) return;
    applyingRef.current = true;
    setApplying(true);
    try {
      const res = await fetch(`/api/intakes/${sourceIntakeId}/form-fields/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetIntakeIds: Array.from(selected) }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to apply.");
      }
      const data = await res.json();
      onSuccess(data.applied);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to apply.");
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-900">Apply to Other Intakes</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="w-6 h-6 border-2 border-[#1a3f8a] border-t-transparent rounded-full animate-spin" />
            </div>
          ) : intakes.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No other intakes found.</p>
          ) : (
            <div className="space-y-2">
              {intakes.map((intake) => {
                const isDraft = intake.status === "draft";
                const isChecked = selected.has(intake.id);
                return (
                  <label
                    key={intake.id}
                    className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-all ${
                      isDraft
                        ? isChecked
                          ? "border-[#1a3f8a] bg-blue-50/50 cursor-pointer"
                          : "border-gray-200 hover:border-gray-300 cursor-pointer"
                        : "border-gray-100 bg-gray-50 cursor-not-allowed"
                    }`}
                    title={!isDraft ? "Set intake to Draft to edit its form" : undefined}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleSelect(intake.id)}
                      disabled={!isDraft}
                      className="accent-[#1a3f8a] w-4 h-4 disabled:opacity-30"
                    />
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-medium truncate ${isDraft ? "text-gray-800" : "text-gray-400"}`}>
                        {intake.name}
                      </p>
                      <p className="text-xs text-gray-400">{intake.year}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <StatusBadge status={intake.status} />
                      {!isDraft && (
                        <svg className="w-4 h-4 text-gray-300" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                        </svg>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100">
          <p className="text-xs text-gray-400 mb-3">
            Only Draft intakes can receive form changes. Custom fields will be replaced.
          </p>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2.5 text-sm font-medium text-gray-700 border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleApply}
              disabled={selected.size === 0 || applying}
              className="flex-1 px-4 py-2.5 text-sm font-medium text-white bg-[#1a3f8a] rounded-xl hover:bg-blue-900 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {applying ? "Applying..." : `Apply to Selected (${selected.size})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function FormBuilderPage() {
  const params = useParams();
  const intakeId = params.id as string;
  const toast = useToast();

  const [fields, setFields] = useState<FormField[]>([]);
  const [intakeName, setIntakeName] = useState("");
  const [intakeStatus, setIntakeStatus] = useState<IntakeStatus>("draft");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [showApplyModal, setShowApplyModal] = useState(false);

  // Track fields to delete
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  // Track new fields (no server id yet)
  const [tempCounter, setTempCounter] = useState(0);

  const readOnly = intakeStatus === "open" || intakeStatus === "closed";

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const selectedField = !readOnly ? (fields.find((f) => f.id === selectedId) ?? null) : null;

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
        setIntakeStatus(intake.status ?? "draft");
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
    if (readOnly) return;
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
    if (readOnly) return;
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
    if (!field) return;

    if (!id.startsWith("temp-")) {
      setDeletedIds((prev) => [...prev, id]);
    }

    setFields((prev) => prev.filter((f) => f.id !== id));
    if (selectedId === id) setSelectedId(null);
    setDirty(true);
  }

  // ── Save ───────────────────────────────────────────────────────────────────

  async function handleSave() {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      for (const id of deletedIds) {
        await fetch(`/api/intakes/${intakeId}/form-fields`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
      }

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
      await fetchFields();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      savingRef.current = false;
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
        {!readOnly && (
          <div className="flex items-center gap-3 shrink-0">
            <button
              onClick={() => setShowApplyModal(true)}
              disabled={dirty}
              className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-gray-700 border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title={dirty ? "Save changes first" : "Copy custom fields to other intakes"}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.5a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5a1.125 1.125 0 01-1.125-1.125v-1.5a3.375 3.375 0 00-3.375-3.375H9.75" />
              </svg>
              Apply to Other Intakes
            </button>
            <button
              onClick={handleSave}
              disabled={!dirty || saving}
              className="flex items-center gap-2 px-5 py-2.5 bg-[#1a3f8a] text-white text-sm font-medium rounded-xl hover:bg-blue-900 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
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
        )}
      </div>

      {/* Read-only banner */}
      {readOnly && (
        <div className="mb-6 flex items-center gap-3 px-5 py-3.5 bg-amber-50 border border-amber-200 rounded-xl">
          <svg className="w-5 h-5 text-amber-500 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
          </svg>
          <p className="text-sm text-amber-800">
            This intake is <strong className="capitalize">{intakeStatus}</strong>. Set it to <strong>Draft</strong> to make changes.
          </p>
        </div>
      )}

      {/* Main layout */}
      <div className="grid grid-cols-12 gap-6">
        {/* Left: Field type palette */}
        <div className="col-span-12 lg:col-span-3">
          {!readOnly && (
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
          )}

          {/* Config panel */}
          {selectedField && (
            <div className={`${readOnly ? "" : "mt-4"} bg-white rounded-2xl border border-gray-100 shadow-sm p-4`}>
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
                        readOnly={readOnly}
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

      {/* Apply Modal */}
      {showApplyModal && (
        <ApplyModal
          sourceIntakeId={intakeId}
          onClose={() => setShowApplyModal(false)}
          onSuccess={(count) => {
            setShowApplyModal(false);
            toast.success(`Form applied to ${count} intake(s).`);
          }}
        />
      )}
    </div>
  );
}
