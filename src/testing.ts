// In-memory fakes for tests: a KVNamespace subset and a fake Airwallex
// issuer that enforces card controls the way Airwallex does.
import type { AuthorizationControls, IssuingTransaction } from "./airwallex/issuing.ts";
import type { ChargeResult, Issuer, SimulatedCharge } from "./service.ts";

export class MemoryKV {
  private m = new Map<string, string>();
  async get(key: string, type?: "json" | "text") {
    const v = this.m.get(key);
    if (v === undefined) return null;
    return type === "json" ? JSON.parse(v) : v;
  }
  async put(key: string, value: string) { this.m.set(key, value); }
  async delete(key: string) { this.m.delete(key); }
  async list({ prefix = "" }: { prefix?: string } = {}) {
    return { keys: [...this.m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
  }
  asKV() { return this as unknown as KVNamespace; }
}

interface FakeCard {
  id: string;
  status: "ACTIVE" | "INACTIVE";
  controls: AuthorizationControls;
  txs: IssuingTransaction[];
}

export class FakeIssuer implements Issuer {
  cards = new Map<string, FakeCard>();
  wallet = 10_000_000;
  createRequestIds: string[] = [];

  async createCardholder(_email: string) { return { cardholderId: crypto.randomUUID() }; }

  async createCard(i: { cardholderId: string; nickName: string; controls: AuthorizationControls; requestId: string }) {
    this.createRequestIds.push(i.requestId);
    const id = crypto.randomUUID();
    this.cards.set(id, { id, status: "ACTIVE", controls: structuredClone(i.controls), txs: [] });
    return { cardId: id, last4: "4021", status: "ACTIVE" };
  }
  async getCardStatus(cardId: string) { return this.card(cardId).status; }
  async updateCard(cardId: string, i: { status?: "ACTIVE" | "INACTIVE"; controls?: Partial<AuthorizationControls> }) {
    const c = this.card(cardId);
    if (i.status) c.status = i.status;
    if (i.controls) c.controls = { ...c.controls, ...structuredClone(i.controls) } as AuthorizationControls;
  }
  async listTransactions(cardId: string) { return [...this.card(cardId).txs].reverse(); }
  async walletAvailable(_currency: string) { return this.wallet; }

  async simulateCharge(cardId: string, c: SimulatedCharge): Promise<ChargeResult> {
    const t = this.charge(cardId, c.amount, c.currency, c.mcc, c.merchant);
    return t.failure_reason ? { approved: false, decline_reason: t.failure_reason } : { approved: true };
  }

  /** Sandbox-style single-phase charge, declined by the card's controls. */
  charge(cardId: string, amount: number, currency: string, mcc: string, merchant = "Merchant"): IssuingTransaction {
    const c = this.card(cardId);
    const perTx = c.controls.transaction_limits.limits.find((l) => l.interval === "PER_TRANSACTION")?.amount ?? Infinity;
    const allowed = c.controls.allowed_merchant_categories ?? [];
    let failure: string | undefined;
    if (c.status !== "ACTIVE") failure = "CARD_INACTIVE";
    else if (allowed.length && !allowed.includes(mcc)) failure = "MERCHANT_CATEGORY_NOT_ALLOWED";
    else if (amount > perTx) failure = "LIMIT_EXCEEDED";
    const base = {
      card_id: cardId, transaction_amount: amount, transaction_currency: currency,
      merchant: { name: merchant, category_code: mcc }, transaction_date: new Date().toISOString(),
    };
    const auth: IssuingTransaction = { ...base, transaction_id: crypto.randomUUID(), transaction_type: "AUTHORIZATION", status: failure ? "FAILED" : "APPROVED", failure_reason: failure };
    c.txs.push(auth);
    if (!failure) c.txs.push({ ...base, transaction_id: crypto.randomUUID(), transaction_type: "CLEARING", status: "APPROVED" });
    if (!failure) this.wallet -= amount;
    return auth;
  }

  private card(id: string) {
    const c = this.cards.get(id);
    if (!c) throw new Error("no such card");
    return c;
  }
}
