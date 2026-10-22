# Database Migrations — KuuNyi

Migrations live in: `supabase/migrations/`
Rollbacks live in: `supabase/rollbacks/` (run by hand only — see below)

## Projects

| Supabase project | Ref | Used by |
|------------------|-----|---------|
| EduEnroll-dev (Singapore) | `fnfvwzwrdsnmwxunciti` | `dev` **and** `staging` deployments |
| Production (Mumbai) | `nhxmumcvgnxlczjsgctz` | `main` — **off limits** to Claude Code |

There is no separate staging database: `dev` and `staging` both read the dev
project. "Migrate staging" means migrating `fnfvwzwrdsnmwxunciti`, and a
migration applied there is live for both deployments at once.

Production migrations are applied by the owner as part of the `staging` → `main`
promotion, never by linking a working copy to the production ref.

## Applying migrations to dev / staging

```bash
# 1. Be on the branch whose migrations you are applying
git checkout staging && git pull origin staging

# 2. Log in and link — dev ref only
npx supabase login
npx supabase link --project-ref fnfvwzwrdsnmwxunciti
cat supabase/.temp/project-ref        # must print fnfvwzwrdsnmwxunciti — stop otherwise

# 3. Inspect
npm run db:status                     # npx supabase migration list
npx supabase db push --dry-run        # must list only the migrations you expect

# 4. Read the SQL of each pending file, then apply
npm run db:migrate                    # npx supabase db push

# 5. Verify and unlink
npm run db:status                     # Local and Remote columns match on every row
npx supabase unlink
```

Always apply through `db push` from the repo. Running a migration's SQL in the
Dashboard SQL Editor (or an MCP `apply_migration`) records it under a new
timestamp, and the history stops matching the files.

### Repairing out-of-sync history

Symptom: `migration list` shows a version only under **Local** next to a
different version only under **Remote**, and `db push` refuses with
"Remote migration versions not found in local migrations directory".

1. Read the remote names (read-only):
   ```sql
   select version, name from supabase_migrations.schema_migrations order by version desc limit 20;
   ```
2. Confirm the local migration's schema changes really are on the database
   (columns, constraints, function bodies). `repair` only edits the history
   table — it never runs SQL.
3. Only if they match:
   ```bash
   npx supabase migration repair --status reverted <remote-only versions>
   npx supabase migration repair --status applied  <local versions>
   ```
4. `npm run db:status` — every row should have both columns filled.

## Creating a migration

```bash
npx supabase migration new <name>
# Example: npx supabase migration new add_notifications_table
```

New files use the timestamp format `YYYYMMDDHHMMSS_name.sql`. Files `000`–`085`
use the older `NNN_name.sql` format; leave them as they are.

If a migration may need reverting, add a matching
`supabase/rollbacks/<timestamp>_<name>.down.sql`. Rollbacks stay outside
`supabase/migrations/` so `db push` never applies them; run one by hand against
a single database, after reverting the code.

## Other commands

```bash
npm run db:diff    # npx supabase db diff — needs Docker for the shadow database
npm run db:reset   # npx supabase db reset — LOCAL STACK ONLY, deletes all data
```

Never run `db reset` while linked to a remote project, and never without
explicit confirmation.
