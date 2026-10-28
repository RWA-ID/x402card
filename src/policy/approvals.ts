// Escalated approvals. An approval is an HMAC over the exact
// (name, amount, currency, approval id), so it can't be replayed for a
// different card, a bigger amount or another currency. A held payment also
// binds its merchant, so approving it can't pay someone else. A policy change
// binds every record it changes, from and to.
import type { PolicyChange } from "./changes.ts";

export interface PendingApproval {
  id: string;
  name: string;
  amount: number;
  currency: string;
  reason: string;
  approver: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "approved" | "denied" | "expired";
  /** Absent = funding (approvals stored before payments could be held). */
  kind?: "funding" | "payment" | "policy";
  payment?: HeldPayment;
  /** kind "policy": the changes approving applies (amount 0). */
  policy?: { changes: PolicyChange[] };
}

/** A payment the payee gate held for a human; approving it makes the charge. */
export interface HeldPayment {
  mcc: string;
  merchant: string;
  merchantUrl?: string;
  payeeName?: string;
  payeeStatus: string;
  purpose?: string;
  requestId?: string;
}

const TTL_MS = 24 * 60 * 60 * 1000;

export function newPendingApproval(
  name: string,
  amount: number,
  currency: string,
  reason: string,
  approver: string,
  now = Date.now(),
  payment?: HeldPayment,
): PendingApproval {
  return {
    id: crypto.randomUUID(),
    name: name.toLowerCase(),
    amount,
    currency: currency.toUpperCase(),
    reason,
    approver,
    createdAt: now,
    expiresAt: now + TTL_MS,
    status: "pending",
    ...(payment ? { kind: "payment" as const, payment } : {}),
  };
}

type Signed = Pick<PendingApproval, "id" | "name" | "amount" | "currency" | "kind" | "payment" | "policy">;

function canonical(a: Signed): string {
  const base = `${a.id}|${a.name.toLowerCase()}|${a.amount}|${a.currency.toUpperCase()}`;
  if (a.kind === "policy") {
    return `x402card-policy:v1|${base}|${JSON.stringify((a.policy?.changes ?? []).map((c) => [c.key, c.from, c.to]))}`;
  }
  // Funding keeps the v1 string so approvals signed before payments existed still verify.
  if (a.kind !== "payment") return `x402card-approval:v1|${base}`;
  const p = a.payment;
  // JSON, so a "|" inside a merchant name can't shift fields.
  return `x402card-payment:v1|${base}|${JSON.stringify([p?.mcc, p?.merchant, p?.merchantUrl ?? "", p?.payeeName ?? ""])}`;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signApproval(secret: string, a: Signed): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(canonical(a)));
  return toHex(new Uint8Array(sig));
}

/** True only if `sig` was issued for exactly this name, amount and currency (and merchant, for a payment). */
export async function verifyApproval(
  secret: string,
  a: Signed,
  sig: string,
): Promise<boolean> {
  const bytes = fromHex(sig);
  if (!bytes) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(secret), bytes, new TextEncoder().encode(canonical(a)));
}

function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function fromHex(s: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(s)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
