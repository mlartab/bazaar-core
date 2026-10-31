import test from "node:test";
import assert from "node:assert/strict";
import { MENU, allowedMoves } from "../src/menu.js";

const CONTRACT = {
  NEGOTIATING: { buyer: ["OFFER", "ACCEPT", "WALK"], seller: ["OFFER", "ACCEPT", "WALK"] },
  AGREED: { buyer: ["PAY"], seller: [] },
  ESCROW_LOCKED: { buyer: [], seller: ["DELIVER"] },
  EXECUTING: { buyer: [], seller: ["DELIVER"] },
  DELIVERED: { buyer: [], seller: [] },
  VERIFYING: { buyer: [], seller: [] },
  SETTLED: { buyer: [], seller: [] },
  REJECTED: { buyer: [], seller: [] },
};

test("menu: every state matches the protocol contract", () => {
  assert.deepEqual(Object.keys(MENU).sort(), Object.keys(CONTRACT).sort());
  for (const [state, roles] of Object.entries(CONTRACT)) {
    assert.deepEqual(allowedMoves(state, "buyer"), roles.buyer, state);
    assert.deepEqual(allowedMoves(state, "seller"), roles.seller, state);
  }
});

test("menu: every actionable non-terminal state names an action", () => {
  // DELIVERED is a transient hop inside the synchronous delivery walk that
  // no client can observe; VERIFYING belongs to the inspector; SETTLED and
  // REJECTED are terminal. Everything else must offer at least one side an
  // action, or an agent reading allowedMoves stalls.
  for (const state of ["NEGOTIATING", "AGREED", "ESCROW_LOCKED", "EXECUTING"]) {
    const total = allowedMoves(state, "buyer").length + allowedMoves(state, "seller").length;
    assert.ok(total > 0, state);
  }
  for (const state of ["DELIVERED", "VERIFYING", "SETTLED", "REJECTED"]) {
    assert.deepEqual(allowedMoves(state, "buyer"), [], state);
    assert.deepEqual(allowedMoves(state, "seller"), [], state);
  }
});

test("menu: unknown states and roles stay empty", () => {
  assert.deepEqual(allowedMoves("NOPE", "buyer"), []);
  assert.deepEqual(allowedMoves("NEGOTIATING", "ghost"), []);
});

test("menu: readers get copies, never the live arrays", () => {
  const first = allowedMoves("NEGOTIATING", "buyer");
  first.push("CHEAT");
  assert.deepEqual(allowedMoves("NEGOTIATING", "buyer"), ["OFFER", "ACCEPT", "WALK"]);
});

test("menu: adding a row changes allowedMoves without editing code", () => {
  assert.ok(!("SANDBOX" in MENU));
  MENU.SANDBOX = { buyer: ["WALK"], seller: [] };
  try {
    assert.deepEqual(allowedMoves("SANDBOX", "buyer"), ["WALK"]);
    assert.deepEqual(allowedMoves("SANDBOX", "seller"), []);
  } finally {
    delete MENU.SANDBOX;
  }
  assert.deepEqual(allowedMoves("SANDBOX", "buyer"), []);
});
