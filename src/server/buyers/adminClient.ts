import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

export const TIMEOUT_MS = 5_000;

/** Every request stops after 5 s, even when the caller passes its own signal. */
export const timedFetch: typeof fetch = (input, init) =>
  fetch(input, {
    ...init,
    signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(TIMEOUT_MS)])
      : AbortSignal.timeout(TIMEOUT_MS),
  });

/** Service role; every request aborts after 5 s (mobile spec 4.1 step 2). */
export const createTimedAdminClient = () =>
  createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: timedFetch },
  });
