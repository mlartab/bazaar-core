// Brick 1: pure menu. No server, no model calls, no dependencies.

// MENU maps state -> role -> moves. Plain data, deliberately exported and
// mutable so later bricks (and scale tests) can extend it at runtime.
export const MENU = {
  NEGOTIATING: {
    buyer: ["OFFER", "ACCEPT", "WALK"],
    seller: ["OFFER", "ACCEPT", "WALK"],
  },
  // Post-negotiation states name the protocol action each side can take
  // next. These run through their own endpoints (pay, delivery), not the
  // moves endpoint — the referee's WRONG_STATE rule keeps moves
  // NEGOTIATING-only, so these entries fix the display contract without
  // changing any validation outcome. WALK is deliberately absent past
  // NEGOTIATING: no endpoint handles it outside negotiation, so listing
  // it would advertise an unreachable option.
  AGREED: {
    buyer: ["PAY"],
    seller: [],
  },
  ESCROW_LOCKED: {
    buyer: [],
    seller: ["DELIVER"],
  },
  EXECUTING: {
    buyer: [],
    seller: ["DELIVER"],
  },
  DELIVERED: {
    buyer: [],
    seller: [],
  },
  VERIFYING: {
    buyer: [],
    seller: [],
  },
  SETTLED: {
    buyer: [],
    seller: [],
  },
  REJECTED: {
    buyer: [],
    seller: [],
  },
};

// allowedMoves returns a plain array, not the envelope, because it is a pure reader.
export function allowedMoves(state, role) {
  const byRole = MENU[state];
  if (byRole === undefined || byRole === null) return [];
  const moves = byRole[role];
  if (!Array.isArray(moves)) return [];
  return [...moves];
}
