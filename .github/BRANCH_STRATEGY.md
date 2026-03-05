# EduEnroll Branch Strategy

## Branches

| Branch | Purpose | Vercel |
|--------|---------|--------|
| `dev` | Active development. Claude Code builds here. | Not deployed |
| `staging` | Testing branch. Vercel preview URL assigned. | Preview deploy |
| `main` | Production only. Never push directly. | `edu-enroll-xi.vercel.app` |

## Workflow for Every Change

```
dev → staging → main
```

### Step 1: Build and test on dev

```bash
npm run dev   # localhost:3005
npm run build # zero errors required
```

### Step 2: Merge dev into staging

```bash
git checkout staging
git merge dev
git push origin staging
```

### Step 3: Test on Vercel staging preview URL

- Open the Vercel preview URL for the `staging` branch
- Test enrollment flow end-to-end
- Test admin dashboard features
- Test on mobile (LAN IP or Vercel preview)

### Step 4: Run API tests against staging

```bash
BASE_URL=https://edu-enroll-xi-staging.vercel.app bash security-audit.sh
```

### Step 5: Promote to production

```bash
bash DEPLOY.sh
```

Or manually:

```bash
git checkout main
git merge staging
git push origin main
```

### Step 6: Vercel auto-deploys main to production

Monitor the deploy at [Vercel Dashboard](https://vercel.com).

## Rules

1. **Never push directly to `main`**. Always go through `staging` first.
2. **Never force-push** to `staging` or `main`.
3. All work happens on `dev`. Feature branches optional for large changes.
4. `staging` must pass build + API tests before promoting to `main`.
5. Use `DEPLOY.sh` for production deploys — it enforces a pre-deploy checklist.

## Quick Reference

```bash
# Daily development
git checkout dev
# ... make changes ...
git add -A && git commit -m "feat: description"
git push origin dev

# Promote to staging
git checkout staging && git merge dev && git push origin staging
git checkout dev

# Promote to production (after staging tests pass)
bash DEPLOY.sh

# Hotfix (emergency only)
git checkout main
git checkout -b hotfix/description
# ... fix ...
git checkout main && git merge hotfix/description && git push origin main
git checkout dev && git merge main && git push origin dev
git checkout staging && git merge dev && git push origin staging
```
