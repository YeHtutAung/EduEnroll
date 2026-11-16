# Per-Runner Ticket Details Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One buyer can buy several tickets in one order, and each ticket (runner) carries its own answers to the fields the organiser marks "Ask for each ticket" — for The Beats Run: runner name and Jersey Size.

**Architecture:** A new boolean `intake_form_fields.per_attendee` splits an event's form into order-level fields (buyer contact, stored in `enrollments.form_data` as today) and per-ticket fields. Per-ticket answers are stored as an array in a new `enrollments.attendees` column, one entry per admission keyed by `(class_id, seat_no)` — the same key `issueTicketsForEnrollment` already numbers tickets by — and copied onto a new `tickets.attendee` column when tickets are issued. One pure module (`src/lib/enrollment/attendees.ts`) defines the slots, the validation and the ticket label, and is shared by the browser and both server write paths. Nothing changes for an event with no per-ticket field.

**Tech Stack:** Next.js 14 App Router, TypeScript, Supabase (Postgres), vitest, Tailwind.

---

## Decisions this plan assumes (confirm before Task 1)

1. **Order limit** — uses the existing per-tier `max_tickets_per_person` (enforced per order in the RPCs). The organiser raises it in the admin, e.g. to 5. No code.
2. **Per-ticket fields** — whatever the organiser flags. For The Beats Run: a new text field "Runner Name" plus the existing "Jersey Size". Default (contact) fields (`is_default = true`: name, phone, email) can never be per-ticket — they are the buyer's contact.
3. **Pre-registration links** — the window closed 9 Nov, so out of scope. The RPCs are not touched; a link order may carry several runners if the tier allows quantity > 1.
4. **Editing a runner after purchase** — out of scope for v1 (admin can see, not edit).
5. **"This is me" shortcut** — out of scope for v1 (YAGNI); every runner card is filled in.
6. **One event per order when runners are asked** — a cart mixing events where any of them has per-ticket fields is refused ("Buy tickets for one event at a time."). The storefront already sells one event per page.
7. **Ceiling** — at most 50 runners in one order regardless of settings (abuse guard; the real limit is the tier's max per person).

## Ground rules

- Branch every PR from `origin/dev` (`git fetch origin && git switch -c <branch> origin/dev`); PRs into `dev`; never merge your own.
- Run `git config user.email` before the first commit — must be `yehtutaung.yha@gmail.com`.
- Migration on the **dev DB only** (`fnfvwzwrdsnmwxunciti`). Production gets it by the owner, **before** the PR 1 code reaches `main` (the public routes select the new columns).
- Unit tests: `npm test -- <path>`. Lint in a worktree: `npx eslint --no-eslintrc -c .eslintrc.json src` (nested-worktree `next build` skips lint). Type check: `npx tsc --noEmit`. Judge by exit code.
- Three public pages render form fields: `/enroll/[slug]/checkout`, `/enroll/[slug]/interest`, `/enroll/form`. Every rendering change below says what happens on each.

## File map

| File | Status | Responsibility |
|---|---|---|
| `supabase/migrations/20261115120000_per_attendee_fields.sql` | create | `per_attendee` flag, `enrollments.attendees`, `tickets.attendee` |
| `supabase/rollbacks/20261115120000_per_attendee_fields.down.sql` | create | rollback |
| `src/lib/enrollment/attendees.ts` | create | slots, validation, ticket label, size totals (pure, shared) |
| `src/server/enrollment/attendeeContext.ts` | create | load per-ticket fields + pack sizes, build slots, validate a request |
| `src/app/api/public/enroll/route.ts` | modify | accept + validate `attendees`, pass to create* |
| `src/server/enrollment/createEnrollment.ts`, `createCartEnrollment.ts` | modify | write `attendees` in the post-RPC UPDATE |
| `src/app/api/public/enrollment/[ref]/route.ts` | modify | PATCH accepts `attendees`; GET returns ticket `seat_no`, `attendee` |
| `src/server/tickets/issueTickets.ts` | modify | copy the matching attendee onto each ticket row |
| `src/app/api/intakes/[id]/form-fields/route.ts`, `.../apply/route.ts`, `src/app/api/public/form-fields/route.ts` | modify | carry `per_attendee` |
| `src/app/admin/intakes/[id]/form/page.tsx` | modify | "Ask for each ticket" toggle |
| `src/components/enrollment/AttendeeSection.tsx` | create | runner cards UI |
| `src/app/(public)/enroll/form/page.tsx`, `src/app/(public)/enroll/[slug]/checkout/page.tsx` | modify | render runner cards, send `attendees` |
| `src/lib/tickets/ticketLayout.ts`, `render/types.ts`, `render/ticketPdf.ts`, `render/ticketPng.ts`, `src/server/tickets/eticketEmailAttachment.ts` | modify | "Runner: …" line on each e-ticket |
| `src/app/admin/students/page.tsx`, `src/server/tickets/qrExport.ts` | modify | runners in admin + exports |

PR split: **PR 1** = Tasks 1–6 (data + server, inert until a field is flagged). **PR 2** = Tasks 7–10 (editor toggle + buyer UI; flagging becomes possible here). **PR 3** = Tasks 11–13 (e-ticket line, admin, exports).

---

## PR 1 — data and server

### Task 1: Migration

**Files:**
- Create: `supabase/migrations/20261115120000_per_attendee_fields.sql`
- Create: `supabase/rollbacks/20261115120000_per_attendee_fields.down.sql`

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================================
-- Per-ticket form answers ("runner details")
--
-- intake_form_fields.per_attendee — the field is asked once per ticket, not
--   once per order. Never on a default (contact) field: those are the buyer.
-- enrollments.attendees — one entry per admission:
--   {"class_id": uuid, "seat_no": int, "answers": {field_key: text}, "label": text}
--   label is fixed at purchase, so editing the form later can't change a ticket.
--   keyed exactly like tickets (class_id, seat_no), seats 1..N per class.
-- tickets.attendee — copy of that entry's answers plus a display label,
--   written when the ticket is issued. NULL for tickets with no runner.
--
-- Additive. Existing rows get false / '[]' / NULL and behave as before.
-- DEPLOY ORDER: apply BEFORE the code that selects these columns.
-- Rollback: supabase/rollbacks/20261115120000_per_attendee_fields.down.sql
-- ============================================================================

BEGIN;

ALTER TABLE public.intake_form_fields
  ADD COLUMN IF NOT EXISTS per_attendee boolean NOT NULL DEFAULT false;

-- Constraints are dropped first so a re-run does not abort the transaction
-- (Postgres has no ADD CONSTRAINT IF NOT EXISTS).
ALTER TABLE public.intake_form_fields
  DROP CONSTRAINT IF EXISTS intake_form_fields_per_attendee_not_default;
ALTER TABLE public.intake_form_fields
  ADD CONSTRAINT intake_form_fields_per_attendee_not_default
  CHECK (NOT (per_attendee AND is_default));

-- Only types whose answer is one short string. A checkbox's "false" would
-- pass "required", and a file has no per-ticket upload path.
ALTER TABLE public.intake_form_fields
  DROP CONSTRAINT IF EXISTS intake_form_fields_per_attendee_type;
ALTER TABLE public.intake_form_fields
  ADD CONSTRAINT intake_form_fields_per_attendee_type
  CHECK (NOT per_attendee OR field_type IN ('text', 'select', 'radio', 'date', 'phone'));

ALTER TABLE public.enrollments
  ADD COLUMN IF NOT EXISTS attendees jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.enrollments
  DROP CONSTRAINT IF EXISTS enrollments_attendees_is_array;
ALTER TABLE public.enrollments
  ADD CONSTRAINT enrollments_attendees_is_array
  CHECK (jsonb_typeof(attendees) = 'array');

ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS attendee jsonb;

ALTER TABLE public.tickets
  DROP CONSTRAINT IF EXISTS tickets_attendee_is_object;
ALTER TABLE public.tickets
  ADD CONSTRAINT tickets_attendee_is_object
  CHECK (attendee IS NULL OR jsonb_typeof(attendee) = 'object');

COMMENT ON COLUMN public.intake_form_fields.per_attendee IS
  'Asked once per ticket (runner), not once per order.';
COMMENT ON COLUMN public.enrollments.attendees IS
  'Per-ticket answers: [{class_id, seat_no, answers}], seats 1..N per class like tickets.';
COMMENT ON COLUMN public.tickets.attendee IS
  'This ticket''s runner: {label, answers}. Copied from enrollments.attendees at issue.';

NOTIFY pgrst, 'reload schema';

COMMIT;
```

- [ ] **Step 2: Write the rollback**

```sql
BEGIN;
ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_attendee_is_object;
ALTER TABLE public.tickets DROP COLUMN IF EXISTS attendee;
ALTER TABLE public.enrollments DROP CONSTRAINT IF EXISTS enrollments_attendees_is_array;
ALTER TABLE public.enrollments DROP COLUMN IF EXISTS attendees;
ALTER TABLE public.intake_form_fields DROP CONSTRAINT IF EXISTS intake_form_fields_per_attendee_type;
ALTER TABLE public.intake_form_fields DROP CONSTRAINT IF EXISTS intake_form_fields_per_attendee_not_default;
ALTER TABLE public.intake_form_fields DROP COLUMN IF EXISTS per_attendee;
NOTIFY pgrst, 'reload schema';
COMMIT;
```

- [ ] **Step 3: Show the owner the migration, then apply to the dev DB** (Supabase MCP `apply_migration`, project `fnfvwzwrdsnmwxunciti`, name `per_attendee_fields`). Check the history version matches the filename `20261115120000`; fix by hand if the tool assigns its own (see memory `reference_migrations`).

- [ ] **Step 4: Verify**

```sql
select column_name, data_type, column_default from information_schema.columns
where table_schema='public' and (table_name, column_name) in
  (('intake_form_fields','per_attendee'),('enrollments','attendees'),('tickets','attendee'));
```
Expected: 3 rows.

- [ ] **Step 5: Commit** — `feat(db): per-ticket form answers (per_attendee, attendees, ticket attendee)`

### Task 2: Pure attendee module

**Files:**
- Create: `src/lib/enrollment/attendees.ts`
- Test: `src/__tests__/lib/attendees.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import {
  attendeeSlots,
  validateAttendees,
  attendeeLabel,
  attendeeTotals,
  MAX_ATTENDEES,
  type AttendeeField,
} from "@/lib/enrollment/attendees";

const NAME: AttendeeField = { field_key: "runner_name", field_label: "Runner Name", field_type: "text", is_required: true, options: null };
const SIZE: AttendeeField = { field_key: "jersey", field_label: "Jersey Size", field_type: "select", is_required: true, options: ["Kids 8", "S", "M"] };
const FIELDS = [NAME, SIZE];
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

describe("attendeeSlots", () => {
  it("numbers seats 1..N per class, summing duplicate lines, in first-seen order", () => {
    expect(attendeeSlots([{ class_id: A, admissions: 1 }, { class_id: B, admissions: 1 }, { class_id: A, admissions: 1 }]))
      .toEqual([{ class_id: A, seat_no: 1 }, { class_id: A, seat_no: 2 }, { class_id: B, seat_no: 1 }]);
  });
});

describe("validateAttendees", () => {
  const slots = [{ class_id: A, seat_no: 1 }, { class_id: B, seat_no: 1 }];
  const good = [
    { class_id: A, seat_no: 1, answers: { runner_name: " Ko Aung ", jersey: "M" } },
    { class_id: B, seat_no: 1, answers: { runner_name: "Ma Su", jersey: "Kids 8" } },
  ];

  it("accepts one entry per slot, trims answers and fixes each runner's label", () => {
    const r = validateAttendees(good, slots, FIELDS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.attendees[0].answers.runner_name).toBe("Ko Aung");
      expect(r.attendees[1].label).toBe("Ma Su · Kids 8");
    }
  });

  it("returns an empty list when there are no per-ticket fields, whatever was sent", () => {
    expect(validateAttendees(good, slots, [])).toEqual({ ok: true, attendees: [] });
  });

  it("rejects a missing runner", () => {
    expect(validateAttendees(good.slice(0, 1), slots, FIELDS).ok).toBe(false);
  });

  it("rejects an entry for a seat that does not exist", () => {
    const bad = [good[0], { ...good[1], seat_no: 2 }];
    expect(validateAttendees(bad, slots, FIELDS).ok).toBe(false);
  });

  it("rejects a required answer left empty", () => {
    const bad = [good[0], { ...good[1], answers: { runner_name: "  ", jersey: "S" } }];
    const r = validateAttendees(bad, slots, FIELDS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/Runner 2/);
  });

  it("rejects a size that is not one of the options", () => {
    const bad = [good[0], { ...good[1], answers: { runner_name: "Ma Su", jersey: "XXXL" } }];
    expect(validateAttendees(bad, slots, FIELDS).ok).toBe(false);
  });

  it("drops keys that are not per-ticket fields", () => {
    const extra = [{ ...good[0], answers: { ...good[0].answers, email: "x@y.z" } }, good[1]];
    const r = validateAttendees(extra, slots, FIELDS);
    expect(r.ok).toBe(true);
    if (r.ok) expect("email" in r.attendees[0].answers).toBe(false);
  });

  it("rejects a non-array and over-long answers", () => {
    expect(validateAttendees("nope", slots, FIELDS).ok).toBe(false);
    const long = [{ ...good[0], answers: { runner_name: "x".repeat(201), jersey: "M" } }, good[1]];
    expect(validateAttendees(long, slots, FIELDS).ok).toBe(false);
  });
});

describe("attendeeLabel", () => {
  it("joins answers in field order", () => {
    expect(attendeeLabel({ runner_name: "Ma Su", jersey: "Kids 8" }, FIELDS)).toBe("Ma Su · Kids 8");
  });
  it("skips empty optional answers", () => {
    expect(attendeeLabel({ runner_name: "Ma Su" }, FIELDS)).toBe("Ma Su");
  });
});

describe("attendeeTotals", () => {
  it("counts each option of a choice field", () => {
    const list = [{ answers: { jersey: "M" } }, { answers: { jersey: "M" } }, { answers: { jersey: "S" } }];
    expect(attendeeTotals(list, SIZE)).toEqual([{ value: "S", count: 1 }, { value: "M", count: 2 }]);
  });
  it("puts values no longer in the option list last", () => {
    const list = [{ answers: { jersey: "XS" } }, { answers: { jersey: "M" } }];
    expect(attendeeTotals(list, SIZE).map((t) => t.value)).toEqual(["M", "XS"]);
  });
});

describe("attendeeSlots limit", () => {
  it("refuses an order with more admissions than MAX_ATTENDEES", () => {
    expect(() => attendeeSlots([{ class_id: A, admissions: MAX_ATTENDEES + 1 }])).toThrow(/too many/i);
  });
});
```

- [ ] **Step 2: Run to see it fail** — `npm test -- src/__tests__/lib/attendees.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// ─── Per-ticket form answers ("runner details") ─────────────────────────────
//
// An organiser can mark a form field "Ask for each ticket". Its answers are
// stored per admission in enrollments.attendees, keyed by (class_id, seat_no)
// — the same key issueTicketsForEnrollment numbers tickets by: seats 1..N per
// class, duplicate lines for one class summed. Keep attendeeSlots and that
// function in step, or a runner lands on the wrong ticket.
//
// Pure: used by the browser (to draw and check the cards) and by both server
// write paths (POST /api/public/enroll, PATCH /api/public/enrollment/[ref]).

export interface AttendeeField {
  field_key: string;
  field_label: string;
  field_type: string;
  is_required: boolean;
  options: unknown;
}

export interface AttendeeSlot {
  class_id: string;
  seat_no: number;
}

export interface Attendee extends AttendeeSlot {
  answers: Record<string, string>;
  /** Fixed at purchase; printed on the ticket. */
  label: string;
}

export const ANSWER_MAX = 200;
/**
 * Hard ceiling on runners per order, checked BEFORE any loop. The quantity
 * comes from the request and max_tickets_per_person is only checked later,
 * inside the RPC, so without this a forged quantity sizes the loop.
 */
export const MAX_ATTENDEES = 50;
const CHOICE_TYPES = new Set(["select", "radio"]);

/** Slots for an order: one per admission (quantity × pack_size), seats 1..N per class. */
export function attendeeSlots(lines: { class_id: string; admissions: number }[]): AttendeeSlot[] {
  const total = lines.reduce((sum, l) => sum + l.admissions, 0);
  if (!Number.isFinite(total) || total > MAX_ATTENDEES) {
    throw new Error("Too many tickets in one order.");
  }
  const byClass = new Map<string, number>();
  for (const l of lines) byClass.set(l.class_id, (byClass.get(l.class_id) ?? 0) + l.admissions);
  const slots: AttendeeSlot[] = [];
  for (const [class_id, n] of Array.from(byClass.entries())) {
    for (let seat_no = 1; seat_no <= n; seat_no++) slots.push({ class_id, seat_no });
  }
  return slots;
}

export type AttendeeResult = { ok: true; attendees: Attendee[] } | { ok: false; message: string };

/**
 * Checks the runners sent with an order. With no per-ticket fields the order
 * has no runners and anything sent is ignored, so events that never use this
 * behave exactly as before.
 */
export function validateAttendees(raw: unknown, slots: AttendeeSlot[], fields: AttendeeField[]): AttendeeResult {
  if (fields.length === 0) return { ok: true, attendees: [] };
  // Also what a buyer sees whose page was opened before the organiser flagged
  // a field, so tell them how to recover.
  if (!Array.isArray(raw)) return { ok: false, message: "Runner details are missing. Reload the page and try again." };

  const sent = new Map<string, Record<string, unknown>>();
  for (const e of raw) {
    if (!e || typeof e !== "object") return { ok: false, message: "Runner details are invalid." };
    const { class_id, seat_no, answers } = e as Record<string, unknown>;
    if (typeof class_id !== "string" || !Number.isInteger(seat_no)) {
      return { ok: false, message: "Runner details are invalid." };
    }
    sent.set(`${class_id}:${seat_no}`, answers && typeof answers === "object" ? (answers as Record<string, unknown>) : {});
  }
  if (sent.size !== slots.length) return { ok: false, message: "Every ticket needs its runner's details." };

  const attendees: Attendee[] = [];
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const given = sent.get(`${slot.class_id}:${slot.seat_no}`);
    if (!given) return { ok: false, message: "Every ticket needs its runner's details." };
    const answers: Record<string, string> = {};
    for (const f of fields) {
      const v = typeof given[f.field_key] === "string" ? (given[f.field_key] as string).trim() : "";
      if (v.length > ANSWER_MAX) return { ok: false, message: `Runner ${i + 1}: ${f.field_label} is too long.` };
      if (!v) {
        if (f.is_required) return { ok: false, message: `Runner ${i + 1}: ${f.field_label} is required.` };
        continue;
      }
      if (CHOICE_TYPES.has(f.field_type) && Array.isArray(f.options) && !f.options.includes(v)) {
        return { ok: false, message: `Runner ${i + 1}: choose a ${f.field_label} from the list.` };
      }
      answers[f.field_key] = v;
    }
    attendees.push({ ...slot, answers, label: attendeeLabel(answers, fields) });
  }
  return { ok: true, attendees };
}

/** "Ma Su · Kids 8" — the line printed on the e-ticket. */
export function attendeeLabel(answers: Record<string, string>, fields: AttendeeField[]): string {
  return fields.map((f) => answers[f.field_key]).filter((v) => v && v.trim()).join(" · ");
}

/** Counts per option of a choice field, in the organiser's option order. */
export function attendeeTotals(
  list: { answers: Record<string, string> }[],
  field: AttendeeField,
): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const a of list) {
    const v = a.answers[field.field_key];
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const order = Array.isArray(field.options) ? (field.options as string[]) : [];
  // A value the organiser has since removed from the list sorts last.
  const rank = (v: string) => (order.indexOf(v) === -1 ? Infinity : order.indexOf(v));
  return Array.from(counts.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((x, y) => (rank(x.value) === rank(y.value) ? 0 : rank(x.value) < rank(y.value) ? -1 : 1));
}
```

- [ ] **Step 4: Run** — same command → PASS (all tests).
- [ ] **Step 5: Commit** — `feat(enroll): per-ticket answer slots, validation and label`

### Task 3: Server context loader

**Files:**
- Create: `src/server/enrollment/attendeeContext.ts`
- Test: `src/__tests__/enrollment/attendeeContext.test.ts`

Responsibility: given order lines `{class_id, quantity}[]` (from the request, or from a stored order), load the classes (`id, intake_id, pack_size`), then the `per_attendee` fields of their event(s) (`field_key, field_label, field_type, is_required, options`, ordered by `sort_order, field_key`), and return `{ fields, slots }`. Export:

```ts
export async function loadAttendeeContext(
  supabase: { from: (t: string) => any },
  lines: { class_id: string; quantity: unknown }[],
): Promise<{ fields: AttendeeField[]; slots: AttendeeSlot[] } | { error: string }>;

export async function checkAttendees(
  supabase: { from: (t: string) => any },
  lines: { class_id: string; quantity: unknown }[],
  raw: unknown,
): Promise<AttendeeResult>; // loadAttendeeContext + validateAttendees
```

Rules (each one is a test):
- Normalise each quantity exactly like `createEnrollment.ts:56` does (`Math.floor`, minimum 1, non-numbers → 1), so the slots match what the RPC books.
- Every `class_id` must be a UUID (reuse the check `createEnrollment.ts:49` uses) — otherwise `{ ok:false, message }`, no query.
- The fields are looked up for the classes' **own** events, never guessed from the first item. If the lines span more than one event **and** any of those events has per-ticket fields → `{ ok:false, message: "Buy tickets for one event at a time." }`.
- `admissions = quantity × (pack_size ?? 1)`; `attendeeSlots` throws above `MAX_ATTENDEES` → return `{ ok:false, message: "Too many tickets in one order." }` (never loop on an unchecked number).
- No per-ticket fields → `{ ok:true, attendees:[] }`.
- Query errors throw; callers turn them into a JSON 500.

- [ ] **Step 1:** Write tests with a mocked `from()` (copy the chain-mock style in `src/__tests__/enrollment/createCartEnrollment.test.ts`), one per rule above, plus: a pack tier with `pack_size 2`, quantity 1 → 2 slots; `quantity: 1e9` → refused without building slots; `quantity: 0` → 1 slot.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** — `feat(enroll): load per-ticket fields and slots for an order`

### Task 4: POST /api/public/enroll accepts `attendees`

**Files:**
- Modify: `src/app/api/public/enroll/route.ts` (body destructure at :29, before `createCartEnrollment` :74 and `createEnrollment` :142)
- Modify: `src/server/enrollment/createEnrollment.ts` (:82-100), `src/server/enrollment/createCartEnrollment.ts` (:113-136)
- Test: `src/__tests__/enrollment/enroll.test.ts`

**Two callers of this route, and they differ:**
- `/enroll/form` sends `form_data` with the order → it must also send `attendees`.
- The trusted-official template (`src/lib/enrollment/trustedOfficialCheckout.ts:150-173`) creates a **draft** order with `items` only — no `form_data`, no `attendees` — and the checkout page sends the details later by PATCH (Task 5). That POST must keep working.

So the rule is: **if the body has neither `form_data` nor `attendees`, skip the runner check** (draft; Task 5 enforces it). Otherwise run it.

- [ ] **Step 1: Failing tests** in `enroll.test.ts` (existing mock pattern; expect to extend `mockFrom` at :8 for the extra classes/fields queries):
  - flagged event, `form_data` sent, `attendees` missing → **400** `code: "ATTENDEES_INVALID"`, message mentions reloading, RPC **not** called;
  - flagged event, trusted-official draft (`items` only) → RPC called, no 400;
  - valid `attendees` → RPC called once, the enrollment UPDATE contains `attendees` with labels;
  - `quantity: 1e9` with `attendees` → 400 without building slots;
  - non-UUID `class_id` → the existing 400 path, never a bare 500;
  - the classes/fields lookup throws → JSON 500 `{ error: "Internal Server Error" }`;
  - the UPDATE returns an error → logged and the route still returns the order (same as form_data today) **and** the test asserts the error is not silently swallowed (logged with the enrollment id, no body values);
  - no per-attendee fields → existing tests stay green; UPDATE has no `attendees` key.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.**
  - Read `attendees` from the body. Lines: cart `items.map(i => ({class_id: i.class_id, quantity: i.quantity}))`, single `[{class_id, quantity}]`.
  - Unless it's a draft (rule above): `const check = await checkAttendees(supabase, lines, attendees)` inside `try/catch` (catch → JSON 500). On `!check.ok` → `NextResponse.json({ error: "Bad Request", message: check.message, code: "ATTENDEES_INVALID" }, { status: 400 })` **before** the RPC, so no seat is held.
  - Pass `check.attendees` into `createEnrollment` / `createCartEnrollment` as a new optional arg `attendees?: Attendee[]`.
  - **Replays.** There is no replay guard today: both create* rerun the form_data UPDATE on every success (`createEnrollment.ts:80-103`, `createCartEnrollment.ts:111-133`), and the cart RPC returns the existing order whatever lines a retry sent (`20261022130000_cart_idempotency.sql:89-123`). So after the RPC, before writing `attendees`: rebuild the slots from the order the RPC **returned** (its items/quantity, via `loadAttendeeContext`) and write `attendees` only if those slots equal the validated attendees' `(class_id, seat_no)` keys **and** the order's status is `pending_payment`. Otherwise leave the stored runners alone.
  - Write the UPDATE when `fd || attendees?.length` (today it sits inside `if (fd)`), and check its `error` (today ignored): log `[enroll] form/attendee update failed` with the enrollment id only.
- [ ] **Step 4:** Run `npm test -- src/__tests__/enrollment` → PASS.
- [ ] **Step 5: Commit** — `feat(enroll): validate and save runner details with an order`

### Task 5: PATCH /api/public/enrollment/[ref] accepts `attendees`

**Files:**
- Modify: `src/app/api/public/enrollment/[ref]/route.ts` (PATCH at :328)
- Test: `src/__tests__/api/public/enrollment-ref.test.ts`

This is the trusted-official checkout's write path (`/enroll/[slug]/checkout`): the order already exists (pending_payment) and the page PATCHes `form_data`.

- [ ] **Step 1: Failing tests:** with per-attendee fields, PATCH without `attendees` → 400 `ATTENDEES_INVALID` and `form_data` is **not** written; with valid `attendees` → the update writes both `form_data` and `attendees`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** Lines come from the order itself: `enrollment_items (class_id, quantity)` for cart orders, else `enrollments.class_id / quantity` (same source `issueTicketsForEnrollment` uses). Validate with `checkAttendees(supabase, lines, body.attendees)` (try/catch → JSON 500) before the update; include `attendees` in the same UPDATE as `form_data`. Keep the pending_payment-only guard.
- Also in this task: the **GET** handler's items (`[ref]/route.ts:102-116`, both the cart and single branches) gain `class_id` — the checkout page needs it to key runners (Task 10). `pack_size` is already returned.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** — `feat(enroll): runner details on the checkout page's order update`

### Task 6: Tickets carry their runner

**Files:**
- Modify: `src/server/tickets/issueTickets.ts` (load enrollment ~:22-140; row build :203-215)
- Test: `src/__tests__/tickets/issueTickets.test.ts`

- [ ] **Step 1: Failing tests:**
  - an enrollment with `attendees` `[{class_id:A, seat_no:1, answers:{...}, label:"Ko Aung · M"}, {class_id:A, seat_no:2, ...}]` → the upserted rows carry `attendee: { label: "Ko Aung · M", answers: {...} }` on seat 1 and the second runner on seat 2;
  - `attendees: []` → every row has `attendee: null` — otherwise unchanged output.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.**
  - Add `attendees` to the enrollment select.
  - `const byKey = new Map(attendees.map(a => [`${a.class_id}:${a.seat_no}`, a]))`; in the seat loop add `attendee: a ? { label: a.label, answers: a.answers } : null`. Use the stored label — never rebuild it from today's form fields (an organiser editing the form must not change issued tickets). No extra query.
  - Do not change seat numbering or the invariants. `ignoreDuplicates` stays — an already-issued ticket is not rewritten (acceptable: runners are fixed at purchase in v1).
- [ ] **Step 4:** `npm test -- src/__tests__/tickets` → PASS. Then `npx tsc --noEmit` and lint → exit 0.
- [ ] **Step 5: Commit** — `feat(tickets): copy each runner onto their ticket`
- [ ] **Step 6: Open PR 1** into `dev`: title `feat: per-ticket runner details — data and server (1/3)`. Body must state, as a **hard gate**: this code selects `enrollments.attendees` and `tickets`/`intake_form_fields` columns on every order and every ticket issue, so on a database without the migration **every order returns 500 and paid orders get no tickets**. The migration must be on production before this reaches `main`. Staging reads the dev DB, so staging cannot catch a missing production migration. Behaviour is otherwise unchanged until a field is flagged (the flag can't be set until PR 2). Trigger `@codex review`.

---

## PR 2 — organiser toggle and buyer UI

### Task 7: `per_attendee` through the field APIs

**Files:**
- Modify: `src/app/api/intakes/[id]/form-fields/route.ts` (interface :12-23, POST :96/:116, PATCH :158/:179)
- Modify: `src/app/api/intakes/[id]/form-fields/apply/route.ts` (select :65, insert map :99-108)
- Modify: `src/app/api/public/form-fields/route.ts` (select :36, type :42-51)
- Test: the existing tests for these routes (`grep -rl "form-fields" src/__tests__`)

- [ ] **Step 1: Failing tests:** POST/PATCH store `per_attendee`; PATCH with `per_attendee: true` on a default field → 400 "Contact fields are asked once per order."; on a `file` or `checkbox` field → 400 "This kind of field can't be asked per ticket." (allowed: text, select, radio, date, phone — matches the DB CHECK); apply copies the flag; public GET returns it.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement, mirroring every `is_required` touchpoint (default `false`). The DB CHECK is the backstop; the route returns the friendly 400 first.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** — `feat(form-editor): per_attendee flag on form fields`

### Task 8: "Ask for each ticket" toggle in the form editor

**Files:**
- Modify: `src/app/admin/intakes/[id]/form/page.tsx` (type :37, toggle UI :208-215, save loop :670-700)

- [ ] **Step 1:** Add `per_attendee: boolean` to the field type; render a second toggle next to Required, label "Ask for each ticket", helper text "Each ticket in the order answers this (for example runner name or T-shirt size).". Hidden for `is_default` fields and for types other than text, select, radio, date, phone. Send `per_attendee` in both the POST and PATCH of the save loop.
- [ ] **Step 2:** Run the dev server (`preview_start`), open an event's form editor on the dev tenant, toggle the flag on a non-default field, save, reload → flag persists; default fields show no toggle.
- [ ] **Step 3: Commit** — `feat(form-editor): ask a field once per ticket`

### Task 9: `AttendeeSection` component

**Files:**
- Create: `src/components/enrollment/AttendeeSection.tsx`

Props:

```ts
{
  slots: { class_id: string; seat_no: number; tierLabel: string }[];
  fields: (AttendeeField & { size_chart_url?: string; size_note?: string })[];
  value: Record<string, Record<string, string>>;        // key `${class_id}:${seat_no}` → answers
  onChange: (key: string, fieldKey: string, v: string) => void;
  errors: Record<string, string>;                         // key → message
  renderField: (field, value, onChange, error) => React.ReactNode; // each page's own DynamicField look
}
```

Layout (matches the approved mockup):
- Heading "Runner details" with "X of N done".
- One card per slot: "Runner {i} · {tierLabel}". A finished card that is not focused collapses to one line `attendeeLabel(...)` with a check and an "Edit" button; the first unfinished card is open.
- Fields render through `renderField`, so a size field uses `SizePicker` exactly like today (SizePicker's radio `name` must be unique per card: pass `${field_key}__${i}`).
- When there is exactly one slot, render no card chrome — the fields look like today's single form.

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** `npx tsc --noEmit` → exit 0.
- [ ] **Step 3: Commit** — `feat(enroll): runner cards for per-ticket questions`

### Task 10: Wire the two ordering pages

**Files:**
- Modify: `src/app/(public)/enroll/form/page.tsx` (fields fetch :560, `DynamicField` :225 rendered :857, `validateStep1` :581-616, `handleSubmit` :634-688, admissions :502)
- Modify: `src/app/(public)/enroll/[slug]/checkout/page.tsx` (`DynamicField` :40 rendered :443, submit :333-337)
- Interest page `src/app/(public)/enroll/[slug]/interest/page.tsx`: **no change** — a sign-up is one person, so a per-ticket field shows as an ordinary field there. Note this in the PR.

For each ordering page:
- [ ] **Step 1:** Split fields: `orderFields = fields.filter(f => !f.per_attendee)`, `runnerFields = fields.filter(f => f.per_attendee)`. Order-level loop renders `orderFields` only.
- [ ] **Step 2:** Build slots with `attendeeSlots(lines.map(l => ({ class_id, admissions: quantity × pack_size })))` — `/enroll/form` already has both (single `class_id`+`quantity`, or the sessionStorage cart); the checkout page has `items` (`class_id` added in Task 5, plus quantity and `pack_size`) from `GET /api/public/enrollment/[ref]` — add `class_id` and `pack_size` to the page's item type (`checkout/page.tsx:17`). Attach each slot's tier label. Building slots on the client uses the same `attendeeSlots`, so the keys match the server's.
- [ ] **Step 3:** Render `<AttendeeSection>` under the order fields when `runnerFields.length > 0`, passing the page's own `DynamicField` as `renderField`.
- [ ] **Step 4:** Validation: run `validateAttendees(toArray(value), slots, runnerFields)` in `validateStep1` (form page) / before submit (checkout page); show the message on the matching card and scroll to it.
- [ ] **Step 5:** Submit: add `attendees: toArray(value)` to the POST body (form page) / PATCH body (checkout page). Handle a 400 `ATTENDEES_INVALID` by showing `message`.
- [ ] **Step 6:** Review step on `/enroll/form` (if it has one; otherwise above the pay button): "Jerseys in this order" — `attendeeTotals` for each choice-type runner field.
- [ ] **Step 7: Verify in the browser** on the dev server, on a dev-DB event set up for it (show the owner the SQL before changing dev data: flag Jersey Size per-ticket, add a "Runner Name" text field per-ticket, set `max_tickets_per_person` 3 on a tier):
  - qty 1 → looks like today (no cards);
  - qty 3 across two tiers → 3 cards, seats numbered per tier, can't continue with a missing size, review shows the totals;
  - submit → order's `attendees` in the dev DB has 3 entries keyed like the slots;
  - mark it paid on dev (existing admin verify) → 3 tickets, each `attendee.label` matches its runner;
  - phone width (375px), no console errors. Repeat on the checkout page flow.
- [ ] **Step 8:** Unit tests + tsc + lint → exit 0. **Commit** — `feat(enroll): ask each runner's details when buying several tickets`
- [ ] **Step 9: Open PR 2** into `dev`; `@codex review`.

---

## PR 3 — e-ticket, admin, exports

### Task 11: "Runner: …" on the e-ticket

**Files:**
- Modify: `src/lib/tickets/ticketLayout.ts` (`TICKET_ROWS` :112-123), `src/lib/tickets/render/types.ts` (:13), `src/lib/tickets/render/ticketPdf.ts` (:229-233), `src/lib/tickets/render/ticketPng.ts` (:175)
- Modify: `src/app/api/public/enrollment/[ref]/route.ts` GET tickets (:209-250): select `seat_no, attendee`, order by `class_id, seat_no`
- Modify: `src/server/tickets/eticketEmailAttachment.ts` (select :33)
- Modify: both pages that render tickets from that GET — `src/app/(public)/enroll/payment/[ref]/page.tsx` and `src/app/(public)/enroll/[slug]/checkout/success/page.tsx` (:91, :138) — map `attendee?.label` → `holder`
- Test: `src/__tests__/enrollment/ticketCardGeometry.test.ts`, `src/__tests__/enrollment/ticketHeaderLayout.test.ts`, plus a new render test asserting the text is drawn
- Not in scope: the scanner response (`src/app/api/scans/route.ts`) shows no runner in v1 — say so in the PR.

- [ ] **Step 1:** Failing test: `TicketData` with `holder: "Ma Su · Kids 8"` draws "Runner: Ma Su · Kids 8"; without `holder` nothing extra is drawn and the geometry tests' expectations are unchanged.
- [ ] **Step 2:** Add `holder?: string` to `TicketData`; a `holder` row in `TICKET_ROWS` placed so existing rows do not move when it is absent (draw it only if set); map `ticket.attendee?.label` → `holder` in both the order page path and the email PDF path. Truncate to fit the card width.
- [ ] **Step 3:** Tests → PASS; download a PDF and a PNG from the dev order in Task 10 and look at them.
- [ ] **Step 4: Commit** — `feat(tickets): print the runner on each e-ticket`

### Task 12: Runners in the admin

**Files:**
- Modify: `src/app/api/admin/students/[id]/route.ts` (:141 — also return `attendees`), `src/app/api/admin/students/route.ts` (list select :77-98 — the XLSX export reads this route at `page.tsx:964`: add `attendees` and `enrollment_items.class_id`), `src/app/admin/students/page.tsx` (detail :325, export :948-1069)

- [ ] **Step 1:** Detail panel: a "Runners" list — "Runner {i} · {tier} — {label}" — when `attendees` is non-empty.
- [ ] **Step 2:** XLSX export: keep the existing sheet unchanged; add sheet "Runners" (one row per runner: `Ref, Tier, Runner #, <each per-ticket field label>, Status`) and sheet "Sizes" (`attendeeTotals` per choice-type per-ticket field, confirmed orders only). **Orders sold before the flag was turned on** have empty `attendees` and their one answer in `form_data[field_key]` — count those too (one per order), or The Beats Run's totals miss every earlier buyer. Add a unit test for that mix. Only add the sheets when the event has a per-ticket field.
- [ ] **Step 3:** Verify on dev with the Task 10 order; open the file.
- [ ] **Step 4: Commit** — `feat(admin): runners and size totals in the student view and export`

### Task 13: Runner in the QR CSV

**Files:**
- Modify: `src/server/tickets/qrExport.ts` (header :55-56), test `src/__tests__/tickets/qrExport.test.ts`

- [ ] **Step 1:** Failing test: a ticket with `attendee.label` exports it in a new **last** column `runner` (appended so existing consumers' column positions don't move), passed through `asText` (formula-injection guard); no attendee → empty.
- [ ] **Step 2:** Implement: add `attendee` to qrExport's tickets select as well as the header → PASS.
- [ ] **Step 3: Commit** — `feat(tickets): runner column in the QR export`
- [ ] **Step 4: Open PR 3** into `dev`; `@codex review`.

---

## Release (owner, after all three PRs are on `dev` and checked on staging)

1. **Required, before PR 1 reaches `main`:** apply `20261115120000_per_attendee_fields.sql` on production (owner runs it; Claude never touches production).
2. Promote dev → staging → main as usual.
3. **Required, BeatsRun production admin, after the code is live:** add a text field "Runner Name" with "Ask for each ticket" on; turn "Ask for each ticket" on for Jersey Size; raise Max per person on the Early Bird tiers (e.g. 5).
4. Buy a 2-runner test order on production, check both e-tickets, then archive it as a test.

## Out of scope (v1)

- Editing a runner after purchase; transferring a ticket.
- "This is me" auto-fill of runner 1.
- Server-side validation of order-level `form_data` (doesn't exist today; unchanged).
- Interest (pre-registration) page per-ticket behaviour.
