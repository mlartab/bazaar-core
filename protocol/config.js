// Protocol tuning in one place: timeouts, caps, and limits that were
// previously magic numbers scattered through server.js and
// session-manager.js. Values only — no logic lives here.

export const SESSION_TIMEOUT_MS = 60000;
export const SWEEP_INTERVAL_MS = 10000;
// Post-payment escrow: a seller who never delivers after capture must not
// lock funds forever. Checked on its own slower tick; expiry refunds.
export const DELIVERY_TIMEOUT_MS = 300000;
export const DELIVERY_SWEEP_INTERVAL_MS = 30000;
// Frozen inspection: a VERIFYING deal the AI never verdicts must not trap
// escrow forever. Checked on its own slower tick; expiry refunds.
export const INSPECTION_TIMEOUT_MS = 300000;
export const INSPECTION_SWEEP_INTERVAL_MS = 30000;
export const MAX_BODY_SIZE = 1024 * 1024;
export const EVENT_CAP = 500;
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_SWEEP_MS = 10 * 60 * 1000;
// Demo-safe mode: when process.env.DEMO_SAFE is "true" (read lazily at
// boot, never at import, so tests can flip it), no sweeper timer is armed
// and expiry only runs via POST /api/admin/demo/sweep. Deals cannot die
// mid-narration on stage.
export function isDemoSafe(env = process.env) {
  return env.DEMO_SAFE === "true";
}
