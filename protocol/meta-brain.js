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

const META_TIMEOUT_MS = 45000;
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

// SAM 3 grounding rung (stub): no production SAM 3 API is wired yet, so
// this simulates the call with a 1-second delay and a grounded verdict.
// Fail-closed callers treat grounded=false (or a throw, which never
// happens here) as inconclusive. Never throws.
export async function executeSAM3(deliverable_url) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  if (typeof deliverable_url !== "string" || deliverable_url.length === 0) {
    return { grounded: false, confidence: 0 };
  }
  return { grounded: true, confidence: 0.98 };
}

// Text/JSON rung: verifies inline prose or structured data against the
// brief (and the deal input_schema, when the caller folds it into the
// prompt). Mock-aware like execute(): marker strings fail deterministically
// keyless; the live path asks the model to read the text against the brief.
// Never throws: every failure resolves to valid=null (frozen escrow).
export async function executeText({ prompt, text }) {
  if (typeof text !== "string" || text.length === 0) {
    return { valid: null, reason: "BAD_INPUT: text must be a non-empty string" };
  }
  if (typeof prompt !== "string" || prompt.length === 0) {
    return { valid: null, reason: "BAD_INPUT: prompt must be a non-empty string" };
  }
  if (!hasModelKey()) {
    const ref = text.toLowerCase();
    if (ref.includes("reject") || ref.includes("fail") || ref.includes("invalid")) {
      return { valid: false, reason: "Mocked fail: marker in delivered text" };
    }
    return { valid: true, reason: "Mocked pass" };
  }
  const base = process.env.META_BASE_URL ?? "https://api.meta.ai/v1";
  const model = process.env.META_MODEL ?? "muse-spark-1.3";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), META_TIMEOUT_MS);
  try {
    const activeKey = process.env.MODEL_API_BasetenKEY || process.env.MODEL_API_KEY;
    console.log("DEBUG KEY:", activeKey ? activeKey.slice(0, 5) + "..." : "UNDEFINED");
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${activeKey}` },
      body: JSON.stringify({
        model: process.env.META_MODEL || "meta-models/muse-spark-open-1026",
        messages: [{
          role: "user",
          content: `${prompt}\n\nDeliverable to verify:\n${text}\n\nReply exactly with VALID or INVALID.`,
        }],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { valid: null, reason: "MODEL_ERROR" };
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "";
    const clean = content.trim().toUpperCase();
    if (clean.includes("VALID")) return { valid: true, reason: "META_AI_VERIFIED" };
    if (clean.includes("INVALID")) return { valid: false, reason: "META_AI_REJECTED" };
    return { valid: null, reason: "MODEL_INCONCLUSIVE" };
  } catch {
    return { valid: null, reason: "FETCH_ABORTED" };
  } finally {
    clearTimeout(timer);
  }
}

// Run the inspection tool. Never throws: every failure mode resolves to a
// { valid, reason } envelope, with valid=null meaning inconclusive — the
// Inspector maps that to frozen escrow, never to settlement.
export async function execute({ deliverable_url, prompt, image }) {
  // Inline snapshot bytes (from the envelope resolver) skip the fetch so
  // content-only envelopes verify without a URL round trip. Shape-checked
  // like a fetched deliverable; anything else is doubt, never a pass.
  const inline = image !== undefined
    && typeof image === "object" && image !== null
    && typeof image.base64 === "string" && image.base64.length > 0
    ? { mime: typeof image.mime === "string" ? image.mime : "application/octet-stream", base64: image.base64 }
    : null;
  if ((typeof deliverable_url !== "string" || deliverable_url.length === 0) && inline === null) {
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
    const deliverable = inline ?? await fetchDeliverable(deliverable_url, ctrl.signal);
    if (deliverable === null) return { valid: null, reason: "FETCH_FAILED" };
    const activeKey = process.env.MODEL_API_BasetenKEY || process.env.MODEL_API_KEY;
    console.log("DEBUG KEY:", activeKey ? activeKey.slice(0, 5) + "..." : "UNDEFINED");
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${activeKey}` },
      body: JSON.stringify({
        model: process.env.META_MODEL || "meta-models/muse-spark-open-1026",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: `${prompt}\n\nReply exactly with VALID or INVALID.` },
            { type: "image_url", image_url: { url: `data:${deliverable.mime};base64,${deliverable.base64}` } },
          ],
        }],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { valid: null, reason: "MODEL_ERROR" };
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "";
    const clean = content.trim().toUpperCase();
    if (clean.includes("VALID")) return { valid: true, reason: "META_AI_VERIFIED" };
    if (clean.includes("INVALID")) return { valid: false, reason: "META_AI_REJECTED" };
    return { valid: null, reason: "MODEL_INCONCLUSIVE" };
  } catch {
    // Network down, timeout, DNS: inconclusive, never settled.
    return { valid: null, reason: "FETCH_ABORTED" };
  } finally {
    clearTimeout(timer);
  }
}
