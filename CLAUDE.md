# CLAUDE.md — CorridorOS

> Source of truth for how Claude Code works in this repo. Read it fully before changing anything.
> If this file conflicts with a code comment, this file wins. If it conflicts with a direct instruction from a team member in the current session, follow the team member, then update this file in the same PR.

---

## 1. What we are building

**CorridorOS turns one export invoice into one programmable cross-border payment workflow.**

Reference case: an Indian MSME exports **₹8,00,000** of goods to a buyer in **Singapore**. Today the exporter handles invoice verification, KYC, payment initiation, FX conversion, correspondent banking, receipt of funds and reconciliation as separate steps with separate parties. CorridorOS runs them as one workflow:

```
Invoice → Compliance → Route selection → FX quote → Cross-border settlement
        → INR payout → Invoice reconciliation → Audit record
```

For the hackathon we support **two simulated routes**:

| Route id | What it models |
|---|---|
| `CORRESPONDENT` | Traditional path: buyer's bank in SG → correspondent/nostro hop(s) → Indian AD Category-I bank → exporter account. Bank cut-offs, weekends, holidays, intermediary deductions, bank FX spread. |
| `TOKENIZED` | 24/7 digital path: bank-issued **tokenized deposits** on a shared ledger with atomic payment-versus-payment FX, then INR payout to the exporter's bank account. Always-on, but constrained by network membership and liquidity. |

The core idea is **optimization, not hype.** The optimizer picks a route by weighing cost, FX spread, settlement time, liquidity and compliance. The demo must include at least one scenario where `CORRESPONDENT` wins. We never pitch "tokens are faster, so tokens win."

---

## 2. Hard guardrails (never violate)

1. **No public stablecoins or crypto.** The tokenized route models *bank-issued tokenized deposits* (the Citi Token Services / wholesale-CBDC pattern), not USDT, USDC or any INR stablecoin. RBI opposes crypto and private stablecoins in payments, and an Indian exporter must receive export proceeds through an authorised bank. The digital route must end in an INR credit via an authorised dealer bank, like the traditional one.
2. **Everything is simulated.** No real bank, SWIFT, NPCI, DGFT or RBI endpoints. No live payment keys. If the optional Sui ledger backend is used (§8), it runs on **localnet or testnet only**, with test tokens that carry no value. Mainnet RPC URLs must never appear in code or config.
3. **Money is never a float.** Amounts are `bigint` in **minor units** (paise, cents) tagged with an ISO 4217 currency. FX rates are decimal strings handled with `decimal.js` at a fixed scale. See §5.
4. **Compliance is a gate, not a weight.** A route that fails a compliance or eligibility check is removed from consideration. It is never "outscored." Compliance never trades off against cost.
5. **No real personal or business data.** Exporters, buyers, IEC, GSTIN, PAN and bank accounts are synthetic, and fixtures are marked `SYNTHETIC`. Identifiers are hashed in logs and audit bundles.
6. **No invented regulatory facts or market numbers.** Fees, spreads, cut-offs, realisation periods and purpose codes live in `config/` files, each with `source:` and `as_of:`, or with `illustrative: true` / `unverified: true`. Never hard-code them in logic.
7. **No partnership claims.** Citi, Swift, Sui and the Splash project are prior art we learned from. The UI, README and pitch must never imply we are affiliated with, endorsed by, or connected to any of them.

If a request would break a guardrail, stop, name the guardrail, and propose the compliant alternative.

---

## 3. Domain glossary (use these names in code)

| Term | Meaning |
|---|---|
| **Corridor** | A currency and jurisdiction pair plus direction, e.g. `SG→IN / SGD→INR`. Config in `config/corridors/`. |
| **Workflow** | One invoice's end-to-end run. Has a `workflow_id` and moves through the state machine in §4. |
| **Step** | One stage of the workflow, e.g. `COMPLIANCE` or `FX_QUOTE`. Each step handler is idempotent. |
| **Route** | A way to move value through the corridor (`CORRESPONDENT`, `TOKENIZED`). Implements the `Route` interface in §6. |
| **Quote** | A route's priced offer: fees, FX rate, spread, estimated INR landed, estimated landing time, expiry. |
| **Mid rate** | Reference rate from the rates simulator. Spreads are measured against it. |
| **All-in cost** | `(INR value at mid − net INR landed) / INR value at mid`, in basis points. Combines fees and spread. |
| **Landed** | INR credited to the exporter's account, final, not just "sent." Time is measured to landed. |
| **Eligibility** | Hard checks a route must pass: corridor support, both banks on network, amount limits, liquidity, quote validity. |
| **Break** | A reconciliation mismatch: short payment, overpayment, missing credit, duplicate, wrong reference. |
| **Audit bundle** | Signed, hash-chained record of every decision in a workflow (§10). |
| **Realisation** | The exporter's obligation to realise and repatriate export proceeds within the RBI-prescribed period. Tracked, not enforced. |
| **e-BRC / FIRA** | Proof-of-realisation documents. We generate **simulated** equivalents only, clearly labelled. |

---

## 4. Workflow state machine

Implemented as an explicit transition table in `packages/workflow/src/machine.ts`. It is event-sourced: state is derived from the `workflow_events` log, never stored as a mutable column.

```
DRAFT
 └─ INVOICE_SUBMITTED
     └─ INVOICE_VERIFIED ───────────────┐ (fail) → INVOICE_REJECTED
         └─ COMPLIANCE_CLEARED ─────────┤ (fail) → COMPLIANCE_HOLD (manual review)
             └─ ROUTES_QUOTED
                 └─ ROUTE_SELECTED
                     └─ FX_LOCKED ──────┤ (expiry) → back to ROUTES_QUOTED
                         └─ SETTLEMENT_INITIATED
                             └─ SETTLED ┤ (fail before finality) → REROUTING → ROUTES_QUOTED
                                 └─ INR_PAYOUT_INITIATED
                                     └─ INR_LANDED
                                         └─ RECONCILED ── (break) → RECON_EXCEPTION
                                             └─ AUDIT_SEALED (terminal)
```

Rules:
- Every transition is an event: `{workflow_id, seq, type, payload, actor, at, prev_hash, hash}`.
- Handlers are **idempotent**. Each carries an `idempotency_key`, and replaying it is a no-op.
- **Rerouting** always takes a fresh quote and a fresh FX lock. Old quotes are never reused. It is allowed only before settlement finality on the failed route, never after.
- **No wall-clock reads in logic.** Inject a `Clock` (`packages/core/src/clock.ts`). Tests use fixed instants.
- A manual action (approve a compliance hold, resolve a recon break) is an event with `actor: {type: "human", id}`.

---

## 5. Money, FX and time

### 5.1 Money
```ts
type Currency = "INR" | "SGD" | "USD";          // extend via config/currencies.yaml
interface Money { amountMinor: bigint; currency: Currency }  // INR paise, SGD/USD cents
```
- Minor-unit exponents come from `config/currencies.yaml`. Never assume 2.
- Arithmetic helpers live in `packages/core/src/money.ts`. Adding different currencies throws `CurrencyMismatchError`.
- API and JSON carry amounts as **strings** of minor units, e.g. `"80000000"` for ₹8,00,000.

### 5.2 FX
- Rates are decimal strings with scale 8, e.g. `"63.12345678"` INR per SGD. **These are placeholders, not real rates.**
- Conversion: `minor × rate`, then round to target minor units with **ROUND_HALF_EVEN**. This is the only rounding point, in `fx.convert()`.
- `spreadBps = (mid − applied) / mid × 10,000` for a sell-foreign / buy-INR conversion. Keep the sign convention documented in code.
- Quotes carry `expiresAt`. A locked quote must be used before expiry, or the workflow re-quotes.
- Rates come from `packages/rates-sim`, a seeded, deterministic random walk. No live FX APIs.

### 5.3 Time and calendars
- Store instants in UTC. Display in `Asia/Kolkata` and `Asia/Singapore`.
- `packages/core/src/calendar.ts` models business days, holidays (IN, SG and US when a USD leg exists) and per-bank cut-offs from `config/calendars/*.yaml`.
- The correspondent route respects cut-offs, weekends and holidays at every hop. The tokenized route settles 24/7 on the ledger, but the **INR payout leg and AD-bank conversion window are modeled explicitly** (`config/routes/tokenized.yaml → inr_payout`). No pretending everything is instant end to end.

---

## 6. Routes

Interface in `packages/routes/src/route.ts`:

```ts
interface Route {
  id: "CORRESPONDENT" | "TOKENIZED";
  checkEligibility(ctx: RouteContext): EligibilityResult;       // hard gate, with reasons
  quote(ctx: RouteContext, clock: Clock): Promise<Quote>;       // fees, rate, spread, ETA, expiry
  settle(lock: FxLock, clock: Clock): Promise<SettlementResult>;
  // SettlementResult.status: PENDING | SOFT | FINAL | FAILED
}
```

### 6.1 `CORRESPONDENT` (simulator in `packages/routes/src/correspondent/`)
- Hops are configurable in `config/routes/correspondent.yaml`: direct SGD nostro, or an SGD→USD→INR path through a USD correspondent.
- Per-hop fields: fixed fee, percentage fee, whether it is deducted from principal (causes short-payment at the exporter), processing time, cut-off, calendar.
- Messages are simplified **ISO 20022-shaped JSON**: `pacs.008` for the credit transfer, `camt.054` for the credit notification. Schema in `packages/routes/src/correspondent/messages.ts`.
- Failure injection: `return`, `delay`, `intermediary_deduction`, `missing_remittance_info`.

### 6.2 `TOKENIZED` (simulator in `packages/routes/src/tokenized/`)
- Participants: buyer's bank (SG) and exporter's AD bank (IN), each issuing tokenized deposits (`tSGD`, `tINR`) on the ledger backend.
- FX happens as **atomic PvP**: `tSGD` and `tINR` swap in one transaction or not at all, priced from a liquidity pool or bank market-maker quote.
- Eligibility fails if either bank is not a network member, the amount exceeds the per-transaction limit, or pool depth cannot fill the order within the max-slippage setting.
- Landed only when the exporter's bank redeems `tINR` into a credit to the exporter's account (the modeled payout leg).
- Failure injection: `insufficient_liquidity`, `participant_offline`, `ledger_reject`, `payout_delay`.

---

## 7. Optimizer

`packages/optimizer/` is pure and deterministic. It takes eligible quotes plus a preference profile and returns a ranked list with a full breakdown.

1. **Gate.** Drop any route that fails compliance or eligibility. Keep the reasons for the UI.
2. **Metrics per remaining route:**
   - `feesInr`: all explicit fees, converted at mid
   - `fxSpreadBps`: against mid
   - `allInCostBps`: fees + spread combined
   - `netInrLanded`: `Money`
   - `timeToLanded`: minutes from now to the estimated landed instant, calendar-aware
   - `liquidityCertainty`: 0–1, from pool depth vs order size (correspondent route uses a config value)
   - `complianceRisk`: 0–1 residual risk score from the compliance engine (only for routes that already passed the gate)
3. **Normalize** each metric across the candidates to 0–1 (min-max; if all are equal, every route gets 1).
4. **Weight** by profile from `config/optimizer_profiles.yaml`: `balanced` (default), `cheapest`, `fastest`, `certain`.
5. **Tie-break** deterministically: higher `netInrLanded`, then earlier `timeToLanded`, then route id alphabetically.
6. **Explain.** Generate the human "why" text from the breakdown with templates, e.g. *"Tokenized lands ₹1,240 more and 3 days sooner; correspondent was blocked by the Friday 17:00 SGT cut-off."* No LLM in the decision path.

The optimizer must be a pure function of `(quotes, profile)`: no I/O and no clock.

---

## 8. Ledger backends (for the tokenized route)

`packages/ledger/` defines a `LedgerBackend` interface with two implementations:

| Backend | Default | Notes |
|---|---|---|
| `memory` | **yes** | In-process ledger with the same semantics: accounts, mint/burn by issuer only, allow-listed holders, atomic swap. Used by all tests. |
| `sui` | optional | Move package in `move/corridor_tokens/`: permissioned `tSGD`/`tINR` coins (issuer-controlled mint/burn, holder allow-list), an atomic PvP swap, and an optional audit-hash anchor. **Localnet/testnet only.** Enable with `LEDGER_BACKEND=sui`. |

The rest of the system must not know which backend is running. If a feature only works on one backend, it belongs in that backend's package.

---

## 9. Compliance engine (simulated)

`packages/compliance/` holds rules as data (`config/compliance/rules.yaml`) plus small pure evaluators. Each rule has an id, a version and a severity (`BLOCK` or `REVIEW` or `INFO`).

Checks for the reference corridor:
- **Invoice integrity:** required fields, totals add up, currency and amounts match, invoice hash recorded, no duplicate invoice number per exporter.
- **Exporter KYB:** synthetic IEC, GSTIN and PAN pass format validation and exist in the seeded registry; bank account verified.
- **Buyer KYB:** entity exists in the seeded SG registry.
- **Sanctions screening:** both parties are fuzzy-matched against a bundled sample list in `data/sanctions_sample.json`. Matches above threshold go to `REVIEW`. This is not a real screening service.
- **Goods:** the HS code checked against a sample restricted or dual-use list goes to `REVIEW`.
- **Purpose code:** assigned from `config/regulatory.yaml` (export of goods / advance receipt), marked for verification.
- **Realisation tracking:** the due date is computed from invoice and shipping dates plus the configured realisation period, flagged `unverified` until someone confirms the current RBI rule.
- **Velocity/AML heuristics:** exporter volume vs history, round-amount patterns → `REVIEW` only.

Every decision is written to the audit bundle with the rule id, version, inputs hash and outcome.

---

## 10. Reconciliation and audit

### 10.1 Reconciliation (`packages/recon/`)
- Match incoming INR credits to invoices by reference first, then by amount and date window.
- Handles: **short payment** from intermediary deductions (shows expected vs received and which hop deducted), partial payments, one payment covering several invoices, duplicate credits.
- On success, emits simulated **e-BRC-like** and **FIRA-like** records, each labelled `SIMULATED — NOT A DGFT/BANK DOCUMENT`.

### 10.2 Audit bundle (`packages/audit/`)
- Every workflow event is hash-chained: `hash = sha256(prev_hash || canonical_json(event))`.
- At `AUDIT_SEALED` we produce a bundle containing: invoice hash, compliance decisions, all quotes (including rejected ones), optimizer breakdown, chosen route, settlement refs, payout ref, recon result and the final chain head. It is signed with an Ed25519 key from env.
- `pnpm audit:verify <bundle.json>` recomputes the chain and checks the signature.
- Optional: anchor the chain head on the Sui backend. The bundle must verify offline without the anchor.

---

## 11. Repository layout

```
corridoros/
├── CLAUDE.md
├── README.md
├── docker-compose.yml              # postgres (+ sui localnet profile)
├── .env.example                    # placeholders only
├── config/
│   ├── currencies.yaml
│   ├── corridors/sg-in.yaml
│   ├── calendars/{in,sg,us}.yaml
│   ├── routes/{correspondent,tokenized}.yaml     # illustrative fees, spreads, times
│   ├── optimizer_profiles.yaml
│   ├── compliance/rules.yaml
│   └── regulatory.yaml             # every entry: source + as_of, or unverified: true
├── apps/
│   ├── api/                        # Fastify + Zod, REST under /v1
│   └── web/                        # Next.js dashboard: invoice upload, route comparison, timeline, audit view
├── packages/
│   ├── core/                       # money, fx, clock, calendar, ids, errors
│   ├── workflow/                   # state machine, event store, step handlers
│   ├── compliance/
│   ├── rates-sim/
│   ├── routes/                     # correspondent/, tokenized/
│   ├── ledger/                     # memory/, sui/
│   ├── optimizer/
│   ├── recon/
│   └── audit/
├── move/corridor_tokens/           # optional Sui Move package
├── scenarios/                      # YAML end-to-end scenarios (§13)
├── data/                           # SYNTHETIC fixtures, sample sanctions list
└── db/                             # Drizzle schema + migrations
```

---

## 12. Tech stack

- **Language:** TypeScript (strict) across backend and frontend, Node 20+, pnpm workspaces.
- **API:** Fastify, Zod for every request/response schema, OpenAPI generated from Zod.
- **DB:** Postgres 16 with Drizzle ORM. `workflow_events` is append-only; projections are rebuildable.
- **Math:** native `bigint` for minor units, `decimal.js` for rates. No `number` for money.
- **Frontend:** Next.js (App Router), Tailwind, Recharts.
- **Ledger (optional):** Sui Move, `@mysten/sui` TypeScript SDK.
- **Testing:** Vitest, `fast-check` for property tests, Playwright for one end-to-end demo path.
- **Quality:** ESLint (with a rule banning `parseFloat`/`Number()` on money fields), Prettier, `tsc --noEmit`.

Do not add a top-level dependency without a one-line reason in the PR description.

---

## 13. Scenarios (the demo is driven by these)

`scenarios/*.yaml` define the invoice, parties, submission instant, route config overrides, injected failures and **expected outcome** (winning route, recon result). `pnpm scenario run <name>` executes one end to end on the memory backend with a fixed clock.

Required scenarios:

| Name | Setup | Expected |
|---|---|---|
| `msme-sg-8l-friday` | ₹8,00,000-equivalent SGD invoice submitted Friday 19:00 IST | `TOKENIZED` wins on time and net INR; correspondent lands after the weekend |
| `msme-sg-8l-tuesday-thin-pool` | Same invoice, Tuesday 11:00 IST, tokenized pool too thin (slippage > max) | `CORRESPONDENT` wins; the explanation names the liquidity reason |
| `msme-sg-8l-bank-not-on-network` | Buyer's bank not a tokenized-network member | `TOKENIZED` ineligible; `CORRESPONDENT` selected |
| `msme-sg-8l-short-payment` | Correspondent route with intermediary deduction | Recon flags short payment and names the deducting hop |
| `msme-sg-8l-sanctions-review` | Buyer name fuzzy-matches the sample list | `COMPLIANCE_HOLD`; no quotes generated until a human approves |
| `msme-sg-8l-reroute` | Tokenized settlement fails before finality | Re-quote, fresh FX lock, settle via correspondent; the audit bundle shows both attempts |

The amount conversion in scenarios uses the rates simulator's seeded mid, so the SGD figure is whatever that seed produces. Never present it as today's real rate.

---

## 14. Commands

```bash
# setup
pnpm install
cp .env.example .env
docker compose up -d                       # postgres
pnpm db:migrate && pnpm seed               # synthetic exporters, buyers, banks, calendars

# run
pnpm dev                                   # api + web
pnpm scenario run msme-sg-8l-friday
pnpm scenario run --all                    # all scenarios, asserts expected outcomes

# audit
pnpm audit:verify out/audit/<workflow_id>.json

# optional Sui backend
docker compose --profile sui up -d         # or: sui start (localnet)
pnpm -C move build && pnpm -C move test
LEDGER_BACKEND=sui pnpm scenario run msme-sg-8l-friday

# quality gates (run before every commit)
pnpm lint && pnpm typecheck && pnpm test && pnpm scenario run --all
```

---

## 15. Testing expectations

- **Money/FX:** property tests confirm conversion is deterministic, round-trip error stays within one minor unit, no negative amounts, and currency mismatch always throws.
- **Calendar:** fixed-instant tests for cut-offs, weekends, IN/SG holidays and a USD-leg holiday.
- **Optimizer:** golden tests per profile. A test asserts that a gated route never appears in rankings, and a test asserts determinism (same input, same output, including tie-breaks).
- **Workflow:** every transition in the table has a test. Illegal transitions throw. Replaying the event log reproduces state. Idempotent handlers are tested by double delivery.
- **Recon:** one test per break type.
- **Audit:** tampering with any event breaks `audit:verify`.
- **Scenarios:** every file in `scenarios/` passes in CI.
- Coverage target: 90% for `core`, `optimizer`, `workflow`; 80% elsewhere.

---

## 16. Coding conventions

- `strict: true`, no `any`, no non-null assertions in `core`/`optimizer`/`workflow`.
- Pure logic lives in packages; I/O lives only in `apps/api`, the event store, the ledger backends and scenario runners.
- Typed errors in `packages/core/src/errors.ts`. Never throw strings. Never swallow errors.
- Structured JSON logs (pino). Never log raw identifiers, account numbers or full invoices.
- API: `/v1`, money as minor-unit strings plus currency, ISO-8601 UTC timestamps, `Idempotency-Key` header required on POSTs.
- Commits: Conventional Commits (`feat(optimizer): add certainty profile`). Small PRs. One reviewer.

---

## 17. How Claude should work here

1. **Plan first** for anything touching more than 3 files, the state machine, the `Route` interface, or money/FX code. Present the plan and wait for approval.
2. **Adding a route:** implement `Route`, add `config/routes/<id>.yaml`, failure injections, and at least two scenarios (one where it wins, one where it loses). Register it in the route registry.
3. **Changing numbers:** fees, spreads, cut-offs and limits change only in `config/`, with `illustrative`/`source` metadata. Never inline them.
4. **Before finishing:** run the quality gates in §14 and report the real results. If something fails and you can't fix it, say so plainly.
5. **Never** weaken a guardrail (§2) or loosen a test to make it pass. Never delete a scenario because its expectation changed. Update the expectation and explain why in the PR.
6. **Regulatory uncertainty:** add a `TODO(reg):` in code and an `unverified: true` entry in `config/regulatory.yaml` rather than guessing.
7. **UI copy:** every simulated artifact (rates, e-BRC/FIRA records, bank names, fees) is visibly labelled as simulated.

---

## 18. Hackathon milestones

- **M1 — Skeleton:** `core` (money, fx, clock, calendar), event store, state machine, invoice submission API.
- **M2 — Routes:** correspondent simulator with hops and cut-offs; tokenized simulator on the memory ledger with PvP and liquidity pool.
- **M3 — Brain:** compliance engine, optimizer with profiles and explanations.
- **M4 — Close the loop:** INR payout, reconciliation, audit bundle plus verifier.
- **M5 — Demo:** dashboard with side-by-side route comparison, a live workflow timeline and an audit viewer; all six scenarios green.
- **Stretch:** Sui Move backend with an audit anchor; PDF invoice extraction with a human confirmation step; a third route (e.g. a CBDC-bridge-style corridor) added purely via the `Route` interface.

---

## 19. Prior art we learned from (context, not claims)

The team's framing draws on three pieces of prior art:
- **Splash (Sui Overflow):** an end-to-end B2B flow of invoice verification, approval, settlement, local payout and audit proof.
- **Swift × Sui:** interoperability work.
- **Citi Token Services:** always-on, tokenized-deposit and 24/7 cross-border clearing work.

Verify any specific claim, date or figure against the primary source before it goes into the README or pitch deck. Cite it there, and never imply affiliation (§2.7).
