# EduEnroll

**Multi-tenant enrollment management for Myanmar language schools.**

SaaS platform supporting MMK currency, bilingual Myanmar + English interface, and subdomain-based multi-tenancy.

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **Fonts**: Noto Sans + Noto Sans Myanmar (Google Fonts)
- **Database**: Supabase (PostgreSQL + Storage)
- **Auth**: Supabase Auth (@supabase/ssr)
- **Excel Export**: SheetJS (xlsx)
- **Linting**: ESLint + Prettier

## Multi-Tenancy Architecture

- **Subdomain routing**: Middleware extracts tenant slug from hostname (e.g. `nihonmoment.eduenroll.com` → slug `nihonmoment`)
- **Localhost fallback**: Use `?tenant=nihonmoment` query param for local development
- **Tenant resolution**: Middleware sets `x-tenant-slug` header → `resolveTenantId()` looks up `tenant_id` from tenants table
- **Admin routes**: `requireAuth()` resolves tenant from user profile (via Supabase session)
- **Public routes**: `resolveTenantId()` resolves tenant from middleware header
- **Skip routes**: `/register`, `/api/saas/*`, `/superadmin` bypass tenant detection

## Project Structure

```
src/
├── app/
│   ├── page.tsx                    # SaaS marketing landing page
│   ├── register/                   # School registration form (subdomain check)
│   ├── admin/                      # Admin dashboard (protected, requires auth)
│   │   ├── layout.tsx              # Auth guard + sidebar shell + ToastProvider
│   │   ├── dashboard/              # Stats overview, recent enrollments
│   │   ├── intakes/                # Intake list + create modal
│   │   │   └── [id]/               # Intake detail: classes, enrollment link
│   │   ├── students/               # Student records, filters, Excel export
│   │   ├── payments/               # Payment verification queue
│   │   ├── announcements/          # Announcement composer + history
│   │   └── settings/               # Bank accounts CRUD + school profile
│   ├── (public)/
│   │   ├── layout.tsx              # Public layout — header, footer, no sidebar
│   │   ├── status/                 # Enrollment status checker (search by ref)
│   │   └── enroll/
│   │       ├── [slug]/             # Intake landing page — class cards, bilingual
│   │       ├── form/               # Two-step enrollment form (personal info → review)
│   │       └── payment/[ref]/      # Payment instructions + proof upload
│   ├── api/
│   │   ├── saas/
│   │   │   ├── check-subdomain/    # GET — live subdomain availability check
│   │   │   └── register/           # POST — create tenant + auth user + profile
│   │   ├── intakes/                # GET/POST intakes, GET/POST classes
│   │   ├── classes/[id]/           # PATCH class
│   │   ├── admin/
│   │   │   ├── stats/              # GET dashboard stats
│   │   │   ├── students/           # GET paginated students + GET [id] detail
│   │   │   ├── payments/pending/   # GET pending payment queue
│   │   │   ├── payments/[id]/verify/ # PATCH approve/reject
│   │   │   ├── bank-accounts/      # GET/POST bank accounts
│   │   │   ├── bank-accounts/[id]/ # PATCH/DELETE bank account
│   │   │   └── announcements/      # GET/POST announcements
│   │   └── public/
│   │       ├── enroll/             # POST enrollment submission
│   │       ├── enroll/[slug]/      # GET intake + classes for public landing
│   │       ├── bank-accounts/      # GET active bank accounts (tenant-scoped)
│   │       ├── payments/upload/    # POST payment proof upload
│   │       └── status/             # GET enrollment status by ref
│   └── layout.tsx
├── components/
│   ├── ui/                         # StatusBadge, StatsCard, ConfirmModal,
│   │                               # Toast, LoadingSpinner, EmptyState
│   └── admin/                      # Sidebar (mobile + desktop), LogoutButton
├── lib/
│   ├── supabase/
│   │   ├── client.ts               # Browser client
│   │   ├── server.ts               # Server client (cookies)
│   │   └── admin.ts                # Service-role client (bypasses RLS)
│   ├── api.ts                      # requireAuth(), resolveTenantId(), badRequest(), notFound()
│   └── utils.ts                    # formatMMK, formatMyanmarPhone, etc.
└── types/
    └── database.ts                 # TypeScript types for all tables + enums
supabase/
├── config.toml                     # Supabase CLI config
└── migrations/
    ├── 000_combined_schema.sql
    ├── 001–012_*.sql               # Individual table/policy migrations
    └── 013_create_announcements.sql
```

## SaaS Pages

| Route | Description |
|-------|-------------|
| `/` | Marketing landing page — hero, 3 feature cards, "Built for Myanmar" section, CTA |
| `/register` | School registration — name EN/MM, subdomain (live availability check via debounced API), admin email, password |

## Admin Dashboard Pages

| Route | Description |
|-------|-------------|
| `/admin/dashboard` | Stats cards, seats overview, recent enrollments, 60s auto-refresh |
| `/admin/intakes` | List intakes, create new intake modal |
| `/admin/intakes/[id]` | Classes table, Add All 5 Classes, Copy Enrollment Link, edit class modal |
| `/admin/students` | Paginated table, filters (intake/level/status/search), Student Detail Modal, Excel export |
| `/admin/payments` | Pending payment card grid, fullscreen review modal, approve/reject flows |
| `/admin/announcements` | Composer (intake + class selector + message), sent history table |
| `/admin/settings` | Bank accounts CRUD (toggle active/inactive, delete), school profile, change password |

## Public Enrollment Pages

| Route | Description |
|-------|-------------|
| `/enroll/[slug]` | Intake landing page — class cards grid, level badges, Myanmar numeral fees, seats remaining, full-class overlay. Edge cases: enrollment-closed page (locked icon), all-classes-full page (orange). Loading skeleton, error state |
| `/enroll/form` | Two-step bilingual enrollment form — Step 1: personal info (name EN/MM, NRC, phone, email), Step 2: review & confirm. Posts to `/api/public/enroll`, redirects to payment page on success |
| `/enroll/payment/[ref]` | Payment instructions — enrollment ref with copy button, numbered bilingual steps, bank accounts with one-tap copy, payment proof upload with preview |
| `/status` | Enrollment status checker — search by ref (auto-fills from `?ref=`), 4 bilingual result states: pending (gold), reviewing (blue), confirmed (green), rejected (red) |

## API Endpoints

### SaaS (no auth)

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/saas/check-subdomain?slug=xxx` | Check subdomain availability → `{ available: true/false }` |
| `POST` | `/api/saas/register` | Create tenant, auth user (owner), and profile. Returns tenant info |

### Public (no auth, tenant-scoped via subdomain)

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/public/enroll/[slug]` | Classes for an intake slug (e.g. `april-2026`). Returns open+full classes, or 410 with code for closed/draft intakes |
| `POST` | `/api/public/enroll` | Submit enrollment (atomic, seat-safe via `SELECT FOR UPDATE`) |
| `POST` | `/api/public/payments/upload` | Upload payment proof (JPEG/PNG/WebP, max 5 MB) |
| `GET`  | `/api/public/bank-accounts` | Active bank accounts (tenant-scoped, minimal fields) |
| `GET`  | `/api/public/status?ref=NM-YYYY-NNNNN` | Check enrollment + payment status |

### Admin (requires Supabase session, tenant from user profile)

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/admin/stats` | Dashboard counts and seat summary |
| `GET`  | `/api/admin/students` | Paginated students with filters |
| `GET`  | `/api/admin/students/[id]` | Full student detail + payment proof signed URL |
| `GET`  | `/api/admin/payments/pending` | Payment verification queue |
| `PATCH`| `/api/admin/payments/[id]/verify` | Approve or reject a payment |
| `GET`  | `/api/admin/bank-accounts` | List bank accounts |
| `POST` | `/api/admin/bank-accounts` | Add bank account |
| `PATCH`| `/api/admin/bank-accounts/[id]` | Toggle active / update details |
| `DELETE`| `/api/admin/bank-accounts/[id]` | Delete bank account |
| `GET`  | `/api/admin/announcements` | List announcements (newest first) |
| `POST` | `/api/admin/announcements` | Save announcement to history |
| `GET`  | `/api/intakes` | List intakes |
| `POST` | `/api/intakes` | Create intake |
| `GET`  | `/api/intakes/[id]/classes` | List classes for an intake |
| `POST` | `/api/intakes/[id]/classes` | Create class |
| `PATCH`| `/api/classes/[id]` | Update class dates/status |

## Database Schema

8 tables with full Row Level Security (multi-tenant, scoped by `tenant_id`):

| Table | Description |
|-------|-------------|
| `tenants` | School organisations (name, subdomain, plan) |
| `users` | Admin staff (owner / admin roles) |
| `intakes` | Enrollment cohorts (e.g. April 2026 Intake) |
| `classes` | JLPT levels N5–N1 per intake, with seat tracking |
| `enrollments` | Student records with auto-generated `NM-YYYY-NNNNN` refs |
| `payments` | Payment proof submissions with verification status |
| `bank_accounts` | School bank accounts shown to students |
| `announcements` | Admin-composed announcements (dispatch wired in Sprint 4) |

Key patterns:
- `submit_enrollment()` — PostgreSQL RPC with `SELECT FOR UPDATE` to prevent overselling
- `trg_payments_sync_enrollment` — advances enrollment status when payment is inserted
- Storage bucket `payment-proofs` — private, tenant-scoped, signed URLs for admin access
- All API routes use `getUser()` (not `getSession()`) for server-side auth validation
- Subdomain-based multi-tenancy with middleware tenant injection

## Getting Started

1. Copy environment variables:

```bash
cp .env.local.example .env.local
```

Fill in your Supabase project URL, anon key, and service role key.

2. Link to Supabase and apply migrations:

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npm run db:migrate
```

3. Install dependencies and start the dev server:

```bash
npm install
npm run dev
```

Open [http://localhost:3005](http://localhost:3005).

For multi-tenant dev testing, use `?tenant=your-slug` query param:
```
http://localhost:3005/enroll/april-2026?tenant=nihonmoment
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server (port 3005) |
| `npm run build` | Build for production |
| `npm run lint` | Run ESLint |
| `npm run format` | Format code with Prettier |
| `npm run db:migrate` | Push pending migrations to Supabase |
| `npm run db:status` | List migration status (local vs remote) |
| `npm run db:diff` | Diff local schema vs remote (requires Docker) |
| `npm run db:reset` | Reset local database (WARNING: deletes all data) |

## Localization

The interface supports both **Myanmar (မြန်မာဘာသာ)** and **English**. Prices are displayed in **MMK (Myanmar Kyat)**.
