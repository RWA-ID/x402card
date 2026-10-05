// Airwallex Issuing calls (API >= 2024-03-31 shapes). Field names checked
// against the airwallex-docs MCP. Amounts are MAJOR units.
import type { AirwallexClient } from "./client.ts";

export type LimitInterval = "PER_TRANSACTION" | "DAILY" | "WEEKLY" | "MONTHLY" | "ALL_TIME";

export interface TransactionLimit {
  amount: number;
  interval: LimitInterval;
}

export interface AuthorizationControls {
  allowed_transaction_count: "SINGLE" | "MULTIPLE";
  transaction_limits: { currency?: string; limits: TransactionLimit[] };
  /** Empty or absent = all currencies allowed. */
  allowed_currencies?: string[];
  /** Empty or absent = all MCCs allowed. */
  allowed_merchant_categories?: string[];
}

export type CardStatus = "PENDING" | "ACTIVE" | "INACTIVE" | "BLOCKED" | "LOST" | "STOLEN" | "CLOSED" | "FAILED";

export interface Card {
  card_id: string;
  card_status: CardStatus;
  cardholder_id?: string;
  card_number?: string; // masked
  nick_name?: string;
  authorization_controls: AuthorizationControls;
  created_at?: string;
}

export interface Cardholder {
  cardholder_id: string;
  status: "INCOMPLETE" | "PENDING" | "READY" | "DISABLED" | "DELETED";
  type: "INDIVIDUAL" | "DELEGATE";
  email: string;
}

/** Legacy transaction object from GET /issuing/transactions. */
export interface IssuingTransaction {
  transaction_id: string;
  card_id: string;
  transaction_type: "AUTHORIZATION" | "CLEARING" | "REFUND" | "REVERSAL" | "ORIGINAL_CREDIT";
  status: string; // APPROVED | PENDING | FAILED ...
  failure_reason?: string;
  transaction_amount: number;
  transaction_currency: string;
  billing_amount?: number;
  billing_currency?: string;
  merchant?: { name?: string; category_code?: string; city?: string; country?: string };
  transaction_date?: string;
  lifecycle_id?: string;
}

/** Card transaction event returned by the simulation endpoints. */
export interface SimulatedEvent {
  card_id?: string;
  type?: "AUTHORIZATION" | "CLEARING" | "REVERSAL_AUTH";
  subtype?: string;
  process_result?: "APPROVED" | "DECLINED";
  failure_reason?: string;
  transaction_amount?: number;
  transaction_currency?: string;
  card_transaction_id?: string;
  card_transaction_lifecycle_id?: string;
  merchant?: { category_code?: string; name?: string };
}

export function createDelegateCardholder(awx: AirwallexClient, email: string) {
  return awx.post<Cardholder>("/issuing/cardholders/create", { type: "DELEGATE", email });
}

export interface CreateCardInput {
  cardholderId: string;
  nickName: string;
  createdBy: string;
  controls: AuthorizationControls;
  requestId: string;
  metadata?: Record<string, string>;
}

/** Non-personalized virtual commercial card; the only kind a DELEGATE can hold. */
export function createCard(awx: AirwallexClient, input: CreateCardInput) {
  return awx.post<Card>("/issuing/cards/create", {
    request_id: input.requestId,
    cardholder_id: input.cardholderId,
    is_personalized: false,
    form_factor: "VIRTUAL",
    program: { purpose: "COMMERCIAL" },
    created_by: input.createdBy,
    nick_name: input.nickName,
    authorization_controls: input.controls,
    metadata: input.metadata,
  });
}

export function getCard(awx: AirwallexClient, cardId: string) {
  return awx.get<Card>(`/issuing/cards/${cardId}`);
}

export interface UpdateCardInput {
  card_status?: "ACTIVE" | "INACTIVE";
  authorization_controls?: Partial<AuthorizationControls>;
  request_id?: string;
}

/** Omitted fields are left unchanged. INACTIVE = frozen (reversible). */
export function updateCard(awx: AirwallexClient, cardId: string, input: UpdateCardInput) {
  return awx.post<Card>(`/issuing/cards/${cardId}/update`, input);
}

export function listTransactions(
  awx: AirwallexClient,
  cardId: string,
  opts: { fromCreatedAt?: string; pageSize?: number } = {},
) {
  return awx.get<{ items: IssuingTransaction[]; has_more?: boolean }>("/issuing/transactions", {
    query: { card_id: cardId, from_created_at: opts.fromCreatedAt, page_size: opts.pageSize ?? 50 },
  });
}

/** Card succeeded only once it CLEARED; declines carry failure_reason. */
export function isSettled(tx: IssuingTransaction): boolean {
  return tx.transaction_type === "CLEARING" && !tx.failure_reason;
}
