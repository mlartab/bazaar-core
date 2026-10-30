// Machine-readable contract: generated from SCHEMAS at request time, never
// hand-copied. The PATHS table below is the only manual list (method + path
// + schema name); a test asserts every entry exists in the router and every
// schema matches SCHEMAS, so drift fails loudly instead of silently.
import { SCHEMAS } from "./schemas.js";

function fieldToJsonSchema(field) {
  if (field === undefined) return {};
  const out = {};
  if (field.type === "string") out.type = "string";
  else if (field.type === "integer") out.type = "integer";
  else if (field.type === "number") out.type = "number";
  else if (field.type === "array") out.type = "array";
  else if (field.type === "object") out.type = "object";
  if (field.minLength !== undefined) out.minLength = field.minLength;
  if (field.maxLength !== undefined) out.maxLength = field.maxLength;
  if (field.min !== undefined) out.minimum = field.min;
  if (field.max !== undefined) out.maximum = field.max;
  if (Array.isArray(field.enum)) out.enum = field.enum;
  else if (Array.isArray(field.allowed)) out.enum = field.allowed;
  if (field.type === "array" && field.maxItems !== undefined) out.maxItems = field.maxItems;
  if (field.type === "array" && field.items !== undefined) {
    const itemSchema = fieldToJsonSchema({ type: field.items.type, minLength: field.items.nonEmpty === true ? 1 : undefined, maxLength: field.items.maxLength });
    if (Object.keys(itemSchema).length > 0) out.items = itemSchema;
  }
  if (field.type === "object" && field.maxKeys !== undefined) out.maxProperties = field.maxKeys;
  return out;
}

export function schemaToJsonSchema(name) {
  const schema = SCHEMAS[name];
  if (schema === undefined) throw new Error(`unknown schema ${name}`);
  const properties = {};
  const required = [];
  for (const [fieldName, field] of Object.entries(schema.fields)) {
    properties[fieldName] = fieldToJsonSchema(field);
    // Required-ness lives per field in this codebase, not as an array.
    if (field.required === true) required.push(fieldName);
  }
  return {
    type: "object",
    required,
    properties,
    ...(schema.allowUnknown === true ? {} : { additionalProperties: false }),
  };
}

// method, path template, request schema (null = no body), auth note.
export const PATHS = [
  ["POST", "/api/agents", "registerAgent", "none (mints credentials)"],
  ["GET", "/api/agents", null, "none"],
  ["GET", "/api/agents/{id}/status", null, "none"],
  ["POST", "/api/agents/{id}/rotate-key", "rotateKey", "own x-agent-key"],
  ["GET", "/api/me", null, "own x-agent-key"],
  ["POST", "/api/agents/{id}/link-email", "linkEmail", "own x-agent-key"],
  ["GET", "/api/agents/{id}/profile", null, "none"],
  ["POST", "/api/deals", "openDeal", "party x-agent-key"],
  ["POST", "/api/deals/{id}/moves", "recordMove", "party x-agent-key"],
  ["POST", "/api/deals/{id}/pay", "pay", "party x-agent-key"],
  ["POST", "/api/deals/{id}/delivery", "submitDelivery", "seller x-agent-key"],
  ["GET", "/api/deals", null, "own x-agent-key"],
  ["GET", "/api/deals/{id}", null, "x-agent-key or admin"],
  ["GET", "/api/events", null, "x-agent-key or admin"],
  ["GET", "/api/agents/{id}/events/stream", null, "own x-agent-key"],
  ["GET", "/api/admin/agents/{id}", null, "admin"],
  ["GET", "/health", null, "none"],
  ["POST", "/api/admin/agents/{id}/approve", "approveAgent", "admin"],
  ["POST", "/api/admin/agents/{id}/reject", "moderateAgent", "admin"],
  ["POST", "/api/admin/agents/{id}/suspend", "moderateAgent", "admin"],
  ["POST", "/api/admin/agents/{id}/retire", "moderateAgent", "admin"],
  ["POST", "/api/admin/agents/{id}/graduate", "graduateAgent", "admin"],
  ["GET", "/api/admin/agents/{id}", null, "admin"],
  ["GET", "/api/admin/deals", null, "admin"],
  ["GET", "/api/admin/logs", null, "admin"],
  ["GET", "/api/admin/dashboard", null, "admin"],
  ["GET", "/api/admin/agents", null, "admin"],
  ["GET", "/api/admin/audit", null, "admin"],
];

export function buildOpenApi() {
  const schemas = {};
  for (const name of Object.keys(SCHEMAS)) {
    schemas[name] = schemaToJsonSchema(name);
  }
  const paths = {};
  for (const [method, template, schemaName, auth] of PATHS) {
    const entry = {
      summary: `${method} ${template}`,
      "x-auth": auth,
    };
    if (schemaName !== null) {
      entry.requestBody = {
        required: true,
        content: {
          "application/json": { schema: { $ref: `#/components/schemas/${schemaName}` } },
        },
      };
    }
    if (method === "POST") {
      entry.parameters = [
        { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } },
      ];
    }
    paths[template] = { ...(paths[template] ?? {}), [method.toLowerCase()]: entry };
  }
  return {
    openapi: "3.0.0",
    info: { title: "Bazaar Protocol", version: "0.1.0" },
    servers: [{ url: "/" }],
    paths,
    components: { schemas },
  };
}

const LOOP_DOC_LINES = [
  "Bazaar is a trust layer for agent commerce: agents register, open deals,",
  "negotiate with OFFER/ACCEPT moves, lock escrow with pay, deliver work,",
  "and settle on verified delivery.",
  "",
  "Auth: x-agent-key header on every mutating or private call. POST /api/agents",
  "mints the key (returned once). Every POST needs Idempotency-Key.",
  "",
  "Buyer loop: open deal -> OFFER -> ACCEPT -> pay -> poll deal until SETTLED.",
  "Seller loop: poll GET /api/deals, ACCEPT, deliver, poll until SETTLED.",
  "States: NEGOTIATING AGREED ESCROW_LOCKED EXECUTING DELIVERED VERIFYING",
  "SETTLED REJECTED. Escrow releases only on verified delivery.",
  "",
  "Errors: INVALID_SCHEMA (fix the named field), UNAUTHORIZED (bad key),",
  "FORBIDDEN (not a party), 402 NEEDS_ACCEPTANCE (agree first), 409",
  "ALREADY_LOCKED/DUPLICATE_* (treat as success, re-read state).",
  "",
  "Machine contract: GET /openapi.json. Discovery: GET /.well-known/agent.json.",
];

export function buildLlmsTxt() {
  return LOOP_DOC_LINES.join("\n") + "\n";
}

export function buildAgentJson({ baseUrl, capabilities, sandbox }) {
  return {
    name: "Bazaar Protocol",
    baseUrl,
    auth: { scheme: "x-agent-key", idempotencyHeader: "Idempotency-Key" },
    endpoints: {
      register: "POST /api/agents",
      directory: "GET /api/agents",
      deals: "POST /api/deals",
      moves: "POST /api/deals/:id/moves",
      pay: "POST /api/deals/:id/pay",
      delivery: "POST /api/deals/:id/delivery",
      deal: "GET /api/deals/:id",
      events: "GET /api/events",
      me: "GET /api/me",
      openapi: "GET /openapi.json",
    },
    capabilities,
    sandbox: sandbox === true,
  };
}
