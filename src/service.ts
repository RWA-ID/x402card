// Card operations behind the MCP tools and the approval endpoints. Agents get
// policy, status and transactions back; never card numbers or Airwallex IDs.
import { AirwallexClient, AirwallexError } from "./airwallex/client.ts";
import { AirwallexSandboxSimulator } from "./airwallex/simulator.ts";
import * as issuing from "./airwallex/issuing.ts";
import type { AuthorizationControls, IssuingTransaction } from "./airwallex/issuing.ts";
import { LEGACY_PARENT, PARENT_NAMES, RESERVED_LABELS, cardKeyOf, nameOfKey } from "./ens/gateway.ts";
import { DEFAULT_CONFIG, type EngineConfig, decideFunding, evaluateActivity, precheckPayment, roundMajor, toAuthorizationControls } from "./policy/engine.ts";
import { newPendingApproval, signApproval, verifyApproval, type HeldPayment, type PendingApproval } from "./policy/approvals.ts";
import { decidePayee, toOrigin, type PayeeCheck, type PayeeChecker } from "./policy/payee.ts";
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
  /**
   * A merchant charge (authorize + clear in one step). On the sandbox this is
   * Airwallex's simulation endpoint; a production adapter hands the merchant a
   * network token or a vaulted card number here, never the agent.
   */
  simulateCharge(cardId: string, c: SimulatedCharge): Promise<ChargeResult>;
}

export interface SimulatedCharge {
  amount: number;
  currency: string;
  mcc: string;
  merchant?: string;
}

export interface ChargeResult {
  approved: boolean;
  decline_reason?: string;
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
  async simulateCharge(cardId: string, c: SimulatedCharge): Promise<ChargeResult> {
    try {
      const ev = await new AirwallexSandboxSimulator(this.awx).charge({ cardId, ...c });
      return ev.process_result === "DECLINED" || ev.failure_reason
        ? { approved: false, decline_reason: ev.failure_reason ?? "DECLINED" }
        : { approved: true };
    } catch (e) {
      // Some sandbox declines come back as 4xx instead of a DECLINED event.
      if (e instanceof AirwallexError && e.status < 500) return { approved: false, decline_reason: e.code ?? "DECLINED" };
      throw e;
    }
  }
}

export class ServiceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Any accepted card name -> its storage key (see cardKeyOf). A bare label
 * means x402card.eth, as it did before xcard.eth was added:
 * "researcher" / "researcher.x402card.eth" -> "researcher";
 * "researcher.xcard.eth" -> "researcher.xcard.eth".
 */
export function normalizeLabel(name: string): string {
  const n = name.trim().toLowerCase();
  const full = n.includes(".") ? n : `${n}.${LEGACY_PARENT}`;
  const key = cardKeyOf(full);
  const label = full.slice(0, full.indexOf("."));
  if (!key || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
    throw new ServiceError("bad_name", `"${name}" is not a valid name under ${PARENT_NAMES.join(" or ")}`);
  }
  return key;
}

/** First label of a card key: "researcher.xcard.eth" -> "researcher". */
export const labelOfKey = (key: string) => key.split(".")[0];

export const fullName = nameOfKey;

export interface CardView {
  name: string;
  status: "active" | "frozen";
  last4?: string;
  records: TextRecords;
  pending_approvals: { id: string; kind: "funding" | "payment"; amount: number; currency: string; reason: string; merchant?: string }[];
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

export interface PaymentInput {
  amount: number;
  currency: string;
  mcc: string;
  merchant: string;
  purpose?: string;
  /** The checkout's URL: the origin the payee gate checks against payeeName. */
  merchantUrl?: string;
  /** The ENS name the agent believes it is paying, e.g. modelhub.eth. */
  payeeName?: string;
  /** Same id on retry replays the first result instead of charging again. */
  requestId?: string;
}

/**
 * blocked  = refused by x402card's pre-check; nothing reached the card network.
 * declined = passed the pre-check, refused by the issuer at authorization.
 * pending_human = the payee gate held it for card.approver; approving it makes the charge.
 */
export type PaymentResult = (
  | { decision: "approved"; amount: number; currency: string; merchant: string }
  | { decision: "blocked"; stage: "x402card"; code: string; reason: string }
  | { decision: "declined"; stage: "issuer"; code: string }
  | { decision: "pending_human"; reason: string; approval_id: string; approver: string; approval_url?: string }
) & { payee?: PayeeCheck; card_frozen?: string; replayed?: boolean };

export type FundingResult =
  | { decision: "approved"; reason: string; new_monthly_limit: number }
  | { decision: "pending_human"; reason: string; approval_id: string; approver: string; approval_url?: string }
  | { decision: "denied"; reason: string };

export interface ServiceOptions {
  approvalSecret: string;
  cardholderEmail: string; // base address; +<label>-<ts> is appended
  /** Approval page link; "{id}" is replaced with the approval id. */
  approvalUrl?: string;
  config?: EngineConfig;
  /** Reads a payee's ENS records (policy/payee.ts). Without it every named payee is unverified. */
  checkPayee?: PayeeChecker;
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
    if (RESERVED_LABELS.has(labelOfKey(label))) throw new ServiceError("reserved", `${fullName(label)} is reserved`);
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
      pending_approvals: approvals.map((a) => ({
        id: a.id,
        kind: a.kind ?? "funding",
        amount: a.amount,
        currency: a.currency,
        reason: a.reason,
        ...(a.payment ? { merchant: a.payment.merchant } : {}),
      })),
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
    return {
      decision: "pending_human",
      reason: d.reason,
      approval_id: pending.id,
      approver: policy.approver,
      ...this.approvalLink(pending.id),
    };
  }

  private approvalLink(id: string): { approval_url?: string } {
    return this.opts.approvalUrl ? { approval_url: this.opts.approvalUrl.replace("{id}", id) } : {};
  }

  /**
   * Human decision on an escalated request. Applies exactly the signed
   * name/amount/currency: funding raises the allowance, a held payment is charged.
   */
  async decide(approvalId: string, approve: boolean, decidedBy: string): Promise<PendingApproval & { charge?: ChargeResult }> {
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
      if (a.payment?.requestId) {
        await this.store.putPayment(a.name, a.payment.requestId, { decision: "blocked", stage: "x402card", code: "DENIED_BY_APPROVER", reason: `denied by ${decidedBy}` });
      }
      return { ...a, status: "denied" };
    }

    if (a.kind === "payment" && a.payment) return this.releasePayment(a, a.payment, decidedBy);

    const { label, policy } = await this.load(a.name);
    if (policy.status === "frozen") throw new ServiceError("frozen", "card is frozen; unfreeze before approving");
    if (!policy.currencies.includes(a.currency)) throw new ServiceError("currency", `${a.currency} no longer allowed`);

    // Mark first so a double click can't apply twice.
    await this.store.putApproval({ ...a, status: "approved" });
    await this.raiseMonthly(label, policy, a.amount);
    await this.store.addEvent(label, { at: Date.now(), kind: "approved", detail: `approved by ${decidedBy}`, amount: a.amount, currency: a.currency });
    return { ...a, status: "approved" };
  }

  /** An approved held payment: re-check the policy as it stands now, then charge. */
  private async releasePayment(a: PendingApproval & { sig: string }, h: HeldPayment, decidedBy: string) {
    const { label, policy, ref } = await this.load(a.name);
    const check = precheckPayment(policy, { amount: a.amount, currency: a.currency, mcc: h.mcc });
    if (!check.ok) throw new ServiceError(check.code.toLowerCase(), `${check.reason}; the payment can't be released`);

    await this.store.putApproval({ ...a, status: "approved" });
    const charge = await this.issuer.simulateCharge(ref.cardId, { amount: a.amount, currency: a.currency, mcc: h.mcc, merchant: h.merchant });
    await this.logCharge(label, charge, `${payeeLabel(h.merchant, h.payeeName, h.payeeStatus)} · MCC ${h.mcc} · approved by ${decidedBy}`, a.amount, a.currency);
    if (h.requestId) {
      const result: PaymentResult = charge.approved
        ? { decision: "approved", amount: a.amount, currency: a.currency, merchant: h.merchant }
        : { decision: "declined", stage: "issuer", code: charge.decline_reason ?? "DECLINED" };
      await this.store.putPayment(label, h.requestId, result);
    }
    return { ...a, status: "approved" as const, charge };
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

  /**
   * The agent's payment path: pre-check against the ENS policy, then the payee
   * gate (is this checkout really the name the agent means to pay?), then hand
   * the charge to the issuer, which enforces the same controls again. A
   * refusal at any layer runs the anomaly rules right away.
   */
  async pay(name: string, p: PaymentInput): Promise<PaymentResult> {
    const { label, policy, ref } = await this.load(name);
    if (p.requestId) {
      const prior = await this.store.getPayment<PaymentResult>(label, p.requestId);
      if (prior) return { ...prior, replayed: true };
    }
    const currency = p.currency.toUpperCase();
    const block = async (code: string, reason: string, detail: string, payee?: PayeeCheck): Promise<PaymentResult> => {
      await this.store.addEvent(label, { at: Date.now(), kind: "blocked", detail: `${detail} · ${code}`, amount: p.amount, currency, code });
      return { decision: "blocked", stage: "x402card", code, reason, ...(payee ? { payee } : {}) };
    };

    let result: PaymentResult;
    const check = precheckPayment(policy, { amount: p.amount, currency, mcc: p.mcc });
    if (!check.ok) {
      result = await block(check.code, check.reason, describePayment(p.merchant, p));
    } else {
      const payee = await this.checkPayee(p);
      const detail = describePayment(payeeLabel(p.merchant, payee.name, payee.status), p);
      const gate = decidePayee(policy, payee);
      if (gate.action === "block") {
        result = await block(gate.code, gate.reason, detail, payee);
      } else if (gate.action === "escalate") {
        result = { ...(await this.holdPayment(label, policy.approver, p, currency, payee, gate.reason)), payee };
      } else {
        const r = await this.issuer.simulateCharge(ref.cardId, { amount: p.amount, currency, mcc: p.mcc, merchant: p.merchant });
        await this.logCharge(label, r, detail, p.amount, currency);
        result = r.approved
          ? { decision: "approved", amount: p.amount, currency, merchant: p.merchant, payee }
          : { decision: "declined", stage: "issuer", code: r.decline_reason ?? "DECLINED", payee };
      }
    }

    // A frozen card is refused anyway; don't count those toward a new freeze.
    if ((result.decision === "blocked" || result.decision === "declined") && policy.status !== "frozen") {
      const v = await this.checkActivity(label);
      if (v.frozen) result.card_frozen = v.reason;
    }
    if (p.requestId) await this.store.putPayment(label, p.requestId, result);
    return result;
  }

  /** Who the payment is to, as far as the agent's inputs and the chain can say. */
  private async checkPayee(p: PaymentInput): Promise<PayeeCheck> {
    const origin = p.merchantUrl ? toOrigin(p.merchantUrl) : null;
    if (p.merchantUrl && !origin) throw new ServiceError("bad_input", "merchant_url must be an absolute http(s) URL");
    const name = p.payeeName?.trim();
    if (!name || !origin) {
      return { status: "unverified", ...(name ? { name } : {}), ...(origin ? { origin } : {}), reason: name ? "no-merchant-url" : "no-payee-name" };
    }
    if (!this.opts.checkPayee) return { status: "unverified", name, origin, reason: "no-ens-reader" };
    return this.opts.checkPayee(name, origin);
  }

  private async holdPayment(label: string, approver: string, p: PaymentInput, currency: string, payee: PayeeCheck, why: string) {
    const held: HeldPayment = {
      mcc: p.mcc,
      merchant: p.merchant,
      payeeStatus: payee.status,
      ...(p.merchantUrl ? { merchantUrl: p.merchantUrl } : {}),
      ...(payee.name ? { payeeName: payee.name } : {}),
      ...(p.purpose ? { purpose: p.purpose } : {}),
      ...(p.requestId ? { requestId: p.requestId } : {}),
    };
    const reason = `${why} · pay ${p.merchant}${p.purpose ? ` · ${p.purpose}` : ""}`;
    const pending = newPendingApproval(label, p.amount, currency, reason, approver, Date.now(), held);
    await this.store.putApproval({ ...pending, sig: await signApproval(this.opts.approvalSecret, pending) });
    await this.store.addEvent(label, { at: Date.now(), kind: "escalated", detail: reason, amount: p.amount, currency });
    return { decision: "pending_human" as const, reason: why, approval_id: pending.id, approver, ...this.approvalLink(pending.id) };
  }

  /** Sandbox demo: a merchant charges the card directly (no x402card pre-check), logged for the feed. */
  async simulateCharge(name: string, c: SimulatedCharge): Promise<ChargeResult> {
    const { label, ref } = await this.load(name);
    if (!(c.amount > 0) || !/^\d{4}$/.test(c.mcc)) throw new ServiceError("bad_input", "amount > 0 and a 4-digit mcc are required");
    const currency = c.currency.toUpperCase();
    const r = await this.issuer.simulateCharge(ref.cardId, { ...c, currency });
    await this.logCharge(label, r, `${c.merchant ?? "Merchant"} · MCC ${c.mcc}`, c.amount, currency);
    return r;
  }

  private logCharge(label: string, r: ChargeResult, detail: string, amount: number, currency: string) {
    return this.store.addEvent(label, r.approved
      ? { at: Date.now(), kind: "charged", detail, amount, currency }
      : { at: Date.now(), kind: "declined", detail: `${detail} · ${r.decline_reason}`, amount, currency, code: r.decline_reason });
  }

  /** Run the anomaly rules for one card and freeze it if they fire. */
  async checkActivity(name: string): Promise<{ frozen: boolean; reason?: string }> {
    const { label, policy, ref } = await this.load(name);
    if (policy.status === "frozen") return { frozen: false };
    const events = await this.store.getEvents(label);
    // A human unfreeze starts a clean window; otherwise the strikes that froze
    // the card would freeze it again on the next check.
    const since = events.find((e) => e.kind === "unfrozen")?.at ?? 0;
    const blocked = events
      .filter((e) => e.kind === "blocked" && e.code && e.code !== "CARD_FROZEN" && e.at > since)
      .map((e) => ({ at: e.at, code: e.code! }));
    const txs = (await this.issuer.listTransactions(ref.cardId))
      .filter((t) => !t.transaction_date || Date.parse(t.transaction_date) > since);
    const verdict = evaluateActivity(policy, txs, Date.now(), this.cfg, blocked);
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

function describePayment(who: string, p: PaymentInput): string {
  return `${who} · MCC ${p.mcc}${p.purpose ? ` · ${p.purpose}` : ""}`;
}

/** "ModelHub API (modelhub.eth ✓)" once the payee gate has verified the name. */
function payeeLabel(merchant: string, name: string | undefined, status: string): string {
  return name && status === "verified" ? `${merchant} (${name} ✓)` : merchant;
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
