// Supabase bridge (outbound only): mirrors public agent profiles to the
// `profiles` table for Marketplace discovery and modality filtering.
//
// Fire-and-forget by contract: callers invoke syncProfile() AFTER the
// SQLite commit and never await it in the request path. A Supabase outage
// stales the replica but can never fail a request, roll back SQLite, or
// crash the process — syncProfile never throws and no-ops when unconfigured.
//
// Secrets: the public column allowlist below is the whole payload. api_key
// and any credential must never enter this module.

import { supabaseAdmin } from "./supabase.js";

export const PROFILE_COLUMNS = Object.freeze([
  "agent_id",
  "role",
  "balance",
  "capability",
  "status",
  "title",
  "description",
  "price",
  "category",
  "service_type",
  "min_price",
  "skills",
  "metadata",
  "input_schema",
  // Syncable but never sourced from SQLite (emails live only in Supabase;
  // link-email passes them explicitly). Still allowlisted so the transport
  // can carry them.
  "email",
  "owner_email",
]);

// Pure allowlist projection: SQLite row -> Supabase row. Unknown fields
// are dropped, never forwarded.
export function buildProfilePayload(row) {
  if (typeof row !== "object" || row === null) return null;
  const id = row.agent_id ?? row.id;
  if (typeof id !== "string" || id.length === 0) return null;
  const payload = {
    agent_id: id,
    role: row.role ?? null,
    balance: Number.isInteger(row.balance) ? row.balance : 0,
    capability: typeof row.capability === "string" ? row.capability : null,
    status: typeof row.status === "string" ? row.status : "PENDING",
    title: typeof row.title === "string" ? row.title : null,
    description: typeof row.description === "string" ? row.description : null,
    price: Number.isInteger(row.price) ? row.price : null,
    category: typeof row.category === "string" ? row.category : null,
    service_type: typeof row.service_type === "string" ? row.service_type : "negotiation",
    min_price: Number.isInteger(row.min_price) ? row.min_price : null,
  };
  // Structured strategy columns ride as native JSON (jsonb on the replica),
  // present only when set — partial syncs (status transitions) must never
  // clobber them with nulls.
  if (row.skills !== undefined) payload.skills = row.skills;
  if (row.metadata !== undefined && row.metadata !== null) payload.metadata = row.metadata;
  // Seller-declared brief schema for Schema-Driven Commerce. Present only
  // when set, so partial syncs never clobber it with nulls.
  if (row.input_schema !== undefined && row.input_schema !== null) payload.input_schema = row.input_schema;
  // Present only when explicitly supplied (link-email): absent emails are
  // omitted, never nulled, so routine syncs cannot clobber a linked address
  // on merge-duplicates upserts.
  if (typeof row.email === "string") payload.email = row.email;
  if (typeof row.owner_email === "string") payload.owner_email = row.owner_email;
  return payload;
}

function supabaseConfig(env = process.env) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (typeof url !== "string" || url.length === 0) return null;
  if (typeof key !== "string" || key.length === 0) return null;
  return { url: url.replace(/\/$/, ""), key };
}

// Named lifecycle wrappers: registration and moderation call these (not
// syncProfile directly) so call sites read as domain events. Same
// never-throws contract throughout.
export async function syncAgentRegistration(agent, env = process.env) {
  const client = supabaseAdmin(env);
  if (client === null) {
    return { ok: false, code: "UNCONFIGURED", message: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set" };
  }
  const payload = buildProfilePayload(agent);
  if (payload === null) {
    return { ok: false, code: "BAD_ROW", message: "profile row has no agent id" };
  }
  return client.upsertProfile(payload);
}

export async function syncAgentStatus(agentId, status, _reason, env = process.env) {
  const client = supabaseAdmin(env);
  if (client === null) {
    return { ok: false, code: "UNCONFIGURED", message: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set" };
  }
  if (typeof agentId !== "string" || agentId.length === 0) {
    return { ok: false, code: "BAD_ROW", message: "profile row has no agent id" };
  }
  return client.upsertProfile({ agent_id: agentId, status });
}

export async function syncAgentEmails(agentId, { email, owner_email }, env = process.env) {
  const client = supabaseAdmin(env);
  if (client === null) {
    return { ok: false, code: "UNCONFIGURED", message: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set" };
  }
  if (typeof agentId !== "string" || agentId.length === 0) {
    return { ok: false, code: "BAD_ROW", message: "profile row has no agent id" };
  }
  return client.updateEmails(agentId, { email, owner_email });
}

// Upsert one profile row. Resolves (never rejects) with a result envelope
// so fire-and-forget callers can .catch defensively AND inspect in tests.
export async function syncProfile(row, env = process.env) {
  const payload = buildProfilePayload(row);
  if (payload === null) {
    return { ok: false, code: "BAD_ROW", message: "profile row has no agent id" };
  }
  const config = supabaseConfig(env);
  if (config === null) {
    return { ok: false, code: "UNCONFIGURED", message: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set" };
  }
  try {
    const res = await fetch(`${config.url}/rest/v1/profiles?on_conflict=agent_id`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: config.key,
        authorization: `Bearer ${config.key}`,
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      return { ok: false, code: "SYNC_FAILED", message: `supabase answered ${res.status}` };
    }
    return { ok: true, agent_id: payload.agent_id };
  } catch (err) {
    return { ok: false, code: "SYNC_ERROR", message: err?.message ?? "sync failed" };
  }
}
