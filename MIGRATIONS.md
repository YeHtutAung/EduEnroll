# Database Migrations — EduEnroll

Supabase project: `nhxmumcvgnxlczjsgctz`
Migrations live in: `supabase/migrations/`

## Workflow

### Create a new migration
```bash
npx supabase migration new <name>
# Example: npx supabase migration new add_notifications_table
```
This creates a timestamped file in `supabase/migrations/`. Write your SQL there.

### Apply pending migrations to remote
```bash
npm run db:migrate
# or: npx supabase db push
```

### Check migration status
```bash
npm run db:status
# Shows which migrations have been applied vs pending
```

### Diff local schema vs remote
```bash
npm run db:diff
# Requires Docker for local shadow database
```

### Reset database (local only)
```bash
npm run db:reset
# WARNING: deletes all data — local dev only, never run against production
```

## Migration naming

Files use the format `NNN_description.sql` (e.g. `013_create_announcements.sql`).
> Note: Supabase CLI expects timestamp-prefixed filenames (`YYYYMMDDHHMMSS_name.sql`)
> for automatic tracking via `supabase db push`. For manual execution, paste SQL
> directly into the Supabase Dashboard → SQL Editor.

## Current migrations

| # | File | Description |
|---|------|-------------|
| 000 | combined_schema.sql | Full baseline schema |
| 001 | create_tenants.sql | Tenants table + RLS |
| 002 | create_users.sql | Users / profiles table |
| 003 | create_intakes.sql | Intake cohorts |
| 004 | create_classes.sql | JLPT level classes |
| 005 | create_enrollments.sql | Student enrollments |
| 006 | create_payments.sql | Payment records |
| 007 | create_bank_accounts.sql | Bank account management |
| 008 | create_enrollment_functions.sql | RPC helpers |
| 009 | create_storage_bucket.sql | Payment proof storage |
| 010 | seed_bank_accounts.sql | Default bank accounts |
| 011 | create_expiry_function.sql | Enrollment expiry cron |
| 012 | add_bank_account_delete_policy.sql | RLS policy fix |
| 013 | create_announcements.sql | Announcements table + RLS |
