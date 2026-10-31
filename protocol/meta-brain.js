// Meta Tool Pattern: the Inspector's model-call layer as a declared tool.
//
// An external LLM agent can read DEFINITION and know exactly how to invoke
// this capability: what it takes, what it returns, and what each outcome
// means for escrow. execute() is the only function that ever talks to the
// Meta Model API; the Inspector (protocol/inspector.js) maps its verdict
// onto the deal state machine and never settles on doubt.

// Strict tool schema: a model (or an external agent) validates its call
// against this before invoking execute().
export const DEFINITION = {
  name: "inspect_deliverable",
  description:
    "Verify a seller's delivered work against the buyer's brief. " +
    "Returns valid=true when the deliverable looks like genuine completed " +
    "work for the brief, valid=false when it is clearly wrong or empty, " +
    "and valid=null when the check is inconclusive (fetch failed, unreadable " +
    "bytes, model error) — in which case escrow stays locked.",
  parameters: {
    type: "object",
    required: ["deliverable_url", "prompt"],
    properties: {
      deliverable_url: {
        type: "string",
        description:
          "Where to fetch the delivered work. https only " +
          "(http is allowed for loopback fixtures only).",
      },
      prompt: {
        type: "string",
        description:
          "The buyer's brief, taken from the deal's metadata.prompt field " +
          "when present, otherwise a server-built deal summary.",
      },
    },
  },
  returns: {
    type: "object",
    required: ["valid", "reason"],
    properties: {
      valid: {
        type: ["boolean", "null"],
        description: "true = genuine work, false = clearly wrong, null = inconclusive.",
      },
      reason: {
        type: "string",
        description: "One-line machine-readable reason, e.g. Mocked pass, FETCH_FAILED, MODEL_INVALID.",
      },
    },
  },
};

const META_TIMEOUT_MS = 15000;
// Deliverable fetch guard: the URL is agent-supplied, so it is fetched
// like untrusted input — https only (http for loopback fixtures), few
// redirects, hard byte cap, same abort budget as the model call.
const FETCH_MAX_BYTES = 5 * 1024 * 1024;
const FETCH_MAX_REDIRECTS = 3;

function hasModelKey() {
  const apiKey = process.env.MODEL_API_KEY;
  return typeof apiKey === "string" && apiKey.length > 0;
}

// Inspector mode for the Admin Console verification panel: "meta" only
// when a real key is configured, otherwise the deterministic mock.
export function inspectorMode() {
  return hasModelKey() ? "meta" : "mock";
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

async function fetchDeliverable(url, signal) {
  if (!isAllowedFetchUrl(url)) return null;
  let current = String(url);
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

// Deterministic mock verdict for keyless operation and tests. Preserves the
// documented inspector contract: deliverable references containing
// reject/fail/invalid read as failed work, everything else reads as valid.
function mockExecute(deliverable_url) {
  const ref = String(deliverable_url ?? "").toLowerCase();
  if (ref.includes("reject") || ref.includes("fail") || ref.includes("invalid")) {
    return { valid: false, reason: "Mocked fail: marker in deliverable reference" };
  }
  return { valid: true, reason: "Mocked pass" };
}

// Run the inspection tool. Never throws: every failure mode resolves to a
// { valid, reason } envelope, with valid=null meaning inconclusive — the
// Inspector maps that to frozen escrow, never to settlement.
export async function execute({ deliverable_url, prompt }) {
  if (typeof deliverable_url !== "string" || deliverable_url.length === 0) {
    return { valid: null, reason: "BAD_INPUT: deliverable_url must be a non-empty string" };
  }
  if (typeof prompt !== "string" || prompt.length === 0) {
    return { valid: null, reason: "BAD_INPUT: prompt must be a non-empty string" };
  }
  if (!hasModelKey()) return mockExecute(deliverable_url);
  const base = process.env.META_BASE_URL ?? "https://api.meta.ai/v1";
  const model = process.env.META_MODEL ?? "muse-spark-1.3";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), META_TIMEOUT_MS);
  try {
    const deliverable = await fetchDeliverable(deliverable_url, ctrl.signal);
    if (deliverable === null) return { valid: null, reason: "FETCH_FAILED" };
    const res = await fetch(`${base}/inspect`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.MODEL_API_KEY}` },
      body: JSON.stringify({ model, prompt, image: deliverable }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { valid: null, reason: "MODEL_ERROR" };
    const data = await res.json().catch(() => null);
    const verdict = typeof data?.verdict === "string" ? data.verdict.trim().toLowerCase() : "";
    if (verdict === "valid") return { valid: true, reason: "MODEL_VALID" };
    if (verdict === "invalid") return { valid: false, reason: "MODEL_INVALID" };
    return { valid: null, reason: "MODEL_INCONCLUSIVE" };
  } catch {
    // Network down, timeout, DNS: inconclusive, never settled.
    return { valid: null, reason: "FETCH_ABORTED" };
  } finally {
    clearTimeout(timer);
  }
}
