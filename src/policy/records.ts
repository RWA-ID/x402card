// ENS text records for <name>.x402card.eth. These are public, so they hold
// policy only: never card number, CVC or card ID.

export const RECORD_KEYS = [
  "card.limit.tx",
  "card.limit.monthly",
  "card.currencies",
  "card.mcc.allow",
  "card.status",
  "card.approver",
] as const;

export type RecordKey = (typeof RECORD_KEYS)[number];
export type TextRecords = Partial<Record<RecordKey, string>>;

export interface CardPolicy {
  limitTx: number;
  limitMonthly: number;
  /** First entry is the limit currency. */
  currencies: string[];
  /** Empty = any MCC. */
  mccAllow: string[];
  status: "active" | "frozen";
  /** Who may approve escalations (ENS name or address). */
  approver: string;
}

export class PolicyError extends Error {}

const ISO_CURRENCY = /^[A-Z]{3}$/;
const MCC = /^\d{4}$/;

export function parseRecords(r: TextRecords): CardPolicy {
  const limitTx = positiveNumber(r["card.limit.tx"], "card.limit.tx");
  const limitMonthly = positiveNumber(r["card.limit.monthly"], "card.limit.monthly");
  if (limitTx > limitMonthly) throw new PolicyError("card.limit.tx exceeds card.limit.monthly");

  const currencies = list(r["card.currencies"]).map((c) => c.toUpperCase());
  if (currencies.length === 0) throw new PolicyError("card.currencies is required");
  for (const c of currencies) if (!ISO_CURRENCY.test(c)) throw new PolicyError(`bad currency ${c}`);

  const mccAllow = list(r["card.mcc.allow"]);
  for (const m of mccAllow) if (!MCC.test(m)) throw new PolicyError(`bad MCC ${m}`);

  const status = (r["card.status"] ?? "active").trim();
  if (status !== "active" && status !== "frozen") throw new PolicyError("card.status must be active|frozen");

  const approver = (r["card.approver"] ?? "").trim();
  if (!approver) throw new PolicyError("card.approver is required");

  return { limitTx, limitMonthly, currencies, mccAllow, status, approver };
}

export function toRecords(p: CardPolicy): Required<TextRecords> {
  return {
    "card.limit.tx": String(p.limitTx),
    "card.limit.monthly": String(p.limitMonthly),
    "card.currencies": p.currencies.join(","),
    "card.mcc.allow": p.mccAllow.join(","),
    "card.status": p.status,
    "card.approver": p.approver,
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
