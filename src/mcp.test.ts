// The demo script, end to end through the MCP protocol, against a fake
// Airwallex that enforces card controls like the sandbox does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer, authenticate, sha256Hex } from "./mcp.ts";
import { CardService } from "./service.ts";
import { Store } from "./store.ts";
import { FakeIssuer, MemoryKV } from "./testing.ts";
import type { PayeeChecker } from "./policy/payee.ts";
import { generateTapKey, tapSigner, type TapSigner } from "./tap/sign.ts";
import { verifyTap } from "./tap/verify.ts";

const ADMIN = "admin-token";

function setup(checkPayee?: PayeeChecker, tap?: () => Promise<TapSigner>) {
  const kv = new MemoryKV();
  const store = new Store(kv.asKV());
  const issuer = new FakeIssuer();
  const svc = new CardService(store, issuer, {
    approvalSecret: "test-secret",
    cardholderEmail: "agents@x402card.dev",
    approvalUrl: "https://demo.x402card.eth.limo/approve.html#{id}",
    checkPayee,
    tap,
    tapKeysUrl: "https://x/keys",
  });
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
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ["issue_card", "list_cards", "get_card", "pay", "sign_request", "request_funding", "update_policy", "get_approval", "freeze", "list_transactions"]);
  assert.equal((await call("wrong", "tools/list")).status, 401);
  assert.equal((await call(ADMIN, "nope")).error.code, -32601);
});

test("approval card: a ui:// resource linked from pay, request_funding and get_approval", async () => {
  const { call } = setup();
  const init = await call(ADMIN, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.ok(init.result.capabilities.resources);
  const tools = (await call(ADMIN, "tools/list")).result.tools;
  const linked = tools.filter((t: any) => t._meta?.ui?.resourceUri === "ui://xcard/approval.html").map((t: any) => t.name);
  assert.deepEqual(linked, ["pay", "request_funding", "update_policy", "get_approval"]);
  assert.deepEqual((await call(ADMIN, "resources/list")).result.resources.map((r: any) => r.uri), ["ui://xcard/approval.html"]);
  const [res] = (await call(ADMIN, "resources/read", { uri: "ui://xcard/approval.html" })).result.contents;
  assert.equal(res.mimeType, "text/html;profile=mcp-app");
  assert.match(res.text, /eth_signTypedData_v4/);
  assert.ok(!res.text.includes("__API__"), "the API origin is filled in");
  assert.ok(res._meta.ui.csp.connectDomains.length === 1);
  assert.equal((await call(ADMIN, "resources/read", { uri: "ui://other" })).error.code, -32002);
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

  // 2. The agent pays in policy: it clears. 3. Disallowed merchant: blocked before the network.
  const paid = (await tool(agent, "pay", { amount: 42, currency: "USD", mcc: "5734", merchant: "ModelHub API" })).structuredContent;
  assert.equal(paid.decision, "approved");
  const casino = (await tool(agent, "pay", { amount: 18, currency: "USD", mcc: "7995", merchant: "SpinPalace" })).structuredContent;
  assert.equal(casino.decision, "blocked");
  assert.equal(casino.stage, "x402card");
  assert.equal(casino.code, "MERCHANT_CATEGORY_NOT_ALLOWED");
  assert.equal(casino.card_frozen, undefined, "one bad MCC only blocks");
  const txs = (await tool(agent, "list_transactions")).structuredContent.transactions;
  assert.ok(txs.some((t: any) => t.type === "CLEARING" && t.settled && t.amount === 42));
  assert.ok(!txs.some((t: any) => t.mcc === "7995"), "a blocked payment never reaches the issuer");

  // 4. Small top-up auto-approves; $300 escalates and a human approves it.
  const small = (await tool(agent, "request_funding", { amount: 25, currency: "USD", purpose: "embeddings" })).structuredContent;
  assert.equal(small.decision, "approved");
  assert.equal(small.new_monthly_limit, 525);

  const big = (await tool(agent, "request_funding", { amount: 300, currency: "USD", purpose: "dataset license" })).structuredContent;
  assert.equal(big.decision, "pending_human");
  assert.equal(big.approver, "alice.eth");
  assert.match(big.reason, /card\.limit\.tx/);
  assert.equal(big.approval_url, `https://demo.x402card.eth.limo/approve.html#${big.approval_id}`);
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
  const again = (await tool(agent, "pay", { amount: 18, currency: "USD", mcc: "7995", merchant: "SpinPalace" })).structuredContent;
  assert.equal(again.decision, "blocked");
  assert.match(again.card_frozen, /2 disallowed merchant-category attempts/);
  assert.equal((await store.getRecords("researcher"))!["card.status"], "frozen");
  assert.equal(issuer.cards.get(ref.cardId)!.status, "INACTIVE");

  // 6. Frozen means frozen, at both layers.
  const frozenPay = (await tool(agent, "pay", { amount: 5, currency: "USD", mcc: "5734", merchant: "ModelHub API" })).structuredContent;
  assert.equal(frozenPay.code, "CARD_FROZEN");
  assert.equal(issuer.charge(ref.cardId, 5, "USD", "5734").failure_reason, "CARD_INACTIVE");
  assert.ok(!(await call(agent, "tools/list")).result.tools.some((t: any) => t.name === "unfreeze"), "agents can't unfreeze");

  // Frozen card: funding is denied.
  const denied = (await tool(agent, "request_funding", { amount: 5, currency: "USD" })).structuredContent;
  assert.equal(denied.decision, "denied");
});

test("pay: issuer declines what slips past, retries don't double-charge, unfreeze resets the window", async () => {
  const { tool, issuer, store, svc } = setup();
  const issued = await tool(ADMIN, "issue_card", {
    name: "scout",
    policy: { limit_tx: 50, limit_monthly: 60, currencies: ["USD"], mcc_allow: ["5734"], approver: "alice.eth" },
  });
  const agent = issued.structuredContent.agent_token as string;
  const ref = (await store.getCard("scout"))!;
  const pay = async (args: Record<string, unknown>) => (await tool(agent, "pay", { currency: "USD", mcc: "5734", merchant: "ModelHub API", ...args })).structuredContent;

  // Pre-check refusals carry the same codes the issuer uses.
  assert.equal((await pay({ amount: 51 })).code, "LIMIT_EXCEEDED");
  assert.equal((await pay({ amount: 5, currency: "EUR" })).code, "CURRENCY_NOT_ALLOWED");
  assert.equal((await pay({ amount: 5, mcc: "57" })).code, "INVALID_MCC");
  assert.equal((await pay({ amount: 5.001 })).code, "INVALID_AMOUNT");

  // Retrying with the same request_id replays the result instead of charging twice.
  const first = await pay({ amount: 40, request_id: "order-1" });
  const retry = await pay({ amount: 40, request_id: "order-1" });
  assert.equal(first.decision, "approved");
  assert.equal(retry.replayed, true);
  assert.equal((await tool(agent, "list_transactions")).structuredContent.transactions.filter((t: any) => t.type === "CLEARING").length, 1);

  // The issuer is the second layer: if its controls are tighter than the records, it declines.
  await issuer.updateCard(ref.cardId, { controls: { allowed_merchant_categories: ["7372"] } });
  const declined = await pay({ amount: 5 });
  assert.equal(declined.decision, "declined");
  assert.equal(declined.stage, "issuer");
  assert.equal(declined.code, "MERCHANT_CATEGORY_NOT_ALLOWED");

  // Second MCC strike (issuer decline + pre-check block) freezes. A human unfreeze starts a clean window.
  assert.ok((await pay({ amount: 5, mcc: "7995" })).card_frozen);
  await svc.unfreeze("scout", "alice.eth");
  assert.equal((await svc.checkActivity("scout")).frozen, false, "old strikes don't refreeze after a human unfreeze");

  // Feed events tell the two layers apart.
  const kinds = (await store.getEvents("scout")).map((e) => e.kind);
  assert.ok(kinds.includes("blocked") && kinds.includes("declined") && kinds.includes("charged"));
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

test("namespaces: the same label under x402card.eth and xcard.eth are separate cards", async () => {
  const { tool, store } = setup();
  const policy = { limit_tx: 50, limit_monthly: 500, currencies: ["USD"], mcc_allow: ["5734"], approver: "alice.eth" };

  const legacy = await tool(ADMIN, "issue_card", { name: "scout", policy: { ...policy, limit_tx: 10 } });
  assert.equal(legacy.structuredContent.card.name, "scout.x402card.eth", "a bare label stays on x402card.eth");
  const x = await tool(ADMIN, "issue_card", { name: "Scout.XCard.eth", policy });
  assert.ok(!x.isError, x.content?.[0]?.text);
  assert.equal(x.structuredContent.card.name, "scout.xcard.eth");

  assert.ok(await store.getCard("scout"), "x402card.eth keeps the bare-label key");
  assert.equal((await store.getRecords("scout.xcard.eth"))!["card.limit.tx"], "50");
  assert.equal((await store.getRecords("scout"))!["card.limit.tx"], "10");

  // Each token is scoped to its own namespace.
  const xAgent = x.structuredContent.agent_token as string;
  assert.equal((await tool(xAgent, "get_card")).structuredContent.card.name, "scout.xcard.eth");
  assert.match((await tool(xAgent, "get_card", { name: "scout.x402card.eth" })).content[0].text, /forbidden/);

  for (const name of ["ai.xcard.eth", "demo.x402card.eth", "shop.xcard.eth"]) {
    assert.match((await tool(ADMIN, "issue_card", { name, policy })).content[0].text, /reserved/);
  }
  assert.equal((await tool(ADMIN, "issue_card", { name: "demo.xcard.eth", policy })).structuredContent.card.name, "demo.xcard.eth");
  assert.match((await tool(ADMIN, "issue_card", { name: "scout.other.eth", policy })).content[0].text, /bad_name/);
});

// Stands in for ENS: modelhub.eth lists its two origins.
const fakePayees: PayeeChecker = async (name, origin) => {
  const listed: Record<string, string[]> = { "modelhub.eth": ["https://modelhub.example", "https://api.modelhub.example"] };
  if (!listed[name]) return { status: "unverified", name, origin, reason: "no-records" };
  return listed[name].includes(origin)
    ? { status: "verified", name, origin, reason: "origin-bound" }
    : { status: "mismatch", name, origin, reason: "origin-not-listed" };
};

test("payee gate: verified pays, a lookalike is blocked then freezes, an unknown payee waits for a human", async () => {
  const { tool, issuer, store, svc } = setup(fakePayees);
  const issued = await tool(ADMIN, "issue_card", {
    name: "buyer.xcard.eth",
    policy: { limit_tx: 50, limit_monthly: 500, currencies: ["USD"], mcc_allow: ["5734"], approver: "alice.eth", payee: "verified-or-escalate" },
  });
  assert.ok(!issued.isError, issued.content?.[0]?.text);
  assert.equal(issued.structuredContent.card.records["card.payee"], "verified-or-escalate");
  const agent = issued.structuredContent.agent_token as string;
  const ref = (await store.getCard("buyer.xcard.eth"))!;
  const pay = async (args: Record<string, unknown>) =>
    (await tool(agent, "pay", { currency: "USD", mcc: "5734", merchant: "ModelHub API", ...args })).structuredContent;
  const clearings = () => issuer.cards.get(ref.cardId)!.txs.filter((t) => t.transaction_type === "CLEARING").length;

  // 1. The checkout's origin is listed by the name: paid, and the feed names it.
  const ok = await pay({ amount: 20, merchant_url: "https://api.modelhub.example/v1/checkout", payee_name: "modelhub.eth" });
  assert.equal(ok.decision, "approved");
  assert.equal(ok.payee.status, "verified");
  assert.match((await store.getEvents("buyer.xcard.eth"))[0].detail, /modelhub\.eth ✓/);

  // 2. A lookalike checkout claiming the same name: blocked before the network. Twice freezes.
  const phish = await pay({ amount: 20, merchant_url: "https://modelhub-pay.example/checkout", payee_name: "modelhub.eth" });
  assert.deepEqual([phish.decision, phish.code, phish.card_frozen], ["blocked", "PAYEE_MISMATCH", undefined]);
  assert.equal(clearings(), 1, "a blocked payment never reaches the issuer");

  // 3. No name to check: held for card.approver, nothing charged yet.
  const held = await pay({ amount: 30, merchant_url: "https://new-vendor.example", purpose: "GPU hours", request_id: "gpu-1" });
  assert.equal(held.decision, "pending_human");
  assert.equal(held.approver, "alice.eth");
  assert.match(held.reason, /not verified \(no-payee-name\)/);
  assert.equal(clearings(), 1);
  const pending = (await tool(agent, "get_card")).structuredContent.card.pending_approvals;
  assert.deepEqual(pending.map((a: any) => [a.kind, a.merchant]), [["payment", "ModelHub API"]]);
  assert.equal((await pay({ amount: 30, merchant_url: "https://new-vendor.example", request_id: "gpu-1" })).decision, "pending_human", "a retry replays the hold");

  // Approving charges exactly the held payment, and a retry now sees the outcome.
  const decided = await svc.decide(held.approval_id, true, "alice.eth");
  assert.equal(decided.charge?.approved, true);
  assert.equal(clearings(), 2);
  const replay = await pay({ amount: 30, merchant_url: "https://new-vendor.example", request_id: "gpu-1" });
  assert.deepEqual([replay.decision, replay.replayed], ["approved", true]);

  // A second lookalike attempt freezes the card.
  const again = await pay({ amount: 5, merchant_url: "https://modelhub-pay.example", payee_name: "modelhub.eth" });
  assert.match(again.card_frozen, /2 payee-mismatch attempts/);
  assert.equal(issuer.cards.get(ref.cardId)!.status, "INACTIVE");
});

test("payee gate: verified-only and the allow-list; a denied hold never charges", async () => {
  const { tool, issuer, store, svc } = setup(fakePayees);
  const policy = { limit_tx: 50, limit_monthly: 500, currencies: ["USD"], approver: "alice.eth" };
  const strict = await tool(ADMIN, "issue_card", { name: "strict", policy: { ...policy, payee: "verified-only", payee_allow: ["other.eth"] } });
  const agent = strict.structuredContent.agent_token as string;
  const pay = async (args: Record<string, unknown>) =>
    (await tool(agent, "pay", { amount: 5, currency: "USD", mcc: "5734", merchant: "ModelHub API", ...args })).structuredContent;

  assert.equal((await pay({})).code, "PAYEE_UNVERIFIED");
  assert.equal((await pay({ merchant_url: "https://modelhub.example", payee_name: "modelhub.eth" })).code, "PAYEE_NOT_ALLOWED");
  assert.match((await tool(agent, "pay", { amount: 5, currency: "USD", mcc: "5734", merchant: "M", merchant_url: "not a url" })).content[0].text, /bad_input/);
  assert.match((await tool(ADMIN, "issue_card", { name: "loose", policy: { ...policy, payee_allow: ["a.eth"] } })).content[0].text, /bad_policy/);

  // Cards without card.payee pay as before, with or without a payee.
  const legacy = await tool(ADMIN, "issue_card", { name: "legacy", policy });
  const legacyAgent = legacy.structuredContent.agent_token as string;
  const r = (await tool(legacyAgent, "pay", { amount: 5, currency: "USD", mcc: "5734", merchant: "M", merchant_url: "https://x.example", payee_name: "modelhub.eth" })).structuredContent;
  assert.deepEqual([r.decision, r.payee.status], ["approved", "mismatch"]);

  // A denied hold: no charge, and the agent's retry learns it was denied.
  const esc = await tool(ADMIN, "issue_card", { name: "esc", policy: { ...policy, payee: "verified-or-escalate" } });
  const escAgent = esc.structuredContent.agent_token as string;
  const held = (await tool(escAgent, "pay", { amount: 9, currency: "USD", mcc: "5734", merchant: "M", request_id: "r1" })).structuredContent;
  await svc.decide(held.approval_id, false, "alice.eth");
  const ref = (await store.getCard("esc"))!;
  assert.equal(issuer.cards.get(ref.cardId)!.txs.length, 0);
  const after = (await tool(escAgent, "pay", { amount: 9, currency: "USD", mcc: "5734", merchant: "M", request_id: "r1" })).structuredContent;
  assert.equal(after.code, "DENIED_BY_APPROVER");
});

test("TAP: browse signs anywhere; checkout only after an approved payment to that merchant", async () => {
  const signer = tapSigner(await generateTapKey());
  const { tool, svc } = setup(fakePayees, () => signer);
  const issued = await tool(ADMIN, "issue_card", {
    name: "shopper.xcard.eth",
    policy: { limit_tx: 50, limit_monthly: 500, currencies: ["USD"], approver: "alice.eth", payee: "verified-or-escalate" },
  });
  const agent = issued.structuredContent.agent_token as string;
  const sign = (url: string, purpose: string) => tool(agent, "sign_request", { url, purpose });
  const merchantCheck = async (url: string, headers: Record<string, string>) => {
    const s = await signer;
    const seen = new Set<string>();
    return verifyTap({ url, headers: new Headers(headers) }, {
      resolveKey: async (kid) => (kid === s.keyid ? s.publicJwk : null),
      nonces: { claim: async (n) => (seen.has(n) ? false : (seen.add(n), true)) },
    });
  };

  // Browsing a product page: any site.
  const browse = (await sign("https://modelhub.example/models/gpt", "browse")).structuredContent;
  assert.equal(browse.tag, "agent-browser-auth");
  assert.equal(browse.keys_url, "https://x/keys");
  assert.equal((await merchantCheck("https://modelhub.example/models/gpt", browse.headers)).ok, true);

  // Checkout before paying: refused. After a verified, approved payment: signed, and the merchant accepts it.
  const checkoutUrl = "https://api.modelhub.example/checkout";
  assert.match((await sign(checkoutUrl, "checkout")).content[0].text, /no_approved_payment/);
  const paid = (await tool(agent, "pay", { amount: 20, currency: "USD", mcc: "5734", merchant: "ModelHub API", merchant_url: checkoutUrl, payee_name: "modelhub.eth" })).structuredContent;
  assert.equal(paid.decision, "approved");
  const checkout = (await sign(checkoutUrl, "checkout")).structuredContent;
  assert.equal(checkout.tag, "agent-payer-auth");
  const verdict = await merchantCheck(checkoutUrl, checkout.headers);
  assert.ok(verdict.ok && verdict.tag === "agent-payer-auth");
  // The window is per origin: paying modelhub doesn't let the agent sign a checkout elsewhere.
  assert.match((await sign("https://modelhub-pay.example/checkout", "checkout")).content[0].text, /no_approved_payment/);

  // A held payment opens the window only once a human approves it.
  const held = (await tool(agent, "pay", { amount: 15, currency: "USD", mcc: "5734", merchant: "New Vendor", merchant_url: "https://new-vendor.example/buy" })).structuredContent;
  assert.match((await sign("https://new-vendor.example/buy", "checkout")).content[0].text, /no_approved_payment/);
  await svc.decide(held.approval_id, true, "alice.eth");
  assert.equal((await sign("https://new-vendor.example/buy", "checkout")).structuredContent.tag, "agent-payer-auth");

  // A frozen card signs nothing.
  await tool(agent, "freeze", { reason: "test" });
  assert.match((await sign("https://modelhub.example/", "browse")).content[0].text, /frozen/);
});

test("TAP: sign_request needs a configured key", async () => {
  const { tool } = setup();
  const issued = await tool(ADMIN, "issue_card", { name: "nokey", policy: { limit_tx: 5, limit_monthly: 50, currencies: ["USD"], approver: "a.eth" } });
  const r = await tool(issued.structuredContent.agent_token, "sign_request", { url: "https://x.example/", purpose: "browse" });
  assert.match(r.content[0].text, /tap_not_configured/);
});

test("owner (wallet sign-in): list_cards, a name picks among several, others' cards are off limits", async () => {
  const { tool, svc, store } = setup();
  const policy = { limit_tx: 50, limit_monthly: 500, currencies: ["USD"], approver: "alice.eth" };
  for (const name of ["a.xcard.eth", "b.xcard.eth", "c.xcard.eth"]) await tool(ADMIN, "issue_card", { name, policy });
  const owner = (labels: string[]) => async (name: string, args: Record<string, unknown> = {}) => {
    const req = new Request("https://x/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    return ((await (await new McpServer(svc, store, { kind: "owner", labels }).handle(req)).json()) as any).result;
  };
  const two = owner(["a.xcard.eth", "b.xcard.eth"]);
  assert.deepEqual((await two("list_cards")).structuredContent.cards.map((c: any) => c.name), ["a.xcard.eth", "b.xcard.eth"]);
  assert.match((await two("get_card")).content[0].text, /name is required: one of a\.xcard\.eth, b\.xcard\.eth/);
  assert.equal((await two("get_card", { name: "b.xcard.eth" })).structuredContent.card.name, "b.xcard.eth");
  assert.match((await two("get_card", { name: "c.xcard.eth" })).content[0].text, /forbidden/);
  // One card: the name may be left out.
  assert.equal((await owner(["c.xcard.eth"])("get_card")).structuredContent.card.name, "c.xcard.eth");
  // Approvals: only those of the owner's cards.
  const asked = (await tool(ADMIN, "request_funding", { name: "c.xcard.eth", amount: 300, currency: "USD" })).structuredContent;
  assert.equal(asked.decision, "pending_human");
  assert.match((await two("get_approval", { approval_id: asked.approval_id })).content[0].text, /not_found/);
  assert.equal((await owner(["c.xcard.eth"])("get_approval", { approval_id: asked.approval_id })).structuredContent.approval.status, "pending");
});
