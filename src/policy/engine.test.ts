import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRecords, toRecords, PolicyError } from "./records.ts";
import { decideFunding, evaluateActivity, precheckPayment, toAuthorizationControls, DEFAULT_CONFIG } from "./engine.ts";
import { newPendingApproval, signApproval, verifyApproval } from "./approvals.ts";
import type { IssuingTransaction } from "../airwallex/issuing.ts";

const records = {
  "card.limit.tx": "100",
  "card.limit.monthly": "1000",
  "card.currencies": "USD",
  "card.mcc.allow": "5734,7372",
  "card.status": "active",
  "card.approver": "hector.eth",
} as const;
const policy = parseRecords(records);

test("records round-trip and reject bad input", () => {
  assert.deepEqual(parseRecords(toRecords(policy)), policy);
  assert.throws(() => parseRecords({ ...records, "card.limit.tx": "5000" }), PolicyError);
  assert.throws(() => parseRecords({ ...records, "card.status": "paused" }), PolicyError);
  assert.throws(() => parseRecords({ ...records, "card.mcc.allow": "57" }), PolicyError);
});

test("controls carry limits, currencies and MCCs", () => {
  const c = toAuthorizationControls(policy);
  assert.equal(c.transaction_limits.currency, "USD");
  assert.deepEqual(c.transaction_limits.limits.map((l) => [l.interval, l.amount]), [
    ["PER_TRANSACTION", 100], ["MONTHLY", 1000],
  ]);
  assert.deepEqual(c.allowed_merchant_categories, ["5734", "7372"]);
});

test("funding: approve, escalate, deny", () => {
  const rich = 1_000_000;
  assert.equal(decideFunding(policy, { amount: 50, currency: "USD" }, rich).decision, "approve");
  assert.equal(decideFunding(policy, { amount: 300, currency: "USD" }, rich).decision, "escalate"); // > card.limit.tx
  assert.equal(decideFunding({ ...policy, limitTx: 900 }, { amount: 300, currency: "USD" }, rich).decision, "escalate"); // > global ceiling
  assert.equal(decideFunding(policy, { amount: 50, currency: "USD" }, DEFAULT_CONFIG.reserveFloor + 10).decision, "escalate");
  assert.equal(decideFunding(policy, { amount: 50, currency: "EUR" }, rich).decision, "deny");
  assert.equal(decideFunding(policy, { amount: 10.001, currency: "USD" }, rich).decision, "deny");
  assert.equal(decideFunding({ ...policy, status: "frozen" }, { amount: 5, currency: "USD" }, rich).decision, "deny");
});

test("activity: one bad MCC declines, the second freezes", () => {
  const now = Date.now();
  const tx = (mcc: string, failure?: string): IssuingTransaction => ({
    transaction_id: crypto.randomUUID(), card_id: "c", transaction_type: "AUTHORIZATION",
    status: failure ? "FAILED" : "APPROVED", failure_reason: failure,
    transaction_amount: 10, transaction_currency: "USD",
    merchant: { category_code: mcc }, transaction_date: new Date(now).toISOString(),
  });
  assert.equal(evaluateActivity(policy, [tx("5734")], now).action, "none");
  assert.equal(evaluateActivity(policy, [tx("7995", "MERCHANT_CATEGORY_NOT_ALLOWED")], now).action, "none");
  const v = evaluateActivity(policy, [tx("7995", "MERCHANT_CATEGORY_NOT_ALLOWED"), tx("7995")], now);
  assert.equal(v.action, "freeze");

  // Attempts the pre-check blocked count too; old ones fall out of the window.
  const mccBlock = { at: now, code: "MERCHANT_CATEGORY_NOT_ALLOWED" };
  assert.equal(evaluateActivity(policy, [], now, DEFAULT_CONFIG, [mccBlock]).action, "none");
  assert.equal(evaluateActivity(policy, [tx("7995", "MERCHANT_CATEGORY_NOT_ALLOWED")], now, DEFAULT_CONFIG, [mccBlock]).action, "freeze");
  const stale = { at: now - DEFAULT_CONFIG.windowMs - 1, code: "MERCHANT_CATEGORY_NOT_ALLOWED" };
  assert.equal(evaluateActivity(policy, [], now, DEFAULT_CONFIG, [mccBlock, stale]).action, "none");
  const burst = Array.from({ length: DEFAULT_CONFIG.velocityMax + 1 }, () => ({ at: now, code: "LIMIT_EXCEEDED" }));
  assert.equal(evaluateActivity(policy, [], now, DEFAULT_CONFIG, burst).action, "freeze");
});

test("payment pre-check: same codes as the issuer", () => {
  const ok = { amount: 100, currency: "usd", mcc: "5734" };
  assert.deepEqual(precheckPayment(policy, ok), { ok: true });
  const code = (r: ReturnType<typeof precheckPayment>) => (r.ok ? "OK" : r.code);
  assert.equal(code(precheckPayment(policy, { ...ok, amount: 100.01 })), "LIMIT_EXCEEDED");
  assert.equal(code(precheckPayment(policy, { ...ok, mcc: "7995" })), "MERCHANT_CATEGORY_NOT_ALLOWED");
  assert.equal(code(precheckPayment(policy, { ...ok, currency: "EUR" })), "CURRENCY_NOT_ALLOWED");
  assert.equal(code(precheckPayment(policy, { ...ok, amount: 0 })), "INVALID_AMOUNT");
  assert.equal(code(precheckPayment(policy, { ...ok, mcc: "abc" })), "INVALID_MCC");
  assert.equal(code(precheckPayment({ ...policy, status: "frozen" }, ok)), "CARD_FROZEN");
  assert.equal(code(precheckPayment({ ...policy, mccAllow: [] }, { ...ok, mcc: "7995" })), "OK", "empty card.mcc.allow means any");
});

test("approval binds to exact name, amount, currency", async () => {
  const a = newPendingApproval("researcher", 300, "USD", "test", "hector.eth");
  const sig = await signApproval("s3cret", a);
  assert.ok(await verifyApproval("s3cret", a, sig));
  assert.ok(!(await verifyApproval("s3cret", { ...a, amount: 301 }, sig)));
  assert.ok(!(await verifyApproval("s3cret", { ...a, currency: "EUR" }, sig)));
  assert.ok(!(await verifyApproval("s3cret", { ...a, name: "other" }, sig)));
  assert.ok(!(await verifyApproval("other", a, sig)));
});
