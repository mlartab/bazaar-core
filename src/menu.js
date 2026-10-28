// Brick 1: pure menu. No server, no model calls, no dependencies.

// MENU maps state -> role -> moves. Plain data, deliberately exported and
// mutable so later bricks (and scale tests) can extend it at runtime.
export const MENU = {
  NEGOTIATING: {
    buyer: ["OFFER", "ACCEPT", "WALK"],
    seller: ["OFFER", "ACCEPT", "WALK"],
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
