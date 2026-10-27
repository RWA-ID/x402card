import { test } from "node:test";
import assert from "node:assert/strict";
import type { EnsReader } from "@x402identity/payee";
import { decidePayee, ensPayeeChecker, type PayeeCheck } from "./payee.ts";
import { newPendingApproval, signApproval, verifyApproval } from "./approvals.ts";
import { PolicyError, parseRecords, toRecords, type CardPolicy } from "./records.ts";

const NOW = 1_800_000_000n;
const YEAR = 365n * 24n * 3600n;

/** Second-level .eth names only: text records, an ETH address, an expiry. */
function fakeReader(names: Record<string, { origins?: string; eth?: string; expires?: bigint }>, fail = false): EnsReader {
  const get = (n: string) => names[n] ?? {};
  const maybeFail = <T>(v: T) => (fail ? Promise.reject(Object.assign(new Error("429"), { shortMessage: "rate limited" })) : Promise.resolve(v));
  return {
    now: async () => NOW,
    text: async (n, key) => maybeFail(key === "org.x402.origins" ? (get(n).origins ?? null) : null),
    addr: async (n, coinType) => maybeFail(coinType === 60n ? (get(n).eth ?? null) : null),
    registryOwner: async () => "0x0000000000000000000000000000000000000000",
    wrapperData: async () => ({ owner: "0x0000000000000000000000000000000000000000", fuses: 0, expiry: 0n }),
    nameExpires: async (label) => maybeFail(get(`${label}.eth`).expires ?? NOW + YEAR),
    extendedResolver: async () => true,
  };
}

const ETH = "0x8E61eD2bC67E2E0c9e5A3E47fC1f1d55a3F8631C";

test("checker: origin bound, mismatch, opted out, expired, read failure", async () => {
  const check = ensPayeeChecker(
    fakeReader({
      "modelhub.eth": { origins: "https://modelhub.example https://api.modelhub.example", eth: ETH },
      "bare.eth": { eth: ETH },
      "gone.eth": { origins: "https://gone.example", expires: NOW - 100n * 24n * 3600n },
    }),
  );
  const ok = await check("modelhub.eth", "https://api.modelhub.example");
  assert.equal(ok.status, "verified");
  assert.equal(ok.reason, "origin-bound");

  const phish = await check("modelhub.eth", "https://modelhub-checkout.example");
  assert.equal(phish.status, "mismatch");
  assert.equal(phish.reason, "origin-not-listed");

  // Has an address but never listed an origin: not set up, not a lookalike.
  const bare = await check("bare.eth", "https://bare.example");
  assert.equal(bare.status, "unverified");
  assert.equal(bare.reason, "no-origins-listed");

  assert.equal((await check("gone.eth", "https://gone.example")).status, "mismatch");
  assert.equal((await check("nobody.eth", "https://x.example")).reason, "no-records");
  assert.equal((await check("ModelHub.eth", "https://modelhub.example")).reason, "name-not-normalized");

  const down = await ensPayeeChecker(fakeReader({}, true))("modelhub.eth", "https://modelhub.example");
  assert.deepEqual([down.status, down.reason], ["unverified", "resolution-failed"]);
});

const base: CardPolicy = parseRecords({
  "card.limit.tx": "50", "card.limit.monthly": "500", "card.currencies": "USD", "card.approver": "alice.eth",
});
const verified: PayeeCheck = { status: "verified", name: "modelhub.eth", origin: "https://modelhub.example", reason: "origin-bound" };
const mismatch: PayeeCheck = { ...verified, status: "mismatch", reason: "origin-not-listed" };
const unverified: PayeeCheck = { status: "unverified", reason: "no-payee-name" };

test("decidePayee: each mode", () => {
  assert.equal(base.payee, "any");
  for (const c of [verified, mismatch, unverified]) assert.equal(decidePayee(base, c).action, "pass");

  const esc = { ...base, payee: "verified-or-escalate" as const };
  assert.equal(decidePayee(esc, verified).action, "pass");
  assert.deepEqual(decidePayee(esc, mismatch), { action: "block", code: "PAYEE_MISMATCH", reason: "modelhub.eth at https://modelhub.example: origin-not-listed" });
  assert.equal(decidePayee(esc, unverified).action, "escalate");

  const only = { ...base, payee: "verified-only" as const };
  assert.equal(decidePayee(only, verified).action, "pass");
  assert.equal((decidePayee(only, unverified) as { code: string }).code, "PAYEE_UNVERIFIED");

  const allow = { ...only, payeeAllow: ["other.eth"] };
  assert.equal((decidePayee(allow, verified) as { code: string }).code, "PAYEE_NOT_ALLOWED");
  assert.equal(decidePayee({ ...allow, payee: "verified-or-escalate" }, verified).action, "escalate");
  assert.equal(decidePayee({ ...allow, payeeAllow: ["modelhub.eth"] }, verified).action, "pass");
});

test("records: card.payee round-trips and is validated", () => {
  const r = { ...toRecords(base), "card.payee": "verified-only", "card.payee.allow": "ModelHub.eth, aws.eth" };
  const p = parseRecords(r);
  assert.deepEqual([p.payee, p.payeeAllow], ["verified-only", ["modelhub.eth", "aws.eth"]]);
  assert.deepEqual(parseRecords(toRecords(p)), p);
  assert.throws(() => parseRecords({ ...r, "card.payee": "sometimes" }), PolicyError);
  assert.throws(() => parseRecords({ ...r, "card.payee.allow": "modelhub.com" }), PolicyError);
  assert.throws(() => parseRecords({ ...r, "card.payee": "any" }), /needs card.payee/);
});

test("a held payment's approval binds the merchant", async () => {
  const held = { mcc: "5734", merchant: "ModelHub API", merchantUrl: "https://modelhub.example", payeeName: "modelhub.eth", payeeStatus: "unverified" };
  const a = newPendingApproval("researcher", 30, "USD", "test", "alice.eth", Date.now(), held);
  const sig = await signApproval("s3cret", a);
  assert.ok(await verifyApproval("s3cret", a, sig));
  assert.ok(!(await verifyApproval("s3cret", { ...a, payment: { ...held, merchantUrl: "https://evil.example" } }, sig)));
  assert.ok(!(await verifyApproval("s3cret", { ...a, payment: { ...held, payeeName: "evil.eth" } }, sig)));
  // The same fields signed as funding must not verify as this payment.
  assert.ok(!(await verifyApproval("s3cret", { ...a, kind: undefined }, sig)));
});
