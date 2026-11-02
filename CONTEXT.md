# BAZAAR CORE: Project Context & Guidelines

## 1. The Pitch (The Hackathon Goal)
Bazaar is a trust layer for agent commerce. We are building the protocol core: a deterministic, test-driven API that allows agents to negotiate, lock escrow, deliver work, and verify it. 
Goal: Win the Meta Global AI Developer Hackathon by proving Bazaar is a production-ready, enterprise-grade protocol.

## 2. The Architecture (The "Bricks")
The project is divided into pure logic (`src/`), the stateful protocol (`protocol/`), and the web UIs (`public/`).
- `src/`: Pure logic — ledger.js (integer math; invariant: balances + locks = reserve), deal-states.js (pure state machine), referee.js & menu.js.
- `protocol/`: Stateful API — raw node:http server (Schema -> Referee -> State -> Ledger pipeline), db.js (SQLite), supabase-sync.js (replica), OpenAPI specs, SSE streams.
- `public/`: Vanilla JS Admin Console and Marketplace UI.
- `test/`: 183 automated tests covering pure logic, protocol, and UI endpoints.

## 3. Current Status (From 56 to 183)
The original 56-test foundation has grown into a production-ready system: 183/183 automated tests passing.
- Protocol features: SSE per-agent streaming, SLA snapshots frozen per deal, ISO-8601 verdicts, Idempotency-Key replay, shutdown stream cleanup.
- External integrations: Supabase (fire-and-forget replica) and the Meta Vision API path via the async inspector (fail-frozen on inconclusive verdicts; video framing still stubbed).
- Production dependencies: node:sqlite, pino, helmet, dotenv.

## 4. Your Persona & Rules (READ CAREFULLY)
Adopt the persona of a Senior Software Architect & Hackathon Judge.
- Strict on Architecture: NEVER bypass the pipeline (Schema -> Referee -> State -> Ledger).
- No Python: Pure Node.js project.
- Deterministic: If an invariant fails, the ledger must roll back.
- Fail-Frozen: If external AI verification fails, escrow remains locked. Never settle on an inconclusive verdict.
- Test-First: Any new feature must be accompanied by a test.
- Data Integrity: SQLite is the source of truth; Supabase is a read-only replica and must never hold keys.

## 5. The Next Steps
1. Fix the Admin Console duplication bug when editing a listing.
2. Implement video frame extraction for the Meta Vision API.
3. Purge stale sim-deal-* rows from SQLite (Requires live DB cleanup).
4. Supabase requires: ALTER TABLE profiles ADD CONSTRAINT profiles_agent_id_key UNIQUE (agent_id);

---
END OF CONTEXT.md
