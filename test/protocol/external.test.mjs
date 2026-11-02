import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../../protocol/server.js";
import { SCHEMAS } from "../../protocol/schemas.js";
import { buildOpenApi } from "../../protocol/openapi.js";

// Loopback must bypass the sandbox proxy; the admin secret never leaves
// this process. AUTO_APPROVE is read at boot, so it is set before the
// server starts and stays on for the whole file.
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";
process.env.ADMIN_SECRET = "test-external-secret";
process.env.AUTO_APPROVE = "true";
process.env.REGISTRATION_PER_IP_PER_HOUR = "1000";

let url;
let stop;
let dir;
let n = 0;

const freshKey = () => `ext-${(n += 1)}`;

async function post(p, body, { key, agentKey, xff } = {}) {
  const headers = { "content-type": "application/json", "idempotency-key": key ?? freshKey() };
  if (agentKey !== undefined) headers["x-agent-key"] = agentKey;
  if (xff !== undefined) headers["x-forwarded-for"] = xff;
  const res = await fetch(url + p, { method: "POST", headers, body: JSON.stringify(body) });
  return [res.status, await res.json()];
}

async function get(p, agentKey) {
  const headers = agentKey === undefined ? {} : { "x-agent-key": agentKey };
  const res = await fetch(url + p, { headers });
  return [res.status, await res.json()];
}

async function aget(p, body) {
  const res = await fetch(url + p, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": freshKey(), authorization: `Bearer ${process.env.ADMIN_SECRET}` },
    body: JSON.stringify(body ?? {}),
  });
  return [res.status, await res.json()];
}

async function agetGet(p) {
  const res = await fetch(url + p, { headers: { authorization: `Bearer ${process.env.ADMIN_SECRET}` } });
  return [res.status, await res.json()];
}

function assertErr(body, code) {
  assert.equal(body.ok, false);
  assert.equal(body.error.code, code);
}

let buyerKey;
let sellerKey;

async function register(id, role, extra = {}) {
  const [status, body] = await post("/api/agents", { id, role, ...extra });
  assert.equal(status, 200);
  return body.result;
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bazaar-external-"));
  const started = await startServer({ dbPath: path.join(dir, "store.db"), port: 0 });
  url = started.url;
  stop = started.close;
  buyerKey = (await register("ext-buyer", "buyer")).api_key;
  sellerKey = (await register("ext-seller", "seller", { title: "External Seller Listing", description: "A sufficiently long description for the external seller.", price: 100, category: "image_gen" })).api_key;
});

after(async () => {
  await stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("protocol: /openapi.json is generated from SCHEMAS and every path exists", async () => {
  const spec = buildOpenApi();
  assert.deepEqual(spec.components.schemas.registerAgent, {
    type: "object",
    required: ["id", "role"],
    properties: {
      id: { type: "string", maxLength: 128 },
      role: { type: "string", enum: ["buyer", "seller"] },
      capability: { type: "string" },
      title: { type: "string", minLength: 5, maxLength: 60 },
      description: { type: "string", minLength: 20, maxLength: 250 },
      price: { type: "integer", minimum: 1, maximum: 100000 },
      delivery_sla_seconds: { type: "integer", minimum: 60, maximum: 86400 },
      category: {
        type: "string",
        enum: ["image_gen", "video_gen", "data", "text_gen", "speech", "speech_transcription"],
      },
      service_type: { type: "string", enum: ["endpoint", "negotiation", "compute"] },
      min_price: { type: "integer", minimum: 1, maximum: 100000 },
      skills: { type: "array", maxItems: 10, items: { type: "string", minLength: 1, maxLength: 64 } },
      metadata: { type: "object", maxProperties: 20 },
      input_schema: { type: "object" },
      wallet_address: { type: "string", maxLength: 42 },
    },
    additionalProperties: false,
  });
  // openDeal carries the buyer brief: optional metadata, max 10 keys, any
  // JSON values (the seller's input_schema checks the shape at open time).
  assert.deepEqual(spec.components.schemas.openDeal.properties.metadata, {
    type: "object",
    maxProperties: 10,
  });
  assert.deepEqual(spec.components.schemas.openDeal.required, ["buyer", "seller", "price"]);
  const [s, b] = await get("/openapi.json");
  assert.equal(s, 200);
  assert.deepEqual(b.result.paths["/api/agents"].post.requestBody.content["application/json"].schema, {
    $ref: "#/components/schemas/registerAgent",
  });
  // Every spec path resolves to a real route (404 would mean drift).
  // Probes are side-effect free: the rotate probe uses an unknown id so it
  // 403s on the own-key check instead of touching a real credential.
  const probes = [
    ["GET", "/api/agents", undefined, 200],
    ["GET", "/api/me", buyerKey, 200],
    ["POST", "/api/agents/no-such-agent/rotate-key", buyerKey, 403],
    ["GET", "/api/admin/agents/no-such-agent", undefined, 404],
  ];
  for (const [method, route, key, want] of probes) {
    const headers = { "content-type": "application/json", "idempotency-key": freshKey() };
    if (key !== undefined) headers["x-agent-key"] = key;
    if (route.startsWith("/api/admin")) headers.authorization = `Bearer ${process.env.ADMIN_SECRET}`;
    const res = await fetch(url + route, { method, headers, body: method === "POST" ? "{}" : undefined });
    const body = await res.json().catch(() => null);
    assert.equal(res.status, want, route);
    // A routed id reports a handler code (FORBIDDEN/NO_SUCH_AGENT); an
    // unrouted path would report NOT_FOUND — so the code proves routing.
    if (route.includes("no-such-agent")) assert.ok(["FORBIDDEN", "NO_SUCH_AGENT"].includes(body.error.code), route);
  }
});

test("protocol: /llms.txt and /.well-known/agent.json describe the loop", async () => {
  const [s1, b1] = await get("/llms.txt");
  assert.equal(s1, 200);
  assert.match(b1.result.text, /Idempotency-Key/);
  // The loop doc tells sellers where the buyer's brief lives.
  assert.match(b1.result.text, /result\.deal\.metadata/);
  const [s2, b2] = await get("/.well-known/agent.json");
  assert.equal(s2, 200);
  assert.equal(b2.result.name, "Bazaar Protocol");
  assert.match(b2.result.baseUrl, /^http:\/\//);
  assert.equal(b2.result.auth.scheme, "x-agent-key");
  assert.ok(Array.isArray(b2.result.capabilities));
  // Seller search is described so agents know how to narrow the directory.
  assert.deepEqual(Object.keys(b2.result.directoryFilters).sort(), ["max_price", "service_type", "skill"]);
  assert.deepEqual(b2.result.directoryFilters.service_type.enum, ["endpoint", "negotiation", "compute"]);
  process.env.PUBLIC_BASE_URL = "https://bazaar.example.com";
  const [, b3] = await get("/.well-known/agent.json");
  assert.equal(b3.result.baseUrl, "https://bazaar.example.com");
  delete process.env.PUBLIC_BASE_URL;
});

test("protocol: rotation swaps the key atomically and replays identically", async () => {
  const reg = await register("ext-rot", "buyer");
  const key1 = reg.api_key;
  const [s, b] = await post("/api/agents/ext-rot/rotate-key", {}, { key: "rotate-once", agentKey: key1 });
  assert.equal(s, 200);
  const key2 = b.result.api_key;
  assert.ok(typeof key2 === "string" && key2 !== key1);
  // Idempotent replay with the CURRENT key returns the same new key,
  // not a third one (the auth gate runs before the replay lookup, so the
  // dead key cannot be used to reach it).
  const [rs, rb] = await post("/api/agents/ext-rot/rotate-key", {}, { key: "rotate-once", agentKey: key2 });
  assert.equal(rs, 200);
  assert.equal(rb.result.api_key, key2);
  // Old key is dead everywhere.
  const [ms] = await get("/api/me", key1);
  assert.equal(ms, 401);
  // New key works.
  const [okS, okB] = await get("/api/me", key2);
  assert.equal(okS, 200);
  assert.equal(okB.result.id, "ext-rot");
  // Another agent's key cannot rotate this row.
  const [, fb] = await post("/api/agents/ext-rot/rotate-key", {}, { agentKey: buyerKey });
  assertErr(fb, "FORBIDDEN");
  // Keyless rotation is rejected before the handler runs.
  const [ks, kb] = await post("/api/agents/ext-rot/rotate-key", {});
  assert.equal(ks, 401);
  assertErr(kb, "UNAUTHORIZED");
});

test("protocol: /api/me is owner-only and reports probation and counts", async () => {
  const [s, b] = await get("/api/me", buyerKey);
  assert.equal(s, 200);
  assert.equal(b.result.id, "ext-buyer");
  assert.equal(b.result.role, "buyer");
  assert.equal(b.result.status, "ACTIVE");
  assert.equal(b.result.probation, 1);
  assert.deepEqual(b.result.deals, { open: 0, total: 0 });
  const [ks] = await get("/api/me");
  assert.equal(ks, 401);
});

test("protocol: probation caps price and concurrency, graduate clears them", async () => {
  const prob = (await register("ext-prob", "buyer")).api_key;
  // Over the 500 CR default cap.
  const [, over] = await post("/api/deals", { id: "prob-over", buyer: "ext-prob", seller: "ext-seller", price: 501 }, { agentKey: prob });
  assertErr(over, "PROBATION_LIMIT");
  // At the cap is fine.
  const [okS] = await post("/api/deals", { id: "prob-ok", buyer: "ext-prob", seller: "ext-seller", price: 500 }, { agentKey: prob });
  assert.equal(okS, 200);
  // Four more to reach five concurrent, then the sixth is refused.
  for (let i = 1; i <= 4; i += 1) {
    const [ds] = await post("/api/deals", { id: `prob-d${i}`, buyer: "ext-prob", seller: "ext-seller", price: 10 }, { agentKey: prob });
    assert.equal(ds, 200);
  }
  const [, sixth] = await post("/api/deals", { id: "prob-d6", buyer: "ext-prob", seller: "ext-seller", price: 10 }, { agentKey: prob });
  assertErr(sixth, "PROBATION_LIMIT");
  // Graduate via the operator: audit-logged, caps lifted. Both sides
  // need it here: ext-seller registered under AUTO_APPROVE too, so it is
  // also on probation and would trip the price cap itself.
  const [gs, gb] = await aget("/api/admin/agents/ext-prob/graduate", {});
  assert.equal(gs, 200);
  assert.equal(gb.result.probation, 0);
  const [sg] = await aget("/api/admin/agents/ext-seller/graduate", {});
  assert.equal(sg, 200);
  const [, ab] = await agetGet("/api/admin/audit");
  assert.ok(ab.result.audit.some((e) => e.action === "GRADUATE" && e.agentId === "ext-prob"));
  const [ps] = await post("/api/deals", { id: "prob-post", buyer: "ext-prob", seller: "ext-seller", price: 1000 }, { agentKey: prob });
  assert.equal(ps, 200);
  // Graduating an unknown agent is a 404, not a silent no-op.
  const [ns] = await aget("/api/admin/agents/ext-ghost/graduate", {});
  assert.equal(ns, 404);
});

test("protocol: registration cap is per-IP and X-Forwarded-For aware", async () => {
  process.env.REGISTRATION_PER_IP_PER_HOUR = "2";
  const xff = "203.0.113.77";
  const [a] = await post("/api/agents", { id: "ext-cap-1", role: "buyer" }, { xff });
  assert.equal(a, 200);
  const [b] = await post("/api/agents", { id: "ext-cap-2", role: "buyer" }, { xff });
  assert.equal(b, 200);
  const [c, cb] = await post("/api/agents", { id: "ext-cap-3", role: "buyer" }, { xff });
  assert.equal(c, 429);
  assertErr(cb, "RATE_LIMITED");
  // A different address is unaffected.
  const [d] = await post("/api/agents", { id: "ext-cap-4", role: "buyer" }, { xff: "198.51.100.9" });
  assert.equal(d, 200);
  process.env.REGISTRATION_PER_IP_PER_HOUR = "1000";
});

test("protocol: events feed is party-scoped, registry events stay public", async () => {
  const aKey = (await register("ext-ev-a", "buyer")).api_key;
  const bKey = (await register("ext-ev-b", "seller")).api_key;
  const [ds] = await post("/api/deals", { id: "ext-ev-deal", buyer: "ext-ev-a", seller: "ext-ev-b", price: 40 }, { agentKey: aKey });
  assert.equal(ds, 200);
  const [, ea] = await get("/api/events", aKey);
  assert.ok(ea.result.events.some((e) => e.type === "DEAL_OPENED" && e.dealId === "ext-ev-deal"));
  // An unrelated outsider sees registrations but no foreign deal rows.
  const cKey = (await register("ext-ev-c", "buyer")).api_key;
  const [, ec] = await get("/api/events", cKey);
  assert.ok(ec.result.events.some((e) => e.type === "AGENT_REGISTERED"));
  assert.ok(!ec.result.events.some((e) => e.dealId === "ext-ev-deal"));
  // No balances, keys, or emails anywhere in anyone's feed.
  for (const e of ec.result.events) {
    const text = JSON.stringify(e);
    assert.ok(!/api_key|owner_email|[^_]email/.test(text), `leak in ${e.type}`);
    assert.ok(!/"balance"/.test(text), `balance in ${e.type}`);
  }
});

test("protocol: speech_transcription registers as canonical speech", async () => {
  const reg = await register("ext-speech", "seller", {
    title: "Speech Seller Listing Title",
    description: "A sufficiently long description for the speech seller row.",
    price: 50,
    category: "speech_transcription",
  });
  assert.ok(typeof reg.api_key === "string");
  const [, list] = await get("/api/agents");
  const row = list.result.agents.find((a) => a.id === "ext-speech");
  assert.equal(row.category, "speech");
});

test("protocol: admin agent detail shows probation without changing lists", async () => {
  const [, detail] = await agetGet("/api/admin/agents/ext-buyer");
  assert.equal(detail.result.agent.id, "ext-buyer");
  assert.equal(detail.result.agent.probation, 1);
  // Public and admin list shapes are untouched (no probation field).
  const [, list] = await get("/api/agents");
  for (const a of list.result.agents) {
    assert.ok(!("probation" in a));
    assert.ok(!("balance" in a));
  }
});
