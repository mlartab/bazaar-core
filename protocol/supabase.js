// Supabase transport (outbound identity replica): minimal REST client over
// the `profiles` table. Zero new dependencies — plain fetch, same as the
// proven sync seam. Every function resolves a result envelope and never
// throws, so fire-and-forget callers stay safe and tests can drive the
// UNCONFIGURED path without env.
//
// If realtime subscriptions or storage ever justify @supabase/supabase-js,
// this file is the single drop-in point; no caller touches transport.

export const PROFILES_TABLE = "profiles";

export function supabaseConfig(env = process.env) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (typeof url !== "string" || url.length === 0) return null;
  if (typeof key !== "string" || key.length === 0) return null;
  return { url: url.replace(/\/$/, ""), key };
}

// Lazy admin client: base URL + service-role key bound at call time (env
// is read per call, never at import, so tests can flip it freely).
export function supabaseAdmin(env = process.env) {
  const config = supabaseConfig(env);
  if (config === null) return null;
  const headers = {
    "content-type": "application/json",
    apikey: config.key,
    authorization: `Bearer ${config.key}`,
  };
  const request = async (path, options = {}) => {
    try {
      const res = await fetch(`${config.url}/rest/v1/${path}`, {
        ...options,
        headers: { ...headers, ...(options.headers ?? {}) },
      });
      if (!res.ok) {
        return { ok: false, code: "SYNC_FAILED", message: `supabase answered ${res.status}` };
      }
      return { ok: true, res };
    } catch (err) {
      return { ok: false, code: "SYNC_ERROR", message: err?.message ?? "sync failed" };
    }
  };
  return {
    upsertProfile: async (payload) => {
      const out = await request(`${PROFILES_TABLE}?on_conflict=agent_id`, {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify(payload),
      });
      if (!out.ok) return out;
      return { ok: true, agent_id: payload.agent_id };
    },
    updateEmails: async (agentId, { email, owner_email }) => {
      const out = await request(`${PROFILES_TABLE}?on_conflict=agent_id`, {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ agent_id: agentId, email, owner_email }),
      });
      if (!out.ok) return out;
      return { ok: true, agent_id: agentId };
    },
    fetchProfile: async (agentId) => {
      const out = await request(
        `${PROFILES_TABLE}?agent_id=eq.${encodeURIComponent(agentId)}&select=*`,
        { method: "GET" },
      );
      if (!out.ok) return out;
      const rows = await out.res.json().catch(() => null);
      if (!Array.isArray(rows) || rows.length === 0) {
        return { ok: false, code: "NO_SUCH_PROFILE", message: `no profile for agent ${agentId}` };
      }
      return { ok: true, profile: rows[0] };
    },
  };
}
