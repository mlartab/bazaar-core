// Async AI Inspector: the verdict behind POST /api/deals/:id/delivery.
//
// The delivery route answers 202 synchronously and lands the deal in
// VERIFYING; this module runs after the response, decides the verdict, and
// moves the locked funds. Fail-frozen: any inconclusive outcome (API error,
// timeout, unknown verdict) leaves the deal in VERIFYING with the escrow
// locked. Never settle funds on doubt.
//
// runInspection never touches req/res: it closes over { store, ledger, emit,
// log } plus the deal identity. A rejection must never crash the process;
// the server attaches a .catch that logs and leaves the deal frozen.

import { transition } from "../src/deal-states.js";
import { settle, refund } from "../src/ledger.js";

const META_TIMEOUT_MS = 15000;

// Deterministic mock verdict for the pre-Vision slice: deliverable
// references containing reject/fail/invalid read as failed work, everything
// else reads as valid. Documented so demos can drive both outcomes.
export function mockVerdict(deliveryUrl) {
  const ref = String(deliveryUrl ?? "").toLowerCase();
  if (ref.includes("reject") || ref.includes("fail") || ref.includes("invalid")) {
    return "REJECTED";
  }
  return "SETTLED";
}

async function visionVerdict(deliveryUrl) {
  // TODO(SSRF): when the real Meta Vision wiring lands, do not fetch
  // deliveryUrl directly. Validate the scheme/host against an allowlist,
  // cap redirects and bytes, and run the fetch from an egress-restricted
  // worker before sending bytes to the Vision API.
  const apiKey = process.env.MODEL_API_KEY;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    return mockVerdict(deliveryUrl);
  }
  const base = process.env.META_BASE_URL ?? "https://api.meta.ai/v1";
  const model = process.env.META_MODEL ?? "muse-spark-1.3";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), META_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/inspect`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, deliveryUrl }),
      signal: ctrl.signal,
    });
    if (!res.ok) return "INCONCLUSIVE";
    const data = await res.json().catch(() => null);
    if (data?.verdict === "valid") return "SETTLED";
    if (data?.verdict === "invalid") return "REJECTED";
    return "INCONCLUSIVE";
  } catch {
    // Network down, timeout, DNS: frozen, never settled. The next
    // inspector run (or an operator) can re-drive the verdict.
    return "INCONCLUSIVE";
  } finally {
    clearTimeout(timer);
  }
}

export async function runInspection({ store, ledger, dealId, deliveryUrl, emit, log }) {
  const deal = store.getDeal(dealId);
  if (deal === null || deal.state !== "VERIFYING") {
    // Already moved (sweeper, retry, restart): nothing to decide.
    return { ok: false, code: "NOT_VERIFYING", message: `deal ${dealId} is not awaiting inspection` };
  }
  const verdict = await visionVerdict(deliveryUrl);
  if (verdict === "INCONCLUSIVE") {
    (log ?? console).warn?.({ dealId }, "inspector.inconclusive");
    emit?.({ type: "INSPECTION_INCONCLUSIVE", dealId });
    return { ok: false, code: "INCONCLUSIVE", message: "inspection was inconclusive; escrow stays locked" };
  }
  const advanced = transition(deal, verdict);
  if (!advanced.ok) {
    (log ?? console).error?.({ dealId, verdict }, "inspector.transition_failed");
    return { ok: false, code: advanced.code, message: advanced.message };
  }
  // Ledger-before-state: funds move first, and only a successful ledger
  // op advances the SQLite row. A failed settle/refund leaves the deal in
  // VERIFYING (fail-frozen) instead of certifying a terminal state whose
  // funds never moved.
  if (verdict === "SETTLED") {
    const paid = settle(ledger, dealId, deal.seller);
    if (!paid.ok) {
      (log ?? console).error?.({ dealId, code: paid.code }, "inspector.settle_failed");
      return { ok: false, code: paid.code, message: paid.message };
    }
    store.setDealState(dealId, advanced.deal.state);
    emit?.({ type: "STATE", dealId, from: advanced.event.from, to: advanced.event.to });
    emit?.({ type: "SETTLED", dealId, paid: paid.paid });
    return { ok: true, to: "SETTLED", paid: paid.paid };
  }
  const back = refund(ledger, dealId);
  if (!back.ok) {
    (log ?? console).error?.({ dealId, code: back.code }, "inspector.refund_failed");
    return { ok: false, code: back.code, message: back.message };
  }
  store.setDealState(dealId, advanced.deal.state);
  emit?.({ type: "STATE", dealId, from: advanced.event.from, to: advanced.event.to });
  emit?.({ type: "REFUNDED", dealId, refunded: back.refunded });
  return { ok: true, to: "REJECTED", refunded: back.refunded };
}
