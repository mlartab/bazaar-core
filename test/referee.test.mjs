import test from "node:test";
import assert from "node:assert/strict";
import { RULES, validate } from "../src/referee.js";
import { MENU } from "../src/menu.js";

function ctx(overrides = {}) {
  return {
    state: "NEGOTIATING",
    role: "buyer",
    seenKeys: [],
    seenOffers: [],
    ...overrides,
  };
}

test("referee: each rejection code returns its code and message", () => {
  assert.deepEqual(validate({ key: "ok1", kind: "OFFER", price: 50 }, ctx({ budget: 100, floor: 10 })), {
    ok: true,
  });
  const cases = [
    ["WRONG_STATE", { key: "w1", kind: "OFFER", price: 50 }, ctx({ state: "AGREED" })],
    ["OFF_MENU", { key: "o1", kind: "CHEAT" }, ctx()],
    ["DUPLICATE_MOVE", { key: "dup", kind: "OFFER", price: 50 }, ctx({ seenKeys: ["dup"] })],
    ["DUPLICATE_OFFER", { key: "d1", kind: "OFFER", price: 50 }, ctx({ seenOffers: [50] })],
    ["BAD_PRICE", { key: "b1", kind: "OFFER", price: -5 }, ctx()],
    ["OVER_BUDGET", { key: "v1", kind: "OFFER", price: 100 }, ctx({ budget: 50 })],
    ["UNDER_FLOOR", { key: "f1", kind: "OFFER", price: 10 }, ctx({ role: "seller", floor: 50 })],
  ];
  assert.equal(cases.length, 7);
  for (const [code, move, context] of cases) {
    const result = validate(move, context);
    assert.equal(result.ok, false, code);
    assert.equal(result.code, code, code);
    assert.equal(typeof result.message, "string", code);
    assert.ok(result.message.length > 0, code);
  }
  assert.equal(validate({ key: "a1", kind: "ACCEPT", price: -5 }, ctx()).code, "BAD_PRICE");
  assert.equal(
    validate({ key: "a2", kind: "ACCEPT", price: 100 }, ctx({ budget: 50 })).code,
    "OVER_BUDGET",
  );
  assert.equal(
    validate({ key: "a3", kind: "ACCEPT", price: 10 }, ctx({ role: "seller", floor: 50 })).code,
    "UNDER_FLOOR",
  );
  // Regression: accepting the standing offer price is the happy path, not
  // a duplicate offer. (This assertion pinned the old buggy behavior and
  // was updated with the fix.)
  assert.deepEqual(
    validate({ key: "a4", kind: "ACCEPT", price: 50 }, ctx({ seenOffers: [50], budget: 100 })),
    { ok: true },
  );
  assert.deepEqual(validate({ key: "w2", kind: "WALK" }, ctx()), { ok: true });
});

test("referee: repeated move key returns DUPLICATE_MOVE", () => {
  const seenKeys = [];
  const seenOffers = [];
  const context = ctx({ seenKeys, seenOffers, budget: 100, floor: 10 });
  const move = { key: "m1", kind: "OFFER", price: 50 };
  assert.deepEqual(validate(move, context), { ok: true });
  assert.deepEqual(seenKeys, []);
  assert.deepEqual(seenOffers, []);
  seenKeys.push("m1");
  const again = validate(move, context);
  assert.equal(again.ok, false);
  assert.equal(again.code, "DUPLICATE_MOVE");
  assert.ok(again.message.length > 0);
});

test("referee: changing the menu table changes what validate accepts", () => {
  const walk = { key: "wk1", kind: "WALK" };
  assert.deepEqual(validate(walk, ctx()), { ok: true });
  const saved = MENU.NEGOTIATING.buyer;
  MENU.NEGOTIATING.buyer = ["OFFER", "ACCEPT"];
  try {
    const result = validate(walk, ctx());
    assert.equal(result.ok, false);
    assert.equal(result.code, "OFF_MENU");
  } finally {
    MENU.NEGOTIATING.buyer = saved;
  }
  assert.deepEqual(validate(walk, ctx()), { ok: true });
});

test("referee: a new rule added as one entry is enforced", () => {
  const before = RULES.length;
  RULES.push({
    code: "NO_WALK",
    message: "walking away is disabled in this test",
    check: (move) => move.kind !== "WALK",
  });
  try {
    assert.equal(RULES.length, before + 1);
    const blocked = validate({ key: "nw1", kind: "WALK" }, ctx());
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, "NO_WALK");
    assert.ok(blocked.message.length > 0);
    assert.deepEqual(validate({ key: "nw2", kind: "OFFER", price: 50 }, ctx({ budget: 100 })), {
      ok: true,
    });
  } finally {
    RULES.pop();
  }
  assert.equal(RULES.length, before);
});

test("referee: a price move with no budget or floor is rejected", () => {
  const noBudget = validate({ key: "nb1", kind: "OFFER", price: 50 }, ctx());
  assert.equal(noBudget.ok, false);
  assert.equal(noBudget.code, "BUDGET_REQUIRED");
  assert.equal(noBudget.message, "budget is required for buyer price moves");
  const noFloor = validate({ key: "nf1", kind: "OFFER", price: 50 }, ctx({ role: "seller" }));
  assert.equal(noFloor.ok, false);
  assert.equal(noFloor.code, "FLOOR_REQUIRED");
  assert.equal(noFloor.message, "floor is required for seller price moves");
  assert.equal(validate({ key: "nb2", kind: "ACCEPT", price: 50 }, ctx()).code, "BUDGET_REQUIRED");
  assert.equal(
    validate({ key: "nf2", kind: "ACCEPT", price: 50 }, ctx({ role: "seller" })).code,
    "FLOOR_REQUIRED",
  );
  assert.deepEqual(validate({ key: "w3", kind: "WALK" }, ctx()), { ok: true });
  assert.deepEqual(validate({ key: "ok2", kind: "OFFER", price: 50 }, ctx({ budget: 100 })), {
    ok: true,
  });
  assert.deepEqual(
    validate({ key: "ok3", kind: "OFFER", price: 50 }, ctx({ role: "seller", floor: 10 })),
    { ok: true },
  );
});

test("referee: a malformed context returns INVALID_CONTEXT", () => {
  const move = { key: "t1", kind: "OFFER", price: 50 };
  const good = { budget: 100, floor: 10 };
  for (const bad of ["seen", 42, {}, null, undefined]) {
    const forKeys = validate(move, ctx({ ...good, seenKeys: bad }));
    assert.equal(forKeys.ok, false);
    assert.equal(forKeys.code, "INVALID_CONTEXT");
    const forOffers = validate(move, ctx({ ...good, seenOffers: bad }));
    assert.equal(forOffers.ok, false);
    assert.equal(forOffers.code, "INVALID_CONTEXT");
  }
});

test("referee: a price move with no budget or floor returns BUDGET_REQUIRED or FLOOR_REQUIRED", () => {
  const noBudget = validate({ key: "nb1", kind: "OFFER", price: 50 }, ctx());
  assert.equal(noBudget.ok, false);
  assert.equal(noBudget.code, "BUDGET_REQUIRED");
  assert.equal(noBudget.message, "budget is required for buyer price moves");
  const noFloor = validate({ key: "nf1", kind: "OFFER", price: 50 }, ctx({ role: "seller" }));
  assert.equal(noFloor.ok, false);
  assert.equal(noFloor.code, "FLOOR_REQUIRED");
  assert.equal(noFloor.message, "floor is required for seller price moves");
  assert.equal(validate({ key: "nb2", kind: "ACCEPT", price: 50 }, ctx()).code, "BUDGET_REQUIRED");
  assert.equal(
    validate({ key: "nf2", kind: "ACCEPT", price: 50 }, ctx({ role: "seller" })).code,
    "FLOOR_REQUIRED",
  );
  assert.deepEqual(validate({ key: "w3", kind: "WALK" }, ctx()), { ok: true });
  assert.deepEqual(validate({ key: "ok2", kind: "OFFER", price: 50 }, ctx({ budget: 100 })), {
    ok: true,
  });
  assert.deepEqual(
    validate({ key: "ok3", kind: "OFFER", price: 50 }, ctx({ role: "seller", floor: 10 })),
    { ok: true },
  );
});

test("referee: a malformed context returns INVALID_CONTEXT", () => {
  const move = { key: "m1", kind: "OFFER", price: 50 };
  for (const badCtx of [null, undefined, "ctx", 42, true]) {
    const result = validate(move, badCtx);
    assert.equal(result.ok, false);
    assert.equal(result.code, "INVALID_CONTEXT");
    assert.equal(typeof result.message, "string");
    assert.ok(result.message.length > 0);
  }
  const good = { budget: 100, floor: 10 };
  for (const bad of ["seen", 42, {}, null, undefined, true]) {
    for (const result of [
      validate(move, ctx({ ...good, seenKeys: bad })),
      validate(move, ctx({ ...good, seenOffers: bad })),
    ]) {
      assert.equal(result.ok, false);
      assert.equal(result.code, "INVALID_CONTEXT");
      assert.equal(typeof result.message, "string");
      assert.ok(result.message.length > 0);
    }
  }
  assert.deepEqual(
    validate(move, ctx({ ...good, seenKeys: new Set(), seenOffers: new Set() })),
    { ok: true },
  );
  assert.deepEqual(validate({ key: "w9", kind: "WALK" }, null), {
    ok: false,
    code: "INVALID_CONTEXT",
    message: "context must have array or Set seenKeys and seenOffers",
  });
});
