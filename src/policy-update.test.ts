// update_policy: tightening applies at once, loosening waits for card.approver's
// wallet signature over every change; the daily limit reaches the card controls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyTypedData, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { McpServer, authenticate } from "./mcp.ts";
import { CardService } from "./service.ts";
import { Store } from "./store.ts";
import { FakeIssuer, MemoryKV } from "./testing.ts";
import { ensApproverAuth } from "./policy/approver.ts";
import { planChanges } from "./policy/changes.ts";
import { parseRecords, PolicyError } from "./policy/records.ts";
import { precheckPayment, toAuthorizationControls } from "./policy/engine.ts";

const ADMIN = "admin-token";
const alice = privateKeyToAccount(generatePrivateKey());
const client = {
  getEnsAddress: async ({ name }: { name: string }) => (name === "alice.eth" ? alice.address : null),
  verifyTypedData: (args: Parameters<typeof verifyTypedData>[0]) => verifyTypedData(args),
} as unknown as PublicClient;

const base = parseRecords({
  "card.limit.tx": "50", "card.limit.monthly": "500", "card.currencies": "USD",
  "card.mcc.allow": "5734,7372", "card.approver": "alice.eth", "card.payee": "verified-or-escalate",
});

test("records: the daily limit sits between per transaction and monthly", () => {
  assert.equal(base.limitDaily, undefined);
  assert.equal(parseRecords({ ...rec(), "card.limit.daily": "200" }).limitDaily, 200);
  assert.throws(() => parseRecords({ ...rec(), "card.limit.daily": "20" }), PolicyError, "below per transaction");
  assert.throws(() => parseRecords({ ...rec(), "card.limit.daily": "900" }), PolicyError, "above monthly");
  const limits = toAuthorizationControls(parseRecords({ ...rec(), "card.limit.daily": "200" })).transaction_limits.limits;
  assert.deepEqual(limits.map((l) => [l.interval, l.amount]), [["PER_TRANSACTION", 50], ["DAILY", 200], ["MONTHLY", 500]]);
  assert.ok(!toAuthorizationControls(base).transaction_limits.limits.some((l) => l.interval === "DAILY"));
  const capped = parseRecords({ ...rec(), "card.limit.tx": "50", "card.limit.daily": "50" });
  assert.equal(precheckPayment(capped, { amount: 50, currency: "USD", mcc: "5734" }).ok, true);
});

test("planChanges: what tightens and what loosens", () => {
  const loose = (input: Record<string, string>) => planChanges(base, input).loosens;
  assert.equal(loose({ "card.limit.tx": "20" }), false);
  assert.equal(loose({ "card.limit.tx": "100" }), true);
  assert.equal(loose({ "card.limit.daily": "200" }), false, "adding a daily limit tightens");
  const daily = parseRecords({ ...rec(), "card.limit.daily": "200" });
  assert.equal(planChanges(daily, { "card.limit.daily": "" }).loosens, true, "removing it loosens");
  assert.equal(planChanges(daily, { "card.limit.daily": "300" }).loosens, true);
  assert.equal(loose({ "card.mcc.allow": "5734" }), false);
  assert.equal(loose({ "card.mcc.allow": "5734,5999" }), true);
  assert.equal(loose({ "card.mcc.allow": "" }), true, "empty = any category");
  assert.equal(loose({ "card.payee": "verified-only" }), false);
  assert.equal(loose({ "card.payee": "any" }), true);
  assert.equal(loose({ "card.payee.allow": "shop.xcard.eth" }), false, "a payee list narrows any verified payee");
  assert.equal(planChanges(base, { "card.limit.tx": "50" }).changes.length, 0);
  assert.throws(() => planChanges(base, { "card.approver": "mallory.eth" } as never), PolicyError);
  assert.throws(() => planChanges(base, { "card.limit.tx": "900" }), PolicyError, "still validated as a whole");
});

test("update_policy: tighten now, loosen after the approver signs, and the card controls follow", async () => {
  const store = new Store(new MemoryKV().asKV());
  const issuer = new FakeIssuer();
  const svc = new CardService(store, issuer, {
    approvalSecret: "s", cardholderEmail: "a@x.dev", approvalUrl: "https://x-card.dev/approve.html#{id}", approverAuth: ensApproverAuth(client),
  });
  let id = 0;
  const tool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const req = new Request("https://x/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
    });
    return ((await (await new McpServer(svc, store, (await authenticate(req.clone(), store, ADMIN))!).handle(req)).json()) as any).result;
  };
  const issued = await tool(ADMIN, "issue_card", {
    name: "demo.xcard.eth",
    policy: { limit_tx: 50, limit_monthly: 500, currencies: ["USD"], mcc_allow: ["5734"], approver: "alice.eth" },
  });
  const agent = issued.structuredContent.agent_token as string;
  const cardId = (await store.getCard("demo.xcard.eth"))!.cardId;
  const controls = () => issuer.cards.get(cardId)!.controls.transaction_limits.limits.map((l) => `${l.interval}:${l.amount}`).join(" ");

  // Tighten: a daily limit of $200 applies at once, on the card too.
  const t = (await tool(agent, "update_policy", { limit_daily: 200 })).structuredContent;
  assert.equal(t.decision, "applied");
  assert.equal(t.changes, "card.limit.daily none → 200");
  assert.equal(controls(), "PER_TRANSACTION:50 DAILY:200 MONTHLY:500");

  // Loosen: nothing changes until alice signs.
  const l = (await tool(agent, "update_policy", { limit_daily: 300, limit_tx: 100, reason: "bigger GPU jobs" })).structuredContent;
  assert.equal(l.decision, "pending_human");
  assert.equal(l.changes, "card.limit.tx 50 → 100; card.limit.daily 200 → 300");
  assert.match(l.approval_url, /^https:\/\/x-card\.dev\/approve\.html#/);
  assert.equal((await store.getRecords("demo.xcard.eth"))!["card.limit.tx"], "50");

  const v = (await svc.approvalView(l.approval_id)) as any;
  assert.equal(v.typed_data.approve.primaryType, "PolicyChange");
  assert.equal(v.typed_data.approve.message.changes, "card.limit.tx 50 → 100; card.limit.daily 200 → 300");
  const mallory = privateKeyToAccount(generatePrivateKey());
  await assert.rejects(svc.decideSigned(l.approval_id, true, await mallory.signTypedData(typed(v.typed_data.approve))), /not signed by alice\.eth/);
  // A signature over the deny can't be used to approve.
  await assert.rejects(svc.decideSigned(l.approval_id, true, await alice.signTypedData(typed(v.typed_data.deny))), /not signed/);
  const done = await svc.decideSigned(l.approval_id, true, await alice.signTypedData(typed(v.typed_data.approve)));
  assert.equal(done.status, "approved");
  assert.equal(controls(), "PER_TRANSACTION:100 DAILY:300 MONTHLY:500");
  const events = (await store.getEvents("demo.xcard.eth")).map((e) => e.kind);
  assert.deepEqual(events.slice(0, 2), ["policy", "escalated"]);

  // A request whose base moved since is refused rather than applied on top.
  const stale = (await tool(agent, "update_policy", { limit_monthly: 800 })).structuredContent;
  await tool(agent, "update_policy", { limit_monthly: 450 });
  const sv = (await svc.approvalView(stale.approval_id)) as any;
  await assert.rejects(svc.decideSigned(stale.approval_id, true, await alice.signTypedData(typed(sv.typed_data.approve))), /changed since the request/);

  // Payments above the daily limit stop at the pre-check; the operator applies loosening directly.
  assert.equal((await tool(ADMIN, "update_policy", { name: "demo.xcard.eth", limit_daily: 0 })).structuredContent.decision, "applied");
  assert.equal(controls(), "PER_TRANSACTION:100 MONTHLY:450");
  assert.match((await tool(agent, "update_policy", {})).content[0].text, /bad_input/);
  assert.match((await tool(agent, "update_policy", { limit_daily: 9999 })).content[0].text, /bad_policy/);
});

function rec() {
  return { "card.limit.tx": "50", "card.limit.monthly": "500", "card.currencies": "USD", "card.approver": "alice.eth" };
}

// The page sends eth_signTypedData_v4 JSON; a viem account signs the same thing.
function typed(td: any) {
  const { EIP712Domain: _d, ...types } = td.types;
  return { domain: td.domain, types, primaryType: td.primaryType, message: { ...td.message, expires: BigInt(td.message.expires) } } as any;
}
