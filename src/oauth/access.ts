// Who may connect an MCP client (Claude, ChatGPT, Grok) over OAuth, and as what.
//
// The person signs in with their email (a code, auth/email.ts) or their wallet
// (Sign-In with Ethereum). What they may grant follows the card policy already on ENS:
//   wallet = "all my cards": every card whose card.approver is this email or
//            resolves to this wallet, plus the cards it issued, read again on
//            each request, so cards issued later join and reassigned ones leave.
//   card  = a card whose card.approver is this person. The client acts as that
//           card's agent, exactly like its agent token.
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

export type Grant = { kind: "fleet" } | { kind: "wallet" } | { kind: "card"; card: string };

/** What a token carries (encrypted by the OAuth library) and what the MCP handler turns into a Caller. */
export interface GrantProps {
  /** Exactly one of address (wallet sign-in) and email (code sign-in). */
  address?: Address;
  email?: string;
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
  /** Email sign-in by code (auth/email.ts). Without it the consent page offers wallets only. */
  email?: { start(email: unknown, ip: string): Promise<{ sent: true; dev_code?: string }>; check(email: unknown, code: unknown): Promise<string> };
}

export const grantId = (g: Grant) => (g.kind === "card" ? `card:${g.card}` : g.kind);

/** The cards whose card.approver resolves to this wallet, with that approver. */
export async function walletCards(address: Address, deps: Pick<AccessDeps, "store" | "resolve">): Promise<{ label: string; approver: string; issuedOnly?: boolean }[]> {
  const me = address.toLowerCase();
  const out: { label: string; approver: string; issuedOnly?: boolean }[] = [];
  // One ENS read per distinct approver, however many cards share it.
  const resolved = new Map<string, Promise<Address | null>>();
  // The index catches cards issued in the last minute that list() doesn't show yet;
  // the approver check below still decides.
  const labels = [...new Set([...(await deps.store.walletIndex(address)), ...(await deps.store.listLabels())])];
  for (const label of labels) {
    const approver = (await deps.store.getRecords(label))?.["card.approver"]?.trim();
    if (!approver) continue;
    if (isSignableApprover(approver)) {
      if (!resolved.has(approver)) resolved.set(approver, deps.resolve(approver).catch(() => null));
      const addr = await resolved.get(approver)!;
      if (addr?.toLowerCase() === me) { out.push({ label, approver }); continue; }
    }
    // Issued by this wallet for someone else to approve: still its card to manage.
    if ((await deps.store.getCard(label))?.issuedBy?.toLowerCase() === me) out.push({ label, approver, issuedOnly: true });
  }
  return out;
}

/** The cards an email account approves or issued, and its org's if it's an operator (the indexes; the records decide). */
export async function emailCards(email: string, store: Store): Promise<{ label: string; approver: string; issuedOnly?: boolean }[]> {
  const me = email.toLowerCase();
  const out: { label: string; approver: string; issuedOnly?: boolean }[] = [];
  const org = await store.orgOf(me);
  const labels = [...new Set([...(await store.accountIndex(me)), ...(org ? await store.orgIndex(org.slug) : [])])];
  for (const label of labels) {
    const [ref, rec] = await Promise.all([store.getCard(label), store.getRecords(label)]);
    const approver = rec?.["card.approver"]?.trim();
    if (!ref || !approver) continue;
    if (approver === me) out.push({ label, approver });
    else if (ref.issuedBy === me || (org && ref.org === org.slug)) out.push({ label, approver, issuedOnly: true });
  }
  return out;
}

export type Identity = { address: Address } | { email: string };

const cardsOf = (id: Identity, deps: Pick<AccessDeps, "store" | "resolve">) =>
  "email" in id ? emailCards(id.email, deps.store) : walletCards(id.address, deps);

/** Every grant this person may make: operator (wallets only), then all their cards, then each card they approve. */
export async function accessOptions(id: Identity, deps: AccessDeps): Promise<AccessOption[]> {
  const out: AccessOption[] = [];
  if ("address" in id && deps.operators.some((o) => o.trim().toLowerCase() === id.address.toLowerCase())) {
    out.push({ id: "fleet", grant: { kind: "fleet" }, name: "Every card (operator)", detail: "Issue cards and act for any card, like the admin token." });
  }
  const cards = await cardsOf(id, deps);
  // Offered with no cards too: the app can then issue this wallet a test card.
  out.push({
    id: "wallet",
    grant: { kind: "wallet" },
    name: cards.length ? `All my cards (${cards.length})` : "My cards (none yet)",
    detail: cards.length
      ? "Every card you approve or issued, including cards issued later."
      : "Connect now and ask the app to issue you a card.",
  });
  // A single-card grant acts as that card's agent, so it's only for the card's approver.
  for (const { label, approver } of cards.filter((c) => !c.issuedOnly)) {
    const grant: Grant = { kind: "card", card: label };
    out.push({ id: grantId(grant), grant, name: fullName(label), detail: `You're its approver (${approver}).`, approver });
  }
  return out;
}

/**
 * The MCP caller for a token's props, checked against the card as it is now:
 * a card that's gone, or whose approver changed, no longer honours the grant.
 * A wallet grant with no cards left still connects, and simply has no cards.
 */
export async function callerFor(p: GrantProps, deps: Pick<AccessDeps, "store" | "resolve">): Promise<Caller | null> {
  if (p.grant.kind === "fleet") return { kind: "admin" };
  if (p.grant.kind === "wallet") {
    const id: Identity = p.email ? { email: p.email } : { address: p.address! };
    return { kind: "owner", ...id, labels: (await cardsOf(id, deps)).map((c) => c.label) };
  }
  const records = await deps.store.getRecords(p.grant.card);
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
