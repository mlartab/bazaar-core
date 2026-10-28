import test from "node:test";
import assert from "node:assert/strict";
import {
  balanceOf,
  checkInvariant,
  createLedger,
  deposit,
  lock,
  redeem,
  refund,
  settle,
} from "../src/ledger.js";

function funded() {
  const ledger = createLedger();
  assert.equal(deposit(ledger, "buyer", 100).ok, true);
  assert.equal(deposit(ledger, "seller", 20).ok, true);
  return ledger;
}

test("ledger: invariant holds after a full deposit-lock-settle cycle", () => {
  const ledger = createLedger();
  assert.equal(deposit(ledger, "buyer", 100).ok, true);
  assert.equal(deposit(ledger, "seller", 20).ok, true);
  const beforeLock = ledger.reserve;
  assert.equal(lock(ledger, "buyer", "deal1", 60).ok, true);
  assert.equal(ledger.reserve, beforeLock);
  const beforeSettle = ledger.reserve;
  assert.equal(settle(ledger, "deal1", "seller").ok, true);
  assert.equal(ledger.reserve, beforeSettle);
  assert.equal(balanceOf(ledger, "buyer"), 40);
  assert.equal(balanceOf(ledger, "seller"), 80);
  assert.deepEqual(ledger.locks, {});
  assert.equal(checkInvariant(ledger).ok, true);
});

test("ledger: failed lock leaves every balance unchanged", () => {
  const ledger = funded();
  const before = JSON.parse(JSON.stringify(ledger));
  const result = lock(ledger, "buyer", "deal1", 1000);
  assert.equal(result.ok, false);
  assert.equal(result.code, "INSUFFICIENT_FUNDS");
  assert.deepEqual(ledger, before);
  assert.equal(checkInvariant(ledger).ok, true);
});

test("ledger: two deals settle independently", () => {
  const ledger = funded();
  assert.equal(lock(ledger, "buyer", "deal1", 30).ok, true);
  assert.equal(lock(ledger, "buyer", "deal2", 40).ok, true);
  assert.equal(settle(ledger, "deal1", "seller").ok, true);
  assert.deepEqual(ledger.locks, { deal2: { agentId: "buyer", amount: 40 } });
  assert.equal(balanceOf(ledger, "buyer"), 30);
  assert.equal(balanceOf(ledger, "seller"), 50);
  assert.equal(settle(ledger, "deal2", "seller").ok, true);
  assert.deepEqual(ledger.locks, {});
  assert.equal(balanceOf(ledger, "seller"), 90);
  assert.equal(checkInvariant(ledger).ok, true);
});

test("ledger: redeeming exactly the full balance leaves zero, not a negative number", () => {
  const ledger = createLedger();
  assert.equal(deposit(ledger, "buyer", 50).ok, true);
  const result = redeem(ledger, "buyer", 50);
  assert.equal(result.ok, true);
  assert.equal(balanceOf(ledger, "buyer"), 0);
  assert.ok(balanceOf(ledger, "buyer") >= 0);
  assert.equal(ledger.reserve, 0);
  assert.equal(checkInvariant(ledger).ok, true);
});

test("ledger: repeated lock on the same deal is rejected", () => {
  const ledger = funded();
  assert.equal(lock(ledger, "buyer", "deal1", 60).ok, true);
  const before = JSON.stringify(ledger);
  const result = lock(ledger, "buyer", "deal1", 10);
  assert.equal(result.ok, false);
  assert.equal(result.code, "DEAL_EXISTS");
  assert.equal(JSON.stringify(ledger), before);
});

const BAD_AMOUNTS = [0, -1, -100, 1.5, "50", NaN];

test("ledger: deposit rejects zero, negative, float, string, and NaN amounts", () => {
  const ledger = funded();
  for (const amount of BAD_AMOUNTS) {
    const before = JSON.stringify(ledger);
    const result = deposit(ledger, "buyer", amount);
    assert.equal(result.ok, false);
    assert.equal(result.code, "BAD_AMOUNT");
    assert.equal(typeof result.message, "string");
    assert.ok(result.message.length > 0);
    assert.equal(JSON.stringify(ledger), before);
  }
});

test("ledger: redeem rejects zero, negative, float, string, and NaN amounts", () => {
  const ledger = funded();
  for (const amount of BAD_AMOUNTS) {
    const before = JSON.stringify(ledger);
    const result = redeem(ledger, "buyer", amount);
    assert.equal(result.ok, false);
    assert.equal(result.code, "BAD_AMOUNT");
    assert.equal(typeof result.message, "string");
    assert.ok(result.message.length > 0);
    assert.equal(JSON.stringify(ledger), before);
  }
});

test("ledger: lock rejects zero, negative, float, string, and NaN amounts", () => {
  const ledger = funded();
  let n = 0;
  for (const amount of BAD_AMOUNTS) {
    n += 1;
    const before = JSON.stringify(ledger);
    const result = lock(ledger, "buyer", `deal-${n}`, amount);
    assert.equal(result.ok, false);
    assert.equal(result.code, "BAD_AMOUNT");
    assert.equal(typeof result.message, "string");
    assert.ok(result.message.length > 0);
    assert.equal(JSON.stringify(ledger), before);
  }
});

test("ledger: empty or non-string IDs are rejected", () => {
  const ledger = funded();
  assert.equal(lock(ledger, "buyer", "deal1", 10).ok, true);
  const badIds = ["", 123, null, undefined, {}, []];
  const calls = [
    (id) => deposit(ledger, id, 10),
    (id) => redeem(ledger, id, 10),
    (id) => lock(ledger, id, "deal-fresh", 10),
    (id) => lock(ledger, "buyer", id, 10),
    (id) => settle(ledger, id, "seller"),
    (id) => settle(ledger, "deal1", id),
    (id) => refund(ledger, id),
  ];
  for (const id of badIds) {
    for (const call of calls) {
      const before = JSON.stringify(ledger);
      const result = call(id);
      assert.equal(result.ok, false);
      assert.equal(result.code, "BAD_ID");
      assert.equal(typeof result.message, "string");
      assert.ok(result.message.length > 0);
      assert.equal(JSON.stringify(ledger), before);
    }
  }
});

test("ledger: settle rejects a seller account that does not exist", () => {
  const ledger = createLedger();
  assert.equal(deposit(ledger, "buyer", 100).ok, true);
  assert.equal(lock(ledger, "buyer", "deal1", 60).ok, true);
  const before = JSON.stringify(ledger);
  const result = settle(ledger, "deal1", "ghost");
  assert.equal(result.ok, false);
  assert.equal(result.code, "NO_SUCH_ACCOUNT");
  assert.equal(JSON.stringify(ledger), before);
  assert.equal(deposit(ledger, "ghost", 5).ok, true);
  assert.equal(settle(ledger, "deal1", "ghost").ok, true);
  assert.equal(balanceOf(ledger, "ghost"), 65);
});

test("ledger: a rollback keeps the same balances and locks objects", () => {
  const ledger = funded();
  assert.equal(lock(ledger, "buyer", "deal1", 30).ok, true);
  const balancesRef = ledger.balances;
  const locksRef = ledger.locks;
  ledger.reserve = 999;
  const result = deposit(ledger, "buyer", 10);
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVARIANT_VIOLATION");
  assert.equal(ledger.balances, balancesRef);
  assert.equal(ledger.locks, locksRef);
  assert.equal(ledger.reserve, 999);
  assert.equal(balanceOf(ledger, "buyer"), 70);
  assert.equal(balanceOf(ledger, "seller"), 20);
  assert.equal(ledger.locks["deal1"].amount, 30);
  assert.deepEqual(ledger.balances, { buyer: 70, seller: 20 });
});

test("ledger: a held lock reference cannot corrupt state on rollback", () => {
  const ledger = funded();
  assert.equal(lock(ledger, "buyer", "deal1", 30).ok, true);
  const held = ledger.locks["deal1"];
  ledger.reserve = 999;
  const result = deposit(ledger, "buyer", 10);
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVARIANT_VIOLATION");
  assert.equal(ledger.locks["deal1"].amount, 30);
  held.amount = 1000000;
  assert.equal(ledger.locks["deal1"].amount, 30);
  assert.equal(balanceOf(ledger, "buyer"), 70);
});
