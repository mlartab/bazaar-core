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
// Auto-generated idempotency keys (requests that omit Idempotency-Key):
// a short window so an agent retrying a failed request within 10 seconds
// gets the cached result, while a deliberate second action later still
// runs as a new request.
export const AUTO_IDEMPOTENCY_TTL_MS = 10 * 1000;
export const IDEMPOTENCY_SWEEP_MS = 10 * 60 * 1000;
// Demo-safe mode: when process.env.DEMO_SAFE is "true" (read lazily at
// boot, never at import, so tests can flip it), no sweeper timer is armed
// and expiry only runs via POST /api/admin/demo/sweep. Deals cannot die
// mid-narration on stage.
export function isDemoSafe(env = process.env) {
  return env.DEMO_SAFE === "true";
}
// Opt-in permissionless onboarding: when "true", new agents start ACTIVE
// with probation caps instead of PENDING review. Default off.
export function isAutoApprove(env = process.env) {
  return env.AUTO_APPROVE === "true";
}
// Probation economics: max deal price and max concurrent (non-terminal)
// deals where the probation agent is buyer OR seller.
export function probationPriceCap(env = process.env) {
  const n = Number(env.PROBATION_MAX_PRICE ?? 500);
  return Number.isInteger(n) && n >= 1 ? n : 500;
}
export function probationMaxDeals(env = process.env) {
  const n = Number(env.PROBATION_MAX_DEALS ?? 5);
  return Number.isInteger(n) && n >= 1 ? n : 5;
}
// Anti-spam for open registration: max registrations per IP per hour.
// X-Forwarded-For leftmost entry wins; direct connections use the socket.
export function registrationPerIpPerHour(env = process.env) {
  const n = Number(env.REGISTRATION_PER_IP_PER_HOUR ?? 20);
  return Number.isInteger(n) && n >= 1 ? n : 20;
}
// Negotiation window: how long NEGOTIATING/AGREED may sit before the
// session sweeper rejects. Read at boot like the other timing envs.
export function negotiationWindowMs(env = process.env) {
  const n = Number(env.NEGOTIATION_WINDOW_MS ?? 60000);
  return Number.isInteger(n) && n >= 1 ? n : 60000;
}
// Inspection window: how long VERIFYING may wait for the AI verdict.
// Read at boot and passed into the session manager like the sweeps.
export function inspectionTimeoutMs(env = process.env) {
  const n = Number(env.INSPECTION_TIMEOUT_MS ?? 300000);
  return Number.isInteger(n) && n >= 1 ? n : 300000;
}
// Seller-declared delivery SLA bounds (seconds). The schema enforces the
// widest legal range; these envs tighten it per deployment.
export function deliverySlaBounds(env = process.env) {
  const num = (v, d) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 ? n : d;
  };
  return {
    min: num(env.DELIVERY_SLA_MIN_SECONDS, 60),
    max: num(env.DELIVERY_SLA_MAX_SECONDS, 86400),
    def: num(env.DELIVERY_SLA_DEFAULT_SECONDS, 300),
  };
}
