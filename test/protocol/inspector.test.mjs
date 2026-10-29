import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../../protocol/db.js";
import { createLedger, checkInvariant, balanceOf } from "../../src/ledger.js";
import { startServer, reconcileLedger } from "../../protocol/server.js";
import { mockVerdict, runInspection, parseVerdict, buildInspectionPrompt } from "../../protocol/inspector.js";

// The sandbox sets HTTP(S)_PROXY for external traffic; loopback test
// traffic must bypass it or fetch tunnels 127.0.0.1 through the proxy.
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";

const closers = [];
after(async () => {
  for (const close of closers.splice(0)) {
    try {
      await close();
    } catch {
      // Already closed by the test itself.
    }
  }
});

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bazaar-inspector-"));
  closers.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, "store.db") };
}

test("protocol: reconcileLedger replays live locks in creation order", () => {
  const { dir, file } = tempDb();
  const store = openStore(file);
  try {
    store.saveDeal({ id: "r-neg", state: "NEGOTIATING", buyer: "b", seller: "s", price: 100 });
    store.saveDeal({ id: "r-agreed", state: "AGREED", buyer: "b", seller: "s", price: 50 });
    store.saveMove({ id: "r-agreed:k1", deal_id: "r-agreed", key: "k1", kind: "OFFER", price: 50 });
    store.saveMove({ id: "r-agreed:k2", deal_id: "r-agreed", key: "k2", kind: "ACCEPT", price: 40 });
    store.saveDeal({ id: "r-locked", state: "ESCROW_LOCKED", buyer: "b", seller: "s", price: 30 });
    // No ACCEPT move: the lock came from pay, so deal.price is the escrow.
    const ledger = createLedger();
    const outcomes = reconcileLedger({ store, ledger });
    // Creation (rowid) order is preserved across the replay.
    assert.deepEqual(outcomes.map((o) => o.id), ["r-agreed", "r-locked"]);
    assert.deepEqual(outcomes.map((o) => o.relocked), [40, 30]);
    // NEGOTIATING holds no lock and is skipped, not an error.
    assert.ok(outcomes.every((o) => o.error === undefined));
    assert.deepEqual(checkInvariant(ledger), { ok: true });
    // Opening deposits are replayed too: 50 + 30 funded, 40 + 30 locked.
    assert.equal(balanceOf(ledger, "b"), 10);
    assert.deepEqual(ledger.locks["r-agreed"].amount, 40);
    assert.deepEqual(ledger.locks["r-locked"].amount, 30);
  } finally {
    store.close();
  }
  assert.equal(fs.existsSync(dir), true);
});

test("protocol: mockVerdict fails only the documented markers", () => {
  assert.equal(mockVerdict("deliverable:abc"), "SETTLED");
  for (const marker of ["reject", "REJECT", "fail", "invalid"]) {
    assert.equal(mockVerdict(`deliverable:${marker}-me`), "REJECTED");
  }
});

test("protocol: parseVerdict accepts only the strict vocabulary", () => {
  assert.equal(parseVerdict({ verdict: "valid" }), "SETTLED");
  assert.equal(parseVerdict({ verdict: "  VALID  " }), "SETTLED");
  assert.equal(parseVerdict({ verdict: "Invalid" }), "REJECTED");
  // Anything else freezes: prose, missing fields, wrong types.
  assert.equal(parseVerdict({ verdict: "looks good to me" }), "INCONCLUSIVE");
  assert.equal(parseVerdict({ verdict: "" }), "INCONCLUSIVE");
  assert.equal(parseVerdict({}), "INCONCLUSIVE");
  assert.equal(parseVerdict(null), "INCONCLUSIVE");
  assert.equal(parseVerdict({ verdict: 42 }), "INCONCLUSIVE");
});

test("protocol: buildInspectionPrompt names the deal under inspection", () => {
  const prompt = buildInspectionPrompt({ dealId: "d-1", price: 40, seller: "s" });
  assert.ok(prompt.includes("d-1"));
  assert.ok(prompt.includes("40"));
  assert.ok(prompt.includes("s"));
  assert.ok(/exactly one word/i.test(prompt));
});

test("protocol: mock path stays hermetic without an API key", async () => {
  // A developer's local .env must never turn unit tests into network
  // calls: pin the keyless branch for the duration of this test.
  const saved = process.env.MODEL_API_KEY;
  delete process.env.MODEL_API_KEY;
  const { file } = tempDb();
  const store = openStore(file);
  try {
    store.saveDeal({ id: "ni-mock", state: "VERIFYING", buyer: "b", seller: "s", price: 10 });
    const ledger = createLedger();
    ledger.balances.b = 0;
    ledger.balances.s = 0;
    ledger.reserve = 10;
    ledger.locks["ni-mock"] = { agentId: "b", amount: 10 };
    const events = [];
    const result = await runInspection({
      store,
      ledger,
      dealId: "ni-mock",
      deliveryUrl: "deliverable:x",
      emit: (e) => events.push(e),
      log: console,
    });
    assert.equal(result.ok, true);
    assert.equal(result.to, "SETTLED");
    assert.equal(store.getDeal("ni-mock").state, "SETTLED");
  } finally {
    store.close();
    if (saved === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = saved;
  }
});

test("protocol: runInspection on a non-VERIFYING deal decides nothing", async () => {
  const { file } = tempDb();
  const store = openStore(file);
  try {
    store.saveDeal({ id: "ni-neg", state: "NEGOTIATING", buyer: "b", seller: "s", price: 10 });
    const events = [];
    const result = await runInspection({
      store,
      ledger: createLedger(),
      dealId: "ni-neg",
      deliveryUrl: "deliverable:x",
      emit: (e) => events.push(e),
      log: console,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "NOT_VERIFYING");
    assert.deepEqual(events, []);
    assert.equal(store.getDeal("ni-neg").state, "NEGOTIATING");
  } finally {
    store.close();
  }
});

test("protocol: runInspection leaves the deal VERIFYING when settle fails", async () => {
  const { file } = tempDb();
  const store = openStore(file);
  try {
    // VERIFYING in SQLite but no lock in the ledger (e.g., lock vaporized):
    // the mock verdict is SETTLED, yet settlement is impossible.
    store.saveDeal({ id: "ni-frozen", state: "VERIFYING", buyer: "b", seller: "s", price: 40 });
    const events = [];
    const result = await runInspection({
      store,
      ledger: createLedger(),
      dealId: "ni-frozen",
      deliveryUrl: "deliverable:x",
      emit: (e) => events.push(e),
      log: console,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "NO_SUCH_DEAL");
    // Ledger-before-state: the row never advanced, and no terminal event
    // certifies funds that never moved.
    assert.equal(store.getDeal("ni-frozen").state, "VERIFYING");
    assert.ok(events.every((e) => e.type !== "STATE" && e.type !== "SETTLED"));
  } finally {
    store.close();
  }
});

test("protocol: escrow survives a server restart and settles at the accept price", async () => {
  const { file } = tempDb();
  let n = 0;
  const freshKey = () => `restart-${(n += 1)}`;
  const post = (base, p, body, agentKey) => {
    const headers = { "content-type": "application/json", "idempotency-key": freshKey() };
    if (agentKey !== undefined) headers["x-agent-key"] = agentKey;
    return fetch(base + p, { method: "POST", headers, body: JSON.stringify(body) });
  };
  const get = (base, p, agentKey) => {
    const headers = agentKey === undefined ? {} : { "x-agent-key": agentKey };
    return fetch(base + p, { headers }).then(async (r) => [r.status, await r.json()]);
  };

  const first = await startServer({ dbPath: file, port: 0 });
  const buyerKey = (await (await post(first.url, "/api/agents", { id: "rb", role: "buyer" })).json()).result.api_key;
  const sellerKey = (await (await post(first.url, "/api/agents", { id: "rs", role: "seller" })).json()).result.api_key;
  assert.equal((await post(first.url, "/api/deals", { id: "r-deal", buyer: "rb", seller: "rs", price: 50 }, buyerKey)).status, 200);
  assert.equal((await post(first.url, "/api/deals/r-deal/moves", { key: "k1", kind: "OFFER", price: 50 }, buyerKey)).status, 200);
  assert.equal((await post(first.url, "/api/deals/r-deal/moves", { key: "k2", kind: "ACCEPT", price: 40 }, sellerKey)).status, 200);
  assert.equal((await post(first.url, "/api/deals/r-deal/pay", {}, buyerKey)).status, 200);
  await first.close();

  // Fresh process, same file: the in-memory ledger starts empty and the
  // boot reconcile must rebuild the 40-credit lock before any request.
  const second = await startServer({ dbPath: file, port: 0 });
  closers.push(second.close);
  // Agent keys live in SQLite, so the pre-restart keys still authenticate.
  const [ds, db] = await get(second.url, "/api/deals/r-deal", buyerKey);
  assert.equal(ds, 200);
  assert.equal(db.state, "ESCROW_LOCKED");
  const delivered = await post(second.url, "/api/deals/r-deal/delivery", { id: "r-del-1", dealId: "r-deal", deliveryUrl: "deliverable:r" }, sellerKey);
  assert.equal(delivered.status, 202);
  let settled = null;
  for (let i = 0; i < 60; i += 1) {
    const [s, b] = await get(second.url, "/api/deals/r-deal", buyerKey);
    assert.equal(s, 200);
    if (b.state === "SETTLED") {
      settled = b;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(settled !== null, "deal never settled after restart");
  const [, eb] = await get(second.url, "/api/events", buyerKey);
  const paid = eb.result.events.find((e) => e.type === "SETTLED" && e.dealId === "r-deal");
  // The accept price (40), not the open price (50): without the replayed
  // lock the inspector could not have paid this amount.
  assert.deepEqual(paid.paid, 40);
}, { timeout: 60000 });
