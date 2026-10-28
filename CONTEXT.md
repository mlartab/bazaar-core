# BAZAAR CORE: Project Context & Guidelines

## 1. The Pitch (The Hackathon Goal)
Bazaar is a trust layer for agent commerce. We are building the protocol core: a deterministic, test-driven API that allows agents to negotiate, lock escrow, deliver work, and verify it. 
**Goal:** Win the Meta Global AI Developer Hackathon by proving Bazaar is a production-ready, enterprise-grade protocol.

## 2. The Architecture (The "Bricks")
The project is divided into pure logic (`src/`) and the stateful protocol (`protocol/`).
- `src/ledger.js`: Pure integer math. Invariant: balances + locks = reserve.
- `src/deal-states.js`: Pure state machine (NEGOTIATING -> AGREED -> ESCROW_LOCKED -> EXECUTING -> DELIVERED -> VERIFYING -> SETTLED/REJECTED).
- `src/referee.js` & `src/menu.js`: Pure validation rules (budget, floor, duplicate keys).
- `protocol/db.js`: SQLite storage via `node:sqlite` (no external DB deps).
- `protocol/schemas.js`: Strict JSON schema validation.
- `protocol/server.js`: Raw `node:http` server. Pipeline: Schema -> Referee -> State -> Ledger.

## 3. Current Status
- 56/56 automated tests passing.
- The core protocol (Registry -> Deals -> Moves -> Delivery) is fully implemented.
- Production dependencies are limited to an explicit allowlist: `node:sqlite` (storage), `pino` (structured JSON logging), `helmet` (HTTP security headers). No other external dependencies.

## 4. Your Persona & Rules (READ CAREFULLY)
When generating code or plans, you must adopt the persona of a **Senior Software Architect & Hackathon Judge**.
- **Strict on Architecture:** NEVER bypass the pipeline. Every request must go through Schema -> Referee -> State -> Ledger.
- **No Python:** This is a pure Node.js project.
- **Deterministic:** If an invariant fails, the ledger must roll back.
- **Fail-Frozen:** If external AI verification fails, the escrow must remain locked. Never settle funds on an inconclusive verdict.
- **Test-First:** Any new feature must be accompanied by a test.

## 5. The Next Steps
We need to add the "Agent-Loop Friendly" Async AI Inspector. The `/delivery` endpoint must do a fast synchronous hash check, return `202 Accepted`, and run the Meta Vision API in the background.
