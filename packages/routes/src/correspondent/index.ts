import {
  add,
  advanceThroughHop,
  applySpread,
  type Clock,
  convert,
  type Currency,
  type FxRate,
  loadCalendar,
  money,
  moneyFromString,
  newId,
  subtract,
} from "@corridoros/core";
import type { EligibilityResult, Quote, SettlementResult } from "@corridoros/domain";
import type { Route, RouteContext } from "../route.js";
import { activePath, loadCorrespondentConfig } from "./config.js";
import { buildCamt054, buildPacs008 } from "./messages.js";

export class CorrespondentRoute implements Route {
  readonly id = "CORRESPONDENT" as const;

  checkEligibility(ctx: RouteContext): EligibilityResult {
    const reasons: string[] = [];
    if (ctx.invoice.currency !== "SGD") {
      reasons.push(`Correspondent path in this demo only models an SGD-denominated invoice, got ${ctx.invoice.currency}.`);
    }
    return { eligible: reasons.length === 0, reasons };
  }

  async quote(ctx: RouteContext, clock: Clock): Promise<Quote> {
    const cfg = loadCorrespondentConfig();
    const path = activePath(cfg);

    let principal = moneyFromString(ctx.invoice.totalMinor, ctx.invoice.currency as Currency);
    let instant = clock.now();
    let feesSourceMinor = 0n;
    let feesDestMinor = 0n;
    let appliedRate: FxRate | null = null;
    let midRateAtConversion: FxRate | null = null;

    for (const hop of path.hops) {
      const cal = loadCalendar(hop.calendar);
      instant = advanceThroughHop(instant, cal, hop.cutoff_key, hop.processing_minutes);

      if (hop.from === hop.to) {
        const fixedFee = BigInt(hop.fixed_fee_minor);
        const pctFee = (principal.amountMinor * BigInt(hop.percentage_fee_bps)) / 10_000n;
        const totalFee = fixedFee + pctFee;
        feesSourceMinor += totalFee;
        if (hop.deducted_from_principal) {
          principal = subtract(principal, money(totalFee, principal.currency));
        }
      } else {
        midRateAtConversion = ctx.rates.midRate(hop.from as Currency, hop.to as Currency, instant);
        const spreadBpsForHop = hop.fx_spread_bps ?? 0;
        appliedRate = { base: hop.from as Currency, quote: hop.to as Currency, rate: applySpread(midRateAtConversion.rate, spreadBpsForHop) };
        let converted = convert(principal, appliedRate);
        const fixedFee = BigInt(hop.fixed_fee_minor);
        const pctFee = (converted.amountMinor * BigInt(hop.percentage_fee_bps)) / 10_000n;
        const totalFee = fixedFee + pctFee;
        feesDestMinor += totalFee;
        converted = subtract(converted, money(totalFee, converted.currency));
        principal = converted;
      }
    }

    if (!midRateAtConversion || !appliedRate) {
      throw new Error("Correspondent active path has no currency-conversion hop");
    }

    const netInrLanded = principal;
    const invoiceOriginal = moneyFromString(ctx.invoice.totalMinor, ctx.invoice.currency as Currency);
    const invoiceValueAtMidInr = convert(invoiceOriginal, midRateAtConversion);
    const feesInr = add(convert(money(feesSourceMinor, ctx.invoice.currency as Currency), midRateAtConversion), money(feesDestMinor, "INR"));

    const allInCostBps =
      invoiceValueAtMidInr.amountMinor === 0n
        ? 0
        : Number(((invoiceValueAtMidInr.amountMinor - netInrLanded.amountMinor) * 10_000n) / invoiceValueAtMidInr.amountMinor);

    const now = clock.now();
    const path0Spread = path.hops.find((h) => h.fx_spread_bps !== undefined)?.fx_spread_bps ?? 0;

    return {
      routeId: "CORRESPONDENT",
      quoteId: newId("quote"),
      midRate: midRateAtConversion,
      appliedRate,
      feesInr,
      fxSpreadBps: path0Spread,
      allInCostBps,
      netInrLanded,
      timeToLandedMinutes: Math.round((instant.getTime() - now.getTime()) / 60_000),
      estimatedLandedAt: instant.toISOString(),
      expiresAt: new Date(now.getTime() + cfg.quote_validity_minutes * 60_000).toISOString(),
      liquidityCertainty: cfg.liquidity_certainty,
      explainFacts: {
        pathId: path.id,
        pathLabel: path.label,
        hopCount: String(path.hops.length),
      },
    };
  }

  async settle(ctx: RouteContext, quote: Quote, clock: Clock): Promise<SettlementResult> {
    const ref = newId("corr-settle");
    let landedAt = quote.estimatedLandedAt;
    let actualLandedInr = quote.netInrLanded;
    let deductingHopId: string | undefined;
    let includeRemittanceInfo = true;
    let status: SettlementResult["status"] = "FINAL";
    let failureReason: string | undefined;

    const injection = ctx.failureInjection;
    if (injection) {
      if (injection.mode === "return") {
        status = "FAILED";
        failureReason = "Correspondent bank returned the payment (return failure injection).";
      } else if (injection.mode === "delay") {
        landedAt = new Date(new Date(landedAt).getTime() + injection.minutes * 60_000).toISOString();
      } else if (injection.mode === "intermediary_deduction") {
        const extra = money(BigInt(injection.extraFeeMinor), "SGD");
        const extraInr = convert(extra, quote.appliedRate);
        actualLandedInr = subtract(actualLandedInr, extraInr);
        deductingHopId = injection.hopId;
      } else if (injection.mode === "missing_remittance_info") {
        includeRemittanceInfo = false;
      }
    }

    const at = clock.now();
    const pacs008 = buildPacs008({
      messageId: newId("pacs008"),
      at,
      debtorName: ctx.buyerBank.name,
      debtorBankId: ctx.buyerBank.bankId,
      creditorName: ctx.exporterBank.name,
      creditorBankId: ctx.exporterBank.bankId,
      currency: ctx.invoice.currency,
      amountMinor: ctx.invoice.totalMinor,
      includeRemittanceInfo,
      invoiceNumber: ctx.invoice.invoiceNumber,
    });
    const camt054 = buildCamt054({
      messageId: newId("camt054"),
      at: new Date(landedAt),
      accountId: ctx.exporterBank.bankId,
      currency: "INR",
      amountMinor: actualLandedInr.amountMinor.toString(),
      includeRemittanceInfo,
      invoiceNumber: ctx.invoice.invoiceNumber,
    });

    if (status === "FAILED") {
      return { status, ref, routeId: "CORRESPONDENT", failureReason, messages: [{ type: pacs008.messageType, messageId: pacs008.messageId }] };
    }

    return {
      status,
      ref,
      routeId: "CORRESPONDENT",
      landedAt,
      actualLandedInr,
      deductingHopId,
      messages: [
        { type: pacs008.messageType, messageId: pacs008.messageId },
        { type: camt054.messageType, messageId: camt054.messageId },
      ],
    };
  }
}

export { loadCorrespondentConfig } from "./config.js";
export * from "./messages.js";
