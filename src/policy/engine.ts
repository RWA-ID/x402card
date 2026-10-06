// Policy engine: plain, deterministic code (no LLM). Maps ENS records to
// Airwallex card controls and decides funding requests and freezes.
import type { AuthorizationControls, IssuingTransaction } from "../airwallex/issuing.ts";
import type { CardPolicy } from "./records.ts";

export interface EngineConfig {
  /** Global ceiling: funding above this always needs a human, whatever card.limit.tx says. */
  escalateAbove: number;
  /** Auto-approval may not take the wallet's available balance below this. */
  reserveFloor: number;
  /** Disallowed-MCC attempts within the window that trigger a freeze. */
  mccStrikesToFreeze: number;
  /** Total attempts within the window that trigger a freeze. */
  velocityMax: number;
  windowMs: number;
}

export const DEFAULT_CONFIG: EngineConfig = {
  escalateAbove: 250,
  reserveFloor: 1000,
  mccStrikesToFreeze: 2,
  velocityMax: 10,
  windowMs: 10 * 60 * 1000,
};

// Currencies Airwallex/ISO 4217 bill with no minor unit; everything else in
// card.currencies is assumed to use 2 decimals.
const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "IDR", "CLP", "ISK", "UGX"]);

export function decimalsFor(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

export function roundMajor(amount: number, currency: string): number {
  const f = 10 ** decimalsFor(currency);
  return Math.round(amount * f) / f;
}

/**
 * Records -> Airwallex authorization_controls. The monthly limit is the
 * card's allowance; approved funding raises it (and the ENS record).
 */
export function toAuthorizationControls(p: CardPolicy): AuthorizationControls {
  const currency = p.currencies[0];
  return {
    allowed_transaction_count: "MULTIPLE",
    transaction_limits: {
      currency,
      limits: [
        { interval: "PER_TRANSACTION", amount: roundMajor(p.limitTx, currency) },
        { interval: "MONTHLY", amount: roundMajor(p.limitMonthly, currency) },
      ],
    },
    allowed_currencies: p.currencies,
    allowed_merchant_categories: p.mccAllow,
  };
}

export type FundingDecision =
  | { decision: "approve"; reason: string }
  | { decision: "escalate"; reason: string }
  | { decision: "deny"; reason: string };

export interface FundingRequest {
  amount: number;
  currency: string;
}

export function decideFunding(
  p: CardPolicy,
  req: FundingRequest,
  walletAvailable: number,
  cfg: EngineConfig = DEFAULT_CONFIG,
): FundingDecision {
  const currency = req.currency.toUpperCase();
  if (p.status === "frozen") return { decision: "deny", reason: "card is frozen" };
  if (!p.currencies.includes(currency)) return { decision: "deny", reason: `${currency} not in card.currencies` };
  if (!(req.amount > 0)) return { decision: "deny", reason: "amount must be positive" };
  if (roundMajor(req.amount, currency) !== req.amount) {
    return { decision: "deny", reason: `${currency} allows ${decimalsFor(currency)} decimals` };
  }

  // The name's own card.limit.tx is the auto-approve line; escalateAbove caps it globally.
  if (req.amount > p.limitTx) {
    return { decision: "escalate", reason: `${req.amount} > card.limit.tx (${p.limitTx})` };
  }
  if (req.amount > cfg.escalateAbove) {
    return { decision: "escalate", reason: `above global auto-approve ceiling ${cfg.escalateAbove} ${currency}` };
  }
  if (walletAvailable - req.amount < cfg.reserveFloor) {
    return { decision: "escalate", reason: `would breach reserve floor ${cfg.reserveFloor} ${currency}` };
  }
  return { decision: "approve", reason: "within policy and above reserve floor" };
}

export interface PaymentRequest {
  amount: number;
  currency: string;
  mcc: string;
}

/** Codes match the issuer's decline reasons, so an agent handles both layers the same way. */
export type PaymentCheck = { ok: true } | { ok: false; code: string; reason: string };

/**
 * x402card's own check before a payment reaches the card network. The issuer
 * enforces the same controls again at authorization; the monthly allowance is
 * left to the issuer, which knows what has already been spent.
 */
export function precheckPayment(p: CardPolicy, req: PaymentRequest): PaymentCheck {
  const currency = req.currency.toUpperCase();
  if (p.status === "frozen") return { ok: false, code: "CARD_FROZEN", reason: "card.status is frozen" };
  if (!(req.amount > 0) || roundMajor(req.amount, currency) !== req.amount) {
    return { ok: false, code: "INVALID_AMOUNT", reason: `amount must be positive with at most ${decimalsFor(currency)} decimals` };
  }
  if (!/^\d{4}$/.test(req.mcc)) return { ok: false, code: "INVALID_MCC", reason: "mcc must be a 4-digit merchant category code" };
  if (!p.currencies.includes(currency)) {
    return { ok: false, code: "CURRENCY_NOT_ALLOWED", reason: `${currency} not in card.currencies (${p.currencies.join(",")})` };
  }
  if (p.mccAllow.length > 0 && !p.mccAllow.includes(req.mcc)) {
    return { ok: false, code: "MERCHANT_CATEGORY_NOT_ALLOWED", reason: `${req.mcc} not in card.mcc.allow (${p.mccAllow.join(",")})` };
  }
  if (req.amount > p.limitTx) {
    return { ok: false, code: "LIMIT_EXCEEDED", reason: `${req.amount} > card.limit.tx (${p.limitTx}); use request_funding for larger amounts` };
  }
  return { ok: true };
}

/** A payment x402card refused before it reached the network (so the issuer never saw it). */
export interface BlockedAttempt {
  at: number;
  code: string;
}

export type TxVerdict = { action: "none" } | { action: "freeze"; reason: string };

/**
 * Looks at recent card activity (newest included) and decides whether to
 * freeze. Airwallex already declines a disallowed MCC; repeated attempts or
 * a burst of activity is treated as an anomaly. Attempts blocked by the
 * pre-check count the same as issuer authorizations.
 */
export function evaluateActivity(
  p: CardPolicy,
  recent: IssuingTransaction[],
  now: number = Date.now(),
  cfg: EngineConfig = DEFAULT_CONFIG,
  blocked: BlockedAttempt[] = [],
): TxVerdict {
  if (p.status === "frozen") return { action: "none" };
  const inWindow = recent.filter((t) => {
    const at = t.transaction_date ? Date.parse(t.transaction_date) : now;
    return now - at <= cfg.windowMs && t.transaction_type === "AUTHORIZATION";
  });
  const blockedInWindow = blocked.filter((b) => now - b.at <= cfg.windowMs);

  const strikes =
    inWindow.filter((t) => isMccViolation(p, t)).length +
    blockedInWindow.filter((b) => b.code === "MERCHANT_CATEGORY_NOT_ALLOWED").length;
  if (strikes >= cfg.mccStrikesToFreeze) {
    return { action: "freeze", reason: `${strikes} disallowed merchant-category attempts` };
  }
  const attempts = inWindow.length + blockedInWindow.length;
  if (attempts > cfg.velocityMax) {
    return { action: "freeze", reason: `${attempts} payment attempts in ${cfg.windowMs / 60000} min` };
  }
  return { action: "none" };
}

export function isMccViolation(p: CardPolicy, t: IssuingTransaction): boolean {
  if (t.failure_reason === "MERCHANT_CATEGORY_NOT_ALLOWED") return true;
  const mcc = t.merchant?.category_code;
  return p.mccAllow.length > 0 && !!mcc && !p.mccAllow.includes(mcc);
}
