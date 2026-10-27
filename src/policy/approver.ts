// Signed approvals: card.approver decides with a wallet signature instead of
// the admin token. The approval is EIP-712 typed data over exactly what will
// happen (card, amount, currency, merchant, decision, expiry); the Worker
// resolves card.approver (an ENS name or an address) and accepts the decision
// only if that address signed it. EOAs, Safes (ERC-1271) and counterfactual
// smart wallets (ERC-6492) all verify through viem's verifyTypedData.
//
// The typed data is eth_signTypedData_v4 JSON (EIP712Domain spelled out, plain
// strings and numbers), so PayBox's request_wallet_sign {op: "typedData"} and a
// browser wallet sign the same bytes.
import { getAddress, isAddress, type Address, type Hex, type PublicClient } from "viem";
import { normalize } from "viem/ens";
import type { PendingApproval } from "./approvals.ts";

export type Decision = "approve" | "deny";

export const APPROVAL_DOMAIN = { name: "X Card", version: "1", chainId: 1 } as const;

export const APPROVAL_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
  ],
  Approval: [
    { name: "id", type: "string" },
    { name: "decision", type: "string" },
    { name: "card", type: "string" },
    { name: "kind", type: "string" },
    { name: "amount", type: "string" },
    { name: "currency", type: "string" },
    { name: "merchant", type: "string" },
    { name: "checkout", type: "string" },
    { name: "payee", type: "string" },
    { name: "approver", type: "string" },
    { name: "expires", type: "uint256" },
  ],
} as const;

/** What the approver signs. Amount is a decimal string so no signer rounds it. */
export function approvalTypedData(a: PendingApproval, decision: Decision, card: string) {
  const p = a.payment;
  return {
    domain: APPROVAL_DOMAIN,
    types: APPROVAL_TYPES,
    primaryType: "Approval" as const,
    message: {
      id: a.id,
      decision,
      card,
      kind: a.kind ?? "funding",
      amount: String(a.amount),
      currency: a.currency,
      merchant: p?.merchant ?? "",
      checkout: p?.merchantUrl ?? "",
      payee: p?.payeeName ?? "",
      approver: a.approver,
      expires: Math.floor(a.expiresAt / 1000),
    },
  };
}

export type ApprovalTypedData = ReturnType<typeof approvalTypedData>;

/**
 * resolve: card.approver -> address, or null when it can't sign (free text,
 * or a name with no ETH address). verify: did address sign typedData?
 */
export interface ApproverAuth {
  resolve(approver: string): Promise<Address | null>;
  verify(address: Address, typedData: ApprovalTypedData, signature: Hex): Promise<boolean>;
}

/** Can this card.approver value ever sign? (An ENS name or an address.) */
export function isSignableApprover(approver: string): boolean {
  const v = approver.trim();
  return isAddress(v) || /^[^\s.,]+(\.[^\s.,]+)*\.[a-z]{2,}$/i.test(v);
}

export function ensApproverAuth(client: PublicClient): ApproverAuth {
  return {
    async resolve(approver) {
      const v = approver.trim();
      if (isAddress(v)) return getAddress(v);
      if (!isSignableApprover(v)) return null;
      // A failed read throws: the caller reports it rather than treating it as "no address".
      const addr = await client.getEnsAddress({ name: normalize(v) });
      return addr ?? null;
    },
    async verify(address, td, signature) {
      const { EIP712Domain: _domain, ...types } = td.types;
      return client.verifyTypedData({ address, domain: td.domain, types, primaryType: td.primaryType, message: { ...td.message, expires: BigInt(td.message.expires) }, signature });
    },
  };
}
