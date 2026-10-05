// Escalated funding approvals. An approval is an HMAC over the exact
// (name, amount, currency, approval id), so it can't be replayed for a
// different card, a bigger amount or another currency.

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
}

const TTL_MS = 24 * 60 * 60 * 1000;

export function newPendingApproval(
  name: string,
  amount: number,
  currency: string,
  reason: string,
  approver: string,
  now = Date.now(),
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
  };
}

function canonical(a: Pick<PendingApproval, "id" | "name" | "amount" | "currency">): string {
  return `x402card-approval:v1|${a.id}|${a.name.toLowerCase()}|${a.amount}|${a.currency.toUpperCase()}`;
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

export async function signApproval(secret: string, a: PendingApproval): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(canonical(a)));
  return toHex(new Uint8Array(sig));
}

/** True only if `sig` was issued for exactly this name, amount and currency. */
export async function verifyApproval(
  secret: string,
  a: Pick<PendingApproval, "id" | "name" | "amount" | "currency">,
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
