# KuuNyi Application - Complete Technical Analysis

---

## 1. PROJECT STRUCTURE

### Framework & Language
- **Framework**: Next.js 14.2.35 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **Database**: Supabase (PostgreSQL + Auth + Storage)
- **Runtime**: Node.js
- **Dev Server Port**: 3005

### Top-Level Directory Structure
```
EduEnroll/
├── .github/workflows/          # CI/CD pipelines (ci.yml, deploy-prod.yml, staging-tests.yml)
├── .vercel/                    # Vercel project config
├── public/                     # Static assets (logos, images)
├── supabase/
│   ├── config.toml             # Supabase CLI config
│   └── migrations/             # 65 SQL migration files (000-065)
├── src/
│   ├── middleware.ts            # Multi-tenant routing, auth guards
│   ├── app/                    # Next.js App Router pages & API routes
│   ├── components/             # Reusable React components
│   ├── lib/                    # Utilities, API helpers, integrations
│   └── types/                  # TypeScript type definitions
├── CLAUDE.md                   # Project rules & safety constraints
├── package.json                # Dependencies & scripts
├── tsconfig.json               # TypeScript config (strict, @/* alias)
├── tailwind.config.ts          # Tailwind with custom fonts/colors
├── next.config.mjs             # Security headers
├── vercel.json                 # Region: sin1, branch deploys
└── .env.local                  # Dev environment variables
```

### Source Directory (`src/`)
```
src/
├── middleware.ts                          # Tenant detection, auth redirects
├── app/
│   ├── layout.tsx                        # Root layout (fonts, analytics)
│   ├── page.tsx                          # Landing page (kuunyi.com)
│   ├── globals.css                       # Global styles
│   ├── login/
│   │   ├── page.tsx                      # Login page
│   │   └── LoginForm.tsx                 # Auth form with role detection
│   ├── register/page.tsx                 # SaaS tenant registration
│   ├── onboarding/page.tsx               # Post-registration setup
│   ├── superadmin/
│   │   ├── layout.tsx                    # Superadmin guard
│   │   ├── page.tsx                      # Superadmin dashboard
│   │   └── schools/[id]/page.tsx         # School management
│   ├── (public)/                         # Public route group
│   │   ├── layout.tsx                    # Public layout
│   │   ├── enroll/
│   │   │   ├── page.tsx                  # Intake listing
│   │   │   ├── form/page.tsx             # Enrollment form
│   │   │   ├── [slug]/page.tsx           # Intake detail
│   │   │   ├── [slug]/status/page.tsx    # Status check
│   │   │   ├── [slug]/success/page.tsx   # Confirmation
│   │   │   └── payment/[ref]/page.tsx    # Payment page
│   │   └── status/page.tsx               # Public status lookup
│   ├── admin/
│   │   ├── layout.tsx                    # Auth guard + context providers
│   │   ├── dashboard/page.tsx            # Stats & recent enrollments
│   │   ├── intakes/                      # Intake CRUD pages
│   │   ├── students/page.tsx             # Student directory
│   │   ├── payments/page.tsx             # Payment verification queue
│   │   ├── announcements/page.tsx        # Bulk messaging
│   │   ├── analytics/page.tsx            # Charts (Recharts)
│   │   ├── guide/page.tsx                # Setup guide
│   │   └── settings/                     # Org settings, staff, billing
│   └── api/                              # 54 API route files, 70+ handlers
│       ├── health/                       # Health check
│       ├── auth/                         # Tenant verification
│       ├── public/                       # Public endpoints (enroll, payments)
│       ├── admin/                        # Authenticated admin endpoints
│       ├── intakes/                      # Intake management
│       ├── classes/                      # Class management
│       ├── saas/                         # SaaS registration
│       ├── superadmin/                   # Superadmin management
│       ├── telegram/                     # Telegram bot integration
│       └── messenger/                    # Facebook Messenger integration
├── components/
│   ├── admin/                            # Sidebar, RoleContext, LogoutButton, etc.
│   ├── ui/                               # ConfirmModal, Toast, StatusBadge, etc.
│   ├── payments/                         # QRPaymentModal
│   └── enrollment/                       # (empty, reserved)
├── lib/
│   ├── supabase/
│   │   ├── admin.ts                      # Service-role client (bypasses RLS)
│   │   ├── server.ts                     # Cookie-based server client
│   │   └── client.ts                     # Browser client
│   ├── api.ts                            # requireAuth(), requireOwner(), resolveTenantId()
│   ├── utils.ts                          # formatMMK(), phone validation, config
│   ├── tenant.ts                         # Subdomain extraction
│   ├── email.ts                          # Resend email templates
│   ├── abank.ts                          # ABank MMQR payment SDK
│   ├── mmpay.ts                          # MyanMyanPay SDK
│   ├── mm-labels.ts                      # Myanmar/English label mappings
│   ├── telegram/                         # Bot processor, notifications, channel invites
│   └── messenger/                        # FB Messenger processor, responses, crypto
└── types/
    └── database.ts                       # Supabase generated types + enums
```

### Key Dependencies
| Package | Purpose |
|---------|---------|
| `@supabase/ssr` | Server-side Supabase client |
| `@supabase/supabase-js` | Supabase JavaScript SDK |
| `recharts` | Analytics charts |
| `jspdf` + `html2canvas` | E-Ticket PDF generation |
| `qrcode` | QR code rendering |
| `mmpay-node-sdk` | MyanMyanPay payment integration |
| `resend` | Transactional email |
| `xlsx` | Excel export |
| `@vercel/analytics` | Web analytics |
| `@dnd-kit/core` | Drag-and-drop (form field ordering) |

---

## 2. DATABASE SCHEMA

### Enums

| Enum Name | Values |
|-----------|--------|
| `plan_type` | `starter`, `pro`, `suspended` |
| `user_role` | `superadmin`, `owner`, `staff` |
| `intake_status` | `draft`, `open`, `closed` |
| `jlpt_level` | `N5`, `N4`, `N3`, `N2`, `N1` |
| `class_status` | `draft`, `open`, `full`, `closed` |
| `enrollment_status` | `pending_payment`, `payment_submitted`, `partial_payment`, `confirmed`, `rejected` |
| `payment_status` | `awaiting_payment`, `pending`, `verified`, `rejected` |

---

### Table: `tenants`
**Description**: Organizations using the platform (multi-tenant root)

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | uuid | PRIMARY KEY, DEFAULT gen_random_uuid() |
| `name` | varchar | NOT NULL |
| `subdomain` | varchar | NOT NULL, UNIQUE |
| `logo_url` | text | NULL |
| `currency` | varchar | DEFAULT 'MMK' |
| `language` | varchar | DEFAULT 'my+en' |
| `plan` | plan_type | DEFAULT 'starter' |
| `org_type` | text | DEFAULT 'language_school' |
| `label_intake` | text | DEFAULT 'Intake' |
| `label_class` | text | DEFAULT 'Class Type' |
| `label_student` | text | DEFAULT 'Student' |
| `label_seat` | text | DEFAULT 'Seat' |
| `label_fee` | text | DEFAULT 'Fee' |
| `email_on_enroll` | boolean | DEFAULT false |
| `payment_mode` | text | DEFAULT 'bank_transfer' |
| `mmqr_provider` | text | DEFAULT 'abank' |
| `auto_cancel_hours` | integer | DEFAULT 72 |
| `messenger_enabled` | boolean | DEFAULT false |
| `messenger_page_id` | text | NULL |
| `messenger_page_token` | text | NULL |
| `telegram_enabled` | boolean | DEFAULT false |
| `telegram_bot_token` | text | NULL |
| `telegram_bot_username` | text | NULL |
| `telegram_webhook_secret` | text | NULL |
| `telegram_auto_send_invite` | boolean | DEFAULT false |
| `created_at` | timestamptz | DEFAULT now() |

**Relationships**: Parent of `users`, `intakes`, `classes`, `enrollments`, `payments`, `bank_accounts`, `announcements`, `class_channels`, `staff_invites`

**Example Records**:
```json
{
  "id": "a1b2c3d4-...",
  "name": "Nihon Moment Japanese Language School",
  "subdomain": "nihon-moment",
  "plan": "starter",
  "org_type": "language_school",
  "label_intake": "Intake",
  "label_class": "Level",
  "payment_mode": "mmqr",
  "telegram_enabled": true,
  "created_at": "2026-01-15T10:00:00Z"
}
```
```json
{
  "id": "e5f6g7h8-...",
  "name": "TMF Music Festival",
  "subdomain": "tmf",
  "plan": "starter",
  "org_type": "event",
  "label_intake": "Event",
  "label_class": "Ticket Type",
  "label_student": "Attendee",
  "payment_mode": "mmqr",
  "created_at": "2026-03-01T08:00:00Z"
}
```

---

### Table: `users`
**Description**: Staff/admin users per tenant (NOT students)

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | uuid | PRIMARY KEY, REFERENCES auth.users(id) ON DELETE CASCADE |
| `tenant_id` | uuid | NOT NULL, FK → tenants(id) |
| `email` | varchar | NOT NULL |
| `role` | user_role | DEFAULT 'student' |
| `full_name` | varchar | NULL |
| `phone` | varchar | NULL |
| `created_at` | timestamptz | DEFAULT now() |

**Relationships**: `tenant_id` → `tenants.id`

**Example Records**:
```json
{
  "id": "usr-001-...",
  "tenant_id": "a1b2c3d4-...",
  "email": "admin@nihonmoment.com",
  "role": "owner",
  "full_name": "Admin User",
  "created_at": "2026-01-15T10:00:00Z"
}
```
```json
{
  "id": "usr-002-...",
  "tenant_id": "a1b2c3d4-...",
  "email": "staff@nihonmoment.com",
  "role": "staff",
  "full_name": "Staff Member",
  "created_at": "2026-02-01T09:00:00Z"
}
```

---

### Table: `intakes`
**Description**: Enrollment batches/periods (e.g., "January 2026 Intake", "Spring Concert")

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | uuid | PRIMARY KEY |
| `tenant_id` | uuid | NOT NULL, FK → tenants(id) |
| `name` | varchar | NOT NULL |
| `year` | integer | NOT NULL |
| `slug` | text | UNIQUE per tenant |
| `hero_image_url` | text | NULL |
| `status` | intake_status | DEFAULT 'draft' |
| `created_at` | timestamptz | DEFAULT now() |

**Relationships**: `tenant_id` → `tenants.id`; parent of `classes`, `announcements`, `intake_form_fields`, `class_channels`

**Example Records**:
```json
{
  "id": "int-001-...",
  "tenant_id": "a1b2c3d4-...",
  "name": "January 2026 Intake",
  "year": 2026,
  "slug": "january-2026",
  "status": "open",
  "created_at": "2025-12-01T10:00:00Z"
}
```
```json
{
  "id": "int-002-...",
  "tenant_id": "e5f6g7h8-...",
  "name": "TMF Spring Concert 2026",
  "year": 2026,
  "slug": "spring-concert-2026",
  "status": "open",
  "created_at": "2026-02-15T08:00:00Z"
}
```

---

### Table: `classes`
**Description**: Class levels or ticket types within an intake

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | uuid | PRIMARY KEY |
| `intake_id` | uuid | NOT NULL, FK → intakes(id) |
| `tenant_id` | uuid | NOT NULL, FK → tenants(id) |
| `level` | text | NOT NULL |
| `fee_mmk` | integer | NOT NULL |
| `seat_total` | integer | NOT NULL |
| `seat_remaining` | integer | NOT NULL, CHECK (>= 0 AND <= seat_total) |
| `enrollment_open_at` | timestamptz | NULL |
| `enrollment_close_at` | timestamptz | NULL |
| `status` | class_status | DEFAULT 'draft' |
| `mode` | text | DEFAULT 'offline', CHECK ('online' or 'offline') |
| `event_date` | date | NULL |
| `start_time` | time | NULL |
| `end_time` | time | NULL |
| `venue` | text | NULL |
| `image_url` | text | NULL |
| `max_tickets_per_person` | integer | DEFAULT 1 |
| `created_at` | timestamptz | DEFAULT now() |

**Relationships**: `intake_id` → `intakes.id`, `tenant_id` → `tenants.id`; parent of `enrollments`, `enrollment_items`, `class_channels`

**Triggers**: `trg_auto_reopen_class` — auto-changes status `full` → `open` when `seat_remaining > 0`

**Example Records**:
```json
{
  "id": "cls-001-...",
  "intake_id": "int-001-...",
  "tenant_id": "a1b2c3d4-...",
  "level": "N5",
  "fee_mmk": 150000,
  "seat_total": 30,
  "seat_remaining": 12,
  "status": "open",
  "mode": "offline"
}
```
```json
{
  "id": "cls-002-...",
  "intake_id": "int-002-...",
  "tenant_id": "e5f6g7h8-...",
  "level": "VIP",
  "fee_mmk": 50000,
  "seat_total": 100,
  "seat_remaining": 45,
  "status": "open",
  "max_tickets_per_person": 5,
  "event_date": "2026-04-20",
  "venue": "Yangon Convention Centre"
}
```

---

### Table: `enrollments`
**Description**: Individual student/attendee enrollment records

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | uuid | PRIMARY KEY |
| `enrollment_ref` | varchar(20) | NOT NULL, UNIQUE (auto-generated e.g., "NM-2026-00042") |
| `class_id` | uuid | FK → classes(id), NULL for cart enrollments |
| `tenant_id` | uuid | NOT NULL, FK → tenants(id) |
| `student_name_en` | varchar | NOT NULL |
| `student_name_mm` | varchar | NULL (Myanmar script) |
| `nrc_number` | varchar | NULL (National Registration Card) |
| `phone` | varchar | NOT NULL |
| `email` | varchar | NULL |
| `form_data` | jsonb | DEFAULT '{}' (dynamic form responses) |
| `quantity` | integer | DEFAULT 1 |
| `status` | enrollment_status | DEFAULT 'pending_payment' |
| `enrolled_at` | timestamptz | DEFAULT now() |
| `rejection_reason` | text | NULL |
| `idempotency_key` | text | NULL, UNIQUE |
| `messenger_psid` | text | NULL (Facebook Messenger ID) |
| `telegram_chat_id` | text | NULL |
| `telegram_phone` | text | NULL |
| `telegram_link_token` | text | NULL |
| `telegram_link_token_expires_at` | timestamptz | NULL |

**Relationships**: `class_id` → `classes.id`, `tenant_id` → `tenants.id`; parent of `payments`, `enrollment_items`

**Triggers**: `trg_enrollments_ref` — auto-generates enrollment_ref; `trg_enrollments_seats` — updates seat_remaining on status change

**Example Records**:
```json
{
  "id": "enr-001-...",
  "enrollment_ref": "NM-2026-00042",
  "class_id": "cls-001-...",
  "tenant_id": "a1b2c3d4-...",
  "student_name_en": "Aung Aung",
  "student_name_mm": "အောင်အောင်",
  "phone": "09-123-456-789",
  "email": "aung@example.com",
  "status": "confirmed",
  "quantity": 1,
  "enrolled_at": "2026-01-20T14:30:00Z"
}
```
```json
{
  "id": "enr-002-...",
  "enrollment_ref": "TMF-2026-00108",
  "class_id": "cls-002-...",
  "tenant_id": "e5f6g7h8-...",
  "student_name_en": "May Thu",
  "phone": "09-987-654-321",
  "status": "pending_payment",
  "quantity": 3,
  "enrolled_at": "2026-03-15T09:00:00Z"
}
```

---

### Table: `payments`
**Description**: Payment records linked to enrollments

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | uuid | PRIMARY KEY |
| `enrollment_id` | uuid | NOT NULL, FK → enrollments(id) ON DELETE CASCADE |
| `tenant_id` | uuid | NOT NULL, FK → tenants(id) |
| `amount_mmk` | integer | NOT NULL |
| `proof_image_url` | text | NULL (legacy single image) |
| `proof_image_urls` | text[] | DEFAULT '{}' (multiple proofs) |
| `bank_reference` | varchar | NULL |
| `admin_note` | text | NULL |
| `received_amount_mmk` | integer | NULL |
| `payer_institution` | text | NULL (source bank from MMQR) |
| `payment_ref` | text | NULL (MMQR order ID) |
| `payment_method` | text | NULL ('manual_upload' or 'mmqr') |
| `mmqr_status` | text | DEFAULT 'PENDING' ('PENDING', 'SUCCESS', 'FAILED', 'REFUNDED') |
| `paid_at` | timestamptz | NULL |
| `status` | payment_status | DEFAULT 'pending' |
| `verified_by` | uuid | FK → users(id) |
| `verified_at` | timestamptz | NULL |
| `created_at` | timestamptz | DEFAULT now() |

**Relationships**: `enrollment_id` → `enrollments.id`, `tenant_id` → `tenants.id`, `verified_by` → `users.id`

**Triggers**: `trg_payments_sync_enrollment` — syncs enrollment status when payment status changes

**Example Records**:
```json
{
  "id": "pay-001-...",
  "enrollment_id": "enr-001-...",
  "tenant_id": "a1b2c3d4-...",
  "amount_mmk": 150000,
  "payment_method": "mmqr",
  "mmqr_status": "SUCCESS",
  "payer_institution": "KBZ Bank",
  "status": "verified",
  "verified_at": "2026-01-20T14:35:00Z",
  "paid_at": "2026-01-20T14:32:00Z"
}
```
```json
{
  "id": "pay-002-...",
  "enrollment_id": "enr-002-...",
  "tenant_id": "e5f6g7h8-...",
  "amount_mmk": 150000,
  "payment_method": "manual_upload",
  "proof_image_urls": ["https://...storage.../proof1.jpg"],
  "status": "pending",
  "created_at": "2026-03-15T09:10:00Z"
}
```

---

### Table: `bank_accounts`
**Description**: Payment receiving accounts for each tenant

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | uuid | PRIMARY KEY |
| `tenant_id` | uuid | NOT NULL, FK → tenants(id) |
| `bank_name` | text | NOT NULL |
| `account_number` | varchar | NOT NULL |
| `account_holder` | varchar | NOT NULL |
| `is_active` | boolean | DEFAULT true |
| `qr_code_url` | text | NULL |
| `created_at` | timestamptz | DEFAULT now() |

**Example Records**:
```json
{
  "id": "ba-001-...",
  "tenant_id": "a1b2c3d4-...",
  "bank_name": "KBZ Bank",
  "account_number": "0123456789",
  "account_holder": "Nihon Moment Co., Ltd",
  "is_active": true
}
```

---

### Table: `enrollment_items`
**Description**: Cart items for multi-class enrollments

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | uuid | PRIMARY KEY |
| `enrollment_id` | uuid | NOT NULL, FK → enrollments(id) ON DELETE CASCADE |
| `class_id` | uuid | NOT NULL, FK → classes(id) |
| `tenant_id` | uuid | NOT NULL, FK → tenants(id) |
| `quantity` | integer | DEFAULT 1, CHECK (>= 1) |
| `fee_mmk` | integer | NOT NULL, CHECK (>= 0) |
| `created_at` | timestamptz | DEFAULT now() |

---

### Table: `intake_form_fields`
**Description**: Dynamic form fields per intake

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | uuid | PRIMARY KEY |
| `intake_id` | uuid | NOT NULL, FK → intakes(id) ON DELETE CASCADE |
| `field_key` | text | NOT NULL |
| `field_label` | text | NOT NULL |
| `field_type` | text | NOT NULL ('text', 'email', 'select', 'radio', 'file', 'date', 'checkbox', 'phone', 'address') |
| `is_required` | boolean | DEFAULT true |
| `options` | jsonb | NULL (for select/radio) |
| `sort_order` | int | DEFAULT 0 |
| `is_default` | boolean | DEFAULT false |
| `created_at` | timestamptz | DEFAULT now() |

**Constraint**: UNIQUE(intake_id, field_key)

---

### Table: `announcements`
**Description**: Bulk messages to students

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | uuid | PRIMARY KEY |
| `tenant_id` | uuid | NOT NULL, FK → tenants(id) |
| `intake_id` | uuid | FK → intakes(id) ON DELETE SET NULL |
| `class_level` | jlpt_level | NULL (NULL = all classes) |
| `target_label` | varchar | NOT NULL |
| `message` | text | NOT NULL |
| `sent_by_id` | uuid | FK → users(id) |
| `sent_by_name` | varchar | NULL |
| `telegram_sent_count` | integer | DEFAULT 0 |
| `telegram_failed_count` | integer | DEFAULT 0 |
| `dispatched_at` | timestamptz | NULL |
| `created_at` | timestamptz | DEFAULT now() |

---

### Table: `staff_invites`
**Description**: Staff invitation tokens

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | uuid | PRIMARY KEY |
| `tenant_id` | uuid | NOT NULL, FK → tenants(id) |
| `email` | varchar | NOT NULL |
| `token` | varchar | NOT NULL, UNIQUE (auto-generated 32-byte hex) |
| `invited_by` | uuid | FK → users(id) |
| `accepted_at` | timestamptz | NULL |
| `expires_at` | timestamptz | DEFAULT now() + 7 days |
| `created_at` | timestamptz | DEFAULT now() |

---

### Table: `class_channels`
**Description**: Telegram channels linked to classes

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | uuid | PRIMARY KEY |
| `tenant_id` | uuid | NOT NULL, FK → tenants(id) |
| `intake_id` | uuid | NOT NULL, FK → intakes(id) |
| `class_id` | uuid | NOT NULL, FK → classes(id) |
| `telegram_channel_id` | text | NOT NULL |
| `telegram_channel_name` | text | NULL |
| `telegram_invite_link` | text | NULL |
| `created_at` | timestamptz | DEFAULT now() |
| `updated_at` | timestamptz | DEFAULT now() |

**Constraint**: UNIQUE(tenant_id, class_id)

---

### Table: `messenger_handoffs`
**Description**: Facebook Messenger live agent handoff tracking

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | uuid | PRIMARY KEY |
| `tenant_id` | uuid | NOT NULL, FK → tenants(id) |
| `sender_psid` | text | NOT NULL |
| `created_at` | timestamptz | DEFAULT now() |
| `expires_at` | timestamptz | NOT NULL |

**Constraint**: UNIQUE(tenant_id, sender_psid)

---

### Table: `messenger_page_sessions`
**Description**: Temporary OAuth sessions for Messenger page connection

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | uuid | PRIMARY KEY |
| `session_id` | uuid | NOT NULL |
| `tenant_slug` | text | NOT NULL |
| `page_id` | text | NOT NULL |
| `page_name` | text | NOT NULL |
| `page_token_encrypted` | text | NOT NULL |
| `expires_at` | timestamptz | NOT NULL |
| `created_at` | timestamptz | DEFAULT now() |

---

### Key Database Functions (RPCs)

| Function | Purpose |
|----------|---------|
| `submit_enrollment(p_class_id, p_idempotency_key, p_quantity)` | Atomic enrollment with seat reservation |
| `submit_cart_enrollment(p_items, p_tenant_id)` | Multi-class cart checkout |
| `check_expired_enrollments()` | Auto-cancel expired pending enrollments |
| `seed_default_classes(p_intake_id, p_tenant_id, p_seat_total)` | Create default N5-N1 classes |
| `get_my_tenant_id()` | Return current user's tenant (SECURITY DEFINER) |
| `get_my_role()` | Return current user's role (SECURITY DEFINER) |

### Entity Relationship Diagram
```
tenants (1) ──────┬──── (N) users
                  ├──── (N) intakes ──── (N) classes ──── (N) enrollments ──── (N) payments
                  ├──── (N) bank_accounts                     │
                  ├──── (N) announcements                     └──── (N) enrollment_items
                  ├──── (N) staff_invites
                  ├──── (N) class_channels
                  └──── (N) messenger_handoffs
```

---

## 3. API ENDPOINTS

### Public Endpoints (No Authentication)

#### `GET /api/health`
Health check endpoint.
```json
// Response 200
{ "status": "ok", "build_time": "2026-04-10T...", "version": "1.0.0", "ref": "abc123" }
```

---

#### `POST /api/saas/register`
Register a new school/tenant.
```json
// Request Body
{
  "school_name_en": "My Language School",
  "school_name_mm": "ကျွန်ုပ်၏ ဘာသာစကားကျောင်း",
  "subdomain": "my-school",
  "admin_email": "admin@myschool.com",
  "password": "securepass123",
  "org_type": "language_school"
}

// Response 201
{
  "tenant_id": "uuid-...",
  "subdomain": "my-school",
  "user_id": "uuid-...",
  "email": "admin@myschool.com"
}
```

---

#### `POST /api/saas/check-subdomain`
Check subdomain availability.
```json
// Request Body
{ "slug": "my-school" }

// Response 200
{ "available": true }
```

---

#### `GET /api/public/enroll/[slug]`
Get intake details + classes for enrollment.
```json
// Response 200
{
  "intake": { "id": "...", "name": "January 2026", "status": "open" },
  "classes": [
    { "id": "...", "level": "N5", "fee_mmk": 150000, "seat_total": 30, "seat_remaining": 12, "status": "open" }
  ],
  "tenant": { "label_intake": "Intake", "label_class": "Level", "org_type": "language_school" }
}
```

---

#### `GET /api/public/form-fields?intake_id=UUID`
Get dynamic form fields for an intake.
```json
// Response 200
[
  { "id": "...", "field_key": "student_name_en", "field_label": "Name (English)", "field_type": "text", "is_required": true, "sort_order": 0 },
  { "id": "...", "field_key": "email", "field_label": "Email", "field_type": "email", "is_required": false, "sort_order": 3 }
]
```

---

#### `GET /api/public/bank-accounts`
Get active bank accounts for payment (requires `x-tenant-slug` header from middleware).
```json
// Response 200
[
  { "bank_name": "KBZ Bank", "account_number": "0123456789", "account_holder": "Nihon Moment", "qr_code_url": "https://..." }
]
```

---

#### `POST /api/public/enroll`
Submit enrollment (single class or cart).
```json
// Request Body (single class)
{
  "class_id": "uuid-...",
  "form_data": {
    "student_name_en": "Aung Aung",
    "phone": "09-123-456-789",
    "email": "aung@example.com"
  },
  "quantity": 1,
  "idempotency_key": "unique-key-123"
}

// Request Body (cart)
{
  "items": [
    { "class_id": "uuid-1", "quantity": 1 },
    { "class_id": "uuid-2", "quantity": 2 }
  ],
  "form_data": { "student_name_en": "May Thu", "phone": "09-987-654-321" }
}

// Response 201
{
  "enrollment_ref": "NM-2026-00042",
  "class_level": "N5",
  "fee_mmk": 150000,
  "quantity": 1,
  "total_fee_mmk": 150000,
  "payment": { "id": "uuid-...", "status": "pending" }
}
```

---

#### `POST /api/public/payments/upload`
Upload payment proof images.
```
// Request: multipart/form-data
- enrollment_ref: "NM-2026-00042"
- proof_image[]: File (max 5 files, 5MB each, JPEG/PNG/WebP)

// Response 201
{
  "payment_id": "uuid-...",
  "enrollment_ref": "NM-2026-00042",
  "amount_mmk": 150000,
  "proof_count": 2,
  "status": "pending"
}
```

---

#### `POST /api/public/payments/abank`
Generate ABank MMQR QR code for payment.
```json
// Request Body
{ "enrollmentRef": "NM-2026-00042" }

// Response 200
{ "qr": "data:image/png;base64,...", "orderId": "AB-123456", "amount": 150000 }
```

---

#### `GET /api/public/payments/abank/status?ref=AB-123456`
Poll ABank payment status.
```json
// Response 200
{ "mmqr_status": "SUCCESS" }
// mmqr_status: "PENDING" | "SUCCESS" | "FAILED" | "REFUNDED"
```

---

#### `GET /api/public/payments/abank/callback`
ABank webhook callback (called by ABank server).
```json
// Response 200
{ "message": "OK" }
```

---

#### `POST /api/public/payments/mmpay`
Generate MyanMyanPay MMQR code.
```json
// Request Body
{ "enrollmentRef": "NM-2026-00042" }

// Response 200
{ "qr": "data:image/png;base64,...", "orderId": "KNY-123456", "amount": 150000, "transactionRefId": "..." }
```

---

#### `GET /api/public/payments/mmpay/status?ref=KNY-123456`
Poll MyanMyanPay status.
```json
// Response 200
{ "mmqr_status": "SUCCESS" }
```

---

#### `POST /api/public/payments/mmpay/webhook`
MyanMyanPay webhook (HMAC signature verified).
```json
// Response 200
{ "message": "OK" }
```

---

#### `GET /api/public/status?ref=NM-2026-00042`
Check enrollment status publicly.
```json
// Response 200
{
  "enrollment": {
    "enrollment_ref": "NM-2026-00042",
    "student_name_en": "Aung Aung",
    "status": "confirmed",
    "enrolled_at": "2026-01-20T14:30:00Z"
  },
  "payment": { "status": "verified", "amount_mmk": 150000 },
  "class": { "level": "N5" },
  "tenant": { "org_type": "language_school", "payment_mode": "mmqr" }
}
```

---

#### `POST /api/public/telegram-link-token`
Generate Telegram deep link token.
```json
// Request Body
{ "enrollment_ref": "NM-2026-00042" }

// Response 200
{ "deepLink": "https://t.me/NihonMomentBot?start=abc123", "expiresIn": "15 minutes" }
```

---

### Authenticated Admin Endpoints
**All require**: Cookie-based auth or `Authorization: Bearer <token>` header

#### `GET /api/admin/stats`
Dashboard statistics.
```json
// Response 200
{
  "total_enrolled": 142,
  "confirmed": 98,
  "pending_review": 12,
  "total_revenue": 14700000,
  "seats": [
    { "level": "N5", "total": 30, "remaining": 12 },
    { "level": "N4", "total": 30, "remaining": 20 }
  ]
}
```

---

#### `GET /api/admin/analytics?range=30d`
Enrollment analytics with charts data.
```json
// Response 200
{
  "daily_enrollments": [{ "date": "2026-01-15", "count": 5 }],
  "by_level": [{ "level": "N5", "count": 42 }],
  "revenue": { "total": 14700000, "verified": 12000000 },
  "conversion_rate": 0.69,
  "seat_fill": 0.60,
  "avg_payment_hours": 4.2
}
```

---

#### `GET /api/admin/students?intake_id=UUID&status=confirmed&search=aung&page=1&page_size=20`
Paginated student list.
```json
// Response 200
{
  "students": [
    {
      "id": "...", "enrollment_ref": "NM-2026-00042",
      "student_name_en": "Aung Aung", "phone": "09-123-456-789",
      "class_level": "N5", "status": "confirmed",
      "enrolled_at": "2026-01-20T14:30:00Z"
    }
  ],
  "total": 142,
  "page": 1,
  "page_size": 20,
  "total_pages": 8
}
```

---

#### `GET /api/admin/students/[id]`
Full enrollment details.
```json
// Response 200
{
  "enrollment": { "id": "...", "enrollment_ref": "NM-2026-00042", "student_name_en": "Aung Aung", "form_data": {} },
  "payment": { "id": "...", "amount_mmk": 150000, "status": "verified", "proof_image_urls": ["https://signed-url..."] },
  "form_fields": [{ "field_key": "email", "field_label": "Email" }],
  "telegram": { "linked": true, "chat_id": "12345" }
}
```

---

#### `GET /api/admin/payments/pending`
List payments awaiting verification.
```json
// Response 200
[
  {
    "id": "pay-...", "enrollment_ref": "NM-2026-00042",
    "student_name_en": "Aung Aung", "amount_mmk": 150000,
    "proof_image_urls": ["https://signed-url..."],
    "status": "pending", "created_at": "2026-01-20T14:32:00Z"
  }
]
```

---

#### `PATCH /api/admin/payments/[id]/verify`
Approve or reject a payment.
```json
// Request Body (approve)
{ "action": "approve", "received_amount": 150000, "admin_note": "Verified OK" }

// Request Body (reject)
{ "action": "reject", "rejection_reason": "Blurry screenshot, amount unclear" }

// Request Body (partial)
{ "action": "request_remaining", "received_amount": 100000, "admin_note": "50,000 MMK remaining" }

// Response 200
{ "enrollment": { "status": "confirmed" }, "payment": { "status": "verified" } }
```

---

#### `GET /api/intakes`
List all intakes for the tenant.
```json
// Response 200
[
  { "id": "...", "name": "January 2026 Intake", "year": 2026, "status": "open", "slug": "january-2026" }
]
```

---

#### `POST /api/intakes`
Create a new intake (owner only).
```json
// Request Body
{ "name": "March 2026 Intake", "year": 2026, "status": "draft" }

// Response 201
{ "id": "uuid-...", "name": "March 2026 Intake", "year": 2026, "status": "draft" }
```

---

#### `GET /api/intakes/[id]/classes`
List classes for an intake.
```json
// Response 200
[
  { "id": "...", "level": "N5", "fee_mmk": 150000, "seat_total": 30, "seat_remaining": 12, "status": "open", "mode": "offline" }
]
```

---

#### `PATCH /api/classes/[id]`
Update a class (owner only).
```json
// Request Body
{ "fee_mmk": 180000, "seat_total": 40, "status": "open" }

// Response 200
{ "id": "...", "level": "N5", "fee_mmk": 180000, "seat_total": 40, "seat_remaining": 22, "status": "open" }
```

---

#### `GET /api/admin/announcements`
List announcements.
```json
// Response 200
[
  { "id": "...", "message": "Class starts next Monday!", "target_label": "N5 - January 2026",
    "telegram_sent_count": 25, "dispatched_at": "2026-01-18T10:00:00Z" }
]
```

---

#### `POST /api/admin/announcements`
Create and optionally dispatch an announcement.
```json
// Request Body
{ "intake_id": "uuid-...", "class_level": "N5", "message": "Class starts next Monday!", "dispatch_telegram": true }

// Response 201
{ "id": "uuid-...", "message": "Class starts next Monday!", "telegram_sent_count": 25 }
```

---

#### `POST /api/admin/announcements/[id]/dispatch`
Dispatch existing announcement to Telegram.
```json
// Response 200
{ "sent": 25, "failed": 2 }
```

---

#### `GET /api/admin/bank-accounts`
List bank accounts.

#### `POST /api/admin/bank-accounts`
Create bank account (owner only).
```json
// Request Body
{ "bank_name": "KBZ Bank", "account_number": "0123456789", "account_holder": "Company Name", "is_active": true }
```

#### `PATCH /api/admin/bank-accounts/[id]`
Update bank account (owner only).

#### `DELETE /api/admin/bank-accounts/[id]`
Delete bank account (owner only). Returns 204.

---

#### `GET /api/admin/staff`
List staff members (owner only).

#### `POST /api/admin/staff`
Create staff account (owner only).
```json
// Request Body
{ "email": "newstaff@school.com", "password": "temppass123", "full_name": "New Staff" }
```

#### `DELETE /api/admin/staff/[id]`
Remove staff member (owner only).

---

#### `POST /api/admin/enrollments/[id]/resend-email`
Resend enrollment confirmation email.
```json
// Request Body (optional)
{ "email": "override@example.com" }
```

---

#### `GET /api/admin/channels?intake_id=UUID`
List Telegram channels (owner only).

#### `POST /api/admin/channels`
Link Telegram channel to class.
```json
// Request Body
{ "class_id": "uuid-...", "intake_id": "uuid-...", "telegram_channel_id": "-100123456789" }
```

#### `DELETE /api/admin/channels/[id]`
Unlink Telegram channel.

---

#### `GET /api/telegram/settings`
Get Telegram bot config.
```json
// Response 200
{ "enabled": true, "botUsername": "NihonMomentBot", "connected": true, "webhookConfigured": true, "autoSendInvite": true }
```

#### `PATCH /api/telegram/settings`
Configure Telegram bot (owner only).
```json
// Request Body
{ "botToken": "123456:ABC-DEF...", "enabled": true, "autoSendInvite": true }
```

---

### Webhook Endpoints

#### `POST /api/telegram/webhook/[secret]`
Telegram bot webhook (secret must match tenant's `telegram_webhook_secret`).

#### `POST /api/messenger/webhook`
Facebook Messenger webhook (HMAC signature verification).

#### `GET /api/messenger/callback`
Meta OAuth callback for page connection.

---

### Superadmin Endpoints (superadmin role only)

#### `GET /api/superadmin/schools`
List all schools.
```json
// Response 200
[
  { "id": "...", "name": "Nihon Moment", "subdomain": "nihon-moment", "plan": "starter",
    "owner_email": "admin@nihonmoment.com", "enrollment_count": 142 }
]
```

#### `GET /api/superadmin/schools/[id]`
Get school details with stats.

#### `PATCH /api/superadmin/schools/[id]`
Suspend/activate school.
```json
// Request Body
{ "plan": "suspended" }
```

---

## 4. AUTHENTICATION

### Overview
KuuNyi uses **Supabase Auth** with cookie-based sessions for browser clients and Bearer tokens for API clients.

### Authentication Flow

```
User Login (email + password)
    │
    ├─► Supabase signInWithPassword()
    │
    ├─► Fetch user profile from `users` table
    │
    ├─► Check role:
    │   ├─► superadmin → set cookie `x-user-role=superadmin` → redirect /superadmin
    │   ├─► owner/staff → verify tenant membership → redirect /admin/dashboard
    │   └─► no profile → error (not authorized)
    │
    └─► Session stored in cookies (managed by @supabase/ssr)
```

### Three Supabase Clients

| Client | File | Usage | RLS |
|--------|------|-------|-----|
| **Server** | `src/lib/supabase/server.ts` | Authenticated admin routes | Enforced |
| **Admin** | `src/lib/supabase/admin.ts` | Public APIs, service operations | Bypassed |
| **Browser** | `src/lib/supabase/client.ts` | Client-side components | Enforced |

### Authorization Functions (`src/lib/api.ts`)

| Function | Purpose | Returns |
|----------|---------|---------|
| `requireAuth()` | Verify authenticated user + tenant membership | `{ supabase, user, tenantId }` or 401/403 |
| `requireOwner()` | Verify user has `owner` role | Same as above or 403 |
| `resolveTenantId()` | Extract tenant from subdomain header | `tenantId` or 400/404 |

### Multi-Tenancy Authentication

**Tenant Detection** (in `src/middleware.ts`):
1. Extract subdomain from `Host` header
2. Set `x-tenant-slug` request header
3. Localhost fallback: `?tenant=slug` → cookie → `NEXT_PUBLIC_DEV_TENANT` env var

**Tenant Verification** (on login):
1. Resolve tenant from subdomain
2. Check user's `tenant_id` matches tenant
3. Reject cross-tenant access attempts

### Role-Based Access Control

| Role | Access Level |
|------|-------------|
| `superadmin` | All tenants, superadmin portal, school management |
| `owner` | Full access to own tenant (create/update/delete everything) |
| `staff` | Read access + limited write (students, announcements) |

### Session Management
- Sessions stored in HTTP cookies via `@supabase/ssr`
- Middleware refreshes sessions on each request
- `x-user-role` cookie used for middleware-level superadmin detection
- Bearer tokens supported via `x-supabase-auth` header (for CI/CD, API clients)

---

## 5. KEY FEATURES

### Main Features

1. **Online Enrollment Portal** - Bilingual (English + Myanmar) enrollment forms with dynamic fields, seat reservation, and multi-class cart checkout
2. **MMQR Instant Payments** - Real-time QR code payments via KBZ, AYA, CB, UAB, Yoma banks (ABank + MyanMyanPay providers)
3. **Admin Dashboard** - Real-time stats, payment verification queue, student management, analytics charts
4. **Telegram & Messenger Integration** - Chatbot enrollment, auto-channel invites, bulk announcements
5. **Multi-Tenant SaaS** - Subdomain-based isolation, custom labels (language school, event, fitness, etc.), staff management
6. **Dynamic Form Builder** - Admin-defined custom fields (text, email, select, radio, file, date, phone, address)
7. **Announcement System** - Target by intake + class level, dispatch via Telegram in batches
8. **E-Ticket PDF Generation** - Downloadable enrollment confirmation tickets

### Enrollment Status Lifecycle
```
pending_payment → payment_submitted → confirmed
                                    → partial_payment → confirmed
                                    → rejected
```

### Top 5 Customer Questions

1. **"I paid but my status still shows pending"**
   - Check `/api/public/status?ref=ENROLLMENT_REF` — if `payment_submitted`, admin hasn't verified yet
   - For MMQR: check `mmqr_status` — if `SUCCESS`, auto-verification may have a delay
   - Admin needs to go to Payments page and verify the proof image

2. **"How do I check my enrollment status?"**
   - Visit the enrollment status page: `https://[tenant].kuunyi.com/status`
   - Enter enrollment reference (e.g., "NM-2026-00042")
   - Or use the link sent via email/Telegram after enrollment

3. **"The class is showing 'full' — can I still enroll?"**
   - Class auto-reopens if someone cancels (trigger: `trg_auto_reopen_class`)
   - Admin can increase `seat_total` in class settings
   - Check `seat_remaining` via the enrollment page

4. **"I want to change my class level after enrolling"**
   - No self-service class change — contact the school admin
   - Admin can reject the enrollment and student re-enrolls in desired class

5. **"How do I connect my Telegram?"**
   - After enrollment, click "Link Telegram" on the status page
   - Generates a deep link to the school's Telegram bot
   - Token expires in 15 minutes — click again for a new one
   - Once linked, auto-join class channels when payment is confirmed

---

## 6. SUPPORT SYSTEM

### Existing Support Setup

KuuNyi currently has the following support-adjacent features:

1. **Enrollment Status Lookup** (`/status` page)
   - Public self-service: students check status by enrollment reference
   - Shows payment status, class details, Telegram link option

2. **Telegram Bot Integration**
   - Students interact with the school's Telegram bot
   - Bot provides enrollment status, payment instructions
   - Auto-sends class channel invites after payment verification
   - Admin sends bulk announcements via Telegram

3. **Facebook Messenger Integration**
   - Webhook-based chatbot for enrollment queries
   - Menu buttons for common actions (enroll, check status, payment)
   - Live agent handoff with timeout (configurable)

4. **Email Notifications** (via Resend)
   - Enrollment confirmation emails
   - Payment verification result emails
   - Admin can resend emails to students

5. **Admin Payment Queue**
   - Visual queue of pending payment verifications
   - Proof image viewer with signed URLs
   - Approve/reject/request-remaining actions

6. **No dedicated ticketing/support system exists** — support is handled through Telegram/Messenger bots and direct admin interaction.

---

## 7. CONNECTION DETAILS - How to Connect from Python

### Environment Variables Needed

```
SUPABASE_URL=https://fnfvwzwrdsnmwxunciti.supabase.co     # Dev database
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIs...          # Service role key (from Supabase dashboard)
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIs...                  # Anon key (limited access)
```

> **WARNING**: Never use the production database (`nhxmumcvgnxlczjsgctz`) directly. Always use the dev database (`fnfvwzwrdsnmwxunciti`).

### Option A: Supabase Python SDK (Recommended)

```bash
pip install supabase
```

#### Connect to the Database

```python
import os
from supabase import create_client, Client

# Load from environment
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]  # Service role for full access

# Create client
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

print("Connected to Supabase!")
```

#### Query Customer by Email

```python
def get_customer_by_email(email: str):
    """Find enrollment(s) by student email."""
    result = (
        supabase.table("enrollments")
        .select("*, payments(*), classes(level, fee_mmk)")
        .eq("email", email)
        .execute()
    )

    if not result.data:
        print(f"No enrollments found for {email}")
        return None

    for enrollment in result.data:
        print(f"Ref: {enrollment['enrollment_ref']}")
        print(f"Name: {enrollment['student_name_en']}")
        print(f"Status: {enrollment['status']}")
        print(f"Class: {enrollment['classes']['level']}")
        print(f"Phone: {enrollment['phone']}")
        print("---")

    return result.data

# Usage
get_customer_by_email("aung@example.com")
```

#### Check Enrollment/Order Status

```python
def check_enrollment_status(enrollment_ref: str):
    """Check enrollment status by reference number."""
    result = (
        supabase.table("enrollments")
        .select("""
            id, enrollment_ref, student_name_en, phone, email,
            status, enrolled_at, quantity,
            payments(id, amount_mmk, status, payment_method, mmqr_status, paid_at, verified_at),
            classes(level, fee_mmk, intake_id)
        """)
        .eq("enrollment_ref", enrollment_ref)
        .single()
        .execute()
    )

    if not result.data:
        print(f"Enrollment {enrollment_ref} not found")
        return None

    e = result.data
    print(f"Enrollment: {e['enrollment_ref']}")
    print(f"Student: {e['student_name_en']}")
    print(f"Status: {e['status']}")
    print(f"Class: {e['classes']['level']}")
    print(f"Fee: {e['classes']['fee_mmk']} MMK")
    print(f"Enrolled: {e['enrolled_at']}")

    if e['payments']:
        for p in e['payments']:
            print(f"  Payment: {p['amount_mmk']} MMK - {p['status']}")
            if p['payment_method']:
                print(f"  Method: {p['payment_method']}")
            if p['paid_at']:
                print(f"  Paid at: {p['paid_at']}")

    return result.data

# Usage
check_enrollment_status("NM-2026-00042")
```

#### Create a Support Ticket (Custom Table)

> Note: KuuNyi does not have a built-in support ticket table. Below is an example of how you would create one and interact with it.

```python
def create_support_ticket(
    tenant_id: str,
    enrollment_ref: str,
    subject: str,
    message: str,
    customer_email: str = None
):
    """
    Create a support ticket linked to an enrollment.

    NOTE: This requires creating a `support_tickets` table first.
    See the SQL migration below.
    """
    # First, look up the enrollment
    enrollment = (
        supabase.table("enrollments")
        .select("id, tenant_id, student_name_en, email, phone")
        .eq("enrollment_ref", enrollment_ref)
        .single()
        .execute()
    )

    if not enrollment.data:
        print(f"Enrollment {enrollment_ref} not found")
        return None

    # Create the ticket
    ticket = (
        supabase.table("support_tickets")
        .insert({
            "tenant_id": enrollment.data["tenant_id"],
            "enrollment_id": enrollment.data["id"],
            "enrollment_ref": enrollment_ref,
            "customer_name": enrollment.data["student_name_en"],
            "customer_email": customer_email or enrollment.data.get("email"),
            "customer_phone": enrollment.data["phone"],
            "subject": subject,
            "message": message,
            "status": "open"
        })
        .execute()
    )

    print(f"Ticket created: {ticket.data[0]['id']}")
    return ticket.data[0]

# Usage
create_support_ticket(
    tenant_id="a1b2c3d4-...",
    enrollment_ref="NM-2026-00042",
    subject="Payment not reflected",
    message="I paid via KBZ but status still shows pending_payment"
)
```

**SQL Migration for support_tickets table** (if needed):
```sql
CREATE TABLE support_tickets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    enrollment_id uuid REFERENCES enrollments(id) ON DELETE SET NULL,
    enrollment_ref text,
    customer_name text NOT NULL,
    customer_email text,
    customer_phone text,
    subject text NOT NULL,
    message text NOT NULL,
    status text DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
    resolved_by uuid REFERENCES users(id),
    resolved_at timestamptz,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_support_tickets_tenant ON support_tickets(tenant_id);
CREATE INDEX idx_support_tickets_status ON support_tickets(tenant_id, status);
CREATE INDEX idx_support_tickets_enrollment ON support_tickets(enrollment_ref);
```

### Option B: Direct PostgreSQL Connection

```bash
pip install psycopg2-binary
```

```python
import psycopg2

# Connection string from Supabase dashboard → Settings → Database
# Format: postgresql://postgres.[project-ref]:[password]@[host]:5432/postgres
conn = psycopg2.connect(
    host="db.fnfvwzwrdsnmwxunciti.supabase.co",
    port=5432,
    database="postgres",
    user="postgres",
    password=os.environ["SUPABASE_DB_PASSWORD"]  # From Supabase dashboard
)

cursor = conn.cursor()

# Query enrollments
cursor.execute("""
    SELECT e.enrollment_ref, e.student_name_en, e.status, e.phone,
           c.level, p.amount_mmk, p.status as payment_status
    FROM enrollments e
    LEFT JOIN classes c ON e.class_id = c.id
    LEFT JOIN payments p ON p.enrollment_id = e.id
    WHERE e.email = %s
    ORDER BY e.enrolled_at DESC
""", ("aung@example.com",))

for row in cursor.fetchall():
    print(row)

cursor.close()
conn.close()
```

### Option C: Call Next.js API Endpoints

```python
import requests

BASE_URL = "https://nihon-moment.kuunyi.com"  # or localhost:3005 for dev

# Public endpoint - no auth needed
def check_status_via_api(enrollment_ref: str):
    """Check enrollment status via the public API."""
    response = requests.get(
        f"{BASE_URL}/api/public/status",
        params={"ref": enrollment_ref}
    )

    if response.status_code == 200:
        data = response.json()
        print(f"Status: {data['enrollment']['status']}")
        return data
    else:
        print(f"Error: {response.status_code} - {response.text}")
        return None

# Authenticated endpoint - requires Bearer token
def get_students_via_api(access_token: str):
    """List students via the admin API (requires auth)."""
    response = requests.get(
        f"{BASE_URL}/api/admin/students",
        headers={"x-supabase-auth": access_token},
        params={"page": 1, "page_size": 20, "status": "confirmed"}
    )

    if response.status_code == 200:
        data = response.json()
        for student in data["students"]:
            print(f"{student['enrollment_ref']} - {student['student_name_en']} - {student['status']}")
        return data
    else:
        print(f"Error: {response.status_code}")
        return None

# Usage
check_status_via_api("NM-2026-00042")
```

### Common Queries Reference

```python
# ─── List all tenants ────────────────────
tenants = supabase.table("tenants").select("*").execute()

# ─── Get tenant by subdomain ────────────────────
tenant = supabase.table("tenants").select("*").eq("subdomain", "nihon-moment").single().execute()

# ─── List open intakes for a tenant ────────────────────
intakes = (
    supabase.table("intakes")
    .select("*")
    .eq("tenant_id", tenant_id)
    .eq("status", "open")
    .execute()
)

# ─── Get classes with availability ────────────────────
classes = (
    supabase.table("classes")
    .select("*")
    .eq("intake_id", intake_id)
    .eq("status", "open")
    .gt("seat_remaining", 0)
    .execute()
)

# ─── Search enrollments by phone ────────────────────
enrollments = (
    supabase.table("enrollments")
    .select("*, payments(*)")
    .ilike("phone", "%09123%")
    .execute()
)

# ─── Get pending payments for verification ────────────────────
pending = (
    supabase.table("payments")
    .select("*, enrollments(enrollment_ref, student_name_en)")
    .eq("tenant_id", tenant_id)
    .eq("status", "pending")
    .execute()
)

# ─── Count enrollments by status ────────────────────
from collections import Counter
all_enrollments = supabase.table("enrollments").select("status").eq("tenant_id", tenant_id).execute()
status_counts = Counter(e["status"] for e in all_enrollments.data)
print(status_counts)
```

---

## Quick Reference Card

| What | Where |
|------|-------|
| **Production URL** | `https://kuunyi.com` |
| **Dev Database** | `fnfvwzwrdsnmwxunciti.supabase.co` |
| **Prod Database** | `nhxmumcvgnxlczjsgctz.supabase.co` (DO NOT ACCESS DIRECTLY) |
| **Dev Admin Login** | `admin@nihonmoment.com` / `NihonMoment@2026` |
| **Framework** | Next.js 14, TypeScript, Tailwind CSS |
| **Database** | Supabase (PostgreSQL) |
| **Payments** | ABank MMQR, MyanMyanPay, Manual Upload |
| **Messaging** | Telegram Bot, Facebook Messenger |
| **Email** | Resend |
| **Hosting** | Vercel (Singapore region) |
| **CI/CD** | GitHub Actions |
| **Total API Endpoints** | 70+ handlers across 54 route files |
| **Database Tables** | 14 tables + 6 RPC functions |
| **Migrations** | 65 SQL migration files |
