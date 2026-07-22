// Audit-H tool tests (Plan v18): state-aware classification, per-mode exit
// and remediation semantics, the Session→PI object graph, and the guards.
// The decision tables are exported pure functions — what is tested is the
// exact logic the launch gate runs.
import { describe, it, expect } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs tool module
import {
  classify,
  stripeState,
  forEveryObject,
  graphDisagreement,
  computeExit,
  decideRemediation,
  guardArgv,
  keyMode,
  EXPORT_SQL,
} from "../../../scripts/stripe-orphan-audit.mjs";

const ctx = (over?: {
  owners?: string[];
  piToSession?: [string, string][];
  conflicts?: [string, { conflict_type: string; status: string; cleanup_status: string }][];
}) => ({
  owners: new Set(over?.owners ?? []),
  piToSession: new Map(over?.piToSession ?? []),
  conflicts: new Map(over?.conflicts ?? []),
});

const pi = (id: string, status: string, metadata: Record<string, string> = {}) =>
  ({ object: "payment_intent", id, status, metadata }) as never;
const session = (id: string, status: string, payment_status = "unpaid", metadata: Record<string, string> = {}) =>
  ({ object: "checkout.session", id, status, payment_status, metadata }) as never;

describe("state mapping", () => {
  it("PI: requires_* and requires_capture are PAYABLE; canceled terminal; succeeded paid", () => {
    expect(stripeState(pi("a", "requires_payment_method"))).toBe("payable");
    expect(stripeState(pi("a", "requires_capture"))).toBe("payable");
    expect(stripeState(pi("a", "processing"))).toBe("processing");
    expect(stripeState(pi("a", "succeeded"))).toBe("paid");
    expect(stripeState(pi("a", "canceled"))).toBe("terminal");
  });

  it("Session: open payable; expired terminal; complete splits by payment_status", () => {
    expect(stripeState(session("s", "open"))).toBe("payable");
    expect(stripeState(session("s", "expired"))).toBe("terminal");
    expect(stripeState(session("s", "complete", "paid"))).toBe("paid");
    expect(stripeState(session("s", "complete", "unpaid"))).toBe("processing");
  });
});

describe("classification — state × owner × conflict", () => {
  it("owned → validate contract, regardless of state", () => {
    const e = classify(pi("pi_1", "succeeded"), ctx({ owners: ["pi_1"] }));
    expect(e.classification).toBe("owned");
  });

  it("Session-owned graph: the unsaved underlying PI is accounted for", () => {
    // The pre-settlement state of EVERY hosted payment: row owns cs_1 only.
    const e = classify(
      pi("pi_1", "requires_payment_method"),
      ctx({ owners: ["cs_1"], piToSession: [["pi_1", "cs_1"]] }),
    );
    expect(e.classification).toBe("owned");
  });

  it("conflict 'pending' → unresolved cleanup, still counts against the gate", () => {
    const e = classify(
      pi("pi_1", "requires_payment_method"),
      ctx({ conflicts: [["pi_1", { conflict_type: "x", status: "open", cleanup_status: "pending" }]] }),
    );
    expect(e.classification).toBe("conflict_pending");
  });

  it("conflict 'done' + terminal object → safe; 'done' + still-payable → flagged", () => {
    const done: [string, { conflict_type: string; status: string; cleanup_status: string }][] =
      [["pi_1", { conflict_type: "x", status: "resolved", cleanup_status: "done" }]];
    expect(classify(pi("pi_1", "canceled"), ctx({ conflicts: done })).classification).toBe("conflict_done");
    expect(classify(pi("pi_1", "requires_payment_method"), ctx({ conflicts: done })).classification)
      .toBe("conflict_done_but_not_terminal");
  });

  it("conflict 'none' is NOT automatically safe — classified from Stripe state", () => {
    const e = classify(
      pi("pi_1", "requires_payment_method"),
      ctx({ conflicts: [["pi_1", { conflict_type: "x", status: "open", cleanup_status: "none" }]] }),
    );
    expect(e.classification).toBe("orphan_payable");
  });

  it("unowned by state: payable→cancel · processing→launch stop · paid→critical · terminal→record only", () => {
    expect(classify(pi("a", "requires_payment_method"), ctx()).action).toBe("cancel");
    expect(classify(pi("a", "processing"), ctx()).action).toBe("launch_stop_monitor");
    expect(classify(pi("a", "succeeded"), ctx()).action).toBe("critical_reconcile_refund");
    expect(classify(pi("a", "canceled"), ctx()).action).toBe("record_only");
  });
});

describe("object graph disagreement", () => {
  it("Session vs PI metadata mismatch → reported, field named", () => {
    const d = graphDisagreement(
      session("cs_1", "open", "unpaid", { integration_flow: "hosted_checkout", enrollment_id: "e1" }),
      pi("pi_1", "requires_payment_method", { integration_flow: "direct_payment_intent", enrollment_id: "e1" }),
    );
    expect(d).toEqual({ sessionId: "cs_1", paymentIntentId: "pi_1", field: "integration_flow" });
  });

  it("agreement (or one side silent) → null", () => {
    expect(graphDisagreement(
      session("cs_1", "open", "unpaid", { enrollment_id: "e1" }),
      pi("pi_1", "requires_payment_method", {}),
    )).toBeNull();
  });

  it("any disagreement forces nonzero exit — mutation on a wrong model compounds it", () => {
    expect(computeExit("detect", [], [{ sessionId: "s", paymentIntentId: "p", field: "tenant_id" }])).toBe(1);
  });
});

describe("exit semantics, per mode", () => {
  const entry = (classification: string) => ({ classification }) as never;

  it("legacy-detect: payable/processing/paid backlog → 1; clean slate → 0", () => {
    expect(computeExit("legacy-detect", [entry("orphan_payable")], [])).toBe(1);
    expect(computeExit("legacy-detect", [entry("orphan_processing")], [])).toBe(1);
    expect(computeExit("legacy-detect", [entry("orphan_paid")], [])).toBe(1);
    expect(computeExit("legacy-detect", [entry("orphan_terminal"), entry("owned"), entry("conflict_done")], [])).toBe(0);
  });

  it("detect: any such orphan is an incident (1); pending cleanup counts", () => {
    expect(computeExit("detect", [entry("conflict_pending")], [])).toBe(1);
    expect(computeExit("detect", [entry("owned")], [])).toBe(0);
  });
});

describe("remediation decisions, per report mode", () => {
  const payable = (owner: string | null) =>
    ({ id: "pi_1", state: "payable", classification: "orphan_payable", ownerPaymentId: owner }) as never;

  it("legacy: owned payable, SAME owner in fresh export → allowed, owner queued for reconciliation", () => {
    const d = decideRemediation("legacy-detect", payable("pay-1"), "pay-1", null, null);
    expect(d.allow).toBe(true);
    expect(d.reconcileOwner).toBe("pay-1");
  });

  it("legacy: owner CHANGED (new, removed, or different row) → refused", () => {
    expect(decideRemediation("legacy-detect", payable("pay-1"), "pay-2", null, null).allow).toBe(false);
    expect(decideRemediation("legacy-detect", payable("pay-1"), null, null, null).allow).toBe(false);
    expect(decideRemediation("legacy-detect", payable(null), "pay-9", null, null).allow).toBe(false);
  });

  it("legacy: unowned remains unowned → allowed", () => {
    expect(decideRemediation("legacy-detect", payable(null), null, null, null).allow).toBe(true);
  });

  it("recurring: orphan gains an owner → refused", () => {
    expect(decideRemediation("detect", payable(null), "pay-new", null, null).allow).toBe(false);
  });

  it("recurring: conflict status changed since the report → refused", () => {
    const d = decideRemediation(
      "detect", payable(null), null,
      { conflict_type: "x", status: "open", cleanup_status: "pending" } as never,
      { conflict_type: "x", status: "open", cleanup_status: "none" } as never,
    );
    expect(d.allow).toBe(false);
  });

  it("processing/paid are escalations — never remediated regardless of mode", () => {
    const processing = { id: "pi_1", state: "processing", classification: "orphan_processing" } as never;
    expect(decideRemediation("legacy-detect", processing, null, null, null).allow).toBe(false);
    expect(decideRemediation("detect", processing, null, null, null).allow).toBe(false);
  });
});

describe("guards", () => {
  it("keys in argv are refused — env only", () => {
    expect(() => guardArgv(["--key", "sk_test_abc123"])).toThrow(/never argv/);
    expect(() => guardArgv(["--key", "rk_live_abc123"])).toThrow(/never argv/);
    expect(() => guardArgv(["--report", "out.json"])).not.toThrow();
  });

  it("key mode derives from the key shape; garbage refuses", () => {
    expect(keyMode("sk_test_x")).toBe("test");
    expect(keyMode("rk_live_x")).toBe("live");
    expect(() => keyMode("whsec_x")).toThrow();
  });

  it("export SQL names id+type+status+cleanup_status for conflicts — classification needs them", () => {
    expect(EXPORT_SQL).toContain("cleanup_status");
    expect(EXPORT_SQL).toContain("conflict_type");
    expect(EXPORT_SQL).toContain("stripe_payment_intent_id");
    expect(EXPORT_SQL).toContain("stripe_session_id");
  });

  it("report entries carry no secret-shaped strings by construction", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/stripe-orphan-audit.mjs", "utf8");
    // The report writer serialises only classification fields — client_secret
    // is never read anywhere in the tool.
    expect(src).not.toMatch(/client_secret/);
  });
});

describe("pagination — the orphan on page 2 is found", () => {
  it("iterates EVERY page of both listings, never first-page-only", async () => {
    // Async iterables spanning 3 "pages" of 100; the orphan sits at index 250.
    const piIds: string[] = [];
    const csIds: string[] = [];
    async function* pis() {
      for (let i = 0; i < 250; i++) yield { object: "payment_intent", id: `pi_${i}`, status: "canceled", metadata: {} };
      yield { object: "payment_intent", id: "pi_page3_orphan", status: "requires_payment_method", metadata: { integration_namespace: "eduenroll" } };
    }
    async function* sessions() {
      for (let i = 0; i < 150; i++) yield { object: "checkout.session", id: `cs_${i}`, status: "expired", payment_status: "unpaid", metadata: {} };
    }
    const fake = {
      paymentIntents: { list: () => pis() },
      checkout: { sessions: { list: () => sessions() } },
    };
    await forEveryObject(fake, (obj: { object: string; id: string }) => {
      if (obj.object === "payment_intent") piIds.push(obj.id);
      else csIds.push(obj.id);
    });
    expect(piIds).toHaveLength(251);
    expect(csIds).toHaveLength(150);
    expect(piIds).toContain("pi_page3_orphan");
  });
});

describe("namespace blindness — why legacy-detect exists (asserted both ways)", () => {
  it("a legacy payable (tenant metadata, no namespace) matches the legacy sweep and NOT the namespace filter", () => {
    const legacy = pi("pi_old", "requires_payment_method", { tenant_id: "t1", enrollment_id: "e1" });
    const m = (legacy as { metadata: Record<string, string> }).metadata;
    // detect's selector:
    expect(m.integration_namespace === "eduenroll").toBe(false);
    // legacy-detect's sweep selector:
    expect(!m.integration_namespace && Boolean(m.tenant_id || m.enrollment_id)).toBe(true);
  });

  it("a v14+ object matches the namespace filter and not the legacy sweep", () => {
    const modern = pi("pi_new", "requires_payment_method", {
      integration_namespace: "eduenroll", tenant_id: "t1", enrollment_id: "e1",
    });
    const m = (modern as { metadata: Record<string, string> }).metadata;
    expect(m.integration_namespace === "eduenroll").toBe(true);
    expect(!m.integration_namespace && Boolean(m.tenant_id)).toBe(false);
  });
});
