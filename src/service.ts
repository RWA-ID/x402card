// Card operations behind the MCP tools and the approval endpoints. Agents get
// policy, status and transactions back; never card numbers or Airwallex IDs.
import { getAddress, isAddress } from "viem";
import { AirwallexClient, AirwallexError } from "./airwallex/client.ts";
import { AirwallexSandboxSimulator } from "./airwallex/simulator.ts";
import * as issuing from "./airwallex/issuing.ts";
import type { AuthorizationControls, IssuingTransaction } from "./airwallex/issuing.ts";
import { LEGACY_PARENT, PARENT_NAMES, RESERVED_KEYS, RESERVED_LABELS, cardKeyOf, nameOfKey } from "./ens/gateway.ts";
import { DEFAULT_CONFIG, type EngineConfig, decideFunding, evaluateActivity, precheckPayment, roundMajor, toAuthorizationControls } from "./policy/engine.ts";
import { newPendingApproval, signApproval, verifyApproval, type HeldPayment, type PendingApproval } from "./policy/approvals.ts";
import { approvalTypedData, isSignableApprover, type ApprovalTypedData, type ApproverAuth } from "./policy/approver.ts";
import { decidePayee, toOrigin, type PayeeCheck, type PayeeChecker } from "./policy/payee.ts";
import type { TapSigner, TapTag } from "./tap/sign.ts";
import { type CardPolicy, PolicyError, type TextRecords, isEmail, maskEmail, parseRecords, toRecords } from "./policy/records.ts";
import { describeChanges, planChanges, type PolicyChange, type PolicyInput } from "./policy/changes.ts";
import type { Org, Store } from "./store.ts";

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

/** An org's caps unless it sets its own. */
export const ORG_DEFAULT_CAPS = { tx: 500, daily: 2000, monthly: 5000, cards: 50 } as const;

/** Self-serve test cards: what any signed-in wallet may issue itself. */
export const TEST_CARDS = { tx: 50, daily: 200, monthly: 500, perWallet: 3 } as const;

/** Demo accounts (email sign-in): cards a tester issues on the console, named by them, under xcard.eth. */
export const DEMO_CARDS = { tx: 500, daily: 2000, monthly: 5000, perAccount: 5, parent: "xcard.eth" } as const;

/** Approval emails to one approver address an hour; the rest wait on the console. */
const APPROVAL_MAILS_PER_HOUR = 10;

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
  pending_approvals: { id: string; kind: "funding" | "payment" | "policy"; amount: number; currency: string; reason: string; merchant?: string }[];
  /** On a demo account's own list: this account issued the card (it may also just approve others'). */
  issued_by_me?: boolean;
  /** On an operator's list: the company it belongs to. */
  org?: string;
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

/**
 * applied = took effect now (only tightening, or the operator asked).
 * pending_human = loosens the policy, so nothing changes until card.approver signs.
 */
export type PolicyResult =
  | { decision: "applied"; changes: string; card: CardView }
  | { decision: "unchanged"; reason: string }
  | { decision: "pending_human"; reason: string; changes: string; approval_id: string; approver: string; approval_url?: string };

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
  /** Visa TAP signing key (tap/sign.ts). Without it sign_request is unavailable. */
  tap?: () => Promise<TapSigner>;
  /** Where merchants fetch the TAP public key, e.g. https://…/keys. */
  tapKeysUrl?: string;
  /** Resolves card.approver and checks its wallet signature (policy/approver.ts). Without it only the admin token decides. */
  approverAuth?: ApproverAuth;
  /** Tells an email approver a request is waiting (auth/mail.ts). Best effort: a failed send never fails the request. */
  notify?: (a: PendingApproval, card: { name: string; last4?: string; approvalUrl?: string }) => Promise<void>;
}

/** An approval as the approver sees it, with the typed data to sign either way. */
export interface ApprovalView {
  approval: PendingApproval;
  card: string;
  /** card.approver is an ENS name or an address, so a wallet signature can decide it. */
  signable: boolean;
  /** card.approver is an email: they decide signed in with a code sent to it. approval.approver is masked. */
  email_approver: boolean;
  /** The address card.approver resolves to now; the one signature that counts. */
  approver_address?: string;
  approval_url?: string;
  typed_data?: { approve: ApprovalTypedData; deny: ApprovalTypedData };
}

export interface SignedRequest {
  url: string;
  tag: TapTag;
  /** Send these two headers on the request to url, unchanged. */
  headers: { "Signature-Input": string; Signature: string };
  keyid: string;
  expires_at: string;
  keys_url?: string;
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

  /**
   * A wallet issues itself a test card over the connector: the next free
   * testN.xcard.eth, within TEST_CARDS' caps, approved by that wallet unless
   * the records name another approver (an email, wallet or ENS name).
   */
  async issueTestCard(address: string, records: TextRecords): Promise<CardView> {
    if (!isAddress(address)) throw new ServiceError("bad_input", "not a wallet address");
    const me = getAddress(address);
    const refs = await Promise.all((await this.store.walletIndex(me)).map((l) => this.store.getCard(l)));
    if (refs.filter((r) => r?.issuedBy === me).length >= TEST_CARDS.perWallet) {
      throw new ServiceError("limit_reached", `a wallet can issue itself ${TEST_CARDS.perWallet} test cards`);
    }
    let policy: CardPolicy;
    try {
      policy = parseRecords({ "card.currencies": "USD", "card.payee": "verified-or-escalate", ...records, "card.approver": records["card.approver"]?.trim() || me, "card.status": "active" });
    } catch (e) {
      if (e instanceof PolicyError) throw new ServiceError("bad_policy", e.message);
      throw e;
    }
    const over = [
      policy.limitTx > TEST_CARDS.tx && `per transaction max ${TEST_CARDS.tx}`,
      (policy.limitDaily ?? Infinity) > TEST_CARDS.daily && `daily max ${TEST_CARDS.daily}`,
      policy.limitMonthly > TEST_CARDS.monthly && `monthly max ${TEST_CARDS.monthly}`,
      policy.currencies.join(",") !== "USD" && "USD only",
    ].filter(Boolean);
    if (over.length) throw new ServiceError("over_test_caps", `test cards: ${over.join(", ")}`);

    for (let tries = 0; tries < 20; tries++) {
      const label = `test${await this.store.nextTestNumber()}.xcard.eth`;
      if (await this.store.getCard(label)) continue;
      return this.issueCard(label, toRecords(policy), { issuedBy: me });
    }
    throw new ServiceError("busy", "couldn't find a free test name; try again");
  }

  /**
   * A demo account (signed in by email) issues a card on the console: a name
   * they pick under xcard.eth, any approver (their own email by default, a
   * colleague's email, a wallet or an ENS name), within DEMO_CARDS' caps.
   */
  async issueAccountCard(email: string, name: string, records: TextRecords): Promise<CardView> {
    const me = email.toLowerCase();
    const refs = await Promise.all((await this.store.accountIndex(me)).map((l) => this.store.getCard(l)));
    if (refs.filter((r) => r?.issuedBy === me).length >= DEMO_CARDS.perAccount) {
      throw new ServiceError("limit_reached", `a demo account can issue ${DEMO_CARDS.perAccount} cards`);
    }
    return this.issueCapped(me, name, records, DEMO_CARDS, "demo");
  }

  /** An org's operator issues a card for the company, within the org's caps. */
  async issueOrgCard(email: string, org: Org, name: string, records: TextRecords): Promise<CardView> {
    if ((await this.store.orgIndex(org.slug)).length >= org.caps.cards) {
      throw new ServiceError("limit_reached", `${org.name} can issue ${org.caps.cards} cards`);
    }
    return this.issueCapped(email.toLowerCase(), name, records, org.caps, "org", org.slug);
  }

  private async issueCapped(me: string, name: string, records: TextRecords, caps: { tx: number; daily: number; monthly: number }, kind: "demo" | "org", org?: string): Promise<CardView> {
    const full = name.trim().toLowerCase();
    const label = full.endsWith(`.${DEMO_CARDS.parent}`) ? full : `${full}.${DEMO_CARDS.parent}`;
    if (label.split(".").length !== 3) throw new ServiceError("bad_name", `pick one word for the name, e.g. maria.${DEMO_CARDS.parent}`);
    let policy: CardPolicy;
    try {
      policy = parseRecords({ "card.currencies": "USD", "card.payee": "verified-or-escalate", "card.approver": me, ...records, "card.status": "active" });
    } catch (e) {
      if (e instanceof PolicyError) throw new ServiceError("bad_policy", e.message);
      throw e;
    }
    // No daily limit asked for: the most allowed, never above the monthly one.
    policy.limitDaily ??= Math.min(policy.limitMonthly, caps.daily);
    const over = [
      policy.limitTx > caps.tx && `per transaction max ${caps.tx}`,
      (policy.limitDaily ?? Infinity) > caps.daily && `daily max ${caps.daily}`,
      policy.limitMonthly > caps.monthly && `monthly max ${caps.monthly}`,
      policy.currencies.join(",") !== "USD" && "USD only",
    ].filter(Boolean);
    if (over.length) throw new ServiceError(`over_${kind}_caps`, `${kind} cards: ${over.join(", ")}`);
    return this.issueCard(label, toRecords(policy), { issuedBy: me, ...(org ? { org } : {}) });
  }

  /** The cards an email account issued or approves, and its org's if it's an operator, as they are now. */
  async accountCards(email: string): Promise<CardView[]> {
    const me = email.toLowerCase();
    const out: CardView[] = [];
    const org = await this.store.orgOf(me);
    const labels = new Set([...(await this.store.accountIndex(me)), ...(org ? await this.store.orgIndex(org.slug) : [])]);
    for (const label of labels) {
      const [ref, rec] = await Promise.all([this.store.getCard(label), this.store.getRecords(label)]);
      const inOrg = !!org && ref?.org === org.slug;
      if (!ref || !rec || (ref.issuedBy !== me && rec["card.approver"] !== me && !inOrg)) continue;
      out.push({ ...(await this.getCard(label)), ...(ref.issuedBy === me ? { issued_by_me: true } : {}), ...(inOrg ? { org: org.slug } : {}) });
    }
    return out;
  }

  async issueCard(name: string, records: TextRecords, opts: { issuedBy?: string; org?: string } = {}): Promise<CardView> {
    const label = normalizeLabel(name);
    if (RESERVED_LABELS.has(labelOfKey(label)) || RESERVED_KEYS.has(label)) throw new ServiceError("reserved", `${fullName(label)} is reserved`);
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

    await this.store.putCard(label, {
      cardholderId: holder.cardholderId, cardId: card.cardId, last4: card.last4, createdAt: Date.now(),
      ...(opts.issuedBy ? { issuedBy: opts.issuedBy } : {}),
      ...(opts.org ? { org: opts.org } : {}),
    });
    await this.store.putRecords(label, toRecords(policy));
    await this.store.clearRequestId("issue", label);
    // An approver that's a plain address gets the card in its wallet index right away.
    if (isAddress(policy.approver)) await this.store.addToWalletIndex(policy.approver, label);
    // Likewise an email approver's account, and the account that issued it.
    if (isEmail(policy.approver)) await this.store.addToAccountIndex(policy.approver, label);
    if (opts.issuedBy && isEmail(opts.issuedBy)) await this.store.addToAccountIndex(opts.issuedBy, label);
    if (opts.issuedBy && isAddress(opts.issuedBy)) await this.store.addToWalletIndex(opts.issuedBy, label);
    if (opts.org) await this.store.addToOrgIndex(opts.org, label);
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
        ...(a.policy ? { changes: describeChanges(a.policy.changes) } : {}),
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
    await this.escalate(pending);
    await this.store.addEvent(label, { at: Date.now(), kind: "escalated", detail: pending.reason, amount, currency: cur });
    return {
      decision: "pending_human",
      reason: d.reason,
      approval_id: pending.id,
      approver: policy.approver,
      ...this.approvalLink(pending.id),
    };
  }

  /**
   * Change the card's limits, merchant categories or payee rules. Tightening
   * applies at once; if any change loosens the policy, the whole change waits
   * for card.approver (direct = the operator, who applies it either way).
   */
  async updatePolicy(name: string, input: PolicyInput, opts: { direct?: boolean; purpose?: string } = {}): Promise<PolicyResult> {
    const { label, policy } = await this.load(name);
    let plan: ReturnType<typeof planChanges>;
    try {
      plan = planChanges(policy, input);
    } catch (e) {
      if (e instanceof PolicyError) throw new ServiceError("bad_policy", e.message);
      throw e;
    }
    if (!plan.changes.length) return { decision: "unchanged", reason: "the card already has this policy" };
    const changes = describeChanges(plan.changes);

    if (!plan.loosens || opts.direct) {
      await this.applyPolicy(label, plan.next, `${plan.loosens ? "changed" : "tightened"}: ${changes}`);
      return { decision: "applied", changes, card: await this.getCard(label) };
    }

    const why = `loosens the policy (${plan.changes.filter((c) => c.loosens).map((c) => c.key).join(", ")})`;
    const reason = `${why}${opts.purpose ? ` · ${opts.purpose}` : ""}`;
    const pending = { ...newPendingApproval(label, 0, policy.currencies[0], reason, policy.approver), kind: "policy" as const, policy: { changes: plan.changes } };
    await this.escalate(pending);
    await this.store.addEvent(label, { at: Date.now(), kind: "escalated", detail: `policy change · ${changes}` });
    return { decision: "pending_human", reason: why, changes, approval_id: pending.id, approver: policy.approver, ...this.approvalLink(pending.id) };
  }

  /** The approved changes, on top of the policy as it is now; refused if a record moved since the request. */
  private async releasePolicy(a: PendingApproval & { sig: string }, changes: PolicyChange[], decidedBy: string) {
    const { label, policy } = await this.load(a.name);
    const now = toRecords(policy);
    const moved = changes.filter((c) => now[c.key] !== c.from);
    if (moved.length) {
      throw new ServiceError("policy_changed", `${moved.map((c) => c.key).join(", ")} changed since the request; ask again`);
    }
    let next: CardPolicy;
    try {
      next = parseRecords({ ...now, ...Object.fromEntries(changes.map((c) => [c.key, c.to])) });
    } catch (e) {
      if (e instanceof PolicyError) throw new ServiceError("bad_policy", e.message);
      throw e;
    }
    await this.store.putApproval({ ...a, status: "approved" });
    await this.applyPolicy(label, next, `approved by ${decidedBy}: ${describeChanges(changes)}`);
    return { ...a, status: "approved" as const };
  }

  private async applyPolicy(label: string, next: CardPolicy, detail: string) {
    const ref = await this.store.getCard(label);
    if (!ref) throw new ServiceError("not_found", `${fullName(label)} has no card`);
    await this.issuer.updateCard(ref.cardId, { controls: toAuthorizationControls(next) });
    await this.store.putRecords(label, toRecords(next));
    await this.store.addEvent(label, { at: Date.now(), kind: "policy", detail });
  }

  /** Stores a request for card.approver and, for an email approver, emails them. */
  private async escalate(pending: PendingApproval) {
    await this.store.putApproval({ ...pending, sig: await signApproval(this.opts.approvalSecret, pending) });
    if (!this.opts.notify || !isEmail(pending.approver)) return;
    // Anyone signed in can name any email as approver, so the mails to one address are capped.
    if ((await this.store.hit(`apml:${pending.approver}`)) > APPROVAL_MAILS_PER_HOUR) return;
    try {
      const ref = await this.store.getCard(pending.name);
      await this.opts.notify(pending, { name: fullName(pending.name), last4: ref?.last4, approvalUrl: this.approvalLink(pending.id).approval_url });
    } catch (e) {
      // The request stands; the approver can still find it on the console.
      console.error("approval mail", e instanceof Error ? e.message : e);
    }
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
    if (a.kind === "policy" && a.policy) return this.releasePolicy(a, a.policy.changes, decidedBy);

    const { label, policy } = await this.load(a.name);
    if (policy.status === "frozen") throw new ServiceError("frozen", "card is frozen; unfreeze before approving");
    if (!policy.currencies.includes(a.currency)) throw new ServiceError("currency", `${a.currency} no longer allowed`);

    // Mark first so a double click can't apply twice.
    await this.store.putApproval({ ...a, status: "approved" });
    await this.raiseMonthly(label, policy, a.amount);
    await this.store.addEvent(label, { at: Date.now(), kind: "approved", detail: `approved by ${decidedBy}`, amount: a.amount, currency: a.currency });
    return { ...a, status: "approved" };
  }

  /**
   * One approval for its approver. scope = the agent's own card: an agent
   * token sees only its card's approvals.
   */
  async approvalView(approvalId: string, scope?: string | string[]): Promise<ApprovalView> {
    const a = await this.approvalFor(approvalId, scope);
    const { sig: _sig, ...approval } = a;
    const card = fullName(a.name);
    const signable = isSignableApprover(a.approver);
    // The view is public by link, so an email approver shows masked.
    const email_approver = isEmail(a.approver);
    if (email_approver) approval.approver = maskEmail(a.approver);
    // Best effort: the page uses it to pick the right account. decideSigned resolves again.
    const approver_address = signable && a.status === "pending" ? await this.opts.approverAuth?.resolve(a.approver).catch(() => null) : null;
    return {
      approval,
      card,
      signable,
      email_approver,
      ...(approver_address ? { approver_address } : {}),
      ...this.approvalLink(a.id),
      ...(signable ? { typed_data: { approve: approvalTypedData(a, "approve", card), deny: approvalTypedData(a, "deny", card) } } : {}),
    };
  }

  /**
   * A decision signed by card.approver's wallet: the typed data from
   * approvalView, signed by the address the approver's ENS name resolves to
   * (read now, so changing the name's address changes who can approve).
   * The approver is the one recorded when the request was made.
   */
  async decideSigned(approvalId: string, approve: boolean, signature: string, scope?: string) {
    const a = await this.approvalFor(approvalId, scope);
    if (a.status !== "pending") throw new ServiceError("already_decided", `approval already ${a.status}`);
    if (!/^0x[0-9a-fA-F]{130,}$/.test(signature)) throw new ServiceError("bad_signature", "signature must be a 0x-prefixed hex signature");
    const auth = this.opts.approverAuth;
    if (!auth) throw new ServiceError("signing_unavailable", "this deployment can't check approver signatures");
    if (!isSignableApprover(a.approver)) {
      throw new ServiceError("approver_cannot_sign", `card.approver "${a.approver}" is not an ENS name or address, so only the operator console can decide this`);
    }
    let address: Awaited<ReturnType<ApproverAuth["resolve"]>>;
    try {
      address = await auth.resolve(a.approver);
    } catch {
      throw new ServiceError("ens_unavailable", `couldn't read ${a.approver}'s address from ENS; try again`);
    }
    if (!address) throw new ServiceError("approver_cannot_sign", `${a.approver} has no ETH address set, so it can't sign`);
    const td = approvalTypedData(a, approve ? "approve" : "deny", fullName(a.name));
    let ok: boolean;
    try {
      ok = await auth.verify(address, td, signature as `0x${string}`);
    } catch {
      ok = false;
    }
    if (!ok) throw new ServiceError("bad_signature", `not signed by ${a.approver} (${address}) for this exact ${approve ? "approval" : "denial"}`);
    // decide() hands back the stored approval, HMAC included; callers never need it.
    const { sig: _sig, ...decided } = { sig: "", ...(await this.decide(a.id, approve, `${a.approver} (signed)`)) };
    return decided;
  }

  /**
   * A decision by an email approver, signed in with a code sent to that
   * address (auth/email.ts). The session's email must be card.approver as it
   * was when the request was made.
   */
  async decideByEmail(approvalId: string, approve: boolean, email: string) {
    const a = await this.approvalFor(approvalId);
    if (a.status !== "pending") throw new ServiceError("already_decided", `approval already ${a.status}`);
    if (!isEmail(a.approver)) throw new ServiceError("not_email_approver", "this card's approver decides with a wallet signature, not by email");
    if (a.approver !== email.toLowerCase()) throw new ServiceError("not_approver", `you're signed in as ${email}, but this card's approver is ${maskEmail(a.approver)}`);
    const { sig: _sig, ...decided } = { sig: "", ...(await this.decide(a.id, approve, `${maskEmail(a.approver)} (email)`)) };
    return decided;
  }

  private async approvalFor(approvalId: string, scope?: string | string[]) {
    const a = await this.store.getApproval(approvalId);
    // Another card's approval looks the same as a missing one to an agent.
    if (!a || (scope !== undefined && !(Array.isArray(scope) ? scope.includes(a.name) : a.name === scope))) throw new ServiceError("not_found", "no such approval");
    if (a.status === "pending" && Date.now() > a.expiresAt) {
      const expired = { ...a, status: "expired" as const };
      await this.store.putApproval(expired);
      return expired;
    }
    return a;
  }

  /** An approved held payment: re-check the policy as it stands now, then charge. */
  private async releasePayment(a: PendingApproval & { sig: string }, h: HeldPayment, decidedBy: string) {
    const { label, policy, ref } = await this.load(a.name);
    const check = precheckPayment(policy, { amount: a.amount, currency: a.currency, mcc: h.mcc });
    if (!check.ok) throw new ServiceError(check.code.toLowerCase(), `${check.reason}; the payment can't be released`);

    await this.store.putApproval({ ...a, status: "approved" });
    const charge = await this.issuer.simulateCharge(ref.cardId, { amount: a.amount, currency: a.currency, mcc: h.mcc, merchant: h.merchant });
    await this.logCharge(label, charge, `${payeeLabel(h.merchant, h.payeeName, h.payeeStatus)} · MCC ${h.mcc} · approved by ${decidedBy}`, a.amount, a.currency);
    const origin = h.merchantUrl ? toOrigin(h.merchantUrl) : null;
    if (charge.approved && origin) await this.store.allowTapCheckout(label, origin);
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
        if (r.approved && payee.origin) await this.store.allowTapCheckout(label, payee.origin);
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

  /**
   * A Visa TAP signature for the agent's next request to url. browse
   * (agent-browser-auth) works for any site; checkout (agent-payer-auth) only
   * for a merchant this card paid with policy approval in the last 15 minutes,
   * so the payer signature never vouches for a payment xcard didn't approve.
   */
  async signRequest(name: string, url: string, purpose: "browse" | "checkout"): Promise<SignedRequest> {
    const { label, policy } = await this.load(name);
    if (!this.opts.tap) throw new ServiceError("tap_not_configured", "this deployment has no TAP signing key");
    if (policy.status === "frozen") throw new ServiceError("frozen", "card is frozen");
    const origin = toOrigin(url);
    if (!origin) throw new ServiceError("bad_input", "url must be an absolute http(s) URL");
    if (purpose === "checkout" && !(await this.store.tapCheckoutAllowed(label, origin))) {
      throw new ServiceError("no_approved_payment", `no approved payment to ${origin} in the last 15 minutes; call pay with this merchant_url first`);
    }
    const tag: TapTag = purpose === "checkout" ? "agent-payer-auth" : "agent-browser-auth";
    const signer = await this.opts.tap();
    const { expires, ...headers } = await signer.sign(url, tag);
    return {
      url,
      tag,
      headers,
      keyid: signer.keyid,
      expires_at: new Date(expires * 1000).toISOString(),
      ...(this.opts.tapKeysUrl ? { keys_url: this.opts.tapKeysUrl } : {}),
    };
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
    await this.escalate(pending);
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
