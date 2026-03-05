# EduEnroll

**Multi-tenant enrollment management platform for Myanmar language schools.**

SaaS platform supporting MMK currency, bilingual Myanmar + English interface, subdomain-based multi-tenancy, and role-based access control.

## Platform Overview

EduEnroll enables Japanese language schools in Myanmar to manage student enrollments online. Each school gets a dedicated subdomain (e.g. `nihonmoment.eduenroll.com`) with:

- **Public enrollment portal** — students browse intakes, select JLPT classes (N5–N1), submit enrollment forms, and upload payment proof
- **Admin dashboard** — school staff manage intakes, verify payments, track students, view analytics, and configure bank accounts
- **Super admin panel** — platform operators monitor all schools, suspend/activate tenants, view cross-platform stats
- **Onboarding wizard** — 4-step setup flow for new schools (profile, bank accounts, first intake, enrollment link)

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Framework** | Next.js 14 (App Router) |
| **Language** | TypeScript |
| **Styling** | Tailwind CSS |
| **Fonts** | Noto Sans + Noto Sans Myanmar (Google Fonts) |
| **Database** | Supabase (PostgreSQL + Storage + Auth) |
| **Auth** | Supabase Auth via `@supabase/ssr` |
| **Charts** | Recharts |
| **Excel Export** | SheetJS (xlsx) |
| **Deployment** | Vercel (wildcard subdomain routing) |
| **Linting** | ESLint + Prettier |

## Environment Variables

Create `.env.local` from the example:

```bash
cp .env.local.example .env.local
```

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL (e.g. `https://xxx.supabase.co`) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase anonymous/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key (server-side only, bypasses RLS) |

## Local Development Setup

### Prerequisites

- Node.js 18+
- npm 9+
- Supabase account with a project created

### Steps

1. Clone and install:

```bash
git clone <repo-url>
cd EduEnroll
npm install
```

2. Configure environment variables:

```bash
cp .env.local.example .env.local
# Fill in your Supabase project URL, anon key, and service role key
```

3. Link to Supabase and apply migrations:

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npm run db:migrate
```

4. Start the dev server:

```bash
npm run dev
```

Open [http://localhost:3005](http://localhost:3005).

5. For multi-tenant dev testing, use `?tenant=` query param:

```
http://localhost:3005/enroll/april-2026?tenant=nihonmoment
http://localhost:3005/admin/dashboard?tenant=nihonmoment
```

## Multi-Tenancy Architecture

- **Subdomain routing**: Middleware extracts tenant slug from hostname (e.g. `nihonmoment.eduenroll.com` → slug `nihonmoment`)
- **Localhost fallback**: Use `?tenant=nihonmoment` query param for local development
- **Tenant resolution**: Middleware sets `x-tenant-slug` header → `resolveTenantId()` looks up `tenant_id` from tenants table
- **Admin routes**: `requireAuth()` resolves tenant from user profile (via Supabase session)
- **Public routes**: `resolveTenantId()` resolves tenant from middleware header
- **Skip routes**: `/register`, `/api/saas/*`, `/superadmin`, `/onboarding` bypass tenant detection

See [SUBDOMAIN_SETUP.md](SUBDOMAIN_SETUP.md) for detailed Vercel wildcard domain configuration.

## Role Descriptions

| Role | Scope | Permissions |
|------|-------|-------------|
| `superadmin` | Platform-wide | View all schools, suspend/activate tenants, access super admin panel. Cannot access individual school admin dashboards. |
| `owner` | Single tenant | Full access within their school — manage staff, bank accounts, school profile, export data, view analytics. Created on registration. |
| `staff` | Single tenant | View dashboard, intakes, students, payments, announcements, analytics. Cannot access Settings, Export, or bank account management. Added via invite. |

**Enforcement layers:**
- **Server-side**: `requireOwner()` in API routes returns 403 for staff
- **Client-side**: Sidebar hides Settings for staff, Export button hidden on students page
- **Database**: RLS policies restrict staff from modifying `bank_accounts`, `tenants`, and other `users`
- **Middleware**: `/superadmin` routes protected by layout-level role check

## Project Structure

```
src/
├── app/
│   ├── page.tsx                    # SaaS marketing landing page
│   ├── login/                      # Admin login page
│   ├── register/                   # School registration form (subdomain check)
│   ├── onboarding/                 # 4-step post-registration wizard
│   ├── superadmin/                 # Super admin panel (superadmin-only)
│   │   ├── layout.tsx              # Auth guard — redirects non-superadmin
│   │   ├── page.tsx                # Schools list, stats, suspend/activate
│   │   └── schools/[id]/           # School detail page
│   ├── admin/                      # Admin dashboard (protected, requires auth)
│   │   ├── layout.tsx              # Auth guard + sidebar shell + RoleProvider
│   │   ├── dashboard/              # Stats overview, recent enrollments
│   │   ├── intakes/                # Intake list + create modal
│   │   │   └── [id]/               # Intake detail: classes, enrollment link
│   │   ├── students/               # Student records, filters, Excel export
│   │   ├── analytics/              # Recharts dashboard (trend, distribution, fill)
│   │   ├── payments/               # Payment verification queue
│   │   ├── announcements/          # Announcement composer + history
│   │   └── settings/               # Bank accounts CRUD + school profile
│   │       ├── staff/              # Staff management (owner-only)
│   │       └── billing/            # Billing placeholder (Free Beta)
│   ├── (public)/
│   │   ├── layout.tsx              # Public layout — header, footer, no sidebar
│   │   ├── status/                 # Enrollment status checker (search by ref)
│   │   └── enroll/
│   │       ├── [slug]/             # Intake landing page — class cards, bilingual
│   │       ├── form/               # Two-step enrollment form
│   │       └── payment/[ref]/      # Payment instructions + proof upload
│   ├── api/
│   │   ├── saas/
│   │   │   ├── check-subdomain/    # GET — subdomain availability check
│   │   │   └── register/           # POST — create tenant + auth user + profile
│   │   ├── superadmin/schools/     # GET list / GET [id] detail / PATCH suspend
│   │   ├── intakes/                # GET/POST intakes, GET/POST classes
│   │   ├── classes/[id]/           # PATCH class
│   │   ├── admin/
│   │   │   ├── stats/              # GET dashboard stats
│   │   │   ├── analytics/          # GET analytics (trend, distribution, fill)
│   │   │   ├── students/           # GET paginated students + GET [id] detail
│   │   │   ├── payments/pending/   # GET pending payment queue
│   │   │   ├── payments/[id]/verify/ # PATCH approve/reject
│   │   │   ├── bank-accounts/      # GET/POST bank accounts
│   │   │   ├── bank-accounts/[id]/ # PATCH/DELETE bank account
│   │   │   ├── announcements/      # GET/POST announcements
│   │   │   └── staff/              # GET list / POST invite (owner-only)
│   │   │       └── accept/         # GET accept invite token
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
│   └── admin/                      # Sidebar, LogoutButton, RoleContext
├── lib/
│   ├── supabase/
│   │   ├── client.ts               # Browser client
│   │   ├── server.ts               # Server client (cookies)
│   │   └── admin.ts                # Service-role client (bypasses RLS)
│   ├── api.ts                      # requireAuth(), requireOwner(), resolveTenantId()
│   └── utils.ts                    # formatMMK, formatMyanmarPhone, etc.
└── types/
    └── database.ts                 # TypeScript types for all tables + enums
supabase/
├── config.toml                     # Supabase CLI config
└── migrations/
    ├── 000_combined_schema.sql     # Combined initial schema
    ├── 001–013_*.sql               # Individual table/policy migrations
    └── 014_staff_roles.sql         # Staff roles, invites, RLS updates
```

## Pages

### SaaS

| Route | Description |
|-------|-------------|
| `/` | Marketing landing page — hero, feature cards, CTA |
| `/register` | School registration — name EN/MM, subdomain check, admin email/password |
| `/onboarding` | 4-step wizard — profile, bank accounts, first intake, enrollment link |

### Super Admin

| Route | Description |
|-------|-------------|
| `/superadmin` | Stats row, schools table, suspend/activate toggle |
| `/superadmin/schools/[id]` | School detail — owner, intakes, revenue, suspend modal |

### Admin Dashboard

| Route | Description |
|-------|-------------|
| `/admin/dashboard` | Stats cards, seats overview, recent enrollments, 60s auto-refresh |
| `/admin/intakes` | List intakes, create new intake modal |
| `/admin/intakes/[id]` | Classes table, Add All 5 Classes, Copy Enrollment Link |
| `/admin/students` | Paginated table, filters, Student Detail Modal, Excel export |
| `/admin/analytics` | Enrollment trend, class distribution, seat fill, date range filter |
| `/admin/payments` | Pending payment card grid, review modal, approve/reject |
| `/admin/announcements` | Composer (intake + class selector + message), sent history |
| `/admin/settings` | Bank accounts CRUD, school profile, change password |
| `/admin/settings/staff` | Staff management — list, invite via email (owner-only) |
| `/admin/settings/billing` | Free Beta placeholder |

### Public Enrollment

| Route | Description |
|-------|-------------|
| `/enroll/[slug]` | Intake landing — class cards, level badges, fees, seats remaining |
| `/enroll/form` | Two-step bilingual enrollment form |
| `/enroll/payment/[ref]` | Payment instructions + proof upload |
| `/status` | Enrollment status checker — search by ref |

## API Endpoints

### SaaS (no auth)

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/saas/check-subdomain?slug=xxx` | Check subdomain availability |
| `POST` | `/api/saas/register` | Create tenant + auth user + owner profile |

### Super Admin (superadmin role required)

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/superadmin/schools` | List all schools with stats |
| `GET`  | `/api/superadmin/schools/[id]` | School detail with intakes, revenue |
| `PATCH`| `/api/superadmin/schools/[id]` | Suspend or activate a school |

### Public (no auth, tenant-scoped via subdomain)

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/public/enroll/[slug]` | Classes for an intake |
| `POST` | `/api/public/enroll` | Submit enrollment (atomic, seat-safe) |
| `POST` | `/api/public/payments/upload` | Upload payment proof (max 5 MB) |
| `GET`  | `/api/public/bank-accounts` | Active bank accounts |
| `GET`  | `/api/public/status?ref=NM-YYYY-NNNNN` | Check enrollment + payment status |

### Admin (requires Supabase session)

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/admin/stats` | Dashboard counts and seat summary |
| `GET`  | `/api/admin/analytics` | Analytics data (trend, distribution, fill, conversion) |
| `GET`  | `/api/admin/students` | Paginated students with filters |
| `GET`  | `/api/admin/students/[id]` | Full student detail + signed proof URL |
| `GET`  | `/api/admin/payments/pending` | Payment verification queue |
| `PATCH`| `/api/admin/payments/[id]/verify` | Approve or reject a payment |
| `GET`  | `/api/admin/bank-accounts` | List bank accounts |
| `POST` | `/api/admin/bank-accounts` | Add bank account |
| `PATCH`| `/api/admin/bank-accounts/[id]` | Toggle active / update |
| `DELETE`| `/api/admin/bank-accounts/[id]` | Delete bank account |
| `GET`  | `/api/admin/announcements` | List announcements |
| `POST` | `/api/admin/announcements` | Save announcement |
| `GET`  | `/api/admin/staff` | List staff members (owner-only) |
| `POST` | `/api/admin/staff` | Create staff invite (owner-only) |
| `GET`  | `/api/admin/staff/accept?token=xxx` | Accept invite, create account |
| `GET`  | `/api/intakes` | List intakes |
| `POST` | `/api/intakes` | Create intake |
| `GET`  | `/api/intakes/[id]/classes` | List classes for intake |
| `POST` | `/api/intakes/[id]/classes` | Create class |
| `PATCH`| `/api/classes/[id]` | Update class |

## Database Schema

9 tables with full Row Level Security (multi-tenant, scoped by `tenant_id`):

| Table | Description |
|-------|-------------|
| `tenants` | School organisations (name, subdomain, plan) |
| `users` | Admin staff (superadmin / owner / staff roles) |
| `intakes` | Enrollment cohorts (e.g. April 2026 Intake) |
| `classes` | JLPT levels N5–N1 per intake, with seat tracking |
| `enrollments` | Student records with auto-generated `NM-YYYY-NNNNN` refs |
| `payments` | Payment proof submissions with verification status |
| `bank_accounts` | School bank accounts shown to students |
| `announcements` | Admin-composed announcements |
| `staff_invites` | Invite tokens for staff onboarding (7-day expiry) |

Key patterns:
- `submit_enrollment()` — PostgreSQL RPC with `SELECT FOR UPDATE` to prevent overselling
- `trg_payments_sync_enrollment` — advances enrollment status when payment is inserted
- Storage bucket `payment-proofs` — private, tenant-scoped, signed URLs for admin access
- All API routes use `getUser()` (not `getSession()`) for server-side auth validation
- `get_my_role()` — SECURITY DEFINER function for RLS policy role checks

## Deployment Guide

### Vercel

1. Push to GitHub and import the repo in Vercel
2. Set environment variables in Vercel dashboard (see [Environment Variables](#environment-variables))
3. Add wildcard domain: `*.eduenroll.com` (or `*.edu-enroll-xi.vercel.app`)
4. Deploy — Vercel auto-detects Next.js and builds

See [SUBDOMAIN_SETUP.md](SUBDOMAIN_SETUP.md) for detailed wildcard subdomain configuration.

### Supabase

1. Create a Supabase project
2. Link locally: `npx supabase link --project-ref <ref>`
3. Apply migrations: `npm run db:migrate`
4. Create the `payment-proofs` storage bucket (private)
5. Set the service role key in Vercel env vars

### Security Audit

Run the tenant isolation test to verify cross-tenant data access is blocked:

```bash
export SUPABASE_URL=https://xxx.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=xxx
bash security-audit.sh
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

The interface supports both **Myanmar** and **English**. Prices are displayed in **MMK (Myanmar Kyat)**.
