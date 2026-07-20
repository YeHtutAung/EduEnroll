# Enrollment RPC privileges — plan v5

**Status:** for review. Do not implement.
**Supersedes:** v4 (probe determinism, stale bullet), v3 (mutating rollout probe), v2 (execution gaps), v1 (overstated severity — see the correction below).
**Issue:** #174

---

## What changed from v4

Design unchanged. Two corrections:

1. **The probe class id must be proven unused first.** The all-zero UUID is not
   guaranteed absent — nothing in the schema forbids it — so the probe was
   non-mutating only by probability. Now generates a fresh id and verifies it
   is unused before use. The cart probe needs no check: it returns on the
   empty-items guard before touching any row.
2. **Removed a stale bullet** that still said "own class and enrollment
   fixtures", contradicting the corrected paragraph directly above it, and
   retitled the rollout retry so it cannot be read as permission to make a
   normal mutating call.

## What changed from v3

Design unchanged. Three corrections:

1. **Rollout probes are now explicitly non-mutating.** v3 said to "retry the
   service-role call briefly" after the PostgREST reload — but a successful
   call creates an enrollment and reserves seats. On production that would
   modify real inventory to prove a cache reloaded. Now uses nonexistent-data
   probes returning `CLASS_NOT_FOUND` / `EMPTY_CART`, verified against dev.
2. **Default-argument wording corrected** — `p_class_id` is required; only the
   trailing parameters have defaults.
3. **Fixture wording corrected** — the RPC creates the enrollment; tests
   pre-create only tenant/intake/class.

## What changed from v2

Design unchanged and approved. Four execution corrections:

1. **Denial tests mutate in the red phase.** H2/H3/H5/H6 read as non-mutating
   but succeed before their assertion fails, creating rows teardown never sees.
   Fixture rule now covers H1-H6 and H8, tracking before asserting.
2. **`NOTIFY pgrst, 'reload schema'`** added inside the migration. Without it
   PostgREST can serve a stale schema cache and return ambiguity errors to
   legitimate service-role calls — a self-inflicted outage over a secure
   database.
3. **Explicit `BEGIN;`/`COMMIT;`**, so the atomicity the safety argument relies
   on is in the SQL rather than assumed of the runner.
4. **Unreachability claim narrowed** to the measured PostgREST call shapes,
   which is what keeps Phase 0b logically necessary.

Items 2 and 3 match existing repo convention (`075`, `076` for the notify;
`039`, `040`, `049`, `074`, `076` for explicit transactions).

## Correction to v1

v1 claimed an anonymous caller could select a legacy overload by parameter name
and thereby bypass the per-person ticket cap and idempotency guard. **That is
false, and it was the claim the priority rested on.**

Across the three overloads present on dev, every parameter after `p_class_id`
has a default, so shorter PostgREST call shapes match multiple candidates:

```
submit_enrollment(uuid)              p_class_id
submit_enrollment(uuid,text)         p_class_id, p_idempotency_key DEFAULT NULL
submit_enrollment(uuid,text,integer) p_class_id, p_idempotency_key DEFAULT NULL,
                                     p_quantity DEFAULT 1
```

So a call naming only `p_class_id` matches **all three**, and resolution fails
as ambiguous. Measured against dev over PostgREST with the anon key:

| Call shape | Result |
|---|---|
| `{p_class_id}` | **HTTP 300, PGRST203** — could not choose best candidate |
| `{p_class_id, p_idempotency_key}` | **HTTP 300, PGRST203** — ambiguous |
| `{p_class_id, p_idempotency_key, p_quantity}` | **HTTP 200** — executes |

SQL-level resolution agrees: `42725 function ... is not unique`.

### The six-argument overload is a different, worse case — and production has it

Phase 0 returned **four** overloads on production, including
`submit_enrollment(uuid,text,text,text,text,text)`. So `008` ran there, unlike
dev.

It is **not** protected by the ambiguity above. `p_student_name_en` and
`p_phone` are required and appear on no other overload, so a call naming them
resolves **unambiguously** to it. It carries `anon` EXECUTE like the rest.

And it predates every guard added since (verified in
`008_create_enrollment_functions.sql`):

| Guard | 6-arg | current 3-arg |
|---|---|---|
| enrolment window | **absent** | present |
| idempotency | **absent** | present |
| per-person ticket cap | **absent** | present |
| `CLASS_FULL` / seat decrement | present | present |

**Therefore on production an anonymous caller can create enrollments that
bypass the enrolment window, idempotency, and the ticket cap, while consuming
real seats.** Seat availability is still respected, so this is inventory abuse
rather than unbounded oversell.

**Severity on production is therefore higher than the "moderate" rating
above** — that rating was derived from dev, which lacks this overload.

This is exactly the environment-divergence hazard this plan warns about, and
the measurement that produced the v2 correction was taken on dev only. **Treat
production as the worst case, not dev.**

**Status of this finding: CONFIRMED by measurement against production
(2026-07-19).** A non-mutating probe with a class id verified unused returned
`{"error":"CLASS_NOT_FOUND","success":false}` — not `PGRST203`. The overload
resolves unambiguously and executes for `anon`.

**Disclosure note (resolved 2026-07-20):** this document was held uncommitted
while production was unpatched, because the repository is public and it
contains a working reproduction. Production has since been migrated — verified:
only the two intended functions remain, `service_role` can execute, and
`anon` / `authenticated` / `PUBLIC` cannot. It is safe to publish.

The probe used — non-mutating, using a class id proven unused per Step 4:

```
POST /rest/v1/rpc/submit_enrollment      (anon key)
{"p_class_id":"<verified-unused-uuid>","p_student_name_en":"probe","p_phone":"0"}
```

Reaching `CLASS_NOT_FOUND` rather than `PGRST203` confirms the overload is
selectable by anon. Given the same claim was wrong once already, confirm before
relying on the severity.

**The legacy overloads are unreachable through the measured PostgREST call
shapes** — but they are not inherently unreachable. Direct SQL can name an
explicit signature, an out-of-repo database client may issue a typed or
schema-qualified call, and privileged tooling may invoke them differently from
PostgREST. The ambiguity is accidental protection at the PostgREST layer only.

This is precisely why **Phase 0b remains blocking**: "no reachable path" applies
to the interface measured, not to every consumer.

## What is actually wrong

**The third row above returned HTTP 200 as `anon`.**

An anonymous caller can invoke `submit_enrollment(uuid,text,integer)` and
`submit_cart_enrollment` directly, creating enrollments and reserving seats
without going through the application. The anon key ships to the browser, so
this is available to anyone.

The database guards still apply — enrolment window, ticket cap, idempotency —
so this is not a cap bypass. What it bypasses is the **application layer**:
`class_id` validation, quantity flooring, the honeypot field, and any
rate-limiting or abuse controls on the route. The practical risk is inventory
denial: scripted enrollment creation that occupies seats without ever paying.

This is the gap left by `20260712080733_revoke_anon_table_inserts.sql` (089),
which revoked anon table inserts to stop forged enrollments. Its own comment
noted writes also go through "a SECURITY DEFINER RPC" — that path was named and
left open, which weakens the intent of that migration.

**Neither caller needs these grants.** Both use `createAdminClient()`, i.e.
service-role:

- `src/server/enrollment/createEnrollment.ts:55`
- `src/server/enrollment/createCartEnrollment.ts:75`

**Severity: moderate, not critical.** Worth fixing properly; not worth an
emergency.

## Second-order effect of the fix — must be stated

Dropping the legacy overloads **removes the ambiguity that currently blocks
short call shapes**. Afterwards, `{p_class_id}` resolves to the surviving
3-arg function via its defaults instead of erroring.

That is an improvement — the survivor has every guard — but it is a behaviour
change in the opposite direction from "we removed capability", and it should
not be discovered after the fact. Combined with the revoke, `anon` cannot call
it at all, so the net effect is closed. The order within one migration makes
this atomic.

---

## Phase 0 — production catalog (read-only, blocking)

Type signatures alone are insufficient: PostgREST resolves on **parameter
names**, and defaults determine ambiguity. Capture all three.

```sql
SELECT p.oid::regprocedure::text                     AS identity_signature,
       pg_get_function_arguments(p.oid)              AS arguments,
       p.proargnames::text                           AS argument_names,
       CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'invoker' END AS security,
       pg_get_userbyid(p.proowner)                   AS owner,
       COALESCE(array_to_string(p.proacl, ' | '), '(default: PUBLIC EXECUTE)') AS acl
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('submit_enrollment','submit_cart_enrollment')
ORDER BY p.proname, p.pronargs, identity_signature;
```

**Stop on any unexpected signature, parameter name, default, owner, or security
mode.** An unrecognised shape means an unknown consumer may exist, or that
production's history diverged further than assumed.

Known state:

| Environment | `submit_enrollment` overloads |
|---|---|
| Fresh local build | **4** — includes `(uuid,text,text,text,text,text)` from `008` |
| Dev | **3** — the 6-arg is absent (`008` was `migration repair`-ed, never ran) |
| Production | **unknown — Phase 0 answers this** |

## Phase 0b — external consumers (blocking)

**In-repo: settled.** A repository-wide search (excluding
`supabase/migrations`, `node_modules`, `.next`, worktrees) returns only the two
service-role call sites, the stale type declaration, and three mocked test
files. Nothing in `scripts/`, `e2e/`, or edge functions.

**Out-of-repo: unknown.** Confirm no caller outside the codebase — agent flows,
the Telegram bot, dashboard tooling, integrations. Dropping a function an
unlisted consumer depends on trades a privilege issue for an outage. If a
legitimate consumer exists it gets its own narrow grant here rather than
blocking the work.

---

## The fix — one timestamped migration

Historical migrations are not edited; the accumulation is repaired forward.

**All steps run inside one explicit transaction.** The safety property — that
dropping the overloads is only safe *because* the anon grants are revoked in
the same change — must be enforced by the SQL, not assumed of the migration
runner. If any assertion, drop, revoke or grant fails, none of it persists.

Explicit `BEGIN;`/`COMMIT;` is also the house style here: `039`, `040`, `049`,
`074` and `076` all use it.

```sql
BEGIN;
  -- 1. assert survivors exist
  -- 2. drop legacy overloads
  -- 3. revoke and grant
  -- 4. NOTIFY pgrst
COMMIT;
```

**1. Assert the survivors exist — fail closed.**

Legacy drops tolerate absence; required survivors must not. Silently skipping
the grant repair could deploy successfully while leaving no usable application
RPC:

```sql
DO $$
BEGIN
  IF to_regprocedure('public.submit_enrollment(uuid,text,integer)') IS NULL THEN
    RAISE EXCEPTION 'Required submit_enrollment(uuid,text,integer) is missing';
  END IF;
  IF to_regprocedure('public.submit_cart_enrollment(jsonb,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Required submit_cart_enrollment(jsonb,uuid) is missing';
  END IF;
END $$;
```

**2. Drop the unused overloads** — explicit signatures, tolerating absence,
because the environments disagree:

```sql
DROP FUNCTION IF EXISTS public.submit_enrollment(uuid);
DROP FUNCTION IF EXISTS public.submit_enrollment(uuid, text);
DROP FUNCTION IF EXISTS public.submit_enrollment(uuid, text, text, text, text, text);
```

A bare `DROP FUNCTION submit_enrollment` is ambiguous with overloads present
and fails; without `IF EXISTS` it fails where the overload never existed.

**3. Narrow EXECUTE on the survivors.**

```sql
REVOKE ALL ON FUNCTION public.submit_enrollment(uuid, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_enrollment(uuid, text, integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.submit_cart_enrollment(jsonb, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_cart_enrollment(jsonb, uuid)
  TO service_role;
```

`postgres` is the owner and retains EXECUTE implicitly — the reasoning that
made the `check_expired_enrollments` revoke safe.

**4. Reload the PostgREST schema cache.**

```sql
NOTIFY pgrst, 'reload schema';
```

The migration changes both the overload set and who may execute the survivors.
Without this, the database privileges are correct but PostgREST can keep
serving from a stale schema cache — continuing to see the dropped overloads and
returning `PGRST203` ambiguity errors to *legitimate* service-role calls. The
result would be a self-inflicted enrollment outage with a perfectly secure
database underneath.

Established precedent in this repo: `075_reload_pgrst_schema_cache.sql` and
`076_fix_stored_functions.sql:294` both do exactly this after touching these
same functions.

Post-migration verification should **retry briefly** rather than assume the
reload is observable instantly — the notification is asynchronous.

**The retry probe must be non-mutating.** A normal successful call creates an
enrollment and reserves seats; used on production to prove a cache reloaded,
that would modify real inventory. Probe with deliberately nonexistent data
instead — verified against dev, no rows created:

**The single-class probe needs a class id proven absent first.** Nothing stops
a row from having the all-zero UUID — it is unlikely, not impossible, and
production verification must be deterministic rather than probabilistic. If
such a class existed, the "probe" would enroll into it.

Generate a fresh id and confirm it is unused, in the database being verified:

```sql
WITH candidate AS (SELECT gen_random_uuid() AS id)
SELECT id AS probe_class_id,
       NOT EXISTS (SELECT 1 FROM public.classes c WHERE c.id = candidate.id) AS probe_is_safe
FROM candidate;
```

Use the returned UUID only when `probe_is_safe` is true.

| RPC | Probe body | Expected |
|---|---|---|
| `submit_enrollment` | `{"p_class_id":"<verified-unused-uuid>","p_idempotency_key":null,"p_quantity":1}` | `{"success":false,"error":"CLASS_NOT_FOUND"}` |
| `submit_cart_enrollment` | `{"p_items":[],"p_tenant_id":null}` | `{"success":false,"error":"EMPTY_CART"}` |

The cart probe needs no such check: it returns on the empty-items guard before
looking up or updating any row.

Reaching those error payloads proves everything the probe needs to: PostgREST
recognises the surviving signature, `service_role` may execute it, and the
request reached the function body — while mutating nothing.

Full enrollment smokes that genuinely create rows belong on local, dev or
staging fixtures. **Never on production.**

**5. Do not add guards to the legacy overloads.** They are being removed, not
repaired. Adding the ticket cap to `(uuid)` would preserve a second code path
maintained in parallel — the condition that created this problem.

## Generated types

`src/types/database.ts:447` declares `submit_enrollment` with the **6-argument**
signature, a shape the application does not call and dev does not have. Both
call sites need `as never` casts to compile, which is what has been suppressing
this drift.

Regeneration is **not** a blind CLI overwrite. `database.ts` is a hand-extended
file containing custom enums and RPC result unions (see line 389). Therefore:

- generate only from the **rebuilt local database** after the migration
- **never** generate from production
- diff the generated output against the current file before replacing it
- preserve `SubmitEnrollmentResult` and `SubmitCartEnrollmentResult`
- remove the RPC argument casts only after compilation proves the corrected
  signatures
- do **not** mechanically remove unrelated `as never` casts elsewhere

---

## Tests

Extend the database suite (`npm run test:db`, local stack only, 26 today).

| # | Test | Red |
|---|---|---|
| H1 | `service_role` can call `submit_enrollment(uuid,text,integer)` | pass (guard) |
| H2 | `anon` is denied — `42501` | **FAIL** |
| H3 | `authenticated` is denied — `42501` | **FAIL** |
| H4 | `service_role` can call `submit_cart_enrollment` | pass (guard) |
| H5 | `anon` is denied on the cart RPC — `42501` | **FAIL** |
| H6 | `authenticated` is denied on the cart RPC — `42501` | **FAIL** |
| H7 | Exactly one `submit_enrollment` overload remains | **FAIL** (4 locally) |
| H8 | Normal enrollment still succeeds; seats decrement exactly once | pass (guard) |

**Red-run stop condition: `34 collected / 29 passed / 5 failed`**, failures
exactly **H2, H3, H5, H6, H7**. Green: `34 / 34`.

Verify by **identity**, not count — matching the count alone previously hid two
compensating errors in the seat-restoration red run.

Assert `42501` specifically, never merely "it threw": a denial test that passes
because the client was misconfigured is indistinguishable from success.

H7 pins the overload count so a future `CREATE OR REPLACE` with a changed
signature fails loudly instead of silently adding a fifth path.

### Fixture discipline — this applies to H1-H6 and H8, not just the obvious ones

**The denial tests mutate during the red phase.** This is easy to miss: H2, H3,
H5 and H6 assert that a call is *denied*, so they read as non-mutating. But
before the migration those calls are **permitted** — that is the whole point of
the red run. So they succeed, create rows, and only then fail on the assertion.

| Test | Red phase | Green phase |
|---|---|---|
| H2, H3 | **creates an enrollment**, decrements seats, then the assertion fails | denied, no row created |
| H5, H6 | **creates a cart enrollment**, decrements several classes, then fails | denied, no row created |

Because the assertion fails, execution stops — so any tracking placed *after*
it never runs, and teardown cannot remove rows it was never told about. Track
**before** asserting:

```ts
const { data, error } = await client.rpc(/* … */);

// Track FIRST: in the red phase this call succeeds, and the assertion below
// will throw before any later statement runs.
if (data && typeof data === "object" && "enrollment_id" in data) {
  made.enrollments.push(String(data.enrollment_id));
}

expect(error?.code).toBe("42501");
```

Each test creates **its own tenant/intake/class fixtures** and then immediately
tracks any enrollment returned by the RPC. The enrollment itself is created by
the function under test — do not pre-create one, or the test measures an
unrelated row.

All of H1-H6 and H8 must additionally:

- use its own **tenant, intake and class** fixtures, with **headroom below
  `seat_total`** — the RPC creates the enrollment under test; do not pre-create
  one
- capture the returned `enrollment_id` and push it to `made.enrollments`
  **immediately**, not at teardown
- track any auth user created
- let teardown errors surface — they are not swallowed
- run sequentially under the existing config

Otherwise a leaked `pending_payment` row is swept up by a later global-expiry
test, which then fails for an unrelated reason.

H1 and H4 could be reduced to privilege-catalog checks to avoid mutation, but
**at least one real PostgREST invocation of each RPC must remain** — a catalog
check confirms the grant, not that the call works.

---

## Rollout

Feature branch from `dev` → PR to `dev` → staging → main. No self-merge.
Migration applied per environment, dev first, verified before promotion.

**Ordering is not flexible here.** The migration removes capability the
application does not use, so code and migration are independent — but if an
unlisted consumer depends on a legacy overload, the migration breaks it
immediately with no code change to correlate against. Phase 0b is the control,
and it blocks.

Post-migration verification — retry the **verified non-mutating probes from
Step 4** briefly first (the PostgREST reload is asynchronous), then check
**effective** privileges, not `proacl`
entries. The owner retains EXECUTE implicitly and may not appear in `proacl`:

```sql
SELECT p.oid::regprocedure::text AS signature,
       has_function_privilege('postgres',      p.oid, 'EXECUTE') AS postgres_exec,
       has_function_privilege('service_role',  p.oid, 'EXECUTE') AS service_role_exec,
       has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec,
       has_function_privilege('public',        p.oid, 'EXECUTE') AS public_exec
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname='public' AND p.proname IN ('submit_enrollment','submit_cart_enrollment')
ORDER BY signature;
```

Expected: `postgres` true, `service_role` true, `anon` / `authenticated` /
`public` false. (`has_function_privilege('public', …)` is valid — verified
against dev.)

---

## Out of scope

**`submit_cart_enrollment` has no idempotency guard** while the single-class RPC
does, so a double-submitted cart may create two enrollments. Found while
enumerating. It deserves its own issue rather than being folded silently into a
privilege migration.

## Open questions

1. Does production have the 6-arg overload? Phase 0 answers it. It changes
   nothing in the migration — `IF EXISTS` covers both — but tells us whether
   production ever ran `008`.
2. Should `anon` retain EXECUTE anywhere? This plan says no, because both
   callers are service-role. If a browser-side path is later found calling
   these directly, that finding invalidates the plan rather than being worked
   around.
