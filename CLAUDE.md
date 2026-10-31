# Claude Code Project Rules

## Git Rules
- NEVER push directly to `main` or `staging` branches
- ALWAYS create feature branch from `dev`
- ALWAYS create PR for review — never merge yourself
- NEVER use `git push --force` on any protected branch
- ALWAYS run `git diff` before committing

## Supabase Rules
- NEVER run `supabase link --project-ref nhxmumcvgnxlczjsgctz` (production)
- NEVER run `supabase link --project-ref kbiszegobsbelzbyyfvo` (Rexiee)
- ONLY work with `fnfvwzwrdsnmwxunciti` (EduEnroll-dev)
- NEVER run `supabase db reset` without explicit confirmation
- NEVER run `supabase db push` without showing migration diff first

## Vercel Rules
- NEVER run `vercel --prod`
- NEVER run `vercel env pull`
- NEVER run `vercel remove`
- Deployments to production are handled by CI/CD only

## GitHub Rules
- NEVER modify `.github/workflows/` files without explicit confirmation
- NEVER push secrets or API keys in any commit
- ALWAYS check `git status` before committing

## Environment Variables
- NEVER log or print actual key values
- NEVER hardcode any API keys in source code
- ALL secrets must come from environment variables only
- DEV keys → .env.local only
- PROD keys → Vercel Production env vars only

## Database Rules
- NEVER run destructive queries on any DB without explicit confirmation
- ALWAYS show the SQL query before executing
- NEVER access production DB (Mumbai) directly
- DEV DB ref: fnfvwzwrdsnmwxunciti (Singapore)
- PROD DB ref: nhxmumcvgnxlczjsgctz (Mumbai) — OFF LIMITS

## General Safety
- ALWAYS ask for confirmation before any destructive action
- ALWAYS prefer reversible actions over irreversible ones
- When in doubt — STOP and ask

## Deployment Workflow
- NEVER deploy directly to production
- Feature branches → PR to staging → test → PR to main → CI/CD deploys
- YOU must review and merge all PRs manually
- NEVER merge your own PRs without review

## Status Reporting
- ALWAYS report PR / task status split into three parts:
  1. **Claude Code** — what Claude Code did, and what it will do next
  2. **Codex** — what Codex (ChatGPT) reviewed or found, and any review to trigger (`@codex review` on the PR)
  3. **Human** — what the owner must do (apply migrations, merge PRs, Vercel / DNS / env settings), marked Required or Optional, in order
- Use this whenever reporting where a PR or change stands, and at the end of any task that needs human follow-up

## Client Work
- Facts about active clients (tenants) live in `docs/clients/<slug>.md`
- Use the `tenant-ops` agent for client-specific investigations
