import { isAuthApiError } from "@supabase/supabase-js";

// Supabase Auth answered "this token is no good" (any 4xx except 429), or it
// couldn't answer (429, 5xx, network, timeout, unknown). The app signs a buyer
// out on 401, so an Auth outage must never become one (mobile spec 4.3).
export type AuthFailure = "rejected" | "unavailable";

export function classifyAuthError(error: unknown): AuthFailure {
  if (isAuthApiError(error)) {
    const s = error.status;
    if (s >= 400 && s < 500 && s !== 429) return "rejected";
  }
  return "unavailable";
}
