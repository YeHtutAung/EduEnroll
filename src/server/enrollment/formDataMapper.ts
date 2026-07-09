import { resolveEmailFromFormData, resolvePhoneFromFormData } from "@/lib/utils";

export interface FormDataUpdatePayload {
  form_data: Record<string, string>;
  student_name_en?: string;
  student_name_mm?: string;
  phone?: string;
  email?: string;
  nrc_number?: string;
  messenger_psid?: string;
}

/**
 * Maps dynamic form_data fields to legacy DB columns.
 * Only populates a column when the field type matches expectations.
 * Includes fallback resolvers for non-standard field names.
 */
export function buildEnrollmentUpdatePayload(
  fd: Record<string, string>,
  fieldTypeMap: Map<string, string>,
  messengerPsid?: string | null,
): FormDataUpdatePayload {
  const payload: FormDataUpdatePayload = { form_data: fd };

  if (fd.name_en && fieldTypeMap.get("name_en") === "text")
    payload.student_name_en = fd.name_en.trim();
  if (fd.name_mm && fieldTypeMap.get("name_mm") === "text")
    payload.student_name_mm = fd.name_mm.trim();
  if (fd.phone && (fieldTypeMap.get("phone") === "phone" || fieldTypeMap.get("phone") === "text"))
    payload.phone = fd.phone.trim();
  if (fd.email && (fieldTypeMap.get("email") === "text" || fieldTypeMap.get("email") === "email"))
    payload.email = fd.email.trim();
  if (fd.nrc && fieldTypeMap.get("nrc") === "text")
    payload.nrc_number = fd.nrc.trim();

  // Fallback: non-standard phone / email field names
  if (!payload.phone) {
    const resolved = resolvePhoneFromFormData(fd);
    if (resolved) payload.phone = resolved;
  }
  if (!payload.email) {
    const resolved = resolveEmailFromFormData(fd);
    if (resolved) payload.email = resolved;
  }

  if (typeof messengerPsid === "string" && messengerPsid.trim()) {
    payload.messenger_psid = messengerPsid.trim();
  }

  return payload;
}

/**
 * Fetches field type definitions for an intake from Supabase.
 * Returns a Map of field_key → field_type.
 */
export async function fetchFieldTypeMap(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from: (t: string) => any },
  intakeId: string,
): Promise<Map<string, string>> {
  const { data: fieldDefs } = await supabase
    .from("intake_form_fields")
    .select("field_key, field_type")
    .eq("intake_id", intakeId) as {
    data: { field_key: string; field_type: string }[] | null;
    error: unknown;
  };
  return new Map((fieldDefs ?? []).map((f) => [f.field_key, f.field_type]));
}
