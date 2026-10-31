import test from "node:test";
import assert from "node:assert/strict";
import { EDGES, transition } from "../src/deal-states.js";

const deal = (state) => ({ state, id: "deal1" });

const ALL_STATES = [
  "NEGOTIATING",
  "AGREED",
  "ESCROW_LOCKED",
  "EXECUTING",
  "DELIVERED",
  "VERIFYING",
  "SETTLED",
  "REJECTED",
];

test("deal-states: NEGOTIATING can reach AGREED and REJECTED, nothing else", () => {
  const ok = transition(deal("NEGOTIATING"), "AGREED");
  assert.equal(ok.ok, true);
  assert.equal(ok.deal.state, "AGREED");
  assert.equal(transition(deal("NEGOTIATING"), "REJECTED").ok, true);
  for (const to of ALL_STATES.filter((s) => s !== "AGREED" && s !== "REJECTED")) {
    const result = transition(deal("NEGOTIATING"), to);
    assert.equal(result.ok, false, to);
    assert.equal(result.code, "ILLEGAL_TRANSITION", to);
  }
});

test("deal-states: every state in the happy path can reach the next one", () => {
  const happy = [
    ["NEGOTIATING", "AGREED"],
    ["AGREED", "ESCROW_LOCKED"],
    ["ESCROW_LOCKED", "EXECUTING"],
    ["EXECUTING", "DELIVERED"],
    ["DELIVERED", "VERIFYING"],
    ["VERIFYING", "SETTLED"],
  ];
  for (const [from, to] of happy) {
    const result = transition(deal(from), to);
    assert.equal(result.ok, true, `${from} -> ${to}`);
    assert.equal(result.deal.state, to, `${from} -> ${to}`);
  }
});

test("deal-states: REJECTED is reachable from every live state", () => {
  for (const from of ["NEGOTIATING", "AGREED", "ESCROW_LOCKED", "VERIFYING"]) {
    const result = transition(deal(from), "REJECTED");
    assert.equal(result.ok, true, from);
    assert.equal(result.deal.state, "REJECTED", from);
  }
  for (const from of ["SETTLED", "REJECTED"]) {
    const result = transition(deal(from), "REJECTED");
    assert.equal(result.ok, false, from);
    assert.equal(result.code, "ILLEGAL_TRANSITION", from);
  }
});

test("deal-states: SETTLED and REJECTED are terminal", () => {
  for (const from of ["SETTLED", "REJECTED"]) {
    for (const to of ALL_STATES) {
      const result = transition(deal(from), to);
      assert.equal(result.ok, false, `${from} -> ${to}`);
      assert.equal(result.code, "ILLEGAL_TRANSITION", `${from} -> ${to}`);
    }
  }
});

test("deal-states: an illegal transition returns ILLEGAL_TRANSITION and the deal is unchanged", () => {
  const d = deal("AGREED");
  const before = JSON.stringify(d);
  const result = transition(d, "SETTLED");
  assert.equal(result.ok, false);
  assert.equal(result.code, "ILLEGAL_TRANSITION");
  assert.equal(typeof result.message, "string");
  assert.ok(result.message.length > 0);
  assert.equal(JSON.stringify(d), before);
});

test("deal-states: an unknown target state returns UNKNOWN_STATE", () => {
  for (const to of ["BOGUS", "", 42, null, undefined]) {
    const result = transition(deal("NEGOTIATING"), to);
    assert.equal(result.ok, false);
    assert.equal(result.code, "UNKNOWN_STATE");
    assert.equal(typeof result.message, "string");
    assert.ok(result.message.length > 0);
  }
});

test("deal-states: transition never mutates the deal it is given", () => {
  const d = { state: "EXECUTING", id: "d9", note: "keep" };
  const before = JSON.parse(JSON.stringify(d));
  const ok = transition(d, "DELIVERED");
  assert.equal(ok.ok, true);
  assert.deepEqual(d, before);
  const bad = transition(d, "SETTLED");
  assert.equal(bad.ok, false);
  assert.deepEqual(d, before);
});

test("deal-states: each successful transition emits one STATE event", () => {
  let d = deal("NEGOTIATING");
  for (const to of ["AGREED", "ESCROW_LOCKED", "EXECUTING", "DELIVERED", "VERIFYING", "SETTLED"]) {
    const from = d.state;
    const result = transition(d, to);
    assert.equal(result.ok, true, `${from} -> ${to}`);
    assert.deepEqual(result.event, { type: "STATE", from, to });
    d = result.deal;
  }
  const rejected = transition(deal("VERIFYING"), "REJECTED");
  assert.equal(rejected.ok, true);
  assert.deepEqual(rejected.event, { type: "STATE", from: "VERIFYING", to: "REJECTED" });
});

test("deal-states: a malformed deal returns INVALID_DEAL", () => {
  for (const bad of [null, undefined, "NEGOTIATING", 42, true, {}, { id: "deal1" }, { state: null }, { state: 42 }, { state: undefined }, { state: {} }, { state: [] }]) {
    const result = transition(bad, "AGREED");
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.equal(result.code, "INVALID_DEAL", JSON.stringify(bad));
    assert.equal(typeof result.message, "string", JSON.stringify(bad));
    assert.ok(result.message.length > 0, JSON.stringify(bad));
  }
  assert.equal(transition(deal("NEGOTIATING"), "AGREED").ok, true);
});

test("deal-states: a deal in an unknown state returns ILLEGAL_TRANSITION", () => {
  for (const to of ["AGREED", "SETTLED", "REJECTED"]) {
    const result = transition(deal("BOGUS"), to);
    assert.equal(result.ok, false, to);
    assert.equal(result.code, "ILLEGAL_TRANSITION", to);
    assert.equal(typeof result.message, "string", to);
    assert.ok(result.message.length > 0, to);
  }
  assert.equal(transition(deal("BOGUS"), "NOPE").code, "UNKNOWN_STATE");
});

test("deal-states: a new edge added to the table is enforced without editing transition", () => {
  assert.equal(transition(deal("NEGOTIATING"), "VERIFYING").ok, false);
  EDGES.NEGOTIATING.push("VERIFYING");
  try {
    const result = transition(deal("NEGOTIATING"), "VERIFYING");
    assert.equal(result.ok, true);
    assert.equal(result.deal.state, "VERIFYING");
    assert.deepEqual(result.event, { type: "STATE", from: "NEGOTIATING", to: "VERIFYING" });
  } finally {
    EDGES.NEGOTIATING = EDGES.NEGOTIATING.filter((s) => s !== "VERIFYING");
  }
  const after = transition(deal("NEGOTIATING"), "VERIFYING");
  assert.equal(after.ok, false);
  assert.equal(after.code, "ILLEGAL_TRANSITION");
});
