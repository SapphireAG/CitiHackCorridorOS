/**
 * Simplified ISO 20022-SHAPED JSON messages — CLAUDE.md §6.1. These mirror the field names and
 * shape of pacs.008 (credit transfer) and camt.054 (credit notification) at a level useful for
 * a demo audit trail; they are not a conformant ISO 20022 implementation.
 */

export interface Pacs008Message {
  messageType: "pacs.008.001.simplified";
  messageId: string;
  creationDateTime: string;
  debtor: { name: string; bankId: string };
  creditor: { name: string; bankId: string };
  instructedAmount: { currency: string; amountMinor: string };
  remittanceInformation: string | null;
}

export interface Camt054Message {
  messageType: "camt.054.001.simplified";
  messageId: string;
  creationDateTime: string;
  creditNotification: {
    accountId: string;
    currency: string;
    amountMinor: string;
    valueDate: string;
  };
  remittanceInformation: string | null;
}

export function buildPacs008(params: {
  messageId: string;
  at: Date;
  debtorName: string;
  debtorBankId: string;
  creditorName: string;
  creditorBankId: string;
  currency: string;
  amountMinor: string;
  includeRemittanceInfo: boolean;
  invoiceNumber: string;
}): Pacs008Message {
  return {
    messageType: "pacs.008.001.simplified",
    messageId: params.messageId,
    creationDateTime: params.at.toISOString(),
    debtor: { name: params.debtorName, bankId: params.debtorBankId },
    creditor: { name: params.creditorName, bankId: params.creditorBankId },
    instructedAmount: { currency: params.currency, amountMinor: params.amountMinor },
    remittanceInformation: params.includeRemittanceInfo ? `INV:${params.invoiceNumber}` : null,
  };
}

export function buildCamt054(params: {
  messageId: string;
  at: Date;
  accountId: string;
  currency: string;
  amountMinor: string;
  includeRemittanceInfo: boolean;
  invoiceNumber: string;
}): Camt054Message {
  return {
    messageType: "camt.054.001.simplified",
    messageId: params.messageId,
    creationDateTime: params.at.toISOString(),
    creditNotification: {
      accountId: params.accountId,
      currency: params.currency,
      amountMinor: params.amountMinor,
      valueDate: params.at.toISOString().slice(0, 10),
    },
    remittanceInformation: params.includeRemittanceInfo ? `INV:${params.invoiceNumber}` : null,
  };
}
