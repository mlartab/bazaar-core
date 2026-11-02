// Brick 4: strict schemas. Pure validation, no server, no storage.
//
// Each schema is plain data. validate(endpoint, request) checks a request
// against the named schema and returns { ok: true } or
// { ok: false, code: "INVALID_SCHEMA", field, message }.
// Rules: required fields, exact types, allowed values, unknown fields
// rejected. Move rule: price is required for OFFER and ACCEPT, forbidden
// for WALK.

// Canonical modality vocabulary. Re-exported here so schema-adjacent code
// has one import site; the source of truth lives in capabilities.js.
// NOTE: registerAgent.capability stays a free-form string — existing agents
// use values like "GPU rendering", and tightening it would break them.
// The enum binds routing and sync, never registration.
export { CAPABILITIES } from "./capabilities.js";

export const SCHEMAS = {
  registerAgent: {
    fields: {
      // Identifiers are bounded everywhere: an unbounded id is a storage
      // and index abuse vector, and nothing legitimate needs more.
      id: { type: "string", required: true, nonEmpty: true, maxLength: 128 },
      role: { type: "string", required: true, allowed: ["buyer", "seller"] },
      // Optional seller pitch for the public marketplace; absent stays null.
      capability: { type: "string" },
      // Marketplace listing card. Lengths are enforced below so the UI can
      // trust what the database returns without re-truncating. Bounds are
      // the storefront standard: titles 5-60 chars, descriptions 20-250,
      // price a positive integer up to 100000 CR.
      title: { type: "string", minLength: 5, maxLength: 60 },
      description: { type: "string", minLength: 20, maxLength: 250 },
      // A hiring price, not escrowed funds: must be a positive integer.
      price: { type: "integer", min: 1, max: 100000 },
      // Marketplace category for grouping. Optional (absent stays null);
      // validated only when present so old payloads keep working.
      category: { type: "string", allowed: ["image_gen", "video_gen", "data", "text_gen", "speech", "speech_transcription"] },
      // Seller-declared delivery SLA in seconds. Wide static bounds here;
      // the deployment env tightens them per request at the handler.
      delivery_sla_seconds: { type: "integer", min: 60, max: 86400 },
      // Service strategy: a fixed-price endpoint, a negotiable service, or
      // raw compute. Optional; the handler defaults absent to "negotiation"
      // so every existing payload keeps validating unchanged.
      service_type: { type: "string", allowed: ["endpoint", "negotiation", "compute"] },
      // Absolute floor for negotiation services. Ignored for endpoint and
      // compute, where the listing price is the floor. Optional; absent
      // stays null and the referee falls back to 1.
      min_price: { type: "integer", min: 1, max: 100000 },
      // Discovery tags: at most 10 short non-empty strings. Optional;
      // absent stays null.
      skills: { type: "array", maxItems: 10, items: { type: "string", nonEmpty: true, maxLength: 64 } },
      // Interaction descriptor (endpoint URL/method/schema, portfolio
      // links). Optional plain object; absent stays null.
      metadata: { type: "object", maxKeys: 20 },
      // Seller-declared JSON Schema for deal metadata (Schema-Driven
      // Commerce). Optional plain object; when absent the server stores a
      // default schema requiring a prompt string.
      input_schema: { type: "object" },
      // Seller payout address for real Base Sepolia settlement. Optional;
      // validated as a 0x address by the handler. Absent stays null.
      wallet_address: { type: "string", maxLength: 42 },
    },
  },
  patchAgent: {
    fields: {
      // Operator edit: every field optional, at least one required (the
      // handler rejects empty patches). Unknown fields rejected as usual.
      // Same storefront bounds as registration when a field is present.
      title: { type: "string", minLength: 5, maxLength: 60 },
      description: { type: "string", minLength: 20, maxLength: 250 },
      price: { type: "integer", min: 1, max: 100000 },
      category: { type: "string", allowed: ["image_gen", "video_gen", "data", "text_gen", "speech", "speech_transcription"] },
      delivery_sla_seconds: { type: "integer", min: 60, max: 86400 },
      // Listing strategy: same shapes as registration; all optional here.
      service_type: { type: "string", allowed: ["endpoint", "negotiation", "compute"] },
      min_price: { type: "integer", min: 1, max: 100000 },
      skills: { type: "array", maxItems: 10, items: { type: "string", nonEmpty: true, maxLength: 64 } },
      metadata: { type: "object", maxKeys: 20 },
    },
  },
  reviewNote: {
    fields: {
      // Optional approval note; shown back to the agent on the status endpoint.
      message: { type: "string" },
    },
  },
  moderationNote: {
    fields: {
      // Rejections, suspensions, and retirements must say why: the reason
      // is surfaced to the agent and written to the audit log.
      reason: { type: "string", required: true, nonEmpty: true, maxLength: 128 },
    },
  },
  linkEmail: {
    fields: {
      // Self-serve identity linking: both addresses ride to Supabase only,
      // never into SQLite. Format (the @-and-dot) is checked in the
      // handler; the schema binds shape and length.
      email: { type: "string", required: true, nonEmpty: true, maxLength: 254 },
      owner_email: { type: "string", required: true, nonEmpty: true, maxLength: 254 },
    },
  },
  openDeal: {
    fields: {
      // Optional: when omitted the server issues a namespaced id
      // (option C). Client ids stay namespaced by convention (buyer:...).
      id: { type: "string", nonEmpty: true, maxLength: 128 },
      buyer: { type: "string", required: true, nonEmpty: true, maxLength: 128 },
      seller: { type: "string", required: true, nonEmpty: true, maxLength: 128 },
      price: { type: "integer", required: true, min: 1 },
      // Optional buyer brief for the Hire flow (e.g. { prompt: "..." }).
      // At most 10 keys; values may be any JSON so seller input schemas
      // can require structured fields like arrays. The seller's
      // input_schema validates the shape at open time.
      metadata: { type: "object", maxKeys: 10 },
    },
  },
  move: {
    fields: {
      dealId: { type: "string", required: true, nonEmpty: true, maxLength: 128 },
      key: { type: "string", required: true, nonEmpty: true, maxLength: 128 },
      kind: { type: "string", required: true, allowed: ["OFFER", "ACCEPT", "WALK"] },
      // A priced move locks funds, so the amount must be present; a WALK
      // locks nothing, so any price on it is a client bug, not a discount.
      price: {
        type: "integer",
        min: 1,
        requiredWhen: { field: "kind", is: ["OFFER", "ACCEPT"] },
        forbiddenWhen: { field: "kind", is: ["WALK"] },
      },
    },
  },
  delivery: {
    fields: {
      id: { type: "string", required: true, nonEmpty: true, maxLength: 128 },
      dealId: { type: "string", required: true, nonEmpty: true, maxLength: 128 },
      // Opaque deliverable reference for the async AI Inspector. The server
      // never fetches it in this slice (see inspector.js TODO); the client
      // must never decide the verdict, so no status field is accepted here.
      deliveryUrl: { type: "string", required: true, nonEmpty: true, maxLength: 2048 },
      // Optional per-delivery modality override for inspection routing.
      // Optional so every existing delivery payload keeps validating.
      capability: { type: "string", maxLength: 64 },
    },
  },
  // Real-settlement capture: the buyer funds the escrow wallet on-chain
  // (Base Sepolia USDC) and proves it with the funding tx hash, which the
  // handler verifies before locking. Unknown fields stay rejected.
  pay: {
    fields: {
      tx_hash: { type: "string", nonEmpty: true, maxLength: 66 },
    },
  },
  rotateKey: {
    fields: {},
  },
  authVerify: {
    fields: {
      message: { type: "string", required: true, nonEmpty: true },
      signature: { type: "string", required: true, nonEmpty: true },
      wallet_address: { type: "string", required: true, nonEmpty: true, maxLength: 42 },
    },
  },
  graduateAgent: {
    fields: {},
  },
};

function fail(field, message) {
  return { ok: false, code: "INVALID_SCHEMA", field, message };
}

function matchesWhen(request, clause) {
  if (!clause) return false;
  return Array.isArray(clause.is) && clause.is.includes(request[clause.field]);
}

function checkType(rule, value) {
  if (rule.type === "string") return typeof value === "string";
  if (rule.type === "integer") return Number.isInteger(value);
  if (rule.type === "array") return Array.isArray(value);
  if (rule.type === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
  return false;
}

function typeName(rule) {
  if (rule.type === "integer") return "an integer";
  if (rule.type === "array") return "an array";
  if (rule.type === "object") return "an object";
  return "a string";
}

export function validate(endpoint, request) {
  const schema = SCHEMAS[endpoint];
  if (schema === undefined) {
    return fail("endpoint", `unknown endpoint: ${String(endpoint)}`);
  }
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return fail("(request)", "request must be an object");
  }
  for (const key of Object.keys(request)) {
    if (!Object.hasOwn(schema.fields, key)) {
      return fail(key, `unknown field: ${key}`);
    }
  }
  for (const [name, rule] of Object.entries(schema.fields)) {
    const value = request[name];
    if (value === undefined) {
      if (rule.required || matchesWhen(request, rule.requiredWhen)) {
        return fail(name, `missing required field: ${name}`);
      }
      continue;
    }
    if (matchesWhen(request, rule.forbiddenWhen)) {
      return fail(name, `field is forbidden here: ${name}`);
    }
    if (!checkType(rule, value)) {
      return fail(name, `field ${name} must be ${typeName(rule)}`);
    }
    if (rule.nonEmpty && value.length === 0) {
      return fail(name, `field ${name} must not be empty`);
    }
    if (rule.min !== undefined && value < rule.min) {
      return fail(name, `field ${name} must be at least ${rule.min}`);
    }
    if (rule.max !== undefined && value > rule.max) {
      return fail(name, `field ${name} must be at most ${rule.max}`);
    }
    if (rule.minLength !== undefined && value.length < rule.minLength) {
      return fail(name, `field ${name} must be at least ${rule.minLength} characters`);
    }
    if (rule.maxLength !== undefined && value.length > rule.maxLength) {
      return fail(name, `field ${name} must be at most ${rule.maxLength} characters`);
    }
    if (rule.allowed !== undefined && !rule.allowed.includes(value)) {
      return fail(name, `field ${name} must be one of: ${rule.allowed.join(", ")}`);
    }
    if (rule.type === "array" && rule.maxItems !== undefined && value.length > rule.maxItems) {
      return fail(name, `field ${name} must have at most ${rule.maxItems} items`);
    }
    if (rule.type === "array" && rule.items !== undefined) {
      for (let i = 0; i < value.length; i++) {
        const el = value[i];
        if (rule.items.type === "string" && typeof el !== "string") {
          return fail(name, `field ${name}[${i}] must be a string`);
        }
        if (typeof el === "string") {
          if (rule.items.nonEmpty && el.length === 0) {
            return fail(name, `field ${name}[${i}] must not be empty`);
          }
          if (rule.items.maxLength !== undefined && el.length > rule.items.maxLength) {
            return fail(name, `field ${name}[${i}] must be at most ${rule.items.maxLength} characters`);
          }
        }
      }
    }
    if (rule.type === "object" && rule.maxKeys !== undefined && Object.keys(value).length > rule.maxKeys) {
      return fail(name, `field ${name} must have at most ${rule.maxKeys} keys`);
    }
    if (rule.type === "object" && rule.stringValues === true) {
      for (const [k, v] of Object.entries(value)) {
        if (typeof v !== "string") {
          return fail(name, `field ${name}[${k}] must be a string`);
        }
      }
    }
  }
  return { ok: true };
}
