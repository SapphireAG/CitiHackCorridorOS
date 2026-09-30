# CorridorOS

CorridorOS turns one export invoice into one programmable cross-border payment workflow.

**Reference case:** an Indian MSME exports ₹8,00,000 of goods to a buyer in Singapore. Today,
invoice verification, KYC, payment initiation, FX conversion, correspondent banking, receipt of
funds and reconciliation are separate steps run by separate parties. CorridorOS runs them as one
workflow:

```
Invoice → Compliance → Route selection → FX quote → Cross-border settlement
        → INR payout → Invoice reconciliation → Audit record
```

Two simulated routes compete for every invoice:

| Route | What it models |
|---|---|
| `CORRESPONDENT` | Traditional path — buyer's bank → correspondent hop(s) → Indian AD Category-I bank → exporter. Bank cut-offs, weekends, holidays, intermediary deductions, FX spread. |
| `TOKENIZED` | Bank-issued **tokenized deposits** on a shared ledger, atomic payment-versus-payment FX, then an INR payout to the exporter's bank account. 24/7, but constrained by network membership and liquidity. |

The point is **optimization, not hype**. A deterministic, config-driven optimizer weighs cost, FX
spread, settlement time, liquidity and compliance risk and picks a route — it is not "tokens are
faster, so tokens win." One of the six bundled scenarios is built specifically to show
`CORRESPONDENT` winning.

Full design contract for this project lives in [`CLAUDE.md`](./CLAUDE.md) — this README is the
practical "what's built and how to run it" companion to it.

## Guardrails

- **No public stablecoins or crypto.** The tokenized route models bank-issued tokenized
  deposits (the Citi Token Services / wholesale-settlement pattern), not USDT/USDC/an INR
  stablecoin. Every route ends in a real INR credit via an authorised dealer bank.
- **Everything is simulated.** No real bank, SWIFT, NPCI, DGFT or RBI endpoints, no live
  payment keys, no mainnet ledger.
- **Money is never a float.** Amounts are `bigint` minor units tagged with an ISO 4217
  currency; FX rates are `decimal.js` strings at a fixed scale; `ROUND_HALF_EVEN` at exactly
  one point in the codebase (`packages/core/src/fx.ts`).
- **Compliance is a gate, not a weight.** A `BLOCK` removes a route from consideration — it is
  never "outscored" by a cheaper or faster one.
- **No real personal or business data.** Every exporter, buyer, bank, IEC/GSTIN/PAN and
  sanctions/HS-code list in `data/` is synthetic and labelled `SYNTHETIC`.
- **No invented regulatory or market numbers.** Every fee, spread, cut-off and realisation
  period lives in `config/` with a `source:`/`as_of:`, or `illustrative: true`/`unverified: true`.
- **No partnership claims.** Citi, Swift, Sui and the Splash project are prior art this design
  drew on (§19 below) — nothing here implies affiliation with or endorsement by any of them.

## What's actually built (read this before the demo)

This repo implements the **M1–M4 milestones** from `CLAUDE.md` as a runnable, tested
TypeScript simulation, driven by a scenario CLI rather than a live web app:

| Milestone | Status |
|---|---|
| M1 — money/FX/clock/calendar, event-sourced state machine, invoice submission | ✅ built |
| M2 — correspondent simulator (hops, cut-offs) + tokenized simulator (PvP, liquidity pool) | ✅ built |
| M3 — compliance engine, optimizer with profiles and explanations | ✅ built |
| M4 — INR payout, reconciliation, hash-chained + Ed25519-signed audit bundle + verifier | ✅ built |
| M5 — `apps/web` dashboard, `apps/api` (Fastify), Postgres/Drizzle persistence | ❌ **not built** |
| Stretch — Sui Move ledger backend, PDF invoice extraction, a third route | ❌ **not built** |

Everything below the table runs today via `pnpm scenario run` against the **in-memory**
ledger/event-store backends (`CLAUDE.md`'s own default for all tests and scenarios) — there is
no database and no HTTP server in this iteration. The six required scenarios in `scenarios/`
all pass (see [Quality gates](#quality-gates-actual-results-as-run) below for real output).

One structural deviation from `CLAUDE.md` §11, made for correctness rather than convenience: a
`packages/domain` package (not in the original layout) holds shared cross-package types
(`Invoice`, `Quote`, `WorkflowEvent`, ...). Without it, `routes`, `optimizer`, `workflow`,
`compliance`, `recon` and `audit` would need to depend on each other for types alone, which
either creates circular workspace dependencies or forces everything into one package. It has no
runtime logic, only `interface`/`type` declarations.

Known scope limits, stated plainly rather than silently skipped:
- Reconciliation fully implements `SHORT_PAYMENT`, `OVERPAYMENT`, `MISSING_CREDIT` and
  `WRONG_REFERENCE`; multi-invoice batching and duplicate-credit detection are represented in
  `ReconBreakType` but not exercised by any bundled scenario.
- The correspondent route only wires its `direct_sgd_nostro` path into `quote()`/`settle()`;
  the `usd_correspondent` path exists in `config/routes/correspondent.yaml` as an illustrative
  alternative for future extension.
- Each calendar (`config/calendars/*.yaml`) uses a **fixed UTC offset**, not real daylight-saving
  transitions — documented in each file. IST and SGT don't observe DST, so this only affects the
  US calendar, used solely by the (currently unwired) USD correspondent leg.
- The Ed25519 audit-signing key is generated fresh per bundle and embedded in the bundle itself
  (so `audit:verify` works fully offline) rather than loaded from a stable KMS-backed identity —
  see the comment in `packages/audit/src/bundle.ts`.
- ESLint is wired up with the TypeScript recommended rules plus a blunt (non type-aware) ban on
  `parseFloat`. `CLAUDE.md` §12 asks for a rule that specifically flags `parseFloat`/`Number()`
  *on money fields* — a precise version of that requires type-aware linting
  (`parserOptions.project`) across a multi-tsconfig workspace, which wasn't wired up here. The
  handful of existing `Number()` calls in the codebase are on already-bigint-computed bps ratios,
  never on money amounts directly — see the comments in `eslint.config.js`.

## Repository layout

```
citiHack/
├── CLAUDE.md                # full design contract — read this for the "why"
├── config/                  # every fee/spread/cut-off/limit, with source/as_of or illustrative
├── data/                    # SYNTHETIC exporters, buyers, banks, sanctions/HS-code sample lists
├── packages/
│   ├── core/                # money, fx, clock, calendar, ids, errors — no business logic
│   ├── domain/               # shared cross-package types only (see note above)
│   ├── rates-sim/            # seeded deterministic FX random walk
│   ├── compliance/           # simulated rule engine (BLOCK/REVIEW/INFO)
│   ├── ledger/                # LedgerBackend interface + in-memory implementation
│   ├── routes/                # Route interface + correspondent/ and tokenized/ simulators
│   ├── optimizer/            # pure (quotes, profile) -> ranked list + explanation
│   ├── workflow/             # event-sourced state machine + orchestrator
│   ├── recon/                  # invoice <-> credit matching, break detection
│   └── audit/                  # hash chain, Ed25519 sign/verify, bundle builder, verify CLI
├── scenarios/                # the 6 required end-to-end scenarios (YAML)
├── scripts/scenario-cli.ts   # `pnpm scenario run <name> | --all`
└── out/                      # scenario + audit bundle JSON output (gitignored)
```

Not present yet: `apps/api`, `apps/web`, `db/` (Drizzle), `move/corridor_tokens/` — see the
milestone table above.

## Setup

```bash
pnpm install
```

No `.env`, no Postgres, no Docker needed to run scenarios or tests — everything here runs
in-memory. `.env.example` documents what a future Postgres/Sui-backed iteration would need.

## Commands

```bash
pnpm typecheck                        # tsc --noEmit across the whole workspace
pnpm lint                             # eslint .
pnpm test                             # vitest run
pnpm test:coverage                    # vitest run --coverage

pnpm scenario run <name>              # run one scenario, e.g. msme-sg-8l-friday
pnpm scenario run --all               # run all 6, assert expected outcomes, exit non-zero on failure

pnpm audit:verify out/audit/<workflow_id>.json   # recompute the hash chain + check the Ed25519 signature offline
```

Running a scenario writes two JSON files for inspection:
- `out/scenarios/<name>.json` — the full workflow result (events, optimizer breakdown, recon, audit bundle)
- `out/audit/<workflow_id>.json` — `{ bundle, events }`, the standalone input to `audit:verify`

## Scenarios

`scenarios/*.yaml` define the invoice, parties, submission instant, route config overrides,
failure injections and expected outcome. `pnpm scenario run --all` asserts every expectation and
exits non-zero if any scenario's actual outcome doesn't match.

| Scenario | Setup | Expected |
|---|---|---|
| `msme-sg-8l-friday` | Invoice submitted Friday 19:00 IST | `TOKENIZED` wins on time and net INR; `CORRESPONDENT` lands after the weekend |
| `msme-sg-8l-tuesday-thin-pool` | Same invoice, Tuesday 11:00 IST, tokenized pool overridden to be too thin | `CORRESPONDENT` wins; the explanation names the liquidity reason |
| `msme-sg-8l-bank-not-on-network` | Buyer's bank is not a tokenized-network member | `TOKENIZED` ineligible; `CORRESPONDENT` selected |
| `msme-sg-8l-short-payment` | Correspondent route, `intermediary_deduction` failure injection | Recon flags `SHORT_PAYMENT` and names the deducting hop |
| `msme-sg-8l-sanctions-review` | Buyer name fuzzy-matches the sample sanctions list | `COMPLIANCE_HOLD`; no quotes generated until a human approves |
| `msme-sg-8l-reroute` | Tokenized settlement fails before finality (`ledger_reject`) | Re-quote, fresh FX lock, settle via `CORRESPONDENT`; both attempts recorded |

The SGD amount in every scenario is derived from the rates simulator's seeded mid (§5.2 of
`CLAUDE.md`) — treat it as illustrative, never as today's real FX rate.

### Sample output (`pnpm scenario run msme-sg-8l-friday`)

```
=== msme-sg-8l-friday ===
₹8,00,000-equivalent SGD invoice submitted Friday 19:00 IST.
Final state: AUDIT_SEALED
  [ranked] TOKENIZED: score=1.0000 netINR=796108.43 timeToLanded=3270min allInCostBps=32
  [ranked] CORRESPONDENT: score=0.2000 netINR=780374.03 timeToLanded=3480min allInCostBps=225
  Explanation: TOKENIZED lands ₹15734.40 more and 3.5 hours sooner than CORRESPONDENT.
  Recon matched: true
  RESULT: PASS
```

TOKENIZED lands more (tighter fees + spread: ~32bps all-in vs ~225bps) and sooner (it only waits
out one AD-bank cut-off; CORRESPONDENT stacks three sequential calendar-gated hops that all roll
past the weekend).

### Sample output (`pnpm scenario run msme-sg-8l-short-payment`)

```
=== msme-sg-8l-short-payment ===
Correspondent route with an intermediary deduction.
Final state: AUDIT_SEALED
  [ranked] CORRESPONDENT: score=1.0000 netINR=776346.40 timeToLanded=450min allInCostBps=225
  [gated]  TOKENIZED: Buyer bank "Synthetic Raffles Trust Bank" is not a tokenized-network member.
  Recon matched: false
    break: SHORT_PAYMENT — Received ₹3078039 minor units less than expected. Deducted at hop "correspondent_lift".
  RESULT: PASS
```

## Audit bundle

Every sealed workflow produces a hash-chained event log (`hash = sha256(prevHash ||
canonical_json(event))`) plus a bundle signed with a fresh Ed25519 keypair, verifiable fully
offline:

```
$ pnpm audit:verify out/audit/wf_....json
VALID — audit bundle for workflow wf_... verifies offline.
  chain head: 8d76f53fc9f42b02bb4157e035447ae1ea0e9ace621da45bf726bfa71af1c153
  sealed at:  2026-01-06T05:30:00.000Z
```

Tampering with any event payload or any bundle field is caught — this is exercised directly in
`packages/audit/test/bundle.test.ts` and was also verified manually by hand-editing a generated
bundle file (flips to `INVALID — Ed25519 signature does not match bundle contents`).

## Quality gates (actual results, as run)

```
$ pnpm lint        # eslint .          -> clean, 0 errors/warnings
$ pnpm typecheck   # tsc --noEmit      -> clean, 0 errors
$ pnpm test        # vitest run        -> 7 test files, 59 tests, all passing
$ pnpm scenario run --all              -> 6/6 scenarios PASS
```

Test coverage by area (§15 of `CLAUDE.md` asks for 90% on `core`/`optimizer`/`workflow`, 80%
elsewhere — this has **not** been measured against that bar; `pnpm test:coverage` is wired up
via `@vitest/coverage-v8` but hasn't been run to check the actual percentage). What *is* covered
with dedicated tests:
- `core`: FX conversion determinism, a round-trip property test (fast-check), negative-amount
  and currency-mismatch rejection, calendar cut-off/weekend/holiday fixed-instant cases.
- `optimizer`: a gated route never appears in the ranked list; determinism (same input -> same
  output, including tie-break order); golden tests showing `cheapest` and `fastest` profiles
  disagree on the winner as expected.
- `workflow`: every transition in the table (generated from `TRANSITIONS` itself, so a table
  edit is automatically covered); illegal transitions throw; event-log replay reproduces state;
  double-delivery of an idempotency key is a no-op.
- `recon`: one test per break type, plus the matched/e-BRC-like/FIRA-like success path.
- `audit`: a freshly sealed bundle verifies; a tampered event breaks the chain; a tampered
  bundle field breaks the signature; `verifyEventChain` reports the exact `seq` where a chain
  breaks.
- `ledger`: allow-list enforcement, mint/burn round-trip, atomic swap rejects without mutating
  any balance when the payer lacks funds.

## Prior art (context, not a claim of affiliation)

This design draws on three public pieces of prior art — **Splash** (Sui Overflow, an end-to-end
B2B invoice/settlement/payout/audit flow), **Swift × Sui** interoperability work, and **Citi
Token Services** (always-on tokenized-deposit cross-border clearing). Nothing in this repo
implies partnership with, endorsement by, or connection to Citi, Swift, Sui, or the Splash
project — verify any specific claim against its primary source before it goes in a pitch deck.
