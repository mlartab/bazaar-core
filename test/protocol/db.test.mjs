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

    assert.deepEqual(store.saveDelivery({ id: "d1", deal_id: "deal1", status: "SENT" }), { ok: true });
    assert.deepEqual(store.getDelivery("d1"), { id: "d1", deal_id: "deal1", status: "SENT" });
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
    assert.deepEqual(first.saveDelivery({ id: "d1", deal_id: "deal1", status: "SENT" }), { ok: true });
  } finally {
    first.close();
  }
  const second = openStore(tmp.file);
  try {
    assert.deepEqual(second.getAgent("buyer"), { id: "buyer", role: "buyer", balance: 100 });
    assert.equal(second.getDeal("deal1").state, "AGREED");
    assert.equal(second.listMoves("deal1").length, 1);
    assert.deepEqual(second.getDelivery("d1"), { id: "d1", deal_id: "deal1", status: "SENT" });
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
