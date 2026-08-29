# HitPay Redirect Allowlist Plan V3 Review

**Plan reviewed:** `docs/superpowers/plans/2026-07-17-hitpay-redirect-allowlist.md`  
**Plan version:** V3  
**Review date:** 2026-07-17  
**Result:** One execution revision still required

## Executive Summary

V3 resolves all six V2 findings. The security design is now internally consistent:

- Work begins from a dedicated feature branch based on `dev`.
- Supplied redirect validation is structurally card-only.
- PayNow ignores the body field and receives `redirectUrl: undefined`.
- The fallback uses `tenantOrigin(subdomain)` and the canonical database enrollment reference.
- `request.nextUrl.origin` preserves the correct protocol and port for local, LAN, preview, and production requests.
- Full tests, lint, and build are separated at the final gate, with the existing scanner failure treated as baseline rather than a new regression.
- The final expected diff lists the complete intended file set.
- Every existing-file commit step includes status and scoped diff checks.

The plan contains exactly **29 unchecked items across six tasks**.

It is not quite safe to execute verbatim in the current workspace. The remaining findings concern PowerShell compatibility and the commit path for conditional or newly created test files—not the redirect security model.

## Findings

| Severity | Location | Finding | Required revision |
|---|---|---|---|
| **High** | Task 1 line 131, Task 2 line 169, Task 6 recheck | The plan still uses `&&`, but this workspace runs Windows PowerShell 5.1, where `&&` is a syntax error. Most importantly, Task 1's `git checkout dev && git pull...` block cannot execute, so the safety-critical branch sequence is not actually clean in the target shell. | Put every command on its own line. Do not use `&&` anywhere in the execution plan. |
| **Medium** | Task 3 verification and commit | The plan says `hitpay-create.test.ts` may need its fixture changed, but Task 3's file list, diff, staging, and commit commands include only `hitpay/route.ts`. If the fixture changes, it remains outside every commit even though Task 6 conditionally expects it in `HEAD`. | Add `src/__tests__/payments/hitpay-create.test.ts` as a conditional Task 3 file and include it in that task's diff, staging, and commit commands whenever modified. |
| **Medium** | Task 4 and Task 5 commit checks | `git diff -- <paths>` does not show untracked files. Therefore the two new test files are staged and committed without their contents appearing in the plan's pre-commit diff. This does not fully satisfy the stated review-before-commit rule. | After the deliberate `git add`, run `git diff --cached -- <all task files>` and inspect the exact staged patch before committing. Apply this pattern to every task; it naturally covers both tracked and new files. |
| **Low** | Task 1 baseline command | `npm test 2>&1 | tail -3` works only because Cygwin happens to provide `tail.exe`, and the pipeline reports `tail`'s exit status rather than Vitest's. The last three lines are also not guaranteed to contain the failing test name and pass count. | Run `npm test` directly and record its summary, or capture output while explicitly preserving the Vitest exit code. Since one failure is expected, clarity is more useful than truncation. |
| **Low** | Task 5 Step 2 | The stated red expectation names only the attacker-origin and cross-tenant tests. The existing implementation should also fail the spoofed-Host fallback and canonical database-reference cases. | State all expected failing cases so the red phase proves both untrusted paths, not only supplied redirects. |
| **Low** | Task 6 status expectation | The comment says plan/review docs and `AGENTS.md` remain untracked but omits the known modified `.claude/settings.local.json` and `design_handoff_sponsor_placements/`. | Repeat the complete known unrelated-state list from Task 1 so the final stop condition is unambiguous. |

## Verification of the Six V2 Findings

| V2 finding | V3 status | Evidence |
|---|---|---|
| Branch creation occurred after implementation commits | **Resolved** | Task 1 runs before any edit and requires `fix/hitpay-redirect-allowlist`. |
| PayNow was accidentally validated | **Resolved** | The route design gates all validation under `hitpayMethod === "card"`. |
| Manual protocol inference broke local/LAN origins | **Resolved** | Task 5 uses `request.nextUrl.origin` and adds route tests for `*.localhost`, LAN IPv4, and Vercel preview. |
| Chained final verification skipped lint/build after baseline failure | **Resolved at the final gate** | Task 5 runs test, lint, and build separately. Remaining `&&` usages still need removal for PowerShell compatibility. |
| Final expected diff was incomplete | **Resolved** | Task 6 lists all six mandatory files and the conditional fixture. |
| Pre-commit status/diff checks were absent | **Partially resolved** | Existing tracked files are checked, but new untracked test files need a staged diff before commit. |

## Required PowerShell-Safe Command Revisions

### Branch setup

Replace:

```bash
git checkout dev && git pull --ff-only origin dev
```

with separate commands:

```powershell
git checkout dev
git pull --ff-only origin dev
```

### Task 2 verification

Replace:

```bash
npm run lint && npm run build
```

with:

```powershell
npm run lint
npm run build
```

### Final recheck

Replace any remaining combined fetch/revision command with:

```powershell
git fetch origin dev
git rev-list --left-right --count origin/dev...HEAD
```

## Correct Conditional Fixture Path

Task 3 should explicitly say:

```text
Modify conditionally: src/__tests__/payments/hitpay-create.test.ts
```

Before committing:

```powershell
git status --short
git add src/app/api/public/payments/hitpay/route.ts

# Only when the fixture changed:
git add src/__tests__/payments/hitpay-create.test.ts

git diff --cached -- src/app/api/public/payments/hitpay/route.ts src/__tests__/payments/hitpay-create.test.ts
git commit -m "refactor: fetch tenant subdomain in the hitpay payment route"
```

## Correct Pre-commit Pattern

For every task:

1. Run `git status --short`.
2. Review the unstaged diff for existing files.
3. Stage only the task's explicitly listed files.
4. Run `git diff --cached -- <task files>`.
5. Confirm no unrelated files or secrets are staged.
6. Commit.

The cached diff is especially important for:

```text
src/__tests__/payments/redirect-allowlist.test.ts
src/__tests__/payments/hitpay-redirect.test.ts
```

because an ordinary unstaged `git diff` cannot display new untracked files.

## Expected Red Phase

Before enforcement, the route-level suite should fail at least these cases:

- attacker-supplied redirect origin;
- another tenant's origin;
- spoofed-Host missing-value fallback;
- fallback built from the raw rather than canonical enrollment reference.

The valid canonical-origin, PayNow-ignore, and direct supplied development-origin cases may already pass against the old route for different reasons. The post-enforcement green run is the authoritative wiring check.

## Security Design Assessment

No new security-design defect was found in V3. These decisions remain approved:

- reject invalid supplied card redirects with `400`;
- validate only card redirects;
- never forward or validate the redirect field for PayNow;
- use an exact normalized-origin comparison;
- reject credentials and malformed URLs;
- trust the tenant canonical origin in production;
- permit the request origin off production only on recognized development hosts;
- keep `platformOrigin()` out of the customer return allowlist;
- derive the fallback from trusted configuration, never the Host header;
- obtain the subdomain through the tenant-scoped enrollment join;
- keep P3 custom-domain expansion separate;
- fix staging configuration instead of widening the allowlist.

## Final Recommendation

V3's security model is ready. Revise the remaining execution instructions before saying `go`: remove all `&&` operators, give the conditional HitPay fixture a real commit path, and inspect staged diffs so new test files are reviewed before commit. After those corrections, implementation can start without another architecture review.
