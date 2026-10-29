// Protocol session timeouts. Deals that stall in NEGOTIATING or AGREED do
// not wait forever: the sweeper flips them to REJECTED with reason
// EXPIRED_TIMEOUT so escrow cannot sit locked when a counterparty walks
// away silently. Captured escrow gets its own slower deadline: a seller who
// never delivers after pay loses the lock to DELIVERY_TIMEOUT. Frozen
// inspection gets a third deadline: a VERIFYING deal the AI never verdicts
// is refunded with reason INSPECTION_TIMEOUT. Intervals and
// the clock are injectable so tests drive the sweeps directly instead of
// sleeping through real timeouts.

import { refund } from "../src/ledger.js";
import { DELIVERY_SWEEP_INTERVAL_MS, DELIVERY_TIMEOUT_MS, INSPECTION_SWEEP_INTERVAL_MS, INSPECTION_TIMEOUT_MS, SESSION_TIMEOUT_MS, SWEEP_INTERVAL_MS } from "./config.js";

export function createSessionManager({ store, ledger, expiresInMs = SESSION_TIMEOUT_MS, intervalMs = SWEEP_INTERVAL_MS, deliveryExpiresInMs = DELIVERY_TIMEOUT_MS, deliveryIntervalMs = DELIVERY_SWEEP_INTERVAL_MS, inspectionExpiresInMs = INSPECTION_TIMEOUT_MS, inspectionIntervalMs = INSPECTION_SWEEP_INTERVAL_MS, demoSafe = false, now = () => Date.now() } = {}) {
  if (!store || !ledger) throw new Error("createSessionManager requires a store and a ledger");

  // One pass: expire every overdue live deal. Per-deal try/catch so one
  // corrupt row cannot abort the rest of the sweep; every outcome is
  // returned for the caller to log.
  const sweepOnce = () => {
    const outcomes = [];
    for (const deal of store.listExpiringDeals(now())) {
      try {
        if (deal.state === "AGREED") {
          // ACCEPT locked escrow at agreement time, so expiry must release
          // it back to the buyer. NEGOTIATING holds no lock: its opening
          // deposit stays buyer balance by design (sandbox faucet, never
          // clawed back).
          const back = refund(ledger, deal.id);
          if (!back.ok) throw new Error(back.message);
        }
        store.setDealState(deal.id, "REJECTED");
        store.setDealCloseReason(deal.id, "EXPIRED_TIMEOUT");
        outcomes.push({ id: deal.id, from: deal.state, to: "REJECTED", refunded: deal.state === "AGREED" });
      } catch (err) {
        outcomes.push({ id: deal.id, from: deal.state, to: null, error: err?.message ?? "sweep failed" });
      }
    }
    return outcomes;
  };

  // One pass: refund captured escrow whose delivery window lapsed. The lock
  // must exist (pay or ACCEPT put it there); a missing lock records an
  // error outcome and leaves the state alone for the next tick, exactly
  // like the session sweep.
  const sweepDeliveries = () => {
    const outcomes = [];
    for (const deal of store.listStaleEscrows(now(), deliveryExpiresInMs)) {
      try {
        const back = refund(ledger, deal.id);
        if (!back.ok) throw new Error(back.message);
        store.setDealState(deal.id, "REJECTED");
        store.setDealCloseReason(deal.id, "DELIVERY_TIMEOUT");
        outcomes.push({ id: deal.id, from: deal.state, to: "REJECTED", refunded: true });
      } catch (err) {
        outcomes.push({ id: deal.id, from: deal.state, to: null, error: err?.message ?? "sweep failed" });
      }
    }
    return outcomes;
  };

  // One pass: unfreeze VERIFYING deals the AI never verdicts. A missing
  // lock records an error outcome and leaves the state alone for the next
  // tick — funds are never trapped forever, and never moved on doubt.
  const sweepInspections = () => {
    const outcomes = [];
    for (const deal of store.listStaleVerifying(now(), inspectionExpiresInMs)) {
      try {
        const back = refund(ledger, deal.id);
        if (!back.ok) throw new Error(back.message);
        store.setDealState(deal.id, "REJECTED");
        store.setDealCloseReason(deal.id, "INSPECTION_TIMEOUT");
        outcomes.push({ id: deal.id, from: deal.state, to: "REJECTED", refunded: true, reason: "INSPECTION_TIMEOUT" });
      } catch (err) {
        outcomes.push({ id: deal.id, from: deal.state, to: null, error: err?.message ?? "sweep failed" });
      }
    }
    return outcomes;
  };

  let timer = null;
  let deliveryTimer = null;
  let inspectionTimer = null;
  const arm = (fn, ms, onSweep) => {
    const handle = setInterval(() => {
      try {
        const outcomes = fn();
        if (onSweep) onSweep(outcomes);
      } catch {
        // The interval must never die: sweep failures are observable via
        // per-deal outcomes, never via a crashed timer.
      }
    }, ms);
    // Belt and braces next to the explicit stop(): a forgotten sweeper
    // must never hold the test runner open on its own.
    if (typeof handle.unref === "function") handle.unref();
    return handle;
  };
  return {
    sweepOnce,
    sweepDeliveries,
    sweepInspections,
    expiresAt: (from = now()) => from + expiresInMs,
    deliveryExpiresAt: (from = now()) => from + deliveryExpiresInMs,
    inspectionExpiresAt: (from = now()) => from + inspectionExpiresInMs,
    start(onSweep) {
      if (timer !== null) return;
      // Demo-safe: no background expiry on stage. The sweep functions stay
      // directly callable so POST /api/admin/demo/sweep can fire them.
      if (demoSafe) return;
      timer = arm(sweepOnce, intervalMs, onSweep);
      deliveryTimer = arm(sweepDeliveries, deliveryIntervalMs, onSweep);
      inspectionTimer = arm(sweepInspections, inspectionIntervalMs, onSweep);
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (deliveryTimer !== null) {
        clearInterval(deliveryTimer);
        deliveryTimer = null;
      }
      if (inspectionTimer !== null) {
        clearInterval(inspectionTimer);
        inspectionTimer = null;
      }
    },
  };
}
