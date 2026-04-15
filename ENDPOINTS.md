# KuuNyi Admin API — Endpoint Reference

## Agent Configuration

Configure these three variables in the agent service:

```
API_BASE_URL  = <see table below>
TENANT_SLUG   = <school subdomain, e.g. nihon-moment>
AGENT_SECRET  = <shared secret — must match AGENT_SECRET on the Next.js server>
```

Each tool constructs the full URL as:
```
{API_BASE_URL}/api/admin/stats?tenant={TENANT_SLUG}
{API_BASE_URL}/api/admin/payments/pending?tenant={TENANT_SLUG}
{API_BASE_URL}/api/intakes?tenant={TENANT_SLUG}
```

And passes these headers on every request:
```
x-agent-secret: {AGENT_SECRET}
x-tenant-slug:  {TENANT_SLUG}
```

### API_BASE_URL by environment

| Environment | API_BASE_URL |
|-------------|-------------|
| Production  | `https://nihon-moment.kuunyi.com` |
| Staging     | `https://nihon-moment.edu-enroll-git-staging-yehtutaungs-projects.vercel.app` |
| Dev (local) | `http://localhost:3005` |

> **Note:** On production and staging the tenant is inferred from the subdomain, so `?tenant=` is not strictly required. On dev (localhost) there is no subdomain, so `?tenant={TENANT_SLUG}` **must** be appended to every request.

All admin endpoints require authentication. Public endpoints are listed separately at the bottom.

---

---

## Stats & Analytics

### `GET /api/admin/stats`
Dashboard statistics snapshot.

**Response**
```json
{
  "total_enrollments": 120,
  "confirmed_count": 85,
  "pending_payment_count": 10,
  "payment_submitted_count": 8,
  "total_revenue_mmk": 25500000,
  "seats_by_class": [
    { "level": "N5", "seat_remaining": 12, "seat_total": 30 },
    { "level": "N4", "seat_remaining": 5,  "seat_total": 30 }
  ]
}
```

---

### `GET /api/admin/analytics`
Enrollment and revenue time-series data.

**Query params**

| Param | Values | Default |
|-------|--------|---------|
| `range` | `30d` \| `90d` \| `intake` \| `all` | `30d` |

**Response** — enrollment counts by date, class fill rates, payment amounts over time.

---

## Enrollments / Students

### `GET /api/admin/students`
Paginated student list with optional filters.

**Query params**

| Param | Type | Description |
|-------|------|-------------|
| `intake_id` | UUID | Filter by intake |
| `class_level` | `N5` \| `N4` \| `N3` \| `N2` \| `N1` | Filter by class level |
| `status` | see below | Filter by enrollment status |
| `search` | string | Partial match on student name or phone |
| `telegram` | `linked` \| `not_linked` | Filter by Telegram link status |
| `channel` | channel UUID \| `none` | Filter by Telegram channel |
| `page` | integer | 1-based page number (default `1`) |
| `page_size` | integer | Rows per page (default `20`, max `100`) |

**Enrollment status values:** `pending_payment` · `payment_submitted` · `partial_payment` · `confirmed` · `rejected`

**Response**
```json
{
  "data": [
    {
      "enrollment_id": "uuid",
      "enrollment_ref": "NM-2026-00042",
      "student_name_en": "Mg Mg",
      "student_name_mm": "မောင်မောင်",
      "phone": "09-xxx-xxx-xxxx",
      "status": "confirmed",
      "enrolled_at": "2026-04-01T10:00:00Z",
      "class_level": "N4",
      "intake_name": "April 2026 Intake",
      "fee_mmk": 350000,
      "quantity": 1,
      "telegram_linked": true
    }
  ],
  "total": 120,
  "page": 1,
  "page_size": 20
}
```

---

### `GET /api/admin/students/[id]`
Full detail for a single enrollment. `[id]` is the enrollment UUID.

**Response**
```json
{
  "enrollment_id": "uuid",
  "enrollment_ref": "NM-2026-00042",
  "student_name_en": "Mg Mg",
  "student_name_mm": "မောင်မောင်",
  "nrc_number": "12/MAMANA(N)123456",
  "phone": "09-xxx-xxx-xxxx",
  "email": "student@example.com",
  "form_data": { "emergency_contact": "..." },
  "form_fields": [{ "field_key": "...", "field_label": "...", "field_type": "..." }],
  "status": "payment_submitted",
  "enrolled_at": "2026-04-01T10:00:00Z",
  "class_level": "N4",
  "intake_name": "April 2026 Intake",
  "fee_mmk": 350000,
  "payment": {
    "id": "uuid",
    "status": "pending",
    "amount_mmk": 350000,
    "bank_reference": "TXN123",
    "payer_institution": "KBZ",
    "submitted_at": "2026-04-02T08:00:00Z",
    "verified_at": null,
    "proof_signed_url": "https://..."
  }
}
```

---

## Payments

### `GET /api/admin/payments/pending`
All enrollments with status `payment_submitted`, oldest first. Includes signed proof image URLs (valid 1 hour).

**Response** — array of:
```json
{
  "enrollment": { "...enrollment fields..." },
  "payment": { "id": "uuid", "status": "pending", "amount_mmk": 350000, "..." },
  "class_level": "N4",
  "intake_id": "uuid",
  "intake_name": "April 2026 Intake",
  "proof_signed_url": "https://...",
  "proof_signed_urls": ["https://..."],
  "items": null,
  "total_fee_mmk": 350000
}
```

---

### `PATCH /api/admin/payments/[id]/verify`
Approve, reject, or flag a partial payment. `[id]` is the **payment UUID**.

Triggers email + Telegram + Messenger notifications to the student automatically.

**Body**
```json
{
  "action": "approve" | "reject" | "request_remaining",
  "rejection_reason": "string (optional, for reject)",
  "admin_note": "string (required for request_remaining)",
  "received_amount": 200000
}
```

**action values**

| Value | Effect |
|-------|--------|
| `approve` | Sets payment → `verified`, enrollment → `confirmed`. Sends approval notification + Telegram channel invite if eligible. |
| `reject` | Sets payment → `rejected`, enrollment → `rejected`. Restores seats. Sends rejection notification. |
| `request_remaining` | Sets enrollment → `partial_payment`. Sends partial payment notification with remaining amount. |

**Response**
```json
{
  "enrollment": { "...updated enrollment..." },
  "payment": { "...updated payment..." }
}
```

---

## Intakes

### `GET /api/intakes`
List all intakes for the tenant, newest year first.

**Response** — array of intake objects:
```json
[
  {
    "id": "uuid",
    "tenant_id": "uuid",
    "name": "April 2026 Intake",
    "year": 2026,
    "status": "open",
    "created_at": "2026-01-01T00:00:00Z"
  }
]
```

---

### `POST /api/intakes`
Create a new intake. **Owner only.**

**Body**
```json
{
  "name": "July 2026 Intake",
  "year": 2026,
  "status": "draft"
}
```

`status` defaults to `draft`. Valid values: `draft` · `open` · `closed`

---

### `GET /api/intakes/[id]`
Fetch a single intake.

---

### `PATCH /api/intakes/[id]`
Update an intake. **Owner only.** All fields optional.

**Body**
```json
{
  "name": "July 2026 Intake",
  "year": 2026,
  "status": "open"
}
```

**status values:** `draft` · `open` · `closed`

> **Agent usage:** To open or close an intake — call `GET /api/intakes` to find the intake ID by name, then `PATCH /api/intakes/[id]` with `{ "status": "open" }` or `{ "status": "closed" }`.

---

## Classes

### `GET /api/intakes/[id]/classes`
List all classes for an intake, sorted N5 → N1.

**Response** — array of class objects:
```json
[
  {
    "id": "uuid",
    "intake_id": "uuid",
    "level": "N4",
    "fee_mmk": 350000,
    "seat_total": 30,
    "seat_remaining": 12,
    "status": "open",
    "mode": "offline",
    "enrollment_open_at": "2026-03-01T00:00:00Z",
    "enrollment_close_at": "2026-04-15T00:00:00Z"
  }
]
```

---

### `POST /api/intakes/[id]/classes`
Create a new class for an intake. **Owner only.**

**Body**
```json
{
  "level": "N3",
  "fee_mmk": 400000,
  "seat_total": 30,
  "status": "draft",
  "mode": "offline",
  "enrollment_open_at": "2026-03-01T00:00:00Z",
  "enrollment_close_at": "2026-04-15T00:00:00Z"
}
```

- `level` — required. Standard JLPT: `N5` · `N4` · `N3` · `N2` · `N1`. Custom strings allowed.
- `fee_mmk` — auto-populated for standard JLPT levels if omitted (N5=300k, N4=350k, N3=400k, N2=450k, N1=500k MMK).
- `seat_total` — defaults to `30`.
- `status` — defaults to `draft`. Values: `draft` · `open` · `full` · `closed`
- `mode` — defaults to `offline`. Values: `offline` · `online`

Returns `409` if a class with that level already exists for the intake.

---

### `PATCH /api/classes/[id]`
Update a class. **Owner only.** All fields optional.

**Body**
```json
{
  "fee_mmk": 400000,
  "seat_total": 35,
  "status": "open",
  "mode": "offline",
  "enrollment_open_at": "2026-03-01T00:00:00Z",
  "enrollment_close_at": null
}
```

- `seat_total` — adjusts `seat_remaining` to preserve already-taken seats. If class was `full` and new total creates available seats, status auto-resets to `open`.
- `enrollment_open_at` / `enrollment_close_at` — pass `null` to clear.

---

## Public Endpoints (no auth required)

These are student-facing. Not needed for admin agent tools.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/public/enroll/[slug]` | Enrollment form data for an intake slug (e.g. `april-2026`) |
| `POST` | `/api/public/enroll` | Submit a new enrollment |
| `GET` | `/api/public/bank-accounts` | Active bank accounts for payment instructions |
| `GET` | `/api/public/status` | Enrollment status lookup by ref number |
| `POST` | `/api/public/payments/upload` | Upload payment proof image |
| `GET` | `/api/health` | Health check — returns version + git ref |

---

## Enum Reference

### Enrollment Status
| Value | Meaning |
|-------|---------|
| `pending_payment` | Enrolled, awaiting payment |
| `payment_submitted` | Payment proof uploaded, awaiting admin verification |
| `partial_payment` | Partial payment received, remaining balance needed |
| `confirmed` | Payment verified, enrollment confirmed |
| `rejected` | Enrollment or payment rejected |

### Class Status
| Value | Meaning |
|-------|---------|
| `draft` | Not yet visible to students |
| `open` | Accepting enrollments |
| `full` | No seats remaining |
| `closed` | Enrollment period ended |

### Intake Status
| Value | Meaning |
|-------|---------|
| `draft` | Not yet published |
| `open` | Accepting enrollments |
| `closed` | Enrollment period ended |
