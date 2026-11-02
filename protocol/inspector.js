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
import { crToUsdc, releaseFunds } from "./wallet.js";
import { isKnownCapability, inspectImageLocally, inspectAudioLocally } from "./capabilities.js";
import { execute as inspectWithBrain, executeSAM3, inspectorMode } from "./meta-brain.js";

// Capability resolution: explicit per-delivery override first, then the
// seller's registered capability, then null (today's mock/vision path).
// Unknown or free-form values ("GPU rendering") are NOT capabilities —
// they fall through to the default path so existing agents keep working.
function resolveCapability({ store, deal, capability }) {
  if (typeof capability === "string" && isKnownCapability(capability)) return capability;
  const registered = store.getAgentCapability?.(deal.seller) ?? null;
  if (isKnownCapability(registered)) return registered;
  return null;
}

// Meta AI Trust Engine Ladder: Local -> SAM 3 -> Muse Spark -> Glimmer.
// Returns { verdict: "SETTLED"|"REJECTED"|"INCONCLUSIVE", reason, confidence }
// so the state machine below keeps its exact contract. Every rung is
// fail-closed: any doubt resolves to INCONCLUSIVE (frozen escrow).
// Keyless (mock) operation skips the SAM 3/Spark rungs and maps the mock
// straight through, byte-identical to the old modelVerdict. Glimmer is a
// dispute-only stub for now and never changes a verdict on its own.
async function modelVerdict({ deliveryUrl, prompt, dealId, emit, log }) {
  const aiVerdict = (verdict, reason, confidence) => {
    emit?.({ type: "AI_VERDICT", dealId, verdict, reason, confidence });
    (log ?? console).info?.({ dealId, verdict, reason, confidence }, "inspector.ai_verdict");
    return { verdict, reason, confidence };
  };
  // Mock path first: no model key means the deterministic mock decides,
  // exactly like the old mapping (null tool output freezes).
  if (inspectorMode() !== "meta") {
    const decided = await inspectWithBrain({ deliverable_url: deliveryUrl, prompt });
    if (decided.valid === true) return aiVerdict("SETTLED", decided.reason ?? "MODEL_VALID", 1);
    if (decided.valid === false) return aiVerdict("REJECTED", decided.reason ?? "MODEL_INVALID", 1);
    return aiVerdict("INCONCLUSIVE", decided.reason ?? "MODEL_INCONCLUSIVE", 0);
  }
  // Rung 2 (SAM 3 grounding): an ungrounded deliverable freezes here and
  // never reaches the semantic check.
  emit?.({ type: "AI_THINKING", dealId, rung: "SAM3" });
  let grounding;
  try {
    grounding = await executeSAM3(deliveryUrl);
  } catch {
    grounding = { grounded: false, confidence: 0 };
  }
  if (!grounding.grounded) {
    return aiVerdict("INCONCLUSIVE", "SAM3_UNGROUNDED", grounding.confidence ?? 0);
  }
  // Rung 3 (Muse Spark schema/semantics): INVALID or INCONCLUSIVE freezes
  // or refunds downstream — this rung never settles on its own.
  emit?.({ type: "AI_THINKING", dealId, rung: "MUSE_SPARK" });
  const decided = await inspectWithBrain({ deliverable_url: deliveryUrl, prompt });
  // Rung 4 (Glimmer referee): dispute-only stub. No dispute signal exists
  // on this path yet, so it observes without overriding the Spark verdict.
  emit?.({ type: "AI_THINKING", dealId, rung: "GLIMMER" });
  if (decided.valid === true) return aiVerdict("SETTLED", decided.reason ?? "MODEL_VALID", grounding.confidence ?? 0.98);
  if (decided.valid === false) return aiVerdict("REJECTED", decided.reason ?? "MODEL_INVALID", grounding.confidence ?? 0.98);
  return aiVerdict("INCONCLUSIVE", decided.reason ?? "MODEL_INCONCLUSIVE", 0);
}

// Zero-cost local verdict. Bytes come from the inspector's guarded fetch;
// capabilities never see URLs, so the SSRF surface does not grow.
async function localVerdict({ capability, deliveryUrl, prompt }) {
  if (capability === "video_gen") {
    // Honest stub: no frame extraction exists yet. INCONCLUSIVE freezes
    // escrow instead of faking a verdict; V3 wires extractVideoFrame here.
    return { verdict: "INCONCLUSIVE", code: "VIDEO_FRAME_TODO", evidence: {} };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), META_TIMEOUT_MS);
  try {
    const deliverable = await fetchDeliverable(deliveryUrl, ctrl.signal);
    if (deliverable === null) return { verdict: "INCONCLUSIVE", code: "FETCH_FAILED", evidence: {} };
    const bytes = Buffer.from(deliverable.base64, "base64");
    if (capability === "image_gen") return inspectImageLocally(bytes, prompt);
    if (capability === "speech_transcription") return inspectAudioLocally(bytes, prompt);
    return { verdict: "INCONCLUSIVE", code: "UNKNOWN_CAPABILITY", evidence: {} };
  } catch {
    return { verdict: "INCONCLUSIVE", code: "FETCH_ABORTED", evidence: {} };
  } finally {
    clearTimeout(timer);
  }
}

const META_TIMEOUT_MS = 15000;
// Deliverable fetch guard: the URL is agent-supplied, so it is fetched
// like untrusted input — https only (http allowed for loopback fixtures),
// few redirects, hard byte cap, same abort budget as the vision call.
// NOTE: no egress-restricted worker yet; that is the follow-up.
const FETCH_MAX_BYTES = 5 * 1024 * 1024;
const FETCH_MAX_REDIRECTS = 3;

// Deterministic mock verdict for keyless operation and tests: deliverable
// references containing reject/fail/invalid read as failed work, everything
// else reads as valid. Documented so demos can drive both outcomes.
export function mockVerdict(deliveryUrl) {
  const ref = String(deliveryUrl ?? "").toLowerCase();
  if (ref.includes("reject") || ref.includes("fail") || ref.includes("invalid")) {
    return "REJECTED";
  }
  return "SETTLED";
}

function isAllowedFetchUrl(value) {
  let parsed = null;
  try {
    parsed = new URL(String(value ?? ""));
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")) return true;
  return false;
}

async function fetchDeliverable(deliveryUrl, signal) {
  if (!isAllowedFetchUrl(deliveryUrl)) return null;
  let current = String(deliveryUrl);
  for (let hop = 0; hop <= FETCH_MAX_REDIRECTS; hop += 1) {
    const res = await fetch(current, { signal, redirect: "manual" });
    if (res.status >= 300 && res.status < 400 && typeof res.headers.get("location") === "string") {
      current = new URL(res.headers.get("location"), current).toString();
      if (!isAllowedFetchUrl(current)) return null;
      continue;
    }
    if (!res.ok) return null;
    const reader = res.body?.getReader?.();
    if (reader === undefined || reader === null) {
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length <= FETCH_MAX_BYTES
        ? { mime: res.headers.get("content-type") ?? "application/octet-stream", base64: buf.toString("base64") }
        : null;
    }
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > FETCH_MAX_BYTES) {
        try { await reader.cancel(); } catch { /* already closed */ }
        return null;
      }
      chunks.push(value);
    }
    return { mime: res.headers.get("content-type") ?? "application/octet-stream", base64: Buffer.concat(chunks).toString("base64") };
  }
  return null;
}

// The delivery row carries only a URL — no stored brief — so the prompt
// states exactly what is asked and admits its limit: does this deliverable
// look like genuine completed work for the referenced deal?
export function buildInspectionPrompt({ dealId, price, seller }) {
  return [
    "You are an inspector for agent-commerce escrow.",
    `Deal ${dealId} (price ${price} credits, seller ${seller}) claims delivery.`,
    "Examine the attached deliverable.",
    'Reply with exactly one word: "valid" if it looks like genuine completed work, "invalid" otherwise.',
  ].join(" ");
}

// Strict vocabulary, fail-frozen: anything but an exact valid/invalid
// verdict (after trim + lowercase) is INCONCLUSIVE, never a settlement.
export function parseVerdict(data) {
  const verdict = typeof data?.verdict === "string" ? data.verdict.trim().toLowerCase() : "";
  if (verdict === "valid") return "SETTLED";
  if (verdict === "invalid") return "REJECTED";
  return "INCONCLUSIVE";
}

export async function runInspection({ store, ledger, dealId, deliveryUrl, capability, emit, log }) {
  const deal = store.getDeal(dealId);
  if (deal === null || deal.state !== "VERIFYING") {
    // Already moved (sweeper, retry, restart): nothing to decide.
    return { ok: false, code: "NOT_VERIFYING", message: `deal ${dealId} is not awaiting inspection` };
  }
  // Oracle routing: known modalities go local first (zero cost). text_gen
  // has no local checker yet, so it shares the default path. Unknown or
  // absent capability keeps today's mock/tool behavior byte-identical.
  const routed = resolveCapability({ store, deal, capability });
  // The brief rides the deal: metadata.prompt when the buyer supplied one,
  // otherwise the server-built deal summary (which admits its limit).
  const brief = typeof deal.metadata?.prompt === "string" && deal.metadata.prompt.length > 0
    ? deal.metadata.prompt
    : buildInspectionPrompt({ dealId, price: deal.price, seller: deal.seller });
  // Trust Engine reasoning rides alongside the verdict so it can be
  // persisted and telemetered even when the outcome is frozen.
  let verdict;
  let aiReason = "LOCAL";
  let aiConfidence = 0;
  const ladderOut = (out) => {
    verdict = out.verdict;
    aiReason = out.reason;
    aiConfidence = out.confidence;
  };
  if (routed !== null && routed !== "text_gen") {
    const local = await localVerdict({ capability: routed, deliveryUrl, prompt: brief });
    (log ?? console).info?.({ dealId, capability: routed, code: local.code }, "inspector.local");
    verdict = local.verdict;
    aiReason = local.code ?? "LOCAL";
    aiConfidence = verdict === "SETTLED" ? 1 : 0;
    // Tool escalation only: a local INCONCLUSIVE falls through to the Ladder,
    // and only when the caller brought their own key. Keyless operation
    // stays frozen here by design — the mock only verdicts on the default
    // path, exactly like the old visionVerdict escalation rule.
    if (verdict === "INCONCLUSIVE" && inspectorMode() === "meta") {
      ladderOut(await modelVerdict({ deliveryUrl, prompt: brief, dealId, emit, log }));
    }
  } else {
    ladderOut(await modelVerdict({ deliveryUrl, prompt: brief, dealId, emit, log }));
  }
  // Persist reasoning before branching: frozen deals keep their AI trace
  // for the operator, and terminal deals carry it into the ledger write.
  // Persistence never fails the inspection — a store error leaves the
  // verdict to proceed fail-closed below.
  try {
    store.setDealAi?.(dealId, { verdict: verdict === "SETTLED" ? "VALID" : verdict === "REJECTED" ? "INVALID" : "INCONCLUSIVE", reason: aiReason, confidence: aiConfidence });
  } catch {
    // Telemetry is best-effort; the verdict below is authoritative.
  }
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
  // Late-finish guard: the verdict above resolved asynchronously, so the
  // deal may have moved under us (e.g. an admin force-refund). Re-fetch
  // and abort unless it is still awaiting inspection — settling a deal
  // the operator already closed would rewrite history and double-move
  // funds. Fail-closed: abort leaves state and escrow exactly as found.
  const currentDeal = store.getDeal(dealId);
  if (currentDeal === null || currentDeal.state !== "VERIFYING") {
    (log ?? console).warn?.({ dealId }, "inspector.stale_verdict");
    return { ok: false, code: "NOT_VERIFYING", message: `deal ${dealId} is not awaiting inspection` };
  }
  // Ledger-before-state: funds move first, and only a successful ledger
  // op advances the SQLite row. A failed settle/refund leaves the deal in
  // VERIFYING (fail-frozen) instead of certifying a terminal state whose
  // funds never moved.
  if (verdict === "SETTLED") {
    // Moderation freeze (P1-3): a seller who lost ACTIVE standing since
    // delivery must not be paid. The deal stays VERIFYING with the escrow
    // locked — the same fail-frozen posture as an inconclusive verdict —
    // so an operator can reinstate, retire, or refund deliberately. A
    // REJECTED verdict still refunds the buyer below: returning money is
    // always safe. Unknown sellers (pre-lifecycle rows) keep the old
    // behavior; only a known non-ACTIVE status freezes.
    const standing = store.getAgentStatus?.(deal.seller)?.status;
    if (typeof standing === "string" && standing !== "ACTIVE") {
      (log ?? console).warn?.({ dealId, seller: deal.seller, standing }, "inspector.seller_not_active");
      emit?.({ type: "SETTLEMENT_FROZEN", dealId, seller: deal.seller, standing });
      return { ok: false, code: "SELLER_NOT_ACTIVE", message: `seller ${deal.seller} is ${standing}; settlement frozen` };
    }
    // Real payout first: the escrow wallet releases deal.price worth of
    // USDC to the seller's registered wallet before anything is marked
    // SETTLED. Idempotent: a recorded payout_tx_hash is reused, never
    // re-broadcast, so a crash between broadcast and state flip cannot
    // double-pay on retry. Sellers without a wallet settle ledger-only.
    // Any broadcast failure freezes the deal — never settle what wasn't paid.
    let payoutTx = store.getDealRow(dealId)?.payout_tx_hash ?? null;
    const sellerWallet = store.getAgentDetail?.(deal.seller)?.wallet_address ?? null;
    if (payoutTx === null && typeof sellerWallet === "string" && sellerWallet.length > 0) {
      try {
        payoutTx = await releaseFunds(sellerWallet, crToUsdc(deal.price));
      } catch (err) {
        (log ?? console).error?.({ dealId, err }, "inspector.payout_failed");
        return { ok: false, code: "PAYOUT_FAILED", message: "on-chain payout failed; escrow stays locked" };
      }
      if (typeof payoutTx !== "string" || payoutTx.length === 0) {
        return { ok: false, code: "PAYOUT_FAILED", message: "on-chain payout failed; escrow stays locked" };
      }
      store.setDealPayoutTx(dealId, payoutTx);
    }
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
