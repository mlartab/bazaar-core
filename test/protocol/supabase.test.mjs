import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startServer } from "../../protocol/server.js";
import { syncAgentRegistration, syncAgentStatus, buildProfilePayload } from "../../protocol/supabase-sync.js";

// The sandbox sets HTTP(S)_PROXY for external traffic; loopback test
// traffic must bypass it or fetch tunnels 127.0.0.1 through the proxy.
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";

const savedUrl = process.env.SUPABASE_URL;
const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let url;
let stop;
let dir;
let n = 0;

const freshKey = () => `supabase-${(n += 1)}`;

let keyA;
let keyB;

// Fake Supabase origin: records upserts, serves programmed profile rows.
// Nothing here asserts SDK behavior — the server speaks plain REST.
const fake = { upserts: [], rows: {} };

async function post(p, body, k = freshKey(), agentKey = undefined) {
  const headers = { "content-type": "application/json", "idempotency-key": k };
  if (agentKey !== undefined) headers["x-agent-key"] = agentKey;
  const res = await fetch(url + p, { method: "POST", headers, body: JSON.stringify(body) });
  return [res.status, await res.json()];
}

async function get(p, agentKey = undefined) {
  const headers = {};
  if (agentKey !== undefined) headers["x-agent-key"] = agentKey;
  const res = await fetch(url + p, { headers });
  return [res.status, await res.json()];
}

let fakeBase;

function useDeadReplica() {
  // Unroutable loopback port: sync fails fast with ECONNREFUSED while test
  // HTTP to the real server keeps working (no global fetch stubbing).
  process.env.SUPABASE_URL = "http://127.0.0.1:1";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
}

function useFakeReplica(base = fakeBase) {
  process.env.SUPABASE_URL = base;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bazaar-supabase-"));
  const started = await startServer({ dbPath: path.join(dir, "store.db"), port: 0 });
  url = started.url;
  stop = started.close;
  const fakeServer = http.createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => { text += chunk; });
    req.on("end", () => {
      if (req.method === "POST" && req.url.startsWith("/rest/v1/profiles")) {
        fake.upserts.push(JSON.parse(text));
        res.writeHead(200, { "content-type": "application/json" });
        res.end("[]");
      } else if (req.method === "GET" && req.url.startsWith("/rest/v1/profiles")) {
        const id = new URL(req.url, "http://x").searchParams.get("agent_id")?.replace(/^eq\./, "");
        const row = id !== null && fake.rows[id] !== undefined ? [fake.rows[id]] : [];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(row));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise((resolve) => fakeServer.listen(0, "127.0.0.1", resolve));
  closersFake.push(fakeServer);
  fakeBase = `http://127.0.0.1:${fakeServer.address().port}`;
  useFakeReplica();
  const [sa, ba] = await post("/api/agents", { id: "link-a", role: "seller", capability: "image_gen" });
  assert.equal(sa, 200);
  keyA = ba.result.api_key;
  const [sb, bb] = await post("/api/agents", { id: "link-b", role: "seller" });
  assert.equal(sb, 200);
  keyB = bb.result.api_key;
});

const closersFake = [];

after(async () => {
  await stop();
  for (const s of closersFake) {
    await new Promise((resolve) => s.close(resolve));
  }
  fs.rmSync(dir, { recursive: true, force: true });
  if (savedUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = savedUrl;
  if (savedKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
});

test("protocol: registration succeeds with a dead replica and leaks no key", async () => {
  useDeadReplica();
  try {
    const [status, body] = await post("/api/agents", { id: "offline-agent", role: "buyer" });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.result.agent.id, "offline-agent");
    assert.ok(typeof body.result.api_key === "string");
  } finally {
    useFakeReplica();
  }
});

test("protocol: link-email rejects without a key and on id mismatch", async () => {
  const payload = { email: "a@example.com", owner_email: "owner@example.com" };
  const [s401] = await post("/api/agents/link-a/link-email", payload);
  assert.equal(s401, 401);
  const [s403, b403] = await post("/api/agents/link-a/link-email", payload, freshKey(), keyB);
  assert.equal(s403, 403);
  assert.equal(b403.error.code, "FORBIDDEN");
  const [s400] = await post("/api/agents/link-a/link-email", { email: "not-an-email", owner_email: "owner@example.com" }, freshKey(), keyA);
  assert.equal(s400, 400);
});

test("protocol: link-email writes Supabase without secrets", async () => {
  const port = new URL(process.env.SUPABASE_URL ?? "").port;
  assert.notEqual(port, "1", "fake replica must be configured");
  fake.upserts.length = 0;
  const [status, body] = await post(
    "/api/agents/link-a/link-email",
    { email: "a@example.com", owner_email: "owner@example.com" },
    freshKey(),
    keyA,
  );
  assert.equal(status, 200);
  assert.deepEqual(body.result, { agent_id: "link-a", linked: true });
  assert.equal(fake.upserts.length, 1);
  assert.deepEqual(fake.upserts[0], { agent_id: "link-a", email: "a@example.com", owner_email: "owner@example.com" });
});

test("protocol: link-email answers 503 when the replica is dead", async () => {
  useDeadReplica();
  try {
    const [status, body] = await post(
      "/api/agents/link-a/link-email",
      { email: "a@example.com", owner_email: "owner@example.com" },
      freshKey(),
      keyA,
    );
    assert.equal(status, 503);
    assert.equal(body.error.code, "SUPABASE_UNAVAILABLE");
  } finally {
    useFakeReplica();
  }
});

test("protocol: profile falls back to SQLite with no secrets", async () => {
  useDeadReplica();
  try {
    const [status, body] = await get("/api/agents/link-a/profile");
    assert.equal(status, 200);
    assert.equal(body.result.source, "sqlite");
    assert.equal(body.result.agent_id, "link-a");
    assert.ok(!("api_key" in body.result));
    assert.ok(!("id" in body.result));
  } finally {
    useFakeReplica();
  }
  const [s404] = await get("/api/agents/nobody/profile");
  assert.equal(s404, 404);
});

test("protocol: profile serves the Supabase row when reachable", async () => {
  const port = new URL(process.env.SUPABASE_URL ?? "").port;
  assert.notEqual(port, "1", "fake replica must be configured");
  fake.rows["link-a"] = {
    agent_id: "link-a",
    role: "seller",
    capability: "image_gen",
    status: "ACTIVE",
    email: "a@example.com",
    owner_email: "owner@example.com",
    created_at: "2026-01-01T00:00:00Z",
  };
  try {
    const [status, body] = await get("/api/agents/link-a/profile");
    assert.equal(status, 200);
    assert.equal(body.result.source, "supabase");
    assert.equal(body.result.email, "a@example.com");
    assert.equal(body.result.owner_email, "owner@example.com");
    assert.ok(!("api_key" in body.result));
  } finally {
    delete fake.rows["link-a"];
  }
});

test("protocol: admin PATCH syncs the full listing payload to Supabase", async () => {
  const savedSecret = process.env.ADMIN_SECRET;
  process.env.ADMIN_SECRET = "test-admin-secret";
  try {
    const [rs, rb] = await post("/api/agents", {
      id: "sync-shop",
      role: "seller",
      capability: "image_gen",
      title: "Sync Shop Title",
      description: "A well-made listing used to verify replica sync payloads.",
      price: 150,
      category: "image_gen",
    });
    assert.equal(rs, 200);
    assert.ok(typeof rb.result.api_key === "string");
    // Drop the registration upsert: only the edit sync may satisfy the wait.
    fake.upserts.length = 0;
    const pres = await fetch(url + "/api/admin/agents/sync-shop", {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: "Bearer test-admin-secret" },
      body: JSON.stringify({
        title: "Recut Sync Title",
        price: 250,
        service_type: "endpoint",
        min_price: 99,
        skills: ["react"],
        metadata: { endpoint_url: "https://api.example.com/v1" },
      }),
    });
    assert.equal(pres.status, 200);
    // The PATCH handler syncs fire-and-forget, so wait for the replica write.
    let synced = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      synced = fake.upserts.find((u) => u.agent_id === "sync-shop" && u.title === "Recut Sync Title") ?? null;
      if (synced !== null) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(synced !== null, "expected the edited listing to reach Supabase");
    assert.equal(synced.description, "A well-made listing used to verify replica sync payloads.");
    assert.equal(synced.price, 250);
    assert.equal(synced.category, "image_gen");
    assert.equal(synced.capability, "image_gen");
    // Strategy columns ride the same sync.
    assert.equal(synced.service_type, "endpoint");
    assert.equal(synced.min_price, 99);
    assert.deepEqual(synced.skills, ["react"]);
    assert.deepEqual(synced.metadata, { endpoint_url: "https://api.example.com/v1" });
    assert.ok(!("api_key" in synced), "replica payload must never carry credentials");
  } finally {
    if (savedSecret === undefined) delete process.env.ADMIN_SECRET;
    else process.env.ADMIN_SECRET = savedSecret;
  }
});

test("protocol: sync wrappers report UNCONFIGURED without env", async () => {
  const savedU = process.env.SUPABASE_URL;
  const savedK = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    assert.equal((await syncAgentRegistration({ id: "x" })).code, "UNCONFIGURED");
    assert.equal((await syncAgentStatus("x", "ACTIVE", null)).code, "UNCONFIGURED");
    assert.equal(buildProfilePayload({ id: "x", api_key: "SECRET" }).api_key, undefined);
  } finally {
    if (savedU !== undefined) process.env.SUPABASE_URL = savedU;
    if (savedK !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedK;
  }
});
