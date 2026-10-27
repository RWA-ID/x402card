// Who may connect an MCP client (Claude, ChatGPT, Grok) over OAuth, and as what.
//
// The person signs in with their wallet (Sign-In with Ethereum). What that
// wallet may grant follows the card policy already on ENS:
//   card  = a card whose card.approver resolves to this wallet. The client acts
//           as that card's agent, exactly like its agent token.
//   fleet = an operator wallet (OPERATORS): every card, plus issue_card, like
//           the admin token.
// Approvals are not part of any grant: they still need card.approver's own
// signature on the approval page.
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { createSiweMessage, parseSiweMessage, validateSiweMessage } from "viem/siwe";
import type { Caller } from "../mcp.ts";
import { isSignableApprover } from "../policy/approver.ts";
import { fullName } from "../service.ts";
import type { Store } from "../store.ts";

export type Grant = { kind: "fleet" } | { kind: "card"; card: string };

/** What a token carries (encrypted by the OAuth library) and what the MCP handler turns into a Caller. */
export interface GrantProps {
  address: Address;
  grant: Grant;
  /** card.approver when the grant was made; a different approver now ends the grant. */
  approver?: string;
}

export interface AccessOption {
  id: string;
  grant: Grant;
  /** Shown on the consent page. */
  name: string;
  detail: string;
  approver?: string;
}

export interface AccessDeps {
  store: Store;
  /** card.approver -> address (policy/approver.ts). Throws when ENS can't be read. */
  resolve(approver: string): Promise<Address | null>;
  /** EOA, ERC-1271 or ERC-6492 signature check over a plain message. */
  verifyMessage(address: Address, message: string, signature: Hex): Promise<boolean>;
  /** Operator wallets (lowercase or checksummed). */
  operators: string[];
}

export const grantId = (g: Grant) => (g.kind === "fleet" ? "fleet" : `card:${g.card}`);

/** Every grant this wallet may make, operator first. */
export async function accessOptions(address: Address, deps: AccessDeps): Promise<AccessOption[]> {
  const me = address.toLowerCase();
  const out: AccessOption[] = [];
  if (deps.operators.some((o) => o.trim().toLowerCase() === me)) {
    out.push({ id: "fleet", grant: { kind: "fleet" }, name: "Every card (operator)", detail: "Issue cards and act for any card, like the admin token." });
  }
  // One ENS read per distinct approver, however many cards share it.
  const resolved = new Map<string, Promise<Address | null>>();
  for (const label of await deps.store.listLabels()) {
    const approver = (await deps.store.getRecords(label))?.["card.approver"]?.trim();
    if (!approver || !isSignableApprover(approver)) continue;
    if (!resolved.has(approver)) resolved.set(approver, deps.resolve(approver).catch(() => null));
    const addr = await resolved.get(approver)!;
    if (addr?.toLowerCase() !== me) continue;
    const grant: Grant = { kind: "card", card: label };
    out.push({ id: grantId(grant), grant, name: fullName(label), detail: `You're its approver (${approver}).`, approver });
  }
  return out;
}

/**
 * The MCP caller for a token's props, checked against the card as it is now:
 * a card that's gone, or whose approver changed, no longer honours the grant.
 */
export async function callerFor(p: GrantProps, store: Store): Promise<Caller | null> {
  if (p.grant.kind === "fleet") return { kind: "admin" };
  const records = await store.getRecords(p.grant.card);
  if (!records || (records["card.approver"] ?? "").trim() !== p.approver) return null;
  return { kind: "agent", label: p.grant.card };
}

const SIWE_STATEMENT = "Sign in to X Card to connect an AI app to your cards. This doesn't move funds or approve payments.";

export function siweMessage(origin: string, address: string, nonce: string, now = new Date()): string {
  if (!isAddress(address)) throw new Error("not an address");
  const u = new URL(origin);
  return createSiweMessage({
    domain: u.host,
    uri: u.origin,
    address: getAddress(address),
    chainId: 1,
    nonce,
    version: "1",
    statement: SIWE_STATEMENT,
    issuedAt: now,
    expirationTime: new Date(now.getTime() + 10 * 60 * 1000),
  });
}

/**
 * True when `message` is the SIWE message issued for this sign-in (same
 * domain, nonce and address, not expired) and `address` signed it.
 */
export async function verifySiwe(
  origin: string,
  expected: { address: string; nonce: string; message: string },
  signature: string,
  deps: Pick<AccessDeps, "verifyMessage">,
  now = new Date(),
): Promise<boolean> {
  if (!/^0x[0-9a-fA-F]{130,}$/.test(signature)) return false;
  const parsed = parseSiweMessage(expected.message);
  const ok = validateSiweMessage({ message: parsed, domain: new URL(origin).host, nonce: expected.nonce, address: getAddress(expected.address), time: now });
  if (!ok) return false;
  try {
    return await deps.verifyMessage(getAddress(expected.address), expected.message, signature as Hex);
  } catch {
    return false;
  }
}
