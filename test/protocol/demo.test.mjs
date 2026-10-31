import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../../protocol/server.js";

// The sandbox sets HTTP(S)_PROXY for external traffic; loopback test
// traffic must bypass it or fetch tunnels 127.0.0.1 through the proxy.
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";
// Same-process server reads these at request/boot time; neither secret
// leaves the test process. DEMO_SAFE is pinned here and restored after:
// each test file runs in its own process, but hygiene is free.
process.env.ADMIN_SECRET = "test-demo-secret";
const savedDemoSafe = process.env.DEMO_SAFE;
process.env.DEMO_SAFE = "true";

let url;
let stop;
let dir;
let n = 0;

const freshKey = () => `demo-${(n += 1)}`;

let buyerKey;

async function post(p, body, k = freshKey(), agentKey = buyerKey) {
  const headers = { "content-type": "application/json", "idempotency-key": k };
  if (agentKey !== undefined) headers["x-agent-key"] = agentKey;
  const res = await fetch(url + p, { method: "POST", headers, body: JSON.stringify(body) });
  return [res.status, await res.json()];
}

async function apost(p, body) {
  const res = await fetch(url + p, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": freshKey(),
      authorization: "Bearer test-demo-secret",
    },
    body: JSON.stringify(body),
  });
  return [res.status, await res.json()];
}

async function aget(p) {
  const res = await fetch(url + p, { headers: { authorization: "Bearer test-demo-secret" } });
  return [res.status, await res.json()];
}

function assertOk(body) {
  assert.equal(body.ok, true);
  assert.ok("state" in body);
  assert.ok("allowedMoves" in body);
  assert.ok("result" in body);
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bazaar-demo-"));
  const started = await startServer({ dbPath: path.join(dir, "store.db"), port: 0 });
  url = started.url;
  stop = started.close;
  const [s1, b1] = await post("/api/agents", { id: "demo-buyer", role: "buyer" });
  assert.equal(s1, 200);
  buyerKey = b1.result.api_key;
  // Commerce requires ACTIVE counterparties (demo-seller was never even
  // registered before; both sides must exist and be approved).
  const [ss] = await post("/api/agents", { id: "demo-seller", role: "seller" });
  assert.equal(ss, 200);
  for (const id of ["demo-buyer", "demo-seller"]) {
    const [as] = await apost(`/api/admin/agents/${id}/approve`, {});
    assert.equal(as, 200, id);
  }
});

after(async () => {
  await stop();
  fs.rmSync(dir, { recursive: true, force: true });
  if (savedDemoSafe === undefined) delete process.env.DEMO_SAFE;
  else process.env.DEMO_SAFE = savedDemoSafe;
});

test("protocol: demo-safe boot advertises itself on the dashboard", async () => {
  const [status, body] = await aget("/api/admin/dashboard");
  assert.equal(status, 200);
  assertOk(body);
  assert.equal(body.result.demoSafe, true);
});

test("protocol: demo-safe manual sweep fires on demand and reports groups", async () => {
  const [os_, ob] = await post("/api/deals", { id: "d-demo-live", buyer: "demo-buyer", seller: "demo-seller", price: 40 });
  assert.equal(os_, 200);
  assert.equal(ob.state, "NEGOTIATING");
  const [status, body] = await apost("/api/admin/demo/sweep", {});
  assert.equal(status, 200);
  assertOk(body);
  assert.equal(body.result.demoSafe, true);
  assert.deepEqual(Object.keys(body.result.sweeps).sort(), ["deliveries", "inspections", "sessions"]);
  // Nothing overdue yet: all three groups report empty outcomes...
  assert.deepEqual(body.result.sweeps.sessions, []);
  assert.deepEqual(body.result.sweeps.deliveries, []);
  assert.deepEqual(body.result.sweeps.inspections, []);
  // ...and the live deal is untouched.
  const [gs, gb] = await post("/api/deals/d-demo-live/moves", { key: "k1", kind: "WALK" });
  assert.equal(gs, 200);
  assert.equal(gb.state, "NEGOTIATING");
});

test("protocol: demo sweep rejects without admin credentials", async () => {
  const res = await fetch(url + "/api/admin/demo/sweep", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": freshKey() },
    body: "{}",
  });
  assert.equal(res.status, 401);
});

test("protocol: SSE stream rejects anonymous listeners", async () => {
  const res = await fetch(url + "/api/admin/events/stream");
  assert.equal(res.status, 401);
  await res.arrayBuffer();
});

test("protocol: SSE stream delivers live protocol events", async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${url}/api/admin/events/stream?token=test-demo-secret`, { signal: ctrl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const nextFrame = async () => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const cut = buf.indexOf("\n\n");
      if (cut !== -1) {
        const frame = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        return frame;
      }
      if (Date.now() > deadline) throw new Error("timed out waiting for SSE frame");
      const { done, value } = await reader.read();
      if (done) throw new Error("SSE stream closed early");
      buf += dec.decode(value, { stream: true });
    }
  };
  try {
    // Greeting comment first; data frames follow live events.
    const hello = await nextFrame();
    assert.ok(hello.startsWith(":"));
    // Trigger exactly one protocol event and await its frame.
    const [rs] = await post("/api/agents", { id: "sse-agent", role: "seller" });
    assert.equal(rs, 200);
    let data = null;
    const deadline = Date.now() + 5000;
    while (data === null && Date.now() < deadline) {
      const frame = await nextFrame();
      if (frame.startsWith("data:")) {
        const parsed = JSON.parse(frame.slice("data:".length).trim());
        if (parsed.type === "AGENT_REGISTERED" && parsed.agentId === "sse-agent") data = parsed;
      }
    }
    assert.ok(data !== null, "AGENT_REGISTERED frame never arrived");
    assert.ok(typeof data.seq === "number");
  } finally {
    ctrl.abort();
    try { await reader.cancel(); } catch { /* already closed */ }
  }
});
