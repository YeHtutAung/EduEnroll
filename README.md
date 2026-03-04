# EduEnroll — Nihon Moment

**Nihon Moment — Japanese Language School Enrollment System**

Built in Myanmar, supports MMK currency and Myanmar + English bilingual interface.

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **Fonts**: Noto Sans + Noto Sans Myanmar (Google Fonts)
- **Database**: Supabase (PostgreSQL + Storage)
- **Auth**: Supabase Auth (@supabase/ssr)
- **Linting**: ESLint + Prettier

## Project Structure

```
src/
├── app/
│   ├── (admin)/              # Admin dashboard routes (protected)
│   │   └── dashboard/        # Placeholder — Sprint 3
│   ├── (public)/
│   │   └── enroll/           # Public enrollment flow
│   ├── api/
│   │   ├── intakes/          # Admin: intake CRUD
│   │   ├── classes/          # Admin: class CRUD
│   │   └── public/
│   │       ├── enroll/       # POST /api/public/enroll — submit enrollment
│   │       ├── payments/
│   │       │   └── upload/   # POST /api/public/payments/upload — proof upload
│   │       └── status/       # GET /api/public/status?ref= — enrollment status
│   └── layout.tsx
├── components/
│   ├── ui/                   # Shared UI primitives
│   ├── admin/                # Admin-specific components
│   └── enrollment/           # Enrollment form components
├── lib/
│   ├── supabase/
│   │   ├── client.ts         # Browser client (createBrowserClient)
│   │   ├── server.ts         # Server client (createServerClient + cookies)
│   │   └── admin.ts          # Service-role client (bypasses RLS)
│   ├── api.ts                # requireAuth(), badRequest(), notFound() helpers
│   └── utils.ts              # formatMMK, formatMyanmarPhone, etc.
└── types/
    └── database.ts           # Full TypeScript types for all 7 tables + RPCs
supabase/
└── migrations/
    ├── 000_combined_schema.sql             # Full schema (all tables, RLS, triggers)
    ├── 008_create_enrollment_functions.sql # submit_enrollment() atomic RPC
    └── 009_create_storage_bucket.sql       # payment-proofs private storage bucket
```

## Public API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/public/enroll/[slug]` | Intake + open classes for a given intake slug (e.g. `april-2026`) |
| `POST` | `/api/public/enroll` | Submit a new enrollment (atomic, seat-safe) |
| `POST` | `/api/public/payments/upload` | Upload payment proof image (JPEG/PNG/WebP, max 5 MB) |
| `GET`  | `/api/public/status?ref=NM-2026-XXXXX` | Check enrollment + payment status |

## Database Schema

7 tables with full Row Level Security (multi-tenant):

| Table | Description |
|-------|-------------|
| `tenants` | School organisations (multi-tenant) |
| `users` | Admin staff (owner / admin roles) |
| `intakes` | Enrollment periods (e.g. April 2026 Intake) |
| `classes` | JLPT levels N5–N1 within an intake, with seat tracking |
| `enrollments` | Student enrollment records with auto-generated `NM-YYYY-NNNNN` refs |
| `payments` | Payment proof submissions with verification status |
| `bank_accounts` | School bank accounts shown to students at enrollment |

Key design patterns:
- `submit_enrollment()` — PostgreSQL function using `SELECT FOR UPDATE` to prevent overselling seats
- `trg_payments_sync_enrollment` — auto-advances enrollment status when a payment is inserted
- Storage bucket `payment-proofs` — private, tenant-scoped paths, signed URLs for admin access

## Getting Started

1. Copy environment variables:

```bash
cp .env.local.example .env.local
```

Fill in your Supabase project URL, anon key, and service role key.

2. Apply migrations in Supabase SQL Editor (in order):
   - `supabase/migrations/000_combined_schema.sql`
   - `supabase/migrations/008_create_enrollment_functions.sql`
   - `supabase/migrations/009_create_storage_bucket.sql`

3. Install dependencies and start the dev server:

```bash
npm install
npm run dev
```

Open [http://localhost:3005](http://localhost:3005) in your browser.

## Scripts

| Command          | Description               |
|------------------|---------------------------|
| `npm run dev`    | Start dev server (port 3005) |
| `npm run build`  | Build for production      |
| `npm run lint`   | Run ESLint                |
| `npm run format` | Format code with Prettier |

## Localization

The interface supports both **Myanmar (မြန်မာဘာသာ)** and **English**. Prices are displayed in **MMK (Myanmar Kyat)** with Myanmar numeral formatting (e.g. `၃၀၀,၀၀၀ MMK`).
