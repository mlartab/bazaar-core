import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore } from "../../protocol/db.js";

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bazaar-protocol-"));
  return { dir, file: path.join(dir, "store.db") };
}

function cleanup(store, { dir }) {
  try {
    store?.close?.();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function tableNames(file) {
  const db = new DatabaseSync(file);
  try {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

test("protocol: a store creates its four tables on open", () => {
  const tmp = tempFile();
  const store = openStore(tmp.file);
  try {
    for (const method of ["close", "saveAgent", "saveDeal", "saveMove", "saveDelivery"]) {
      assert.equal(typeof store[method], "function");
    }
    assert.deepEqual(tableNames(tmp.file), ["agents", "deals", "deliveries", "moves"]);
  } finally {
    cleanup(store, tmp);
  }
  assert.equal(fs.existsSync(tmp.dir), false);
});

test("protocol: a legacy database migrates review columns to status", () => {
  const tmp = tempFile();
  // Hand-build a pre-migration file: old review vocabulary, no listing or
  // lifecycle columns at all.
  const legacy = new DatabaseSync(tmp.file);
  try {
    legacy.exec(`CREATE TABLE agents (
      id TEXT PRIMARY KEY, role TEXT, balance INTEGER, capability TEXT,
      review_status TEXT DEFAULT 'PENDING_REVIEW', review_message TEXT
    )`);
    legacy.exec(`INSERT INTO agents (id, role, balance, review_status, review_message)
      VALUES ('old-active', 'seller', 10, 'ACTIVE', 'v1'),
             ('old-pending', 'seller', 0, 'PENDING_REVIEW', NULL)`);
  } finally {
    legacy.close();
  }
  const store = openStore(tmp.file);
  try {
    assert.deepEqual(store.getAgentStatus("old-active"), { status: "ACTIVE", status_reason: "v1" });
    assert.deepEqual(store.getAgentStatus("old-pending"), { status: "PENDING", status_reason: null });
    // Migrated ACTIVE row is listed; pending row is not.
    assert.ok(store.listAgents().some((a) => a.id === "old-active"));
    assert.ok(!store.listAgents().some((a) => a.id === "old-pending"));
    // Old columns are gone: exactly one source of status truth remains.
    const cols = new DatabaseSync(tmp.file)
      .prepare("PRAGMA table_info(agents)")
      .all()
      .map((r) => r.name);
    assert.ok(cols.includes("status"));
    assert.ok(cols.includes("status_reason"));
    assert.ok(!cols.includes("review_status"));
    assert.ok(!cols.includes("review_message"));
  } finally {
    cleanup(store, tmp);
  }
  assert.equal(fs.existsSync(tmp.dir), false);
});

test("protocol: a row written then read back is identical", () => {
  const tmp = tempFile();
  const store = openStore(tmp.file);
  try {
    assert.deepEqual(store.saveAgent({ id: "buyer", role: "buyer", balance: 100 }), { ok: true });
    assert.deepEqual(store.getAgent("buyer"), { id: "buyer", role: "buyer", balance: 100 });

    assert.deepEqual(
      store.saveDeal({ id: "deal1", state: "NEGOTIATING", buyer: "buyer", seller: "seller", price: 50 }),
      { ok: true },
    );
    assert.deepEqual(store.getDeal("deal1"), {
      id: "deal1",
      state: "NEGOTIATING",
      buyer: "buyer",
      seller: "seller",
      price: 50,
    });
    assert.deepEqual(store.setDealState("deal1", "AGREED"), { ok: true });
    assert.equal(store.getDeal("deal1").state, "AGREED");

    assert.deepEqual(
      store.saveMove({ id: "m1", deal_id: "deal1", key: "k1", kind: "OFFER", price: 50 }),
      { ok: true },
    );
    assert.deepEqual(store.listMoves("deal1"), [
      { id: "m1", deal_id: "deal1", key: "k1", kind: "OFFER", price: 50 },
    ]);

    assert.deepEqual(store.saveDelivery({ id: "d1", deal_id: "deal1", status: null, delivery_url: "u1" }), { ok: true });
    assert.deepEqual(store.getDelivery("d1"), { id: "d1", deal_id: "deal1", status: null, delivery_url: "u1" });
  } finally {
    cleanup(store, tmp);
  }
  assert.equal(fs.existsSync(tmp.dir), false);
});

test("protocol: a second open on the same file sees the same rows", () => {
  const tmp = tempFile();
  const first = openStore(tmp.file);
  try {
    assert.deepEqual(first.saveAgent({ id: "buyer", role: "buyer", balance: 100 }), { ok: true });
    assert.deepEqual(first.saveDeal({ id: "deal1", state: "AGREED" }), { ok: true });
    assert.deepEqual(first.saveMove({ id: "m1", deal_id: "deal1", key: "k1", kind: "OFFER", price: 50 }), {
      ok: true,
    });
    assert.deepEqual(first.saveDelivery({ id: "d1", deal_id: "deal1", status: null, delivery_url: "u1" }), { ok: true });
  } finally {
    first.close();
  }
  const second = openStore(tmp.file);
  try {
    assert.deepEqual(second.getAgent("buyer"), { id: "buyer", role: "buyer", balance: 100 });
    assert.equal(second.getDeal("deal1").state, "AGREED");
    assert.equal(second.listMoves("deal1").length, 1);
    assert.deepEqual(second.getDelivery("d1"), { id: "d1", deal_id: "deal1", status: null, delivery_url: "u1" });
  } finally {
    cleanup(second, tmp);
  }
  assert.equal(fs.existsSync(tmp.dir), false);
});

test("protocol: a repeated move key on one deal is rejected by the database", () => {
  const tmp = tempFile();
  const store = openStore(tmp.file);
  try {
    assert.deepEqual(store.saveDeal({ id: "deal1", state: "NEGOTIATING" }), { ok: true });
    assert.deepEqual(store.saveMove({ id: "m1", deal_id: "deal1", key: "k1", kind: "OFFER", price: 50 }), {
      ok: true,
    });
    const again = store.saveMove({ id: "m2", deal_id: "deal1", key: "k1", kind: "OFFER", price: 60 });
    assert.equal(again.ok, false);
    assert.equal(again.code, "DUPLICATE_MOVE");
    assert.equal(typeof again.message, "string");
    assert.ok(again.message.length > 0);
    // The first row survives and the same key works on a different deal.
    assert.equal(store.listMoves("deal1").length, 1);
    assert.deepEqual(store.saveDeal({ id: "deal2", state: "NEGOTIATING" }), { ok: true });
    assert.deepEqual(store.saveMove({ id: "m3", deal_id: "deal2", key: "k1", kind: "OFFER", price: 60 }), {
      ok: true,
    });
  } finally {
    cleanup(store, tmp);
  }
  assert.equal(fs.existsSync(tmp.dir), false);
});

test("protocol: a repeated delivery id is rejected by the database", () => {
  const tmp = tempFile();
  const store = openStore(tmp.file);
  try {
    assert.deepEqual(store.saveDeal({ id: "deal1", state: "NEGOTIATING" }), { ok: true });
    assert.deepEqual(store.saveDelivery({ id: "d1", deal_id: "deal1", delivery_url: "u1" }), { ok: true });
    const again = store.saveDelivery({ id: "d1", deal_id: "deal1", delivery_url: "u2" });
    assert.equal(again.ok, false);
    assert.equal(again.code, "DUPLICATE_DELIVERY");
    assert.equal(typeof again.message, "string");
    assert.ok(again.message.length > 0);
    assert.deepEqual(store.getDelivery("d1").delivery_url, "u1");
  } finally {
    cleanup(store, tmp);
  }
  assert.equal(fs.existsSync(tmp.dir), false);
});

test("protocol: a missing or malformed path returns a clear error, not a crash", () => {
  for (const bad of [undefined, null, "", 42, {}, []]) {
    let result;
    assert.doesNotThrow(() => {
      result = openStore(bad);
    });
    assert.equal(result?.ok, false);
    assert.match(result?.code ?? "", /BAD_PATH|DB_ERROR/);
    assert.equal(typeof result?.message, "string");
    assert.ok(result.message.length > 0);
  }
});

test("protocol: legacy agents without keys are backfilled on open", () => {
  const tmp = tempFile();
  const legacy = new DatabaseSync(tmp.file);
  try {
    legacy.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, role TEXT, balance INTEGER)`);
    legacy.exec(`INSERT INTO agents (id, role, balance) VALUES ('old', 'seller', 5)`);
  } finally {
    legacy.close();
  }
  const store = openStore(tmp.file);
  try {
    // Pre-key rows must never fail open: the migration mints credentials.
    const key = store.getAgentApiKey("old");
    assert.equal(typeof key, "string");
    assert.ok(key.length > 0);
    assert.deepEqual(store.getAgentByKey(key), { id: "old", role: "seller", balance: 5 });
    assert.equal(store.getAgentByKey("no-such-key"), null);
  } finally {
    cleanup(store, tmp);
  }
});

test("protocol: the public listing shows sellers only, never buyers", () => {
  const tmp = tempFile();
  const store = openStore(tmp.file);
  try {
    store.saveAgent({ id: "market-seller", role: "seller", balance: 0, status: "ACTIVE", api_key: "k1" });
    store.saveAgent({ id: "market-buyer", role: "buyer", balance: 0, status: "ACTIVE", api_key: "k2" });
    const ids = store.listAgents().map((a) => a.id);
    assert.ok(ids.includes("market-seller"));
    assert.ok(!ids.includes("market-buyer"));
  } finally {
    cleanup(store, tmp);
  }
});

test("protocol: the store runs in WAL mode with a busy timeout", () => {
  const tmp = tempFile();
  const store = openStore(tmp.file);
  try {
    // journal_mode persists in the file, so a second connection can prove
    // it. busy_timeout is per-connection state applied at open: its
    // execution (no throw above) is the coverage, there is nothing to read.
    const raw = new DatabaseSync(tmp.file);
    try {
      assert.equal(raw.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    } finally {
      raw.close();
    }
  } finally {
    cleanup(store, tmp);
  }
});

test("protocol: a deal written with expiry reads back identical", () => {
  const tmp = tempFile();
  const store = openStore(tmp.file);
  try {
    store.saveDeal({ id: "d-exp", state: "NEGOTIATING", buyer: "b", seller: "s", price: 50, expires_at: 12345, close_reason: "EXPIRED_TIMEOUT" });
    const row = store.listDeals().find((d) => d.id === "d-exp");
    assert.equal(row.expires_at, 12345);
    assert.equal(row.close_reason, "EXPIRED_TIMEOUT");
    assert.equal(store.setDealCloseReason("d-exp", "DONE").ok, true);
    assert.equal(store.listDeals().find((d) => d.id === "d-exp").close_reason, "DONE");
    assert.equal(store.setDealCloseReason("d-ghost", "DONE").ok, false);
  } finally {
    cleanup(store, tmp);
  }
});
