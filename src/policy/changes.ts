// Policy changes an agent may ask for (update_policy). Tightening applies at
// once; anything that loosens the policy waits for card.approver's signature.
// The approver, currencies and status are not changeable here: the approver
// is who guards the rest, and status has freeze / the human unfreeze.
import { PAYEE_MODES, PolicyError, parseRecords, toRecords, type CardPolicy, type RecordKey } from "./records.ts";

export const CHANGEABLE = [
  "card.limit.tx",
  "card.limit.daily",
  "card.limit.monthly",
  "card.mcc.allow",
  "card.payee",
  "card.payee.allow",
] as const satisfies readonly RecordKey[];

export type ChangeableKey = (typeof CHANGEABLE)[number];
export type PolicyInput = Partial<Record<ChangeableKey, string>>;

/** One record's change. from/to are record values; "" = none (daily) or any (lists). */
export interface PolicyChange {
  key: ChangeableKey;
  from: string;
  to: string;
  loosens: boolean;
}

export interface PolicyPlan {
  next: CardPolicy;
  changes: PolicyChange[];
  /** Any change that gives the agent more room. */
  loosens: boolean;
}

/** The policy after `input`, validated as a whole, and what each change does. */
export function planChanges(current: CardPolicy, input: PolicyInput): PolicyPlan {
  for (const k of Object.keys(input)) {
    if (!(CHANGEABLE as readonly string[]).includes(k)) throw new PolicyError(`${k} can't be changed here`);
  }
  const before = toRecords(current);
  const next = parseRecords({ ...before, ...input });
  const after = toRecords(next);
  const changes: PolicyChange[] = [];
  for (const key of CHANGEABLE) {
    if (before[key] === after[key]) continue;
    changes.push({ key, from: before[key], to: after[key], loosens: loosens(key, current, next) });
  }
  return { next, changes, loosens: changes.some((c) => c.loosens) };
}

function loosens(key: ChangeableKey, cur: CardPolicy, next: CardPolicy): boolean {
  switch (key) {
    case "card.limit.tx":
      return next.limitTx > cur.limitTx;
    case "card.limit.monthly":
      return next.limitMonthly > cur.limitMonthly;
    case "card.limit.daily":
      return (next.limitDaily ?? Infinity) > (cur.limitDaily ?? Infinity);
    case "card.mcc.allow":
      return widens(cur.mccAllow, next.mccAllow);
    case "card.payee.allow":
      return widens(cur.payeeAllow, next.payeeAllow);
    case "card.payee":
      return PAYEE_MODES.indexOf(next.payee) < PAYEE_MODES.indexOf(cur.payee);
  }
}

/** An allowlist where empty means anything: does `next` allow something `cur` didn't? */
function widens(cur: string[], next: string[]): boolean {
  if (next.length === 0) return cur.length > 0;
  if (cur.length === 0) return false;
  return next.some((x) => !cur.includes(x));
}

/** "card.limit.tx 50 → 200; card.limit.daily none → 100", as the approver reads (and signs) it. */
export function describeChanges(changes: Pick<PolicyChange, "key" | "from" | "to">[]): string {
  const show = (k: ChangeableKey, v: string) => (v ? v : k === "card.limit.daily" ? "none" : "any");
  return changes.map((c) => `${c.key} ${show(c.key, c.from)} → ${show(c.key, c.to)}`).join("; ");
}
