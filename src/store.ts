// KV layout. Public records and private Airwallex IDs live under separate
// prefixes; only rec:* is ever served by the gateway.
// <label> is the card key: the bare label for x402card.eth, the full name for
// xcard.eth (see cardKeyOf in ens/gateway.ts).
//   rec:<label>       public ENS text records (TextRecords JSON)
//   card:<label>      private { cardholderId, cardId, last4, ... }
//   op:<kind>:<key>   request_id reserved for an in-flight write (reused on retry)
//   appr:<id>         funding approvals
//   tok:<sha256>      agent token -> label it may act for
//   evt:<label>       recent policy events (escalations, freezes) for the feed
//   pay:<label>:<id>  result of a pay call, replayed when the agent retries with the same request_id (24h)
//   tapok:<label>:<origin>  a payment to this merchant was approved, so a TAP checkout signature may be issued (15 min)
//   tapn:<nonce>      TAP nonce seen by the demo merchant (8 min)
//   authz:<handle>    an MCP client sign-in in progress on /authorize (10 min; see oauth/authorize.ts)
//   awx:token         cached Airwallex token (see airwallex/client.ts)
//   otp:<sha256(email)>      a sign-in code in flight: { hash, tries } (10 min; see auth/email.ts)
//   otprl:<sha256(email)>    sign-in codes sent to this email this hour (rate limit)
//   otpip:<ip>               sign-in codes requested from this IP this hour
//   sess:<sha256>            email session token -> { email, createdAt } (7 days)
//   acct:<email>             cards an email account issued or approves, by key (like wallet:)
//   org:<slug>               a company: { slug, name, operators, caps }
//   orgm:<email>             the org this email operates
//   orgc:<slug>              the org's cards, by key
import type { TextRecords } from "./policy/records.ts";
import type { PendingApproval } from "./policy/approvals.ts";
import type { RecordSource } from "./ens/gateway.ts";

export interface CardRef {
  cardholderId: string;
  cardId: string;
  last4?: string;
  createdAt: number;
  /** Who issued it for themselves: a wallet (connector test cards) or an email (demo accounts); absent = the operator. */
  issuedBy?: string;
  /** The company it belongs to; that org's operators manage it. */
  org?: string;
}

/** A company. Operators issue and manage its cards; approvals stay with each card's card.approver. */
export interface Org {
  slug: string;
  name: string;
  /** Lowercase emails. */
  operators: string[];
  caps: { tx: number; daily: number; monthly: number; cards: number };
  createdAt: number;
}

export interface CardEvent {
  at: number;
  /** "blocked" = refused by x402card's pre-check; "declined" = refused by the issuer. */
  kind: "issued" | "charged" | "blocked" | "declined" | "funded" | "escalated" | "approved" | "denied" | "frozen" | "unfrozen" | "policy";
  detail: string;
  amount?: number;
  currency?: string;
  /** Decline/block code, e.g. MERCHANT_CATEGORY_NOT_ALLOWED. */
  code?: string;
}

const MAX_EVENTS = 50;

export class Store implements RecordSource {
  private kv: KVNamespace;
  constructor(kv: KVNamespace) { this.kv = kv; }

  getRecords(label: string) { return this.kv.get<TextRecords>(`rec:${label}`, "json"); }
  putRecords(label: string, r: TextRecords) { return this.kv.put(`rec:${label}`, JSON.stringify(r)); }

  getCard(label: string) { return this.kv.get<CardRef>(`card:${label}`, "json"); }
  putCard(label: string, c: CardRef) { return this.kv.put(`card:${label}`, JSON.stringify(c)); }

  /**
   * Cards issued to a wallet, by key (lowercase address). A direct get, so a
   * card shows up at once; list() can lag new keys by about a minute.
   */
  async walletIndex(address: string): Promise<string[]> {
    return (await this.kv.get<string[]>(`wallet:${address.toLowerCase()}`, "json")) ?? [];
  }
  async addToWalletIndex(address: string, label: string): Promise<void> {
    const have = await this.walletIndex(address);
    if (!have.includes(label)) await this.kv.put(`wallet:${address.toLowerCase()}`, JSON.stringify([...have, label]));
  }

  /** Cards an email account issued or approves, by key. Direct get, like walletIndex. */
  async accountIndex(email: string): Promise<string[]> {
    return (await this.kv.get<string[]>(`acct:${email.toLowerCase()}`, "json")) ?? [];
  }
  async addToAccountIndex(email: string, label: string): Promise<void> {
    const have = await this.accountIndex(email);
    if (!have.includes(label)) await this.kv.put(`acct:${email.toLowerCase()}`, JSON.stringify([...have, label]));
  }

  getOrg(slug: string) { return this.kv.get<Org>(`org:${slug}`, "json"); }
  /** Writes the org and moves its operators' memberships to match. */
  async putOrg(org: Org, removed: string[] = []) {
    await this.kv.put(`org:${org.slug}`, JSON.stringify(org));
    await Promise.all(org.operators.map((e) => this.kv.put(`orgm:${e}`, org.slug)));
    await Promise.all(removed.map((e) => this.kv.delete(`orgm:${e}`)));
  }
  /** The org this email operates, if it's still listed there. */
  async orgOf(email: string): Promise<Org | null> {
    const me = email.toLowerCase();
    const slug = await this.kv.get(`orgm:${me}`);
    const org = slug ? await this.getOrg(slug) : null;
    return org?.operators.includes(me) ? org : null;
  }
  async orgIndex(slug: string): Promise<string[]> {
    return (await this.kv.get<string[]>(`orgc:${slug}`, "json")) ?? [];
  }
  async addToOrgIndex(slug: string, label: string): Promise<void> {
    const have = await this.orgIndex(slug);
    if (!have.includes(label)) await this.kv.put(`orgc:${slug}`, JSON.stringify([...have, label]));
  }

  getOtp(key: string) { return this.kv.get<{ hash: string; tries: number }>(`otp:${key}`, "json"); }
  putOtp(key: string, v: { hash: string; tries: number }) { return this.kv.put(`otp:${key}`, JSON.stringify(v), { expirationTtl: 10 * 60 }); }
  deleteOtp(key: string) { return this.kv.delete(`otp:${key}`); }

  /** Counts one more hit on a rate-limit key; returns the count including it (window = 1 hour). */
  async hit(key: string): Promise<number> {
    const n = Number((await this.kv.get(key)) ?? "0") + 1;
    await this.kv.put(key, String(n), { expirationTtl: 3600 });
    return n;
  }

  getSession(hash: string) { return this.kv.get<{ email: string; createdAt: number }>(`sess:${hash}`, "json"); }
  putSession(hash: string, email: string) {
    return this.kv.put(`sess:${hash}`, JSON.stringify({ email, createdAt: Date.now() }), { expirationTtl: 7 * 24 * 3600 });
  }
  deleteSession(hash: string) { return this.kv.delete(`sess:${hash}`); }

  /** Next self-serve test number (test1, test2, …). Not atomic; the caller skips names already taken. */
  async nextTestNumber(): Promise<number> {
    const n = Number((await this.kv.get("seq:test")) ?? "0") + 1;
    await this.kv.put("seq:test", String(n));
    return n;
  }

  async listLabels(): Promise<string[]> {
    const { keys } = await this.kv.list({ prefix: "card:" });
    return keys.map((k) => k.name.slice("card:".length));
  }

  /** Returns the request_id reserved for this operation, creating one if needed. */
  async requestIdFor(kind: string, key: string): Promise<string> {
    const k = `op:${kind}:${key}`;
    const existing = await this.kv.get(k);
    if (existing) return existing;
    const id = crypto.randomUUID();
    await this.kv.put(k, id, { expirationTtl: 24 * 3600 });
    return id;
  }
  clearRequestId(kind: string, key: string) { return this.kv.delete(`op:${kind}:${key}`); }

  getApproval(id: string) { return this.kv.get<PendingApproval & { sig: string }>(`appr:${id}`, "json"); }
  putApproval(a: PendingApproval & { sig: string }) { return this.kv.put(`appr:${a.id}`, JSON.stringify(a)); }

  async listApprovals(): Promise<(PendingApproval & { sig: string })[]> {
    const { keys } = await this.kv.list({ prefix: "appr:" });
    const all = await Promise.all(keys.map((k) => this.kv.get<PendingApproval & { sig: string }>(k.name, "json")));
    return all.filter((a) => a !== null).sort((a, b) => b.createdAt - a.createdAt);
  }

  async tokenLabel(tokenHash: string) { return this.kv.get(`tok:${tokenHash}`); }
  putToken(tokenHash: string, label: string) { return this.kv.put(`tok:${tokenHash}`, label); }

  async getEvents(label: string): Promise<CardEvent[]> {
    return (await this.kv.get<CardEvent[]>(`evt:${label}`, "json")) ?? [];
  }
  async addEvent(label: string, e: CardEvent) {
    const events = [e, ...(await this.getEvents(label))].slice(0, MAX_EVENTS);
    await this.kv.put(`evt:${label}`, JSON.stringify(events));
  }

  getPayment<T>(label: string, requestId: string) { return this.kv.get<T>(`pay:${label}:${requestId}`, "json"); }
  putPayment(label: string, requestId: string, result: unknown) {
    return this.kv.put(`pay:${label}:${requestId}`, JSON.stringify(result), { expirationTtl: 24 * 3600 });
  }

  /** Opens the TAP checkout window for a merchant origin after a payment to it was approved. */
  allowTapCheckout(label: string, origin: string) {
    return this.kv.put(`tapok:${label}:${origin}`, String(Date.now()), { expirationTtl: 15 * 60 });
  }
  async tapCheckoutAllowed(label: string, origin: string) { return (await this.kv.get(`tapok:${label}:${origin}`)) !== null; }

  getAuthz<T>(handle: string) { return this.kv.get<T>(`authz:${handle}`, "json"); }
  putAuthz(handle: string, v: unknown) { return this.kv.put(`authz:${handle}`, JSON.stringify(v), { expirationTtl: 10 * 60 }); }
  deleteAuthz(handle: string) { return this.kv.delete(`authz:${handle}`); }

  /**
   * TAP replay check for the demo merchant. KV is eventually consistent, so two
   * requests racing within a second can both pass; a real merchant wants a
   * strongly consistent store (a Durable Object) here.
   */
  async claimTapNonce(nonce: string, ttlS: number): Promise<boolean> {
    const k = `tapn:${nonce}`;
    if ((await this.kv.get(k)) !== null) return false;
    await this.kv.put(k, "1", { expirationTtl: Math.max(60, ttlS) });
    return true;
  }
}
