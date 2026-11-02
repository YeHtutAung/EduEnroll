import type { createAdminClient } from "@/lib/supabase/admin";
import type { MarketingPageVersion } from "@/types/database";
import type { MarketingContent } from "./content";

type Admin = ReturnType<typeof createAdminClient>;
type DbError = { code?: string; message?: string; statusCode?: string } | null;

export const VERSION_LIST_LIMIT = 20;

export type WriteResult =
  | { ok: true; revision: number }
  | { ok: false; reason: "stale" | "not_configured" | "error" };

/** The table, function or bucket isn't there yet: the migration hasn't been applied. */
export function isNotConfigured(error: DbError): boolean {
  if (!error) return false;
  return (
    error.code === "42P01" || // undefined table
    error.code === "42883" || // undefined function
    error.code === "PGRST202" || // function not in the schema cache
    error.code === "PGRST205" || // table not in the schema cache
    error.statusCode === "NoSuchBucket" ||
    /bucket not found/i.test(error.message ?? "")
  );
}

export function isStale(error: DbError): boolean {
  return /marketing_draft_stale/.test(error?.message ?? "");
}

function failure(error: DbError): WriteResult {
  if (isStale(error)) return { ok: false, reason: "stale" };
  if (isNotConfigured(error)) return { ok: false, reason: "not_configured" };
  console.error("[marketing] write failed:", error?.code, error?.message);
  return { ok: false, reason: "error" };
}

export async function readVersion(admin: Admin, status: "draft" | "published") {
  const { data, error } = (await admin
    .from("marketing_page_versions")
    .select("*")
    .eq("status", status)
    .maybeSingle()) as { data: MarketingPageVersion | null; error: DbError };
  return { row: data, error };
}

export async function listArchived(admin: Admin) {
  const { data, error } = (await admin
    .from("marketing_page_versions")
    .select("id, published_at")
    .eq("status", "archived")
    .order("published_at", { ascending: false })
    .limit(VERSION_LIST_LIMIT)) as {
    data: Pick<MarketingPageVersion, "id" | "published_at">[] | null;
    error: DbError;
  };
  return { rows: data ?? [], error };
}

/**
 * The only way content reaches the draft row. Revision 0 means no draft existed
 * when the editor loaded: the function creates one only if that's still true and
 * the published version hasn't changed. Any other revision must still match.
 */
export async function writeDraft(
  admin: Admin,
  args: {
    content: MarketingContent;
    expectedRevision: number;
    basePublishedId: string | null;
    userId: string;
  },
): Promise<WriteResult> {
  if (args.expectedRevision === 0) {
    const { error } = (await admin.rpc("create_marketing_draft", {
      p_base_published_id: args.basePublishedId,
      p_content: args.content,
      p_user_id: args.userId,
    } as never)) as { error: DbError };
    return error ? failure(error) : { ok: true, revision: 1 };
  }

  const revision = args.expectedRevision + 1;
  const { data, error } = (await admin
    .from("marketing_page_versions")
    .update({ content: args.content, revision, updated_at: new Date().toISOString() } as never)
    .eq("status", "draft")
    .eq("revision", args.expectedRevision)
    .select("id")) as { data: { id: string }[] | null; error: DbError };
  if (error) return failure(error);
  if (!data?.length) return { ok: false, reason: "stale" };
  return { ok: true, revision };
}
