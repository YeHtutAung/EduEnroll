import { randomBytes } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BuyerProfile, Database } from "@/types/database";
import { canCreateProfile } from "@/lib/authMethod";
import { createTimedAdminClient } from "./adminClient";

// ─── ensureBuyerProfile: the ONLY path that creates a buyer profile ─────────
//
// Mobile spec 4.1 "No password a buyer didn't set" and 4.5. Someone could
// pre-register a buyer's email with a password; the buyer's first email-code
// sign-in would then confirm that same user. So before the profile exists we
// claim it and replace the password with a random one nobody sees, and only
// then create the row.
//
// The reset ends EVERY session of the user, the caller's own included (GoTrue
// deletes all auth.sessions rows on a password change; Task 10 found it, Task
// 11a's spike confirmed it). So after creating the row we ask Auth for a
// one-time magic-link hash (generateLink sends no email and doesn't call the
// Send Email Hook, also confirmed) and hand it back as `reissue`. The caller
// turns it into a fresh session for the same user: the website's route on its
// cookie client, the app's POST /me as tokens. `reissue: null` means the
// re-issue couldn't be prepared: the account exists, the buyer signs in once
// more.
//
// The caller's getUser() must ALREADY have accepted `accessToken` for `user`.
// Never log the password, the access token, the claim token, the re-issue
// hash or the email. The hash is a sign-in credential: callers never return
// it in a response body or log it.

/** A one-time sign-in hash for re-issuing the caller's session. */
export type Reissue = { hashedToken: string };

export type EnsureResult =
  | {
      ok: true;
      status: 200 | 201;
      profile: BuyerProfile;
      /**
       * Absent: no reset ran, the caller's session is untouched.
       * Present: the reset ended the caller's session; re-issue with this
       * (or, when null, ask the buyer to sign in once more).
       */
      reissue?: Reissue | null;
    }
  | { ok: false; status: 403; code: "FORBIDDEN"; reason: "staff" | "unconfirmed" | "not_email_code" }
  | { ok: false; status: 409; code: "DELETION_IN_PROGRESS" }
  | { ok: false; status: 503; code: "SERVER" };

export interface EnsureInput {
  user: { id: string; email?: string | null; email_confirmed_at?: string | null };
  accessToken: string;
}

export interface EnsureDeps {
  admin: SupabaseClient<Database>;
}

type Admin = SupabaseClient<Database>;

type Fns = Database["public"]["Functions"];
type BuyerRpc =
  | "claim_buyer_profile"
  | "buyer_profile_claim_held"
  | "create_buyer_profile"
  | "release_buyer_profile_claim";

/**
 * supabase-js can't infer RPC types from this hand-written Database type (the
 * repo casts at each call), so the args and result are typed from
 * src/types/database.ts here, in one place.
 */
async function rpc<N extends BuyerRpc>(
  admin: Admin,
  name: N,
  args: Fns[N]["Args"],
): Promise<{ data: Fns[N]["Returns"] | null; error: { code?: string } | null }> {
  return (await admin.rpc(name as never, args as never)) as unknown as {
    data: Fns[N]["Returns"] | null;
    error: { code?: string } | null;
  };
}

const SERVER: EnsureResult = { ok: false, status: 503, code: "SERVER" };
const DELETING: EnsureResult = { ok: false, status: 409, code: "DELETION_IN_PROGRESS" };
const forbidden = (reason: "staff" | "unconfirmed" | "not_email_code"): EnsureResult => ({
  ok: false,
  status: 403,
  code: "FORBIDDEN",
  reason,
});

/** Step name and error code only: never a message, which may echo input. */
function logFailure(step: string, err: unknown): void {
  const code =
    err && typeof err === "object"
      ? ((err as { code?: unknown }).code ?? (err as { status?: unknown }).status ?? (err as { name?: unknown }).name)
      : undefined;
  console.error(`[ensureBuyerProfile] ${step} failed`, typeof code === "string" || typeof code === "number" ? code : "");
}

type ProfileRead = { kind: "none" } | { kind: "error" } | { kind: "row"; row: BuyerProfile };

async function readProfile(admin: Admin, userId: string): Promise<ProfileRead> {
  const { data, error } = await admin.from("buyer_profiles").select("*").eq("id", userId).maybeSingle();
  if (error) {
    logFailure("profile read", error);
    return { kind: "error" };
  }
  return data ? { kind: "row", row: data as BuyerProfile } : { kind: "none" };
}

/** Step 3's answer for a row that exists: live → 200, deleted → 409. */
function answerExisting(row: BuyerProfile): EnsureResult {
  return row.deleted_at ? DELETING : { ok: true, status: 200, profile: row };
}

/**
 * 64 random base64url characters plus a fixed suffix with one of each class
 * (lower, upper, digit, symbol), so a hosted password policy that demands
 * symbols still accepts it. Nobody ever sees or uses this password.
 */
function randomPassword(): string {
  return randomBytes(48).toString("base64url") + "aA1!";
}

async function release(admin: Admin, userId: string, token: string): Promise<void> {
  try {
    const { error } = await rpc(admin, "release_buyer_profile_claim", { p_user_id: userId, p_token: token });
    if (error) logFailure("release", error);
  } catch (err) {
    // The claim expires after 30 s anyway; the answer stays 503.
    logFailure("release", err);
  }
}

export async function ensureBuyerProfile(
  input: EnsureInput,
  deps: EnsureDeps = { admin: createTimedAdminClient() },
): Promise<EnsureResult> {
  const { admin } = deps;
  const { user, accessToken } = input;

  let pre: EnsureResult | { claimed: string };
  try {
    pre = await beforeClaim(admin, user, accessToken);
  } catch (err) {
    // No claim is held yet, so there is nothing to release.
    logFailure("pre-claim", err);
    return SERVER;
  }
  if (!("claimed" in pre)) return pre;
  const token = pre.claimed;

  // Steps 6-9. Every exit here releases the claim with this exact token,
  // except 'created' / 'existing' / 'lost' from create_buyer_profile.
  try {
    // 6. Still ours?
    const held = await rpc(admin, "buyer_profile_claim_held", { p_user_id: user.id, p_token: token });
    if (held.error || held.data !== true) {
      if (held.error) logFailure("claim check", held.error);
      await release(admin, user.id, token);
      return SERVER;
    }

    // 7. Replace any password set before the buyer confirmed. Nobody sees this one.
    const password = randomPassword();
    const updated = await admin.auth.admin.updateUserById(user.id, { password });
    if (updated.error) {
      logFailure("password reset", updated.error);
      await release(admin, user.id, token);
      return SERVER;
    }

    // 8. (Removed by Task 11a.) The reset above already ended every session,
    // including any opened with a pre-registered password, so there is no
    // "sign out others" step: it would find no session and fail.

    // 9. Create.
    const created = await rpc(admin, "create_buyer_profile", {
      p_user_id: user.id,
      p_token: token,
      p_email: user.email!,
    });
    if (created.error) {
      // Includes 23505: the email is on another user's profile.
      logFailure("create", created.error);
      await release(admin, user.id, token);
      return SERVER;
    }
    if (created.data === "lost") return SERVER; // the claim is no longer ours: don't release
    if (created.data !== "created" && created.data !== "existing") {
      await release(admin, user.id, token);
      return SERVER;
    }

    const row = await readProfile(admin, user.id);
    if (row.kind !== "row") return SERVER;
    const answer: EnsureResult =
      created.data === "created" ? { ok: true, status: 201, profile: row.row } : answerExisting(row.row);
    // 10. Our reset ended the caller's session: prepare its re-issue.
    if (!answer.ok) return answer;
    return { ...answer, reissue: await prepareReissue(admin, user.email!) };
  } catch (err) {
    logFailure("claimed step", err);
    await release(admin, user.id, token);
    return SERVER;
  }
}

/**
 * A one-time magic-link hash for this address. Never throws; null on any
 * failure (the profile already exists by now, so nothing is released). Logs
 * the step and error code only, never the hash.
 */
async function prepareReissue(admin: Admin, email: string): Promise<Reissue | null> {
  try {
    const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
    if (error) {
      logFailure("reissue link", error);
      return null;
    }
    const hashedToken = data?.properties?.hashed_token;
    return typeof hashedToken === "string" && hashedToken !== "" ? { hashedToken } : null;
  } catch (err) {
    logFailure("reissue link", err);
    return null;
  }
}

/** Steps 1-5. Returns a final answer, or the claim token to carry on with. */
async function beforeClaim(
  admin: Admin,
  user: EnsureInput["user"],
  accessToken: string,
): Promise<EnsureResult | { claimed: string }> {
  // 1. Staff accounts never become buyers.
  const staff = await admin.from("users").select("id").eq("id", user.id).maybeSingle();
  if (staff.error) {
    logFailure("staff read", staff.error);
    return SERVER;
  }
  if (staff.data) return forbidden("staff");

  // 2. Only a confirmed email address. (An account with no email can't be confirmed.)
  if (!user.email_confirmed_at || !user.email) return forbidden("unconfirmed");

  // 3. An existing profile answers at once and nothing else runs.
  const existing = await readProfile(admin, user.id);
  if (existing.kind === "error") return SERVER;
  if (existing.kind === "row") return answerExisting(existing.row);

  // 4. Email code or Google only, checked before the claim so a password session never
  // holds one. A session whose amr lists a password is refused even if it also lists
  // otp or oauth. The reason stays "not_email_code" (the app contract).
  if (!canCreateProfile(accessToken)) {
    return forbidden("not_email_code");
  }

  // 5. Claim.
  const claim = await rpc(admin, "claim_buyer_profile", { p_user_id: user.id });
  if (claim.error) {
    logFailure("claim", claim.error);
    return SERVER;
  }
  if (!claim.data) return SERVER; // another caller holds a fresh claim
  if (claim.data === "exists") {
    const reread = await readProfile(admin, user.id);
    return reread.kind === "row" ? answerExisting(reread.row) : SERVER;
  }
  return { claimed: claim.data };
}
