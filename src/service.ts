// Card operations behind the MCP tools and the approval endpoints. Agents get
// policy, status and transactions back; never card numbers or Airwallex IDs.
import { AirwallexClient, AirwallexError } from "./airwallex/client.ts";
import * as issuing from "./airwallex/issuing.ts";
import type { AuthorizationControls, IssuingTransaction } from "./airwallex/issuing.ts";
import { PARENT_NAME, RESERVED_LABELS } from "./ens/gateway.ts";
import { DEFAULT_CONFIG, type EngineConfig, decideFunding, evaluateActivity, roundMajor, toAuthorizationControls } from "./policy/engine.ts";
import { newPendingApproval, signApproval, verifyApproval, type PendingApproval } from "./policy/approvals.ts";
import { type CardPolicy, PolicyError, type TextRecords, parseRecords, toRecords } from "./policy/records.ts";
import type { Store } from "./store.ts";

/** The Airwallex surface the service needs; faked in tests. */
export interface Issuer {
  createCardholder(email: string): Promise<{ cardholderId: string }>;
  createCard(input: { cardholderId: string; nickName: string; controls: AuthorizationControls; requestId: string }): Promise<{ cardId: string; last4?: string; status: string }>;
  getCardStatus(cardId: string): Promise<string>;
  updateCard(cardId: string, input: { status?: "ACTIVE" | "INACTIVE"; controls?: Partial<AuthorizationControls> }): Promise<void>;
  listTransactions(cardId: string): Promise<IssuingTransaction[]>;
  walletAvailable(currency: string): Promise<number>;
}

export class AirwallexIssuer implements Issuer {
  private awx: AirwallexClient;
  constructor(awx: AirwallexClient) { this.awx = awx; }

  async createCardholder(email: string) {
    const h = await issuing.createDelegateCardholder(this.awx, email);
    return { cardholderId: h.cardholder_id };
  }
  async createCard(i: { cardholderId: string; nickName: string; controls: AuthorizationControls; requestId: string }) {
    const c = await issuing.createCard(this.awx, { ...i, createdBy: "x402card" });
    return { cardId: c.card_id, last4: c.card_number?.slice(-4), status: c.card_status };
  }
  async getCardStatus(cardId: string) { return (await issuing.getCard(this.awx, cardId)).card_status; }
  async updateCard(cardId: string, i: { status?: "ACTIVE" | "INACTIVE"; controls?: Partial<AuthorizationControls> }) {
    await issuing.updateCard(this.awx, cardId, { card_status: i.status, authorization_controls: i.controls });
  }
  async listTransactions(cardId: string) { return (await issuing.listTransactions(this.awx, cardId)).items; }
  async walletAvailable(currency: string) {
    const b = (await this.awx.getCurrentBalances()).find((x) => x.currency === currency);
    return b?.available_amount ?? 0;
  }
}

export class ServiceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** "researcher" or "researcher.x402card.eth" -> "researcher". */
export function normalizeLabel(name: string): string {
  let n = name.trim().toLowerCase();
  if (n.endsWith("." + PARENT_NAME)) n = n.slice(0, -(PARENT_NAME.length + 1));
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(n)) {
    throw new ServiceError("bad_name", `"${name}" is not a valid name under ${PARENT_NAME}`);
  }
  return n;
}

export const fullName = (label: string) => `${label}.${PARENT_NAME}`;

export interface CardView {
  name: string;
  status: "active" | "frozen";
  last4?: string;
  records: TextRecords;
  pending_approvals: { id: string; amount: number; currency: string; reason: string }[];
}

export interface SafeTransaction {
  type: string;
  status: string;
  settled: boolean;
  amount: number;
  currency: string;
  merchant?: string;
  mcc?: string;
  decline_reason?: string;
  at?: string;
}

export type FundingResult =
  | { decision: "approved"; reason: string; new_monthly_limit: number }
  | { decision: "pending_human"; reason: string; approval_id: string; approver: string }
  | { decision: "denied"; reason: string };

export interface ServiceOptions {
  approvalSecret: string;
  cardholderEmail: string; // base address; +<label>-<ts> is appended
  config?: EngineConfig;
}

export class CardService {
  private store: Store;
  private issuer: Issuer;
  private opts: ServiceOptions;
  private cfg: EngineConfig;

  constructor(store: Store, issuer: Issuer, opts: ServiceOptions) {
    this.store = store;
    this.issuer = issuer;
    this.opts = opts;
    this.cfg = opts.config ?? DEFAULT_CONFIG;
  }

  async issueCard(name: string, records: TextRecords): Promise<CardView> {
    const label = normalizeLabel(name);
    if (RESERVED_LABELS.has(label)) throw new ServiceError("reserved", `${fullName(label)} is reserved`);
    if (await this.store.getCard(label)) throw new ServiceError("exists", `${fullName(label)} already has a card`);

    const policy = parseRecords({ "card.status": "active", ...records });
    const [user, domain] = this.opts.cardholderEmail.split("@");
    const holder = await this.issuer.createCardholder(`${user}+${label}-${Date.now()}@${domain}`);

    // Same request_id on retry, so a retried create can't issue two cards.
    const requestId = await this.store.requestIdFor("issue", label);
    const card = await this.issuer.createCard({
      cardholderId: holder.cardholderId,
      nickName: fullName(label),
      controls: toAuthorizationControls(policy),
      requestId,
    });

    await this.store.putCard(label, { cardholderId: holder.cardholderId, cardId: card.cardId, last4: card.last4, createdAt: Date.now() });
    await this.store.putRecords(label, toRecords(policy));
    await this.store.clearRequestId("issue", label);
    await this.store.addEvent(label, { at: Date.now(), kind: "issued", detail: "card issued" });
    return this.getCard(label);
  }

  async getCard(name: string): Promise<CardView> {
    const { label, policy, ref } = await this.load(name);
    const approvals = (await this.store.listApprovals()).filter((a) => a.name === label && a.status === "pending");
    return {
      name: fullName(label),
      status: policy.status,
      last4: ref.last4,
      records: toRecords(policy),
      pending_approvals: approvals.map((a) => ({ id: a.id, amount: a.amount, currency: a.currency, reason: a.reason })),
    };
  }

  async requestFunding(name: string, amount: number, currency: string, purpose = ""): Promise<FundingResult> {
    const { label, policy } = await this.load(name);
    const cur = currency.toUpperCase();
    const wallet = await this.issuer.walletAvailable(cur);
    const d = decideFunding(policy, { amount, currency: cur }, wallet, this.cfg);

    if (d.decision === "deny") return { decision: "denied", reason: d.reason };

    if (d.decision === "approve") {
      const newLimit = await this.raiseMonthly(label, policy, amount);
      await this.store.addEvent(label, { at: Date.now(), kind: "funded", detail: `auto-approved${purpose ? ` · ${purpose}` : ""}`, amount, currency: cur });
      return { decision: "approved", reason: d.reason, new_monthly_limit: newLimit };
    }

    const pending = newPendingApproval(label, amount, cur, purpose ? `${d.reason} · ${purpose}` : d.reason, policy.approver);
    await this.store.putApproval({ ...pending, sig: await signApproval(this.opts.approvalSecret, pending) });
    await this.store.addEvent(label, { at: Date.now(), kind: "escalated", detail: pending.reason, amount, currency: cur });
    return { decision: "pending_human", reason: d.reason, approval_id: pending.id, approver: policy.approver };
  }

  /** Human decision on an escalated request. Applies exactly the signed name/amount/currency. */
  async decide(approvalId: string, approve: boolean, decidedBy: string): Promise<PendingApproval> {
    const a = await this.store.getApproval(approvalId);
    if (!a) throw new ServiceError("not_found", "no such approval");
    if (a.status !== "pending") throw new ServiceError("already_decided", `approval already ${a.status}`);
    if (Date.now() > a.expiresAt) {
      await this.store.putApproval({ ...a, status: "expired" });
      throw new ServiceError("expired", "approval expired");
    }
    if (!(await verifyApproval(this.opts.approvalSecret, a, a.sig))) {
      throw new ServiceError("tampered", "approval does not match its signature");
    }

    if (!approve) {
      await this.store.putApproval({ ...a, status: "denied" });
      await this.store.addEvent(a.name, { at: Date.now(), kind: "denied", detail: `denied by ${decidedBy}`, amount: a.amount, currency: a.currency });
      return { ...a, status: "denied" };
    }

    const { label, policy } = await this.load(a.name);
    if (policy.status === "frozen") throw new ServiceError("frozen", "card is frozen; unfreeze before approving");
    if (!policy.currencies.includes(a.currency)) throw new ServiceError("currency", `${a.currency} no longer allowed`);

    // Mark first so a double click can't apply twice.
    await this.store.putApproval({ ...a, status: "approved" });
    await this.raiseMonthly(label, policy, a.amount);
    await this.store.addEvent(label, { at: Date.now(), kind: "approved", detail: `approved by ${decidedBy}`, amount: a.amount, currency: a.currency });
    return { ...a, status: "approved" };
  }

  async freeze(name: string, reason: string): Promise<CardView> {
    const { label, policy, ref } = await this.load(name);
    if (policy.status !== "frozen") {
      await this.issuer.updateCard(ref.cardId, { status: "INACTIVE" });
      await this.store.putRecords(label, toRecords({ ...policy, status: "frozen" }));
      await this.store.addEvent(label, { at: Date.now(), kind: "frozen", detail: reason });
    }
    return this.getCard(label);
  }

  async unfreeze(name: string, by: string): Promise<CardView> {
    const { label, policy, ref } = await this.load(name);
    if (policy.status === "frozen") {
      await this.issuer.updateCard(ref.cardId, { status: "ACTIVE" });
      await this.store.putRecords(label, toRecords({ ...policy, status: "active" }));
      await this.store.addEvent(label, { at: Date.now(), kind: "unfrozen", detail: `unfrozen by ${by}` });
    }
    return this.getCard(label);
  }

  async listTransactions(name: string): Promise<SafeTransaction[]> {
    const { ref } = await this.load(name);
    const txs = await this.issuer.listTransactions(ref.cardId);
    return txs.map(toSafe);
  }

  /** Run the anomaly rules for one card and freeze it if they fire. */
  async checkActivity(name: string): Promise<{ frozen: boolean; reason?: string }> {
    const { label, policy, ref } = await this.load(name);
    if (policy.status === "frozen") return { frozen: false };
    const verdict = evaluateActivity(policy, await this.issuer.listTransactions(ref.cardId), Date.now(), this.cfg);
    if (verdict.action !== "freeze") return { frozen: false };
    await this.freeze(label, `anomaly: ${verdict.reason}`);
    return { frozen: true, reason: verdict.reason };
  }

  async checkAll(): Promise<void> {
    for (const label of await this.store.listLabels()) {
      try {
        await this.checkActivity(label);
      } catch (e) {
        console.error(`checkActivity ${label}:`, e instanceof Error ? e.message : e);
      }
    }
  }

  private async raiseMonthly(label: string, policy: CardPolicy, amount: number): Promise<number> {
    const ref = await this.store.getCard(label);
    if (!ref) throw new ServiceError("not_found", `${fullName(label)} has no card`);
    const next = { ...policy, limitMonthly: roundMajor(policy.limitMonthly + amount, policy.currencies[0]) };
    await this.issuer.updateCard(ref.cardId, { controls: toAuthorizationControls(next) });
    await this.store.putRecords(label, toRecords(next));
    return next.limitMonthly;
  }

  private async load(name: string) {
    const label = normalizeLabel(name);
    const [ref, records] = await Promise.all([this.store.getCard(label), this.store.getRecords(label)]);
    if (!ref || !records) throw new ServiceError("not_found", `${fullName(label)} has no card`);
    return { label, ref, policy: parseRecords(records) };
  }
}

function toSafe(t: IssuingTransaction): SafeTransaction {
  return {
    type: t.transaction_type,
    status: t.status,
    settled: issuing.isSettled(t),
    amount: t.transaction_amount,
    currency: t.transaction_currency,
    merchant: t.merchant?.name,
    mcc: t.merchant?.category_code,
    decline_reason: t.failure_reason,
    at: t.transaction_date,
  };
}

/** Turns Airwallex/policy errors into a message an agent can act on. */
export function describeError(e: unknown): { code: string; message: string } {
  if (e instanceof ServiceError) return { code: e.code, message: e.message };
  if (e instanceof AirwallexError) return { code: `airwallex_${e.code ?? e.status}`, message: e.message };
  if (e instanceof PolicyError) return { code: "bad_policy", message: e.message };
  return { code: "internal", message: "internal error" };
}
