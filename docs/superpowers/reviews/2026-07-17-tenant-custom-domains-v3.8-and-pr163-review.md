# Tenant Custom Domains V3.8 and PR #163 Review

## Executive Decision

| Item | Decision | Next action |
|---|---|---|
| Custom-domain plan V3.8 | **Approved for implementation** | Tasks 1–8 may begin. Keep production DNS/env blocked on P1–P3. |
| PR #163 — ABank callback verification | **Changes requested before approval** | Remove unauthenticated callback fallbacks from financial/audit fields and add one route-level wiring test. |
| P2 — HitPay base redirect allowlist | **Highest remaining critical-path implementation** | Plan and implement immediately after the small PR #163 correction. |
| F2 — tenant header/agent contract | **Create durable issue now** | Open and assign the issue before the custom-domain PR is allowed to merge. |

If only one substantial new workstream can start after PR #163 is corrected, choose **P2**. Tasks 1–8 are implementation-ready but cannot unlock production without P2 and P3. F2 issue creation is small enough to do immediately rather than scheduling it as a competing engineering stream.

## Plan V3.8 Review

**Approved. No plan revision is required.**

V3.8 incorporates the final optional V3.7 test-isolation improvement:

- `MMPAY_MODE` is saved and restored delete-aware.
- The MMQR test explicitly deletes `MMPAY_MODE` to force the sandbox branch.
- ABank and MMQR callback tests mock tenant resolution, send valid JSON requests, and require payable enrollment fixtures.
- All prior host-aware middleware, environment restoration, payment callback, preflight, and rollout findings remain resolved.

Verified plan state:

- Eight numbered tasks.
- 70 unchecked items and zero checked items.
- The confirmed production tenant slug is `flashtic`; the document is specific implementation guidance rather than a placeholder template.
- No tracked implementation file was modified by the plan update.

### Plan security posture

- Custom domains resolve only through an explicit map.
- Unknown production hosts cannot use generic inference or development fallbacks.
- Staff and privileged surfaces remain on platform-controlled hosts.
- ABank and MMQR callbacks move to the platform origin.
- HitPay custom-domain support requires P2 and P3 separately.
- The dev preflight refuses non-EduEnroll-dev Supabase hosts before constructing the service-role client.
- Production tenant/domain ownership remains a human superadmin verification.
- F2 remains deliberately outside this feature but is a merge gate, not optional debt.

## PR #163 Review

PR: [fix: verify ABank callbacks against the provider before confirming](https://github.com/YeHtutAung/EduEnroll/pull/163)

### Verdict

**The core security fix is correct, but request changes before merge.**

The previous confirmation bypass is closed because the handler now:

1. Looks up the local payment by `payment_ref`.
2. Calls `abank.enquiryOrder(orderId)` server-to-server.
3. Requires `verifyEnquiry()` to return `success` before verifying the payment and confirming the enrollment.
4. Rejects provider failure, amount mismatch, and an echoed mismatched order ID.
5. Leaves pending/refunded/not-found/unrecognized enquiry states non-confirming.

Caller-supplied `status` and `errorCode` no longer decide whether payment succeeded. That is the essential security correction.

### Findings

| Severity | Finding | Impact | Required correction |
|---|---|---|---|
| **Medium** | After authoritative success, `paid_at` still comes from caller-controlled `transactionDateTime`. | A caller who knows their order ID cannot forge payment success, but can forge financial timing/reporting data once ABank reports the payment successful. `paid_at` is not merely cosmetic. | Use a trusted provider enquiry timestamp if ABank supplies one; otherwise use server time. Never use the callback query timestamp. |
| **Medium** | `bank_reference` and `payer_institution` fall back to callback query parameters when ABank omits those fields. | A successful payer can inject false reference/institution values into audit data. This contradicts the PR's stated boundary that callback values do not control trusted data. | Persist only `verdict.transactionId` and `verdict.institutionName`; use a neutral value or `null` when absent. |
| **Medium** | Tests cover the pure `verifyEnquiry()` decision but not route wiring. | A future handler regression could bypass the verifier, use callback fields again, or update state before enquiry while all 13 pure-function tests still pass. | Add a route-level test that mocks enquiry/admin dependencies and proves forged callback success remains pending when ABank says pending, then confirms only when ABank says success. |
| **Low** | PR description says verification “requires a matching orderId,” but the implementation accepts an enquiry that omits `orderId`; a test explicitly pins that behavior. | The documentation overstates validation and may mislead future reviewers. The enquiry URL itself is scoped by order ID, so this is not currently a confirmed bypass. | Either require an echoed order ID after UAT confirms it is always present, or document that a present echo must match while an absent echo relies on the scoped enquiry request. |
| **Low** | The handler logs the full unauthenticated callback parameter object. | User-controlled values enter application logs and can create noisy or misleading audit output. | Log only bounded identifiers and the authoritative verdict, or sanitize/truncate callback values. |

### Recommended success write

If enquiry data has no trusted transaction timestamp:

```typescript
await supabase
  .from("payments")
  .update({
    mmqr_status: "SUCCESS",
    status: "verified",
    paid_at: new Date().toISOString(),
    bank_reference: verdict.transactionId
      ? `CB:${verdict.transactionId}`
      : "CB:verified",
    payer_institution: verdict.institutionName ?? null,
  } as never)
  .eq("id", payment.id);
```

If UAT confirms the enquiry response includes a provider transaction time, add that typed field to `EnquiryData`, validate it, and prefer it over server time.

Do not fall back to:

- `params.transactionDateTime`
- `params.transactionId`
- `params.endToEndId`
- `params.institutionName`

Those values are unauthenticated input.

### Required route-level cases

At minimum:

1. Callback says success, ABank enquiry says pending → no payment/enrollment confirmation.
2. Callback contains forged transaction metadata, ABank enquiry says success without metadata → stored audit fields do not contain callback values.
3. ABank enquiry says success with matching order/amount → payment verified and enrollment confirmed.
4. ABank enquiry throws → `502`, no state mutation.
5. ABank enquiry returns mismatched amount/order → no confirmation.

The existing pure-function tests should remain; the route tests complement rather than replace them.

## Verification Evidence

### GitHub state

- PR #163 is open, non-draft, mergeable, and targets `dev`.
- Head commit: `3c8907fd10aa125b26f08bded6b4fd93f9ba1074`.
- Three files changed, one commit, 235 additions, 21 deletions.
- Vercel status: success; preview deployment ready.
- No submitted GitHub reviews were present at inspection time.

### Local validation on the PR branch

| Check | Result |
|---|---|
| `npx vitest run src/__tests__/lib/abank.test.ts` | **Pass:** 13/13 |
| `npm test` | **238 pass, 1 fail** |
| Failing test | `src/__tests__/scanner/events.test.ts` |
| PR relationship to failure | Scanner test and implementation are unchanged by PR #163; failure matches the documented baseline issue. |
| `npm run lint` | **Pass:** no warnings or errors |
| `npm run build` | **Pass:** compiled, type-checked, and generated pages successfully |
| `git diff --check origin/dev...HEAD` | **Pass:** no whitespace errors |

The build emitted non-blocking Google Fonts optimization warnings because remote stylesheets could not be downloaded; compilation still completed successfully.

## Recommended Work Order

### 1. Correct and merge P1 — PR #163

Make the audit-field and route-test corrections above, rerun targeted tests, full tests, lint, and build, then obtain human review and merge to `dev`. This closes a live confirmation bypass and is independently valuable.

### 2. Open the durable F2 issue immediately

This is a quick governance action rather than the next engineering project. The issue should contain:

- current inbound `x-tenant-slug` trust behavior;
- agent HMAC tenant-binding gap;
- preferred host-derived tenant contract;
- bot migration requirement;
- replay/cross-tenant tests;
- owner and priority.

Record its URL in the V3.8 plan before the custom-domain PR merges.

### 3. Implement P2 — HitPay base redirect allowlist

P2 is the next critical-path engineering item because:

- the current handler accepts a client-provided redirect URL;
- P3 cannot be written accurately until P2's actual shape exists;
- production custom-domain rollout requires both P2 and P3;
- Tasks 1–8 alone cannot unblock DNS.

P2 should use parsed, exact origin comparison—not prefixes or substring matching—and should allow only the platform and correct tenant origin. Reject credential-bearing URLs, lookalike hosts, non-HTTPS production origins, malformed URLs, and cross-tenant origins.

### 4. Implement Tasks 1–8

The custom-domain implementation may proceed before or alongside P2 if capacity permits. It is approved and independent at code level. Keep its branch and commits separate from P1/P2, and do not stage unrelated untracked files.

### 5. Rewrite and implement P3 after P2 merges

Inspect the real merged P2 handler, then rewrite F1/P3 against that code. Add mapped-custom-origin acceptance and cross-tenant rejection tests.

### 6. Production rollout only after P1–P3

No DNS or production `TENANT_CUSTOM_DOMAINS` configuration until P1, P2, and P3 are merged and deployed and the V3.8 verification checklist is complete.

## Repository Hygiene

The current branch is `fix/abank-callback-verification`.

Known working-tree items outside the PR patch include:

- modified `.claude/settings.local.json`;
- untracked `AGENTS.md`;
- untracked `design_handoff_sponsor_placements/`;
- untracked custom-domain plan and review documents.

When documentation is eventually committed, stage explicit paths. Do not use `git add -A`.

## Final Recommendation

1. **Do not merge PR #163 unchanged.** Remove callback-derived audit fields and add route-level verification.
2. **After that small correction, prioritize merging P1.**
3. **Open the durable F2 issue immediately.**
4. **Point the next substantial planning/implementation effort at P2.**
5. **Tasks 1–8 are approved and may begin in parallel or immediately afterward.**

No GitHub review, issue, merge, commit, or code change was submitted as part of this review.
