// KV layout. Public records and private Airwallex IDs live under separate
// prefixes; only rec:* is ever served by the gateway.
//   rec:<label>       public ENS text records (TextRecords JSON)
//   card:<label>      private { cardholderId, cardId, last4, ... }
//   op:<kind>:<key>   request_id reserved for an in-flight write (reused on retry)
//   appr:<id>         funding approvals
//   tok:<sha256>      agent token -> label it may act for
//   evt:<label>       recent policy events (escalations, freezes) for the feed
//   pay:<label>:<id>  result of a pay call, replayed when the agent retries with the same request_id (24h)
//   awx:token         cached Airwallex token (see airwallex/client.ts)
import type { TextRecords } from "./policy/records.ts";
import type { PendingApproval } from "./policy/approvals.ts";
import type { RecordSource } from "./ens/gateway.ts";

export interface CardRef {
  cardholderId: string;
  cardId: string;
  last4?: string;
  createdAt: number;
}

export interface CardEvent {
  at: number;
  /** "blocked" = refused by x402card's pre-check; "declined" = refused by the issuer. */
  kind: "issued" | "charged" | "blocked" | "declined" | "funded" | "escalated" | "approved" | "denied" | "frozen" | "unfrozen";
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
}
