# Enrollment Expiry Cron Setup

The function `check_expired_enrollments()` rejects any enrollment that has
been in `pending_payment` status for more than **72 hours** and restores the
freed seat back to the class. It should run **every 6 hours**.

Two setup options are provided. Choose the one that fits your Supabase plan.

---

## Option A — pg_cron (Recommended)

pg_cron runs entirely inside Postgres. No extra infrastructure is needed and
the job survives restarts automatically.

### 1. Enable the extension

In the Supabase Dashboard → **Database → Extensions**, search for `pg_cron`
and enable it. This only needs to be done once per project.

Alternatively, run in the SQL editor:

```sql
CREATE EXTENSION IF NOT EXISTS pg_cron;
```

### 2. Schedule the job

Open **Database → SQL Editor** and run:

```sql
-- Run every 6 hours (00:00, 06:00, 12:00, 18:00 UTC)
SELECT cron.schedule(
  'expire-pending-enrollments',        -- job name (unique)
  '0 */6 * * *',                       -- cron expression
  $$
    SELECT public.check_expired_enrollments();
  $$
);
```

### 3. Verify the schedule

```sql
SELECT jobid, jobname, schedule, command, active
FROM   cron.job
WHERE  jobname = 'expire-pending-enrollments';
```

### 4. View recent run history

```sql
SELECT runid, jobid, status, start_time, end_time, return_message
FROM   cron.job_run_details
WHERE  jobid = (SELECT jobid FROM cron.job WHERE jobname = 'expire-pending-enrollments')
ORDER  BY start_time DESC
LIMIT  20;
```

### 5. Pause / remove the job

```sql
-- Disable without deleting:
SELECT cron.alter_job(
  job_id  := (SELECT jobid FROM cron.job WHERE jobname = 'expire-pending-enrollments'),
  active  := false
);

-- Remove permanently:
SELECT cron.unschedule('expire-pending-enrollments');
```

---

## Option B — Supabase Edge Function with Built-in Scheduler

Use this if pg_cron is not available on your Supabase plan (Free tier
pg_cron access varies by region).

### 1. Create the Edge Function

```
supabase/functions/expire-enrollments/index.ts
```

```typescript
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

Deno.serve(async (_req) => {
  const { data, error } = await supabase.rpc("check_expired_enrollments");

  if (error) {
    console.error("Expiry job failed:", error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  console.log("Expiry job result:", JSON.stringify(data));
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
});
```

### 2. Deploy the function

```bash
supabase functions deploy expire-enrollments --no-verify-jwt
```

### 3. Schedule via Supabase Dashboard

Go to **Edge Functions → expire-enrollments → Schedules** and add:

| Field    | Value       |
|----------|-------------|
| Schedule | `0 */6 * * *` |
| Method   | GET         |

Or via CLI:

```bash
supabase functions schedule expire-enrollments \
  --cron "0 */6 * * *"
```

### 4. Trigger manually for testing

```bash
curl -X POST \
  "https://<project-ref>.supabase.co/functions/v1/expire-enrollments" \
  -H "Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>"
```

---

## Cron Expression Reference

| Expression    | Meaning                        |
|---------------|--------------------------------|
| `0 */6 * * *` | Every 6 hours (00, 06, 12, 18) |
| `0 */1 * * *` | Every hour                     |
| `0 0 * * *`   | Once daily at midnight         |
| `*/15 * * * *`| Every 15 minutes (testing)     |

---

## Manual Test (SQL Editor)

To verify the function works before scheduling:

```sql
-- Temporarily expire a test enrollment to confirm logic
UPDATE public.enrollments
SET    enrolled_at = now() - interval '73 hours'
WHERE  enrollment_ref = 'NM-2026-00001'   -- replace with a real ref
  AND  status = 'pending_payment';

-- Run the function
SELECT public.check_expired_enrollments();

-- Inspect result — should show expired_count > 0
```

---

## Notes

- The function is **idempotent**: running it multiple times on the same data
  produces the same result.
- Seat restoration is capped at `seat_total` to handle any data inconsistency.
- If a class was marked `full` when its last seat was taken, the function
  reopens it to `open` when seats are returned.
- All DB changes happen in a single CTE transaction (atomic).
