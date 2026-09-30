import { add, advanceThroughHop, applySpread, type Clock, convert, type FxRate, loadCalendar, money, moneyFromString, newId } from "@corridoros/core";
import type { EligibilityResult, Quote, SettlementResult } from "@corridoros/domain";
import { MemoryLedger, type LedgerBackend } from "@corridoros/ledger";
import type { Route, RouteContext } from "../route.js";
import { loadTokenizedConfig, type TokenizedConfig } from "./config.js";

interface Economics {
  midRate: FxRate;
  appliedRate: FxRate;
  swapFeeSgdMinor: bigint;
  netPrincipalSgdMinor: bigint;
  convertedInrMinor: bigint;
  payoutFeeInrMinor: bigint;
  netInrLandedMinor: bigint;
  instantAfterLedger: Date;
  instantAfterPayout: Date;
}

export class TokenizedRoute implements Route {
  readonly id = "TOKENIZED" as const;
  private readonly ledger: LedgerBackend;

  constructor(ledger: LedgerBackend = new MemoryLedger()) {
    this.ledger = ledger;
    const cfg = loadTokenizedConfig();
    for (const member of cfg.network.members) {
      this.ledger.allowHolder("tSGD", member.bank_id);
      this.ledger.allowHolder("tINR", member.bank_id);
    }
  }

  checkEligibility(ctx: RouteContext): EligibilityResult {
    const cfg = loadTokenizedConfig(ctx.configOverrides?.tokenized);
    const reasons: string[] = [];

    const isMember = (bankId: string, networkMember: boolean) =>
      networkMember && cfg.network.members.some((m) => m.bank_id === bankId);

    if (!isMember(ctx.buyerBank.bankId, ctx.buyerBank.tokenizedNetworkMember)) {
      reasons.push(`Buyer bank "${ctx.buyerBank.name}" is not a tokenized-network member.`);
    }
    if (!isMember(ctx.exporterBank.bankId, ctx.exporterBank.tokenizedNetworkMember)) {
      reasons.push(`Exporter bank "${ctx.exporterBank.name}" is not a tokenized-network member.`);
    }

    const orderSizeMinor = BigInt(ctx.invoice.totalMinor);
    const limitMinor = BigInt(cfg.per_transaction_limit_minor.amount);
    if (orderSizeMinor > limitMinor) {
      reasons.push(`Order size ${orderSizeMinor.toString()} exceeds the per-transaction limit of ${limitMinor.toString()} minor ${cfg.per_transaction_limit_minor.currency}.`);
    }

    const poolDepthMinor = BigInt(cfg.liquidity_pool.depth_minor.amount);
    const impliedSlippageBps = poolDepthMinor === 0n ? 1_000_000n : (orderSizeMinor * 10_000n) / poolDepthMinor;
    if (impliedSlippageBps > BigInt(cfg.liquidity_pool.max_slippage_bps)) {
      reasons.push(
        `Liquidity pool too thin for this order: implied slippage ~${impliedSlippageBps.toString()}bps exceeds max_slippage_bps=${cfg.liquidity_pool.max_slippage_bps} (pool depth ${poolDepthMinor.toString()} minor ${cfg.liquidity_pool.depth_minor.currency}).`,
      );
    }

    if (ctx.failureInjection?.mode === "insufficient_liquidity") {
      reasons.push("Simulated insufficient_liquidity failure injection.");
    }
    if (ctx.failureInjection?.mode === "participant_offline") {
      reasons.push("Simulated participant_offline failure injection: a required network participant is unreachable.");
    }

    return { eligible: reasons.length === 0, reasons };
  }

  private computeEconomics(ctx: RouteContext, clock: Clock, cfg: TokenizedConfig): Economics {
    const principalSgd = moneyFromString(ctx.invoice.totalMinor, "SGD");
    const instantAfterLedger = new Date(clock.now().getTime() + cfg.timing.ledger_settlement_minutes * 60_000);

    const midRate = ctx.rates.midRate("SGD", "INR", instantAfterLedger);
    const appliedRate: FxRate = { base: "SGD", quote: "INR", rate: applySpread(midRate.rate, cfg.fx_spread_bps) };

    const swapFeeSgdMinor = (principalSgd.amountMinor * BigInt(cfg.fees.swap_fee_bps)) / 10_000n;
    const netPrincipalSgdMinor = principalSgd.amountMinor - swapFeeSgdMinor;

    const convertedInr = convert(money(netPrincipalSgdMinor, "SGD"), appliedRate);
    const payoutFeeInrMinor = BigInt(cfg.fees.payout_fee_minor);
    const netInrLandedMinor = convertedInr.amountMinor - payoutFeeInrMinor;

    const payoutCalendar = loadCalendar(cfg.timing.inr_payout.calendar);
    const instantAfterPayout = advanceThroughHop(
      instantAfterLedger,
      payoutCalendar,
      cfg.timing.inr_payout.cutoff_key,
      cfg.timing.inr_payout.processing_minutes,
    );

    return {
      midRate,
      appliedRate,
      swapFeeSgdMinor,
      netPrincipalSgdMinor,
      convertedInrMinor: convertedInr.amountMinor,
      payoutFeeInrMinor,
      netInrLandedMinor,
      instantAfterLedger,
      instantAfterPayout,
    };
  }

  async quote(ctx: RouteContext, clock: Clock): Promise<Quote> {
    const cfg = loadTokenizedConfig(ctx.configOverrides?.tokenized);
    const econ = this.computeEconomics(ctx, clock, cfg);

    const principalSgd = moneyFromString(ctx.invoice.totalMinor, "SGD");
    const invoiceValueAtMidInr = convert(principalSgd, econ.midRate);
    const netInrLanded = money(econ.netInrLandedMinor, "INR");
    const feesInr = add(convert(money(econ.swapFeeSgdMinor, "SGD"), econ.midRate), money(econ.payoutFeeInrMinor, "INR"));

    const allInCostBps =
      invoiceValueAtMidInr.amountMinor === 0n
        ? 0
        : Number(((invoiceValueAtMidInr.amountMinor - netInrLanded.amountMinor) * 10_000n) / invoiceValueAtMidInr.amountMinor);

    const orderSizeMinor = BigInt(ctx.invoice.totalMinor);
    const poolDepthMinor = BigInt(cfg.liquidity_pool.depth_minor.amount);
    const liquidityCertainty =
      poolDepthMinor === 0n ? 0 : Math.max(0, Math.min(1, 1 - Number(orderSizeMinor) / Number(poolDepthMinor)));

    const now = clock.now();
    return {
      routeId: "TOKENIZED",
      quoteId: newId("quote"),
      midRate: econ.midRate,
      appliedRate: econ.appliedRate,
      feesInr,
      fxSpreadBps: cfg.fx_spread_bps,
      allInCostBps,
      netInrLanded,
      timeToLandedMinutes: Math.round((econ.instantAfterPayout.getTime() - now.getTime()) / 60_000),
      estimatedLandedAt: econ.instantAfterPayout.toISOString(),
      expiresAt: new Date(now.getTime() + cfg.quote_validity_minutes * 60_000).toISOString(),
      liquidityCertainty,
      explainFacts: {
        network: "bank-issued tokenized deposits (tSGD/tINR), permissioned ledger",
        swapType: "atomic PvP",
      },
    };
  }

  async settle(ctx: RouteContext, quote: Quote, clock: Clock): Promise<SettlementResult> {
    const cfg = loadTokenizedConfig(ctx.configOverrides?.tokenized);
    const ref = newId("tok-settle");
    const injection = ctx.failureInjection;

    if (injection?.mode === "ledger_reject") {
      return { status: "FAILED", ref, routeId: "TOKENIZED", failureReason: "Ledger rejected the atomic PvP swap (ledger_reject failure injection)." };
    }
    if (injection?.mode === "participant_offline") {
      return { status: "FAILED", ref, routeId: "TOKENIZED", failureReason: "A network participant was unreachable (participant_offline failure injection)." };
    }

    const econ = this.computeEconomics(ctx, clock, cfg);

    // Buyer's bank issues tSGD backed by the buyer's real deposit; the atomic swap below both
    // extinguishes that tSGD and issues the AD bank's tINR in one step (see SwapRequest doc).
    this.ledger.mint(ctx.buyerBank.bankId, "tSGD", ctx.buyerBank.bankId, econ.netPrincipalSgdMinor);

    const swap = this.ledger.atomicSwap({
      fromBank: ctx.buyerBank.bankId,
      fromToken: "tSGD",
      fromAmountMinor: econ.netPrincipalSgdMinor,
      toBank: ctx.exporterBank.bankId,
      toToken: "tINR",
      toAmountMinor: econ.convertedInrMinor,
    });

    if (swap.status === "REJECTED") {
      return { status: "FAILED", ref, routeId: "TOKENIZED", failureReason: `Ledger swap rejected: ${swap.reason}` };
    }

    // AD bank redeems tINR into a real INR credit to the exporter's account — this IS "landed".
    this.ledger.burn(ctx.exporterBank.bankId, "tINR", ctx.exporterBank.bankId, econ.convertedInrMinor);

    let landedAtMs = econ.instantAfterPayout.getTime();
    if (injection?.mode === "payout_delay") landedAtMs += injection.minutes * 60_000;

    return {
      status: "FINAL",
      ref,
      routeId: "TOKENIZED",
      landedAt: new Date(landedAtMs).toISOString(),
      actualLandedInr: money(econ.netInrLandedMinor, "INR"),
      messages: [{ type: "ledger.pvp_swap", messageId: swap.swapId }],
    };
  }
}

export { loadTokenizedConfig } from "./config.js";
export type { TokenizedConfig, TokenizedConfigOverrides } from "./config.js";
