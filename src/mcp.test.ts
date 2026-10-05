// The demo script, end to end through the MCP protocol, against a fake
// Airwallex that enforces card controls like the sandbox does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer, authenticate, sha256Hex } from "./mcp.ts";
import { CardService } from "./service.ts";
import { Store } from "./store.ts";
import { FakeIssuer, MemoryKV } from "./testing.ts";

const ADMIN = "admin-token";

function setup() {
  const kv = new MemoryKV();
  const store = new Store(kv.asKV());
  const issuer = new FakeIssuer();
  const svc = new CardService(store, issuer, { approvalSecret: "test-secret", cardholderEmail: "agents@x402card.dev" });
  let id = 0;
  async function call(token: string, method: string, params: Record<string, unknown> = {}) {
    const req = new Request("https://x/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const caller = await authenticate(req.clone(), store, ADMIN);
    if (!caller) return { status: 401 };
    const res = await new McpServer(svc, store, caller).handle(req);
    return { status: res.status, ...((await res.json()) as object) } as any;
  }
  const tool = async (token: string, name: string, args: Record<string, unknown> = {}) =>
    (await call(token, "tools/call", { name, arguments: args })).result;
  return { kv, store, issuer, svc, call, tool };
}

test("protocol: initialize, tools/list, auth", async () => {
  const { call } = setup();
  const init = await call(ADMIN, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.ok(init.result.capabilities.tools);
  const list = await call(ADMIN, "tools/list");
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ["issue_card", "get_card", "request_funding", "freeze", "list_transactions"]);
  assert.equal((await call("wrong", "tools/list")).status, 401);
  assert.equal((await call(ADMIN, "nope")).error.code, -32601);
});

test("demo script through MCP", async () => {
  const { tool, issuer, store, svc, call } = setup();

  // 1. Issue researcher.x402card.eth
  const issued = await tool(ADMIN, "issue_card", {
    name: "researcher.x402card.eth",
    policy: { limit_tx: 50, limit_monthly: 500, currencies: ["USD"], mcc_allow: ["5734", "7372"], approver: "alice.eth" },
  });
  assert.ok(!issued.isError, issued.content?.[0]?.text);
  const agent = issued.structuredContent.agent_token as string;
  assert.match(agent, /^x4c_[0-9a-f]{64}$/);
  const card = issued.structuredContent.card;
  assert.equal(card.name, "researcher.x402card.eth");
  assert.equal(card.records["card.status"], "active");
  assert.equal(card.records["card.mcc.allow"], "5734,7372");
  const text = JSON.stringify(issued);
  const ref = (await store.getCard("researcher"))!;
  assert.ok(!text.includes(ref.cardId), "Airwallex card id must not leak to the agent");

  // Agent token: no issue_card, scoped to its own name.
  const agentTools = (await call(agent, "tools/list")).result.tools.map((t: any) => t.name);
  assert.ok(!agentTools.includes("issue_card"));
  const other = await tool(agent, "get_card", { name: "someoneelse" });
  assert.ok(other.isError);
  assert.match(other.content[0].text, /forbidden/);

  // 2. Allowed charge clears; 3. disallowed merchant declines.
  issuer.charge(ref.cardId, 42, "USD", "5734", "ModelHub API");
  issuer.charge(ref.cardId, 18, "USD", "7995", "SpinPalace");
  const txs = (await tool(agent, "list_transactions")).structuredContent.transactions;
  assert.ok(txs.some((t: any) => t.type === "CLEARING" && t.settled && t.amount === 42));
  assert.ok(txs.some((t: any) => t.decline_reason === "MERCHANT_CATEGORY_NOT_ALLOWED" && t.mcc === "7995"));
  assert.equal((await svc.checkActivity("researcher")).frozen, false, "one bad MCC only declines");

  // 4. Small top-up auto-approves; $300 escalates and a human approves it.
  const small = (await tool(agent, "request_funding", { amount: 25, currency: "USD", purpose: "embeddings" })).structuredContent;
  assert.equal(small.decision, "approved");
  assert.equal(small.new_monthly_limit, 525);

  const big = (await tool(agent, "request_funding", { amount: 300, currency: "USD", purpose: "dataset license" })).structuredContent;
  assert.equal(big.decision, "pending_human");
  assert.equal(big.approver, "alice.eth");
  assert.match(big.reason, /card\.limit\.tx/);
  const pending = (await tool(agent, "get_card")).structuredContent.card.pending_approvals;
  assert.equal(pending.length, 1);

  // Tampering with the stored approval (e.g. amount) is caught.
  const stored = (await store.getApproval(big.approval_id))!;
  await store.putApproval({ ...stored, amount: 3000 });
  await assert.rejects(svc.decide(big.approval_id, true, "alice.eth"), /does not match/);
  await store.putApproval(stored);

  await svc.decide(big.approval_id, true, "alice.eth");
  await assert.rejects(svc.decide(big.approval_id, true, "alice.eth"), /already/);
  const after = (await tool(agent, "get_card")).structuredContent.card;
  assert.equal(after.records["card.limit.monthly"], "825");
  const monthly = issuer.cards.get(ref.cardId)!.controls.transaction_limits.limits.find((l) => l.interval === "MONTHLY")!;
  assert.equal(monthly.amount, 825, "Airwallex control raised with the record");

  // 5. Anomaly: a second disallowed-MCC attempt freezes the card and flips the record.
  issuer.charge(ref.cardId, 18, "USD", "7995", "SpinPalace");
  const verdict = await svc.checkActivity("researcher");
  assert.equal(verdict.frozen, true);
  assert.equal((await store.getRecords("researcher"))!["card.status"], "frozen");
  assert.equal(issuer.cards.get(ref.cardId)!.status, "INACTIVE");
  assert.equal(issuer.charge(ref.cardId, 5, "USD", "5734").failure_reason, "CARD_INACTIVE");

  // Frozen card: funding is denied.
  const denied = (await tool(agent, "request_funding", { amount: 5, currency: "USD" })).structuredContent;
  assert.equal(denied.decision, "denied");
});

test("issue_card guards", async () => {
  const { tool } = setup();
  const policy = { limit_tx: 50, limit_monthly: 500, currencies: ["USD"], approver: "alice.eth" };
  assert.match((await tool(ADMIN, "issue_card", { name: "demo", policy })).content[0].text, /reserved/);
  assert.match((await tool(ADMIN, "issue_card", { name: "Bad_Name!", policy })).content[0].text, /bad_name/);
  assert.match((await tool(ADMIN, "issue_card", { name: "x", policy: { ...policy, limit_tx: 900 } })).content[0].text, /bad_policy/);
  assert.ok(!(await tool(ADMIN, "issue_card", { name: "scout", policy })).isError);
  assert.match((await tool(ADMIN, "issue_card", { name: "scout", policy })).content[0].text, /exists/);
});

test("agent tokens are stored hashed", async () => {
  const { tool, kv } = setup();
  const r = await tool(ADMIN, "issue_card", { name: "scout", policy: { limit_tx: 50, limit_monthly: 500, currencies: ["USD"], approver: "a.eth" } });
  const token = r.structuredContent.agent_token;
  const keys = (await kv.list({ prefix: "tok:" })).keys.map((k) => k.name);
  assert.deepEqual(keys, [`tok:${await sha256Hex(token)}`]);
});
