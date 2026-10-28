// ENS text records for <name>.x402card.eth. These are public, so they hold
// policy only: never card number, CVC or card ID.

export const RECORD_KEYS = [
  "card.limit.tx",
  "card.limit.daily",
  "card.limit.monthly",
  "card.currencies",
  "card.mcc.allow",
  "card.status",
  "card.approver",
  "card.payee",
  "card.payee.allow",
] as const;

export type RecordKey = (typeof RECORD_KEYS)[number];
export type TextRecords = Partial<Record<RecordKey, string>>;

export interface CardPolicy {
  limitTx: number;
  /** Absent = no daily limit (cards issued before it existed). */
  limitDaily?: number;
  limitMonthly: number;
  /** First entry is the limit currency. */
  currencies: string[];
  /** Empty = any MCC. */
  mccAllow: string[];
  status: "active" | "frozen";
  /** Who may approve escalations (ENS name or address). */
  approver: string;
  /**
   * What a payment needs to know about who it pays (see policy/payee.ts).
   * any = check when the agent names a payee, never gate on it.
   */
  payee: PayeeMode;
  /** ENS names this card may pay. Empty = any verified payee. */
  payeeAllow: string[];
}

export const PAYEE_MODES = ["any", "verified-or-escalate", "verified-only"] as const;
export type PayeeMode = (typeof PAYEE_MODES)[number];

export class PolicyError extends Error {}

const ISO_CURRENCY = /^[A-Z]{3}$/;
const MCC = /^\d{4}$/;

export function parseRecords(r: TextRecords): CardPolicy {
  const limitTx = positiveNumber(r["card.limit.tx"], "card.limit.tx");
  const limitMonthly = positiveNumber(r["card.limit.monthly"], "card.limit.monthly");
  if (limitTx > limitMonthly) throw new PolicyError("card.limit.tx exceeds card.limit.monthly");
  const daily = (r["card.limit.daily"] ?? "").trim();
  const limitDaily = daily ? positiveNumber(daily, "card.limit.daily") : undefined;
  if (limitDaily !== undefined) {
    if (limitTx > limitDaily) throw new PolicyError("card.limit.tx exceeds card.limit.daily");
    if (limitDaily > limitMonthly) throw new PolicyError("card.limit.daily exceeds card.limit.monthly");
  }

  const currencies = list(r["card.currencies"]).map((c) => c.toUpperCase());
  if (currencies.length === 0) throw new PolicyError("card.currencies is required");
  for (const c of currencies) if (!ISO_CURRENCY.test(c)) throw new PolicyError(`bad currency ${c}`);

  const mccAllow = list(r["card.mcc.allow"]);
  for (const m of mccAllow) if (!MCC.test(m)) throw new PolicyError(`bad MCC ${m}`);

  const status = (r["card.status"] ?? "active").trim();
  if (status !== "active" && status !== "frozen") throw new PolicyError("card.status must be active|frozen");

  const approver = (r["card.approver"] ?? "").trim();
  if (!approver) throw new PolicyError("card.approver is required");

  // Absent = any, so cards issued before the payee gate keep paying as they did.
  const payee = (r["card.payee"] ?? "").trim() || "any";
  if (!(PAYEE_MODES as readonly string[]).includes(payee)) {
    throw new PolicyError(`card.payee must be ${PAYEE_MODES.join("|")}`);
  }
  const payeeAllow = list(r["card.payee.allow"]).map((n) => n.toLowerCase());
  for (const n of payeeAllow) if (!ENS_NAME.test(n)) throw new PolicyError(`bad payee name ${n}`);
  if (payeeAllow.length > 0 && payee === "any") {
    throw new PolicyError("card.payee.allow needs card.payee verified-only or verified-or-escalate");
  }

  return { limitTx, ...(limitDaily !== undefined ? { limitDaily } : {}), limitMonthly, currencies, mccAllow, status, approver, payee: payee as PayeeMode, payeeAllow };
}

// The verifier only reads .eth names; anything else could never match.
const ENS_NAME = /^[^\s.,]+(\.[^\s.,]+)*\.eth$/;

export function toRecords(p: CardPolicy): Required<TextRecords> {
  return {
    "card.limit.tx": String(p.limitTx),
    "card.limit.daily": p.limitDaily !== undefined ? String(p.limitDaily) : "",
    "card.limit.monthly": String(p.limitMonthly),
    "card.currencies": p.currencies.join(","),
    "card.mcc.allow": p.mccAllow.join(","),
    "card.status": p.status,
    "card.approver": p.approver,
    "card.payee": p.payee,
    "card.payee.allow": p.payeeAllow.join(","),
  };
}

function positiveNumber(v: string | undefined, key: string): number {
  const n = Number(v);
  if (v === undefined || v.trim() === "" || !Number.isFinite(n) || n <= 0) {
    throw new PolicyError(`${key} must be a positive number`);
  }
  return n;
}

function list(v: string | undefined): string[] {
  return (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}
