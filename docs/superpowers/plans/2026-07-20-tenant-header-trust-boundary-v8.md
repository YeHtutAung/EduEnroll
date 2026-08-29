# Tenant header trust boundary (Phase 1) — plan v8

**Status:** APPROVED for implementation, conditional on Phase 0.
**Supersedes:** v7 (classifier tests unrunnable in red, stale T13 sentence), v6 (host predicate unpinned), v5 (T14d misclassified, single-method mock), v4 (vacuous T10, single() conflation, unspecified harness), v3 (contradictory delete, non-executable Phase 2, T12 misclassified), v2 (host-derived identity claimed too much), v1 (bypassed root path, under-scoped allowlist, spoofable signal)
**Issue:** #164 (tracked as F2 in the custom-domains plan)
**Scope:** Phase 1 only. Phase 2 is deferred to a separate plan — see below.

---

## What changed from v7

Sequencing only; no design change.

1. **The classifier extraction is now its own verified step before the red
   phase.** `isPlatformRootHost()` does not exist on `dev`, so tests importing
   it would fail at module load — invalidating the red phase under the stop
   conditions rather than merely failing. The red baseline is `dev` **plus**
   that behaviour-preserving extraction, proven green first.
2. **Stale T13 sentence corrected.** It claimed T13 had moved to the deferred
   signing plan — true of the old Phase 2 T13, false of the Phase 1 guard added
   in v7. An implementer following it would have omitted exactly that guard.

## What changed from v6

1. **T13 added.** T11 and T12 pin the *signature* half of the warning
   condition but not the *host* half — an implementation logging after every
   valid signature passes both. The failure would be operational, not a red
   test: once the bot migrates to tenant hosts, legitimate traffic would keep
   emitting "legacy root bot" events and the removal gate could never clear.
2. **The same-endpoint replay decision is restored** to the deferred Phase 2
   requirements, which claim nothing was lost.

## Execution sequence

1. Complete Phase 0 endpoint inventory
2. Branch from `dev`
3. Extract the shared platform-root classifier — **no behaviour change**
4. Add classifier and root-redirect regression tests
5. Run the suite; it must be green before proceeding
6. Add the Phase 1 middleware and `requireAuth()` tests
7. Run the red phase: `RED: T1, T2, T3, T10, T11, T14a, T14b`
8. Confirm every guard passes, including the classifier tests and T13
9. Implement sanitization, telemetry, and the `.maybeSingle()` handling
10. Green suite, then lint and build

## Stop conditions for implementation

Halt and report rather than proceeding if any of these hold:

- Phase 0 (bot endpoint inventory) is incomplete
- **T10 does not fail** against that baseline — it is then not observing the
  vulnerability, and the red count is fiction
- T14a or T14b fails through a mock or import error instead of the expected
  status mismatch — that is an **invalid** red phase, not a passed one
- any listed guard fails during the red run

## What changed from v5

Test mechanics only; no design change.

1. **T14d reclassified as a guard.** With `.single()`, a missing config row
   yields `data: null` plus a discarded error, so the code already returns 403.
   It passes today; its job is to prove `.maybeSingle()` does not turn that into
   a 500.
2. **The mocked query terminal must expose both `.single()` and
   `.maybeSingle()`.** The red run exercises `.single()`, the green run
   `.maybeSingle()`. A single-method fixture makes the red run die on
   `TypeError` — proving nothing — so a stop condition now declares that case
   an invalid red phase rather than a failure.
3. **T10's assertion pinned explicitly**, including that `host` *is* in the
   override list, so an empty or malformed override cannot satisfy it.
4. **Platform-root classifier tests added**, including a lookalike domain.
   Extraction touches the root-`/admin` redirect, not just telemetry.

## What changed from v4

1. **T10 would have passed red for the wrong reason.** The suite reads
   `x-middleware-request-x-tenant-slug`, which Next emits only when middleware
   passes `request: { headers }`. The root branch returns a bare
   `NextResponse.next()`, so that header is already absent and
   `expect(slug(res)).toBeNull()` passes today — while the forged header still
   flows downstream. T10 now asserts the override mechanism, and **must be
   demonstrated red before the count is accepted**.
2. **`.single()` errors on zero rows**, so "any error → 500" would turn a
   missing tenant into a 500 — swapping one conflation for another. Both
   lookups move to `.maybeSingle()`, yielding four distinct outcomes
   (500/404/500/403) with T14a-d covering them.
3. **The `requireAuth()` test harness is specified here**, not deferred to
   Phase 0: a new `src/__tests__/lib/api-auth.test.ts` with an explicit
   isolation contract, real signatures, and separate no-row vs query-error
   fixtures.
4. **T7 renamed** — middleware does not verify signatures, so it can only prove
   a tenant-host request derives that tenant regardless of agent headers.
5. Stale Phase 2 wording removed ("small follow-up PR", "Phase 2 step 3").

## What changed from v3

**Structural:** Phase 2 is removed from this plan. It had grown into a protocol
migration — new signed payload, version negotiation, downgrade rules, a changed
`requireAuth()` signature across every agent-reachable route, and a
server-first rollout. It gets its own plan; its requirements are recorded below
so nothing is lost. This plan is now Phase 1 only, and Phase 1 is honestly a
**partial** fix.

Corrections:

1. **One deletion, not two.** v3 gave an unconditional delete followed by a
   conditional one. Followed literally, the first breaks the bot before the
   exception can preserve anything.
2. **T12 reclassified as a guard.** It asserts no event on an invalid
   signature; no event exists today, so it already passes. Listing it as an
   expected red would have meant "fixing" a passing test.
3. **T14 split** into T14a (tenant lookup) and T14b (config lookup), so a single
   label cannot hide an untested branch.
4. **Severity wording corrected** — `requireAuth()` builds an *owner* context,
   so the replay path is a conditional cross-tenant privilege escalation, not
   "no escalation found".

## What changed from v2

The design direction holds; one central claim did not.

1. **Host-derived identity does not close cross-tenant replay.** The signature
   covers only `chatId + "." + rawBody` — no tenant, host, method or path — so a
   captured valid request replays against any tenant sharing that chat id, and
   nothing constrains sharing. The **separate Phase 2 plan must bind the
   destination into the signature**; v4 does not implement that. The severity
   wording is corrected here.
2. **The migration warning would have stopped firing exactly when needed.** Its
   condition included "tenant came from the transitional header", which Phase 2
   deletes. Now keyed on signature-valid + platform-root, placed before the
   missing-slug 400.
3. **"Platform root" gets one shared classifier** used by middleware and
   `requireAuth()`, instead of a second literal list that can drift.
4. **`requireAuth()`'s discarded query errors are fixed here**, not deferred —
   otherwise T8b would enshrine "database outage looks like revoked agent".
5. Rollout scope corrected; a stale line claiming `allowed_chat_ids` blocks
   cross-tenant naming removed.

## What is actually true

Verified against the code, not inferred from the issue.

`src/middleware.ts:21` copies inbound headers with `new Headers(request.headers)` and
only ever **sets** `x-tenant-slug` (line 96) when a tenant resolves. It never
deletes. So on the platform root, an unknown host, or any skipped prefix, the
caller's own value survives into the request.

**Consumers, and how much they depend on it:**

| Consumer | Behaviour without the header |
|---|---|
| `src/app/layout.tsx`, `(public)/layout.tsx`, `admin/layout.tsx`, `login/page.tsx`, `(public)/enroll/page.tsx` | falls back to `extractSubdomainFromHost` |
| `resolveTenantId()` — `api.ts:181` | falls back to host |
| `api/webhooks/telegram` | falls back to host |
| **`requireAuth()` agent path — `api.ts:60`** | **400 Bad Request. Hard dependency.** |

`/api/scans` and `/api/events` are **not** affected despite being skip-prefixed:
both authenticate with a per-tenant Bearer key via `resolveScannerTenant()` and
never read the header.

So sanitizing breaks exactly one thing: signed agent requests.

## The collision, measured

The bot calls the **root host** with the slug in a header. This is not an
assumption — `src/__tests__/middleware.test.ts:245` pins it:

```
https://kuunyi.com/api/admin/payments/<id>/verify
  x-agent-signature, x-chat-id, x-tenant-slug: flashtic
```

Host-derived identity therefore **breaks the bot** until it is redeployed to
call `https://<tenant>.kuunyi.com/...`. That coordination is the whole cost of
this issue.

## Severity, stated honestly

**Moderate, with a conditional escalation path.** Earlier wording said "no
privilege escalation was found". That is too strong: `requireAuth()` constructs
an **owner** context for the named tenant, so a captured valid signature
authorizes as owner of any tenant sharing that chat id. More precisely:

> No evidence was found that the replay path is currently exercised in dev
> data. The authentication design nevertheless permits cross-tenant owner
> authorization when a chat id is shared and a valid request is captured.
> Production was not checked, so the dev observation must not be generalized.

- **Session users are unaffected.** All 14 `/api/admin` routes use
  `requireAuth()`; none uses `resolveTenantId()`. For a session user the tenant
  comes from their `users` row, so a forged header is inert.
- **Agent requests are HMAC-gated, but the destination is not signed.** Forging
  one from scratch requires `AGENT_SECRET`. However the signature covers only
  `chatId + "." + rawBody`, so a *captured* valid request replays against any
  tenant whose `allowed_chat_ids` includes that chat id. Today no chat id is
  shared across tenants on dev, and no constraint enforces that. Treat this as
  a latent cross-tenant replay path, not a closed one — see Phase 2.
- **Public routes are the actual exposure.** A forged header selects tenant
  context for service-role-backed public routes (enrollment creation, status
  lookup, bank-account listing, uploads, payment creation) on hosts where no
  tenant resolves. Those routes are intentionally public and already reachable
  on that tenant's own subdomain, and a caller can only set headers on their
  own request. The weakness is the trust boundary, not a new capability.

It should not be closed as a non-issue, and it does not warrant breaking
payment verification in a hurry.

---

## The fix

### Phase 1 — sanitize, with one narrow transitional exception

At the **top** of `middleware()`, immediately after `new Headers(request.headers)`
and **before** `shouldSkipTenant()`, so `/api/messenger/*`, `/api/saas/*`,
`/api/events`, `/api/scans` and `/superadmin` are covered:

**One authoritative algorithm** — v3 gave two snippets, an unconditional delete
followed by a conditional one. Followed literally, the first removes the value
before the exception can preserve it, breaking the bot immediately. There is
exactly one deletion:

```ts
const isTransitional = AGENT_TRANSITIONAL_PREFIXES.some((prefix) =>
  pathname.startsWith(prefix),
);
if (!isTransitional) {
  requestHeaders.delete("x-tenant-slug");
}
```

Stated precisely: **outside the transitional allowlist, middleware-derived
resolution is the only source of `x-tenant-slug`.** Inside it, during Phase 1
only, the inbound value is still trusted — deliberately. It is not accurate to
say line 96 becomes the only writer until the allowlist is empty.

**The `/` early return must propagate the sanitized headers.** Line 71 currently
reads:

```ts
if (pathname === "/") return NextResponse.next();
```

That response carries the *original* request headers, so a forged slug still
reaches `app/layout.tsx` on `https://kuunyi.com/` — the deletion above would be
bypassed on the single most obvious host to attack. It becomes:

```ts
if (pathname === "/") {
  return NextResponse.next({ request: { headers: requestHeaders } });
}
```

This branch needs its own test: T1 covers `/enroll` and would not catch it.

**The exception, and why it is path-gated rather than header-gated.** The
allowlist above is:

```ts
const AGENT_TRANSITIONAL_PREFIXES = ["/api/admin/"]; // ← pending Phase 0
```

**`/api/admin/` alone is very likely wrong.** `requireAuth()` is called by
**7 routes outside** `/api/admin`:

```
/api/intakes            /api/intakes/[id]              /api/intakes/[id]/classes
/api/intakes/[id]/form-fields   /api/intakes/[id]/form-fields/apply
/api/messenger/settings         /api/messenger/select-page
```

Only `/api/admin/payments/[id]/verify` reads `x-agent-signature` explicitly, but
that is about reading a POST body: `requireAuth(rawBody = "")` defaults to the
empty string, so a signed **GET** authenticates against *any* of these routes.
Agent reachability is therefore wider than the one route that mentions agents.

Worse for Phase 2: **`/api/messenger/` is in `SKIP_TENANT_PREFIXES`**, so
middleware never derives a tenant there. Moving the bot to a tenant host does
*not* fix those two routes — they would break in Phase 2 rather than Phase 1.
If the bot needs them, Phase 2 must also narrow the skip prefix from
`/api/messenger/` to `/api/messenger/webhook`, which is the route that
legitimately has no tenant context.

It must **not** be gated on the presence of `x-agent-signature`. An attacker
can add that header freely, which would re-open the hole for public routes —
the sanitization would be trivially bypassable by the people it is meant to
stop.

Path-gating is safe because on `/api/admin/`:

- session users take their tenant from their profile, so the header is inert
- agent users are HMAC-verified, so an unauthenticated caller cannot use it

It is *not* safe against a captured valid request naming a tenant that shares
the chat id — see "Host-derived identity is NOT sufficient" below. Phase 1 does
not claim to fix that; Phase 2's signature binding does.

This closes the public-route exposure immediately with **no bot coordination**.

### Phase 2 — deferred to its own plan

**Phase 2 is no longer a step in this plan.** Across v2 and v3 it grew into a
protocol migration: a new signed payload, an external version signal with strict
downgrade rules, a changed `requireAuth()` signature threaded through every
agent-reachable route, a server-first/bot-second/legacy-removal sequence, and
its own test matrix. Following v3's numbered steps literally would have moved
the bot to a tenant host and stopped — leaving the destination unsigned, which
is the actual defect.

Tracked separately as **agent request signing v2**. Requirements established
here, so nothing is lost:

- **Bind the full request target.** `pathname` alone leaves the query string
  unsigned, and signed GETs reach every `requireAuth()` route. Sign
  `pathname + canonical query`, canonicalization defined explicitly and pinned
  byte-for-byte by tests so bot and server cannot diverge.
- **Use an unambiguous serialization.** Dot-joined variable-length fields are
  ambiguous — pathname and body both contain dots. Use `JSON.stringify([...])`
  or length-prefixing.
- **Change the `requireAuth()` input.** It receives only `rawBody` today and
  reads `headers()`; it cannot see method or URL (verified). It needs the
  request, or an explicit `{ method, requestTarget, rawBody }`, and **every
  agent-reachable caller must pass the same bytes the bot signed.** Phase 0's
  inventory determines that set.
- **External version signal + strict downgrade.** The version inside the payload
  cannot tell the server which payload to reconstruct — the header is an opaque
  digest. Use `x-agent-signature: v2=<hex>` or a version header. A request
  marked v2 is verified **only** as v2, never falling back to legacy.
- **Rollout is server-first, and not order-free.** Deploy v2 acceptance
  alongside legacy; deploy the bot on tenant hosts with v2; observe no root-host
  agent traffic and no successful legacy verifications; disable legacy
  authorization; remove the middleware exception; run the final suite. v3's
  claim that bot and server could deploy "in either order" was wrong — a v2-only
  bot deployed first fails unless it has a designed legacy fallback.
- **Legacy verification after cutoff, if retained, is telemetry only.** On a
  platform root: never authorize; optionally verify a legacy signature purely to
  emit the warning; return 400. A successful telemetry verification must not
  fall through into authorization.
- **Decide explicitly on same-endpoint replay.** Destination binding stops
  *cross-tenant* replay; it does not stop replaying the same signed request
  against the same endpoint. The Phase 2 plan must choose between accepting
  that and relying on operation idempotency, or adding a signed timestamp with
  a bounded acceptance window (and possibly nonce tracking). Recorded here
  because this section claims no Phase 2 requirement was lost.
- **Tests:** T8c (real verifier, chat id shared by both tenants), T15 method
  change invalidates, T16 pathname change invalidates, T17 query change
  invalidates, T18 no v2→legacy fallback, T19 legacy rejected on tenant hosts
  after cutoff, T20 legacy root request may warn but never authenticate.

Until that lands, **#164 stays open** and Phase 1 is explicitly a partial fix.


## Phase 0 — agent endpoint inventory (blocking)

Nothing is implemented until the set of endpoints the external bot calls is
known and written down. The allowlist above is a placeholder.

Either confirm it calls **only** `/api/admin/*`, or record the exact routes so
the transitional allowlist and the Phase 2 skip-prefix change cover them.

Do **not** widen the exception to every `requireAuth()` route as a shortcut.
That would restore the trusted inbound header across `/api/intakes/*` — which
is most of the tenant-scoped read surface — for no established reason.

## Phase 1 telemetry, and the future removal gate

The gate is evidence that no agent request still arrives on a root host.

**The warning must be emitted only after signature verification, inside
`requireAuth()` — not from middleware.** A middleware warning keyed on the
presence of `x-agent-signature` is spoofable by anyone: it would let a stranger
manufacture false "legacy bot" evidence, and keep the "no warnings observed"
gate from ever clearing. The signal that gates a security change must not be
writable by an unauthenticated caller.

Emit a fixed structured event when **both** hold:

- `verifyAgentSignature()` **succeeded**
- the host is a platform root

**Not** "and tenant context came from the transitional header", which v2 said.
Phase 2 deletes that header unconditionally, so a regressed bot would arrive
with no tenant context and fall into the existing 400 — and the event would
never fire, precisely when it is most needed. The condition above keeps working
across both phases.

It must run **immediately after signature verification and before the
missing-slug 400**, or Phase 2's early return skips it.

**"Platform root" needs one shared definition.** Middleware classifies it inline
today (`isRootDomain`, four host literals). Putting a second list in `api.ts`
creates two definitions that drift across production, staging, `www`, legacy
Vercel hosts and any future domain. Extract a pure helper into `@/lib/tenant`
alongside `isDevHost()` and call it from both.

Do not pass the classification as a request header (`x-platform-root` or
similar) unless middleware deletes the inbound value first and is its only
writer — otherwise it is another client-controlled input, which is the exact
defect this plan exists to remove.

During Phase 1 the event may additionally carry a fixed boolean recording that
the transitional path was taken. A boolean, not the slug.

Log no slug, chat id, signature, body or secret — the event's occurrence is the
whole signal.

Ship Phase 1, wait one full operating cycle, then check for absence. Asking the
bot's operator is a useful cross-check but weaker on its own: it establishes
what someone believes is configured, not what is running.

**Consequently Phase 1 changes `src/middleware.ts` *and* `src/lib/api.ts`** —
not "middleware and tests only", as v1 claimed.

---

## In scope: requireAuth's agent path discards query errors

`api.ts:70` and `:81` destructure `data` and drop `error` on both
security-relevant lookups:

- a failed **tenant** lookup becomes `404 Tenant not found`
- a failed **telegram config** lookup becomes `403 Agent access has been revoked`

Fail-closed, so not a bypass — but a database incident is indistinguishable from
a missing tenant or a revoked agent. It is the same "no answer" versus "the
answer is no" defect found in the ABank callback, `verify-custom-domains.ts`,
the enroll index and `issueTickets`.

**Fixed here rather than deferred.** Phase 1 already modifies this function and
adds the first direct tests for this path, so the cost is near zero now and the
tests would otherwise enshrine the current behaviour: T8b asserts a 403 for a
chat id that is absent, and without this fix that same 403 is what a database
outage produces. Distinguishing them is what makes T8b meaningful.

**`.single()` makes "no rows" an error**, so a naive `if (error) return 500`
turns a missing tenant into a 500 and a tenant with no Telegram config into a
500 — replacing one conflation with another. Switch both to `.maybeSingle()`,
which `resolveTenantId()` at `api.ts:196` already uses, so absence and failure
become separate states:

```ts
const { data: tenant, error: tenantError } = await query.maybeSingle();
if (tenantError) {
  console.error("[agent-auth] tenant lookup failed");   // no request or secret data
  return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
}
if (!tenant) {
  return NextResponse.json({ error: "Not Found", message: "Tenant not found." }, { status: 404 });
}
```

Equivalently for the config lookup. That yields **four** distinct outcomes, all
of which need tests — T8b covers only the last one:

| Situation | Expected |
|---|---|
| tenant query fails | **500** |
| tenant query succeeds, no row | **404** |
| config query fails | **500** |
| config query succeeds, no row | **403** |
| config row exists, chat id absent | **403** (T8b) |

## Tests

Extend `src/__tests__/middleware.test.ts`, which already has the
`middlewareRequest()` factory. These are unit tests of middleware, no database.

| # | Case | Phase |
|---|---|---|
| T1 | Forged `x-tenant-slug` on `kuunyi.com/enroll` → no tenant context | 1 |
| T2 | Forged header on a skipped prefix (`/api/events`) → no tenant context | 1 |
| T3 | Forged header on an unknown host (`flashtic.evil.com`) → no tenant context | 1 |
| T4 | Genuine subdomain host still resolves its tenant | 1 (guard) |
| T5 | Custom domain still resolves its tenant | 1 (guard) |
| T6 | `/api/admin/` on root host retains the inbound header | 1 (pins the exception) |
| T7 | A tenant-host request derives that tenant **regardless of supplied agent headers** | 1 (guard) |
| T8a | Replay against another tenant host yields the **other host's** slug | 1 |
| T8b | A validly signed request carrying that slug is **rejected** when its chat id is not in that tenant's `allowed_chat_ids` | 1 |
| T10 | Root request installs a sanitized request-header override that **excludes** `x-tenant-slug` | 1 — see below |
| T11 | Valid signed request on a root host emits the transitional event | 1 |
| T12 | **Invalid** signature on a root host emits **no** event | 1 — guard |
| T13 | **Valid** signature on a **tenant host** emits **no** event | 1 — guard, proves the host predicate is applied |
| T14a | **Tenant** lookup query error returns **500**, not 404 | 1 |
| T14b | **Telegram config** lookup query error returns **500**, not 403 | 1 |
| T14c | Unknown tenant (no row) still returns **404** | 1 (guard) |
| T14d | Tenant with **no config row** still returns **403** | 1 (guard) |

T6 and T9 are deliberately contradictory: T6 pins the transitional exception,
T9 replaces it when the exception is removed. Adding T9 while T6 still exists
means one of them is wrong — that is the intended signal that Phase 2 is
complete.

**T8 is split because no single test can prove it.** The issue words it as
"replayed against another tenant host is rejected", but middleware happily
resolves the *other* tenant — the rejection comes from `allowed_chat_ids` inside
`requireAuth()`. The existing middleware suite mocks only the Supabase session
refresh and never calls `requireAuth()`, so it *cannot* observe the rejection.

- **T8a** lives in `src/__tests__/middleware.test.ts` — asserts the derived slug
- **T8b** lives beside the other auth tests — mocks the tenant and
  `tenant_telegram_configs` queries, and uses a genuinely valid signature or a
  narrowly mocked verifier, asserting a 403
- **T8c** is the one that actually tests replay: same chat id authorized for
  *both* tenants. T8b alone proves only that the allowlist works. Without T8c
  the suite would report the replay concern as covered while the vector remains
  open — a green test for a defect that still exists

Written as one middleware test it would pass while proving nothing about
replay — the same shape as the webhook check in #178 that returned 404 from a
deleted route for months.

**Red-first, with exact expectations.** Against **current `dev` plus the
separately verified classifier extraction** — steps 3-5 of the execution
sequence, proven green before the red phase begins — Phase 1 must show:

```
Expected RED  : exactly T1, T2, T3, T10, T11, T14a, T14b
Expected GUARD: T4, T5, T6, T7, T8a, T8b, T12, T13, T14c, T14d,
                the platform-root classifier tests, and the existing
                root-`/admin` redirect — pass in BOTH runs
No existing middleware test may fail, including the temporary agent test at
middleware.test.ts:245, which Phase 1 deliberately keeps passing.
```

**T10 must not be written as `expect(slug(res)).toBeNull()`.** The suite reads
`x-middleware-request-x-tenant-slug`, which Next emits only when middleware
passes `request: { headers }`. The root branch returns a bare
`NextResponse.next()`, so that header is **already absent** — the assertion
passes against current code while the forged header still flows downstream. It
would be a vacuous test for the exact vulnerability it exists to prove.

Assert the mechanism explicitly, so it cannot be weakened later:

```ts
const overridden = response.headers.get("x-middleware-override-headers");
expect(overridden).not.toBeNull();
const names = overridden!.split(",").map((n) => n.trim().toLowerCase());
expect(names).not.toContain("x-tenant-slug");
expect(names).toContain("host");   // a real override, not an empty/malformed one
```

The request **must** carry a forged `x-tenant-slug`, or excluding it proves
nothing. Asserting `host` is present distinguishes a genuine sanitized override
from an empty one that would trivially satisfy the `not.toContain`.

**Verify T10 fails against that baseline before accepting the red count.** If it
passes, the test is not observing the vulnerability and the count is fiction.

**T13 exists because T11 and T12 together do not pin the host predicate.** They
prove the *signature* half — valid on root logs, invalid on root does not. An
implementation that emitted the warning after **every** valid signature, host
ignored, passes both.

The consequence is operational rather than a test failure: once the bot
correctly migrates to tenant hosts, every legitimate request would keep emitting
"legacy root bot" events, and the removal gate — defined as the *absence* of
those events — could never clear. The suite stays green while the migration
becomes impossible to finish.

T13 uses the real verifier against a tenant host (`flashtic.kuunyi.com`). It is
a guard: no warning exists before implementation, so it passes in both runs.
Truth table it completes:

| Signature | Host | Event |
|---|---|---|
| valid | platform root | **yes** (T11) |
| invalid | platform root | no (T12) |
| valid | tenant host | no (T13) |
| invalid | tenant host | no — implied by both predicates |

**T14d is a guard too.** With `.single()`, a missing config row returns
`data: null` *plus* an error; the current code discards the error, so `config`
is null, `allowed` is `[]`, and the chat id is not in it — **403 today**. Its
job is to prove the `.maybeSingle()` switch does not turn a legitimate missing
configuration into a 500.

**T12 is a guard, not a red.** v3 listed it as an expected failure, but it
asserts that an invalid signature emits *no* event — and today no event exists
at all, so it passes already. Expecting it to fail would have meant either
"fixing" a passing test or dismissing a correct result as noise.

T11, T14a and T14b fail red because the warning and the error handling do not
exist yet.

T8c and the former post-Phase-2 warning case are deferred to the signing plan.
**The current T13 is a Phase 1 guard** — valid tenant-host traffic emits no
transitional warning — and does not depend on destination binding. The stale
sentence this replaces would have led an implementer to omit the very guard v7
added.

T4-T7 and T8a are guards over existing behaviour and must pass in both runs.
T8b is new coverage of existing behaviour and should pass immediately — if it
fails red, the revocation check is not doing what the issue assumes, which is a
finding in its own right rather than a test to fix.

### Platform-root classifier tests

Extracting `isRootDomain` is not telemetry-only: middleware uses it to redirect
root-host `/admin` to `/register`. The helper therefore needs direct tests —
`kuunyi.com`, `www.kuunyi.com`, `staging.kuunyi.com`,
`edu-enroll-xi.vercel.app` → true; a tenant subdomain, a custom domain, and a
lookalike such as `kuunyi.com.evil.example` → false; plus port, case and
trailing-dot normalization.

Keep a middleware guard proving root `/admin` still redirects while a tenant
subdomain's `/admin` does not.

**These cannot pass in the red run as-is.** `isPlatformRootHost()` does not
exist on `dev` — classification is inline at `middleware.ts:28` — so a direct
test importing it fails at module load, which would invalidate the red phase
under the stop conditions rather than merely failing.

So the extraction is a **separate behaviour-preserving step, verified before
the red phase begins**:

1. Extract `isPlatformRootHost()` into `src/lib/tenant.ts`
2. Replace middleware's inline classification with it
3. Add the classifier and root-`/admin` regression tests
4. Run the full suite — it must be **green**, proving the refactor changed
   nothing
5. Only then add the Phase 1 tests and run the documented red matrix

The red baseline is therefore *current `dev` plus this separately verified
extraction* — not bare `dev`. Refactor-first is preferable to marking these
green-only, because the helper governs routing behaviour, not just telemetry.

### The requireAuth() harness — specified now, not deferred

Phase 0 determines which *routes* the bot calls; it does not determine where
unit tests for `requireAuth()` live. That is decided here.

The middleware suite cannot host them: it mocks only the Supabase session
refresh and never exercises `headers()`, `createAdminClient()`, the
tenant/config branches, real HMAC verification, or warning emission.

**New file: `src/__tests__/lib/api-auth.test.ts`**, with an explicit isolation
contract:

- `next/headers` mocked per test
- admin-client query chain mocked, with **separate fixtures for "no row" and
  "query error"** — conflating them is the defect being fixed
- **the mocked terminal must expose BOTH `.single()` and `.maybeSingle()`.** The
  red run executes code calling `.single()`; the green implementation calls
  `.maybeSingle()`. A fixture offering only one makes the red run fail with
  `TypeError: query.single is not a function`, which proves nothing about
  404/403 versus 500:

  ```ts
  const result = { data, error };
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    single: vi.fn(async () => result),
    maybeSingle: vi.fn(async () => result),
  };
  ```

  **Stop condition:** if T14a or T14b fails because a mock method is missing, a
  module import fails, or `requireAuth()` throws, the red phase is **invalid** —
  not passed, not failed. They must reach a real response and differ only in
  status: T14a expected 500 / received 404, T14b expected 500 / received 403.
- `AGENT_SECRET` set and restored, delete-aware (restore must remove the key if
  it was absent, not set it to `undefined`)
- **real** signatures via `createHmac` for T8b/T11 where practical, rather than
  a mocked verifier — a mocked verifier cannot show that verification precedes
  the warning
- console/warning spies restored per test
- no ambient environment dependency

Final collected/passed/failed counts are stated once T10 has been demonstrated
red and the file above exists.

---

## Rollout

Feature branch from `dev` → PR to `dev` → staging → main. No self-merge.
No migration and no database change: middleware, the authentication helper
(`src/lib/api.ts`) and tests only.

Phase 1 is independently shippable and closes the public-route exposure.
**Phase 2 is a separately planned, coordinated server-and-bot protocol
migration. It is not part of this implementation.**

**#164 stays open until Phase 2 lands.** Phase 1 leaves an unsigned tenant
selector trusted on the transitional allowlist, which is not what the issue
asks for. If the bot cannot migrate, the answer is not to declare the exception
permanently acceptable — it is to bind tenant identity into the HMAC payload
(the issue's "signed slug" alternative), so the selector stops being unsigned.
Either route closes the issue; leaving Phase 1 in place indefinitely does not.

---

## Open questions

1. **Who deploys the bot, and on what cadence?** Phase 2 is blocked on it, and
   so is Phase 0's endpoint inventory. If the bot cannot be changed, the fix is
   the signed-slug binding rather than an indefinite exception — see Rollout.
2. **Is `AGENT_SECRET` rotation a separate concern?** Out of scope here, but the
   agent contract's security rests entirely on it.
3. **Should Phase 1's warning log be kept after Phase 2?** I would keep it, as
   an alarm for a regressed bot deployment.
