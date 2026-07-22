// stripe-orphan-audit.mjs — Plan v18 audit H, the launch gate for reopening
// (no shebang: vite-node imports this module in tests and rejects `#!`;
//  invoke as `node scripts/stripe-orphan-audit.mjs ...`)
// sales. Three commands:
//
//   legacy-detect  one-time historical inventory (deployment steps 6/9).
//                  Starts from EXPORTED payment provider ids and retrieves
//                  them directly, traverses Session → PaymentIntent, and
//                  additionally sweeps for objects carrying legacy
//                  tenant/enrollment metadata WITHOUT the namespace — the
//                  residue of provider-creation-then-failed-insert that no
//                  database export can name. Payables here are the EXPECTED
//                  WORKLOAD: nonzero exit means "work remains".
//
//   detect         recurring post-launch sweep by
//                  metadata.integration_namespace = 'eduenroll' (only correct
//                  for objects created after v14+ code). Any payable/
//                  processing/paid orphan is an ANOMALY: nonzero exit is an
//                  incident signal.
//
//   remediate      cancels REVIEWED payable orphans only. Requires the report
//                  file, a FRESH ownership export (a Stripe re-fetch cannot
//                  see a row that appeared after the first export), explicit
//                  account/mode/count confirmation, and re-fetches every
//                  object immediately before mutating. Batch is allowed for
//                  legacy-detect reports only; detect reports are per-object
//                  with a root-cause note. Runs only under route containment
//                  (STRIPE_SALES_OPEN not "true" — operator-verified).
//
//   print-sql      prints the exact export SQL for the database half. The
//                  tool has NO database connection, by construction.
//
// The key comes from STRIPE_AUDIT_KEY or STRIPE_SECRET_KEY in the
// environment, NEVER argv (argv leaks into shell history and process lists).
// Output is sanitized: ids, states, classifications, timestamps — never
// client secrets or customer data.

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);

export const NAMESPACE = "eduenroll";

// ── Pure: classification (state × database owner) ───────────────────────────
// "Present in the conflict table" is never automatically safe: a 'pending'
// cleanup row describes an object that is still payable.

export function stripeState(obj) {
  if (obj.object === "checkout.session") {
    if (obj.status === "open") return "payable";
    if (obj.status === "expired") return "terminal";
    if (obj.status === "complete") {
      return obj.payment_status === "paid" ? "paid" : "processing";
    }
    return "unknown";
  }
  // payment_intent
  if (obj.status === "succeeded") return "paid";
  if (obj.status === "canceled") return "terminal";
  if (obj.status === "processing") return "processing";
  return "payable"; // requires_* / requires_capture: can still take money
}

/**
 * @param obj        Stripe object (payment_intent or checkout.session)
 * @param owners     Set of provider ids owned by payment rows (BOTH columns)
 * @param sessionOwners Map sessionId → true for rows owning the Session — a
 *                   row owning the Session accounts for its underlying PI
 *                   even when stripe_payment_intent_id was never saved (the
 *                   pre-settlement state of every hosted payment).
 * @param piToSession Map paymentIntentId → sessionId (the object graph)
 * @param conflicts  Map objectId → {conflict_type, status, cleanup_status}
 */
export function classify(obj, { owners, piToSession, conflicts }) {
  const state = stripeState(obj);
  const id = obj.id;

  let owned = owners.has(id);
  if (!owned && obj.object === "payment_intent") {
    const sess = piToSession.get(id);
    if (sess && owners.has(sess)) owned = true; // Session-owned graph
  }

  const conflict = conflicts.get(id) ?? null;

  if (owned) return { id, state, classification: "owned", action: "validate_contract" };

  if (conflict) {
    if (conflict.cleanup_status === "pending") {
      return { id, state, classification: "conflict_pending", action: "unresolved_cleanup" };
    }
    if (conflict.cleanup_status === "done") {
      return state === "terminal"
        ? { id, state, classification: "conflict_done", action: "none" }
        : { id, state, classification: "conflict_done_but_not_terminal", action: "flag" };
    }
    // 'none': evaluated is not proven safe — classify from Stripe state.
  }

  switch (state) {
    case "payable":
      return { id, state, classification: "orphan_payable", action: "cancel" };
    case "processing":
      return { id, state, classification: "orphan_processing", action: "launch_stop_monitor" };
    case "paid":
      return { id, state, classification: "orphan_paid", action: "critical_reconcile_refund" };
    case "terminal":
      return { id, state, classification: "orphan_terminal", action: "record_only" };
    default:
      return { id, state, classification: "unknown_state", action: "flag" };
  }
}

/** Session + its PI audited together; metadata disagreement → report, STOP. */
export function graphDisagreement(session, pi) {
  if (!session || !pi) return null;
  const sm = session.metadata ?? {};
  const pm = pi.metadata ?? {};
  const keys = ["integration_flow", "tenant_id", "enrollment_id"];
  for (const k of keys) {
    if (sm[k] && pm[k] && sm[k] !== pm[k]) {
      return { sessionId: session.id, paymentIntentId: pi.id, field: k };
    }
  }
  return null;
}

// ── Pure: exit semantics, per mode ───────────────────────────────────────────
export function computeExit(mode, entries, disagreements) {
  if ((disagreements?.length ?? 0) > 0) return 1; // wrong model somewhere — stop
  if (mode === "legacy-detect") {
    // Backlog loop: work remains while any payable / processing /
    // unreconciled paid HISTORICAL object exists.
    return entries.some((e) =>
      ["orphan_payable", "orphan_processing", "orphan_paid", "conflict_pending",
       "conflict_done_but_not_terminal", "unknown_state"].includes(e.classification),
    ) ? 1 : 0;
  }
  // detect: any such orphan is an incident.
  return entries.some((e) =>
    ["orphan_payable", "orphan_processing", "orphan_paid", "conflict_pending",
     "conflict_done_but_not_terminal", "unknown_state"].includes(e.classification),
  ) ? 1 : 0;
}

// ── Pure: remediation decision, per report mode ──────────────────────────────
/**
 * @param reportMode   "legacy-detect" | "detect"
 * @param entry        report entry {id, state, classification, ownerPaymentId?}
 * @param freshOwnerId payment-row id owning the object in the FRESH export
 *                     (null if unowned now)
 * @param freshConflict fresh conflict row or null
 * @param reportConflict conflict row captured in the report or null
 */
export function decideRemediation(reportMode, entry, freshOwnerId, freshConflict, reportConflict) {
  if (entry.state !== "payable") {
    return { allow: false, reason: "processing/paid objects are escalations, never remediated here" };
  }
  if (reportMode === "legacy-detect") {
    const reportOwner = entry.ownerPaymentId ?? null;
    if (reportOwner === null && freshOwnerId === null) {
      return { allow: true, reason: "unowned in report and in fresh export" };
    }
    if (reportOwner !== null && freshOwnerId === reportOwner) {
      return { allow: true, reason: "owned by the SAME payment row; reconcile it after cancellation", reconcileOwner: reportOwner };
    }
    return { allow: false, reason: `ownership changed (report=${reportOwner ?? "none"}, fresh=${freshOwnerId ?? "none"})` };
  }
  // detect: only confirmed-unowned, unchanged conflict state.
  if (freshOwnerId !== null) {
    return { allow: false, reason: "a payment owner appeared in the fresh export" };
  }
  const a = JSON.stringify(reportConflict ?? null);
  const b = JSON.stringify(freshConflict ?? null);
  if (a !== b) return { allow: false, reason: "conflict state changed since the report" };
  return { allow: true, reason: "confirmed unowned, conflict state unchanged" };
}

// ── Pure: key + argv guards ───────────────────────────────────────────────────
export function guardArgv(argv) {
  for (const a of argv) {
    if (/^(sk|rk|pk)_(live|test)_/.test(a)) {
      throw new Error("Stripe keys must come from the environment (STRIPE_AUDIT_KEY / STRIPE_SECRET_KEY), never argv");
    }
  }
}

export function keyMode(key) {
  if (/^(sk|rk)_live_/.test(key)) return "live";
  if (/^(sk|rk)_test_/.test(key)) return "test";
  throw new Error("unrecognised key shape");
}

// ── Export SQL (the database half arrives as files) ──────────────────────────
export const EXPORT_SQL = `
-- Run in the Supabase dashboard SQL editor; save each result as JSON.
-- payments.json:
select json_agg(t) from (
  select id, enrollment_id, status, stripe_payment_intent_id, stripe_session_id
    from payments
   where stripe_payment_intent_id is not null or stripe_session_id is not null
) t;
-- conflicts.json:
select json_agg(t) from (
  select provider_object_id, conflict_type, status, cleanup_status
    from payment_settlement_conflicts where provider = 'stripe'
) t;
`;

// ── IO helpers ────────────────────────────────────────────────────────────────
function loadJson(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return parsed ?? [];
}

function buildDbIndexes(paymentsRows, conflictRows) {
  const owners = new Set();
  const ownerByObject = new Map();
  for (const r of paymentsRows) {
    if (r.stripe_payment_intent_id) {
      owners.add(r.stripe_payment_intent_id);
      ownerByObject.set(r.stripe_payment_intent_id, r.id);
    }
    if (r.stripe_session_id) {
      owners.add(r.stripe_session_id);
      ownerByObject.set(r.stripe_session_id, r.id);
    }
  }
  const conflicts = new Map();
  for (const c of conflictRows) {
    conflicts.set(c.provider_object_id, {
      conflict_type: c.conflict_type,
      status: c.status,
      cleanup_status: c.cleanup_status,
    });
  }
  return { owners, ownerByObject, conflicts };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

async function verifyAccountAndMode(stripe, key, args) {
  if (!args.account || !args.mode) {
    throw new Error("--account and --mode are required, stated by the operator before anything is listed");
  }
  const mode = keyMode(key);
  if (mode !== args.mode) {
    throw new Error(`key is ${mode} mode but operator stated ${args.mode}; refusing`);
  }
  const acct = await stripe.accounts.retrieve();
  if (acct.id !== args.account) {
    throw new Error(`key belongs to ${acct.id} but operator stated ${args.account}; refusing`);
  }
}

// ── Detect (both modes) ───────────────────────────────────────────────────────
async function runDetect(mode, args, stripe) {
  const payments = loadJson(args.payments);
  const conflictRows = loadJson(args.conflicts);
  const { owners, ownerByObject, conflicts } = buildDbIndexes(payments, conflictRows);

  const objects = new Map(); // id → stripe object
  const piToSession = new Map();
  const disagreements = [];

  const remember = (obj) => objects.set(obj.id, obj);

  if (mode === "legacy-detect") {
    // 1. Every exported provider id, retrieved directly.
    for (const r of payments) {
      if (r.stripe_payment_intent_id && !objects.has(r.stripe_payment_intent_id)) {
        try {
          remember(await stripe.paymentIntents.retrieve(r.stripe_payment_intent_id));
        } catch (e) {
          if (e?.code !== "resource_missing") throw e;
        }
      }
      if (r.stripe_session_id && !objects.has(r.stripe_session_id)) {
        try {
          const s = await stripe.checkout.sessions.retrieve(r.stripe_session_id);
          remember(s);
          if (typeof s.payment_intent === "string") {
            piToSession.set(s.payment_intent, s.id);
            if (!objects.has(s.payment_intent)) {
              remember(await stripe.paymentIntents.retrieve(s.payment_intent));
            }
          }
        } catch (e) {
          if (e?.code !== "resource_missing") throw e;
        }
      }
    }
    // 2. Exhaustive sweep for legacy metadata WITHOUT the namespace.
    await forEveryObject(stripe, (obj) => {
      const m = obj.metadata ?? {};
      if (!m.integration_namespace && (m.tenant_id || m.enrollment_id)) remember(obj);
      if (obj.object === "checkout.session" && typeof obj.payment_intent === "string") {
        piToSession.set(obj.payment_intent, obj.id);
      }
    });
  } else {
    // detect: namespace-selected, exhaustively paginated.
    await forEveryObject(stripe, (obj) => {
      if ((obj.metadata ?? {}).integration_namespace === NAMESPACE) remember(obj);
      if (obj.object === "checkout.session" && typeof obj.payment_intent === "string") {
        piToSession.set(obj.payment_intent, obj.id);
      }
    });
  }

  // Object graph disagreements: report and stop, never cancel on a wrong model.
  for (const [piId, sessId] of piToSession) {
    const d = graphDisagreement(objects.get(sessId), objects.get(piId));
    if (d) disagreements.push(d);
  }

  const entries = [...objects.values()].map((obj) => {
    const e = classify(obj, { owners, piToSession, conflicts });
    const ownerId = ownerByObject.get(obj.id)
      ?? (obj.object === "payment_intent" && piToSession.get(obj.id)
        ? ownerByObject.get(piToSession.get(obj.id))
        : undefined);
    return {
      ...e,
      object: obj.object,
      created: obj.created ?? null,
      ownerPaymentId: ownerId ?? null,
      conflict: conflicts.get(obj.id) ?? null,
    };
  });

  const exitCode = computeExit(mode, entries, disagreements);
  const report = {
    tool: "stripe-orphan-audit",
    mode,
    account: args.account,
    stripeMode: args.mode,
    generatedAt: new Date().toISOString(),
    entries,
    disagreements,
    exitCode,
  };
  writeFileSync(args.report, JSON.stringify(report, null, 2));
  const counts = {};
  for (const e of entries) counts[e.classification] = (counts[e.classification] ?? 0) + 1;
  console.log(`[${mode}] ${entries.length} objects:`, JSON.stringify(counts));
  if (disagreements.length) console.log(`METADATA DISAGREEMENTS: ${disagreements.length} — no mutation permitted until resolved`);
  console.log(`report: ${args.report} — exit ${exitCode}`);
  return exitCode;
}

export async function forEveryObject(stripe, fn) {
  for await (const pi of stripe.paymentIntents.list({ limit: 100 })) fn(pi);
  for await (const s of stripe.checkout.sessions.list({ limit: 100 })) fn(s);
}

// ── Remediate ─────────────────────────────────────────────────────────────────
async function runRemediate(args, stripe) {
  if (process.env.STRIPE_SALES_OPEN === "true") {
    throw new Error("route containment is not active (STRIPE_SALES_OPEN=true); remediation runs only in a contained window");
  }
  const report = JSON.parse(readFileSync(args.report, "utf8"));
  if (report.tool !== "stripe-orphan-audit") throw new Error("not an audit report");
  if (report.account !== args.account || report.stripeMode !== args.mode) {
    throw new Error("report account/mode does not match the operator's stated account/mode");
  }
  if ((report.disagreements?.length ?? 0) > 0) {
    throw new Error("report contains metadata disagreements; resolve before any mutation");
  }

  const candidates = report.entries.filter((e) => e.classification === "orphan_payable"
    || (report.mode === "legacy-detect" && e.state === "payable"));

  if (String(candidates.length) !== args["expect-count"]) {
    throw new Error(`report has ${candidates.length} payable candidates but operator stated ${args["expect-count"]}`);
  }
  if (args.confirm !== "CANCEL") throw new Error('pass --confirm CANCEL to proceed');

  if (report.mode === "detect") {
    // Batch forbidden: one object per invocation, with a root cause.
    if (!args.only || !args["root-cause"]) {
      throw new Error("detect reports remediate ONE object per run: --only <id> --root-cause \"...\" (cancelling the symptom without understanding the writer schedules the next orphan)");
    }
  }

  // Fresh ownership export — the second look the Stripe re-fetch cannot give.
  const fresh = buildDbIndexes(loadJson(args["fresh-payments"]), loadJson(args["fresh-conflicts"]));

  let failures = 0;
  for (const entry of candidates) {
    if (args.only && entry.id !== args.only) continue;

    const freshOwner = fresh.ownerByObject.get(entry.id) ?? null;
    const freshConflict = fresh.conflicts.get(entry.id) ?? null;
    const decision = decideRemediation(report.mode, entry, freshOwner, freshConflict, entry.conflict ?? null);
    if (!decision.allow) {
      console.log(`REFUSED ${entry.id}: ${decision.reason}`);
      failures++;
      continue;
    }

    // Re-fetch immediately before mutation; refuse on state drift.
    const current = entry.object === "checkout.session"
      ? await stripe.checkout.sessions.retrieve(entry.id)
      : await stripe.paymentIntents.retrieve(entry.id);
    if (stripeState(current) !== "payable") {
      console.log(`REFUSED ${entry.id}: state drifted to ${stripeState(current)} since the report`);
      failures++;
      continue;
    }

    if (entry.object === "checkout.session") await stripe.checkout.sessions.expire(entry.id);
    else await stripe.paymentIntents.cancel(entry.id);
    console.log(`cancelled ${entry.id}${decision.reconcileOwner ? ` — now reconcile payment row ${decision.reconcileOwner}` : ""}`);
  }
  return failures > 0 ? 1 : 0;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  guardArgv(rest);
  const args = parseArgs(rest);

  if (cmd === "print-sql") {
    console.log(EXPORT_SQL);
    return 0;
  }
  if (!["legacy-detect", "detect", "remediate"].includes(cmd)) {
    console.error("usage: stripe-orphan-audit.mjs <legacy-detect|detect|remediate|print-sql> ...");
    return 2;
  }

  const key = process.env.STRIPE_AUDIT_KEY || process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_AUDIT_KEY or STRIPE_SECRET_KEY must be set (a restricted key where available)");

  const Stripe = require("stripe");
  const stripe = new Stripe(key);
  await verifyAccountAndMode(stripe, key, args);

  if (cmd === "remediate") return runRemediate(args, stripe);
  for (const f of ["payments", "conflicts", "report"]) {
    if (!args[f]) throw new Error(`--${f} is required (run print-sql for the export queries)`);
  }
  return runDetect(cmd, args, stripe);
}

const invokedDirectly =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`audit FAILED: ${err.message}`);
      process.exit(2);
    });
}
