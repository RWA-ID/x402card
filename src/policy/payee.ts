// Payee gate: does the merchant's website belong to the ENS name the agent
// says it is paying? Read from the name's own records with the x402
// payee-name verifier (@x402identity/payee), then decided by card.payee.
import { verifyPayee, toOrigin, type EnsReader } from "@x402identity/payee";
import { zeroAddress } from "viem";
import type { CardPolicy } from "./records.ts";

/**
 * verified   = the name is live and lists the merchant's origin in org.x402.origins.
 * mismatch   = the name exists but does not vouch for that origin (or has expired):
 *              the shape of a lookalike or phishing checkout.
 * unverified = nothing to check against: no name given, no records, or the chain read failed.
 */
export type PayeeStatus = "verified" | "mismatch" | "unverified";

export interface PayeeCheck {
  status: PayeeStatus;
  /** The name the agent claimed, when it gave one. */
  name?: string;
  origin?: string;
  /** Verifier reason code (payee-name spec), or why nothing was checked. */
  reason: string;
  checked_at?: string;
}

export type PayeeChecker = (name: string, origin: string) => Promise<PayeeCheck>;

/** Normalizes the merchant URL to an origin; null when it isn't an http(s) URL. */
export { toOrigin };

/**
 * Checks a card payment's payee. A card payment has no payTo (the network
 * routes the money), so only the origin half of payee-name applies. The
 * verifier checks origin before payTo, so a placeholder payTo that can never
 * match tells the two apart: payto-not-listed means the origin passed.
 */
export function ensPayeeChecker(reader: EnsReader): PayeeChecker {
  return async (name, origin) => {
    const pr = { accepts: [{ network: "eip155:1", payTo: zeroAddress }], extensions: { "payee-name": { info: { name } } } };
    const [v] = (await verifyPayee(pr, origin, reader)) ?? [];
    if (!v) return { status: "unverified", name, origin, reason: "no-declaration" };
    // A name that lists no origins at all hasn't opted in; that is not evidence
    // of a lookalike, so it stays unverified instead of counting as a strike.
    const optedOut = v.reason === "origin-not-listed" && v.detail?.got === "(empty)";
    const status: PayeeStatus =
      v.verdict === true || v.reason === "payto-not-listed" ? "verified"
      : v.verdict === false && !optedOut ? "mismatch"
      : "unverified";
    const reason = status === "verified" ? "origin-bound" : optedOut ? "no-origins-listed" : v.reason;
    return { status, name, origin, reason, checked_at: v.checked_at };
  };
}

export type PayeeDecision =
  | { action: "pass" }
  | { action: "block"; code: "PAYEE_MISMATCH" | "PAYEE_UNVERIFIED" | "PAYEE_NOT_ALLOWED"; reason: string }
  | { action: "escalate"; reason: string };

/** card.payee + card.payee.allow applied to a check. Plain code, no I/O. */
export function decidePayee(p: CardPolicy, c: PayeeCheck): PayeeDecision {
  if (p.payee === "any") return { action: "pass" };
  const who = c.name ? `${c.name} at ${c.origin ?? "?"}` : (c.origin ?? "payee");

  if (c.status === "mismatch") {
    return { action: "block", code: "PAYEE_MISMATCH", reason: `${who}: ${c.reason}` };
  }
  if (c.status === "verified" && p.payeeAllow.length > 0 && !p.payeeAllow.includes(c.name!.toLowerCase())) {
    const reason = `${c.name} is verified but not in card.payee.allow`;
    return p.payee === "verified-only" ? { action: "block", code: "PAYEE_NOT_ALLOWED", reason } : { action: "escalate", reason };
  }
  if (c.status === "verified") return { action: "pass" };

  const reason = `payee not verified (${c.reason})`;
  return p.payee === "verified-only" ? { action: "block", code: "PAYEE_UNVERIFIED", reason } : { action: "escalate", reason };
}
