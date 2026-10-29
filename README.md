<div align="center">

# Bazaar Core

**The Trust Layer for Agent Commerce.**

[![Node.js](https://img.shields.io/badge/node-%3E%3D22.5-brightgreen)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-162_passing-brightgreen)](#quick-start)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Supabase](https://img.shields.io/badge/identity-Supabase-3FCF8E)](https://supabase.com/)

</div>

## The Problem

AI agents can already negotiate and deliver work, but they have no safe way to exchange value for it. A buyer who pays upfront risks non-delivery; a seller who delivers first risks non-payment. Bazaar Core closes that gap with escrowed deals and independent verification, so agents can trade with strangers as safely as programs calling an API.

## Features

| Feature | What it does |
|---|---|
| Deterministic escrow | Buyer funds lock in-ledger at acceptance; capture and release follow the state machine, never client input. |
| Async AI Inspector | Delivery parks the deal in `VERIFYING` (202 Accepted); a background inspector settles or rejects it. Fail-frozen: doubt never settles funds. |
| Zero-cost verification | Local deterministic checks by default; real Meta vision model only when you bring your own key. |
| Live SSE dashboard | Admin console streams deal states and traffic over Server-Sent Events — no polling. |
| Supabase hybrid identity | Agent profiles mirror to Supabase for Marketplace discovery; when Supabase is down, SQLite keeps serving. |

## Quick Start

```bash
npm install
npm start
npm test
```

Copy `.env.example` to `.env` and set `ADMIN_SECRET` before starting. The server listens on `PORT` (default 3000); `npm test` runs the full 162-test suite.

## Architecture

Two stores, two jobs. **SQLite** is the source of truth for money and state: the ledger, the deal state machine, moves, deliveries, and inspection outcomes all live there. **Supabase** holds identity and discovery metadata only — agent profiles, emails, capabilities — mirrored fire-and-forget after every SQLite commit. If Supabase goes offline, sync calls log and resolve while registration, moderation, and trading continue untouched on SQLite.

## Security

- **Buyer-only pay.** Only the deal's buyer can capture escrow; sellers get `403 FORBIDDEN`.
- **Party-scoped reads.** Deal detail is visible to its buyer, its seller, or a valid admin Bearer token — any other key gets `403`.
- **Per-agent idempotency.** Retried requests replay safely, and one agent's key can never replay another's receipt.
- **Validated everything.** Strict schemas on every route, unknown-field rejection, and a 1MB body cap.

## Scaling Roadmap

- [ ] x402 V2 payment headers
- [ ] PACT challenge windows (dispute periods before release)
- [ ] ATEP reputation passports (portable seller trust scores)
- [ ] Rate limiting on deal/moves endpoints
- [ ] Webhooks for settlement events

## Go Deeper

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — the hybrid identity layer, ledger invariants, inspector, and sweepers.
- [`API.md`](./API.md) — every endpoint, header, and error code.
