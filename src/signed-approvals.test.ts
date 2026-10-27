// card.approver decides with a wallet signature: the chat path (get_approval ->
// PayBox signs typed_data -> submit_approval) and the public /approvals/:id
// endpoint behind the approval page. Real secp256k1 signatures throughout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyTypedData, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { McpServer, authenticate } from "./mcp.ts";
import { CardService } from "./service.ts";
import { Store } from "./store.ts";
import { FakeIssuer, MemoryKV } from "./testing.ts";
import { ensApproverAuth } from "./policy/approver.ts";
import worker, { type Env } from "./index.ts";

const ADMIN = "admin-token";
const alice = privateKeyToAccount(generatePrivateKey());
const mallory = privateKeyToAccount(generatePrivateKey());

// ENS as far as these tests go: alice.eth has an address, nobody.eth has none.
const ens: Record<string, `0x${string}`> = { "alice.eth": alice.address };
const client = {
  getEnsAddress: async ({ name }: { name: string }) => ens[name] ?? null,
  // EOA check only; the Worker's client also handles ERC-1271/6492 over RPC.
  verifyTypedData: (args: Parameters<typeof verifyTypedData>[0]) => verifyTypedData(args),
} as unknown as PublicClient;

function setup() {
  const store = new Store(new MemoryKV().asKV());
  const issuer = new FakeIssuer();
  const svc = new CardService(store, issuer, {
    approvalSecret: "test-secret",
    cardholderEmail: "agents@x402card.dev",
    approverAuth: ensApproverAuth(client),
  });
  let id = 0;
  const tool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const req = new Request("https://x/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
    });
    const caller = (await authenticate(req.clone(), store, ADMIN))!;
    return ((await (await new McpServer(svc, store, caller).handle(req)).json()) as any).result;
  };
  const issue = async (name: string, approver = "alice.eth") => {
    const r = await tool(ADMIN, "issue_card", {
      name,
      policy: { limit_tx: 50, limit_monthly: 500, currencies: ["USD"], mcc_allow: ["5734"], approver, payee: "verified-or-escalate" },
    });
    assert.ok(!r.isError, r.content?.[0]?.text);
    return r.structuredContent.agent_token as string;
  };
  return { store, issuer, svc, tool, issue };
}

// What a wallet does with eth_signTypedData_v4 JSON: parse it and sign it as is.
const signJson = (account: typeof alice, td: unknown) => account.signTypedData(JSON.parse(JSON.stringify(td)));

test("a held payment is approved in chat with the approver's wallet signature", async () => {
  const { tool, issue, issuer } = setup();
  const agent = await issue("scout.xcard.eth");

  const held = (await tool(agent, "pay", { amount: 15, currency: "USD", mcc: "5734", merchant: "New Vendor", merchant_url: "https://new-vendor.example/buy" })).structuredContent;
  assert.equal(held.decision, "pending_human");

  const view = (await tool(agent, "get_approval", { approval_id: held.approval_id })).structuredContent;
  assert.equal(view.card, "scout.xcard.eth");
  assert.equal(view.signable, true);
  const msg = view.typed_data.approve.message;
  assert.deepEqual(
    [msg.decision, msg.card, msg.kind, msg.amount, msg.currency, msg.merchant, msg.checkout, msg.approver],
    ["approve", "scout.xcard.eth", "payment", "15", "USD", "New Vendor", "https://new-vendor.example/buy", "alice.eth"],
  );
  assert.equal(view.typed_data.deny.message.decision, "deny");
  assert.equal(view.approval.sig, undefined, "the HMAC never leaves the Worker");

  // Someone else's wallet, or the deny message offered as an approval, is refused.
  const bad = async (signature: string, approve = true) => {
    const r = await tool(agent, "submit_approval", { approval_id: held.approval_id, approve, signature });
    assert.ok(r.isError);
    return r.structuredContent.error.code;
  };
  assert.equal(await bad(await signJson(mallory, view.typed_data.approve)), "bad_signature");
  assert.equal(await bad(await signJson(alice, view.typed_data.deny)), "bad_signature");
  assert.equal(await bad("0x1234"), "bad_signature");

  const ok = await tool(agent, "submit_approval", { approval_id: held.approval_id, approve: true, signature: await signJson(alice, view.typed_data.approve) });
  assert.ok(!ok.isError, ok.content?.[0]?.text);
  assert.equal(ok.structuredContent.approval.status, "approved");
  assert.equal(ok.structuredContent.approval.charge.approved, true);
  assert.equal(ok.structuredContent.approval.sig, undefined);
  const [card] = issuer.cards.values();
  assert.ok(card.txs.some((t) => t.transaction_type === "CLEARING" && t.transaction_amount === 15), "approving charged the card");

  // The same signature can't decide it twice.
  assert.equal(await bad(await signJson(alice, view.typed_data.approve)), "already_decided");
});

test("funding: a signed approval raises the allowance; a signed denial refuses it", async () => {
  const { tool, issue } = setup();
  const agent = await issue("researcher.xcard.eth");
  const ask = async () => (await tool(agent, "request_funding", { amount: 300, currency: "USD", purpose: "dataset" })).structuredContent;

  const a = await ask();
  const view = (await tool(agent, "get_approval", { approval_id: a.approval_id })).structuredContent;
  assert.equal(view.typed_data.approve.message.kind, "funding");
  const r = await tool(agent, "submit_approval", { approval_id: a.approval_id, approve: true, signature: await signJson(alice, view.typed_data.approve) });
  assert.equal(r.structuredContent.card.records["card.limit.monthly"], "800");

  const b = await ask();
  const v2 = (await tool(agent, "get_approval", { approval_id: b.approval_id })).structuredContent;
  // A signature over another approval's message doesn't carry over.
  const reused = await tool(agent, "submit_approval", { approval_id: b.approval_id, approve: true, signature: await signJson(alice, view.typed_data.approve) });
  assert.equal(reused.structuredContent.error.code, "bad_signature");
  const d = await tool(agent, "submit_approval", { approval_id: b.approval_id, approve: false, signature: await signJson(alice, v2.typed_data.deny) });
  assert.equal(d.structuredContent.approval.status, "denied");
  assert.equal(d.structuredContent.card.records["card.limit.monthly"], "800");
});

test("scope and approvers that can't sign", async () => {
  const { tool, issue } = setup();
  const scout = await issue("scout.xcard.eth");
  const other = await issue("other.xcard.eth");
  const held = (await tool(scout, "pay", { amount: 15, currency: "USD", mcc: "5734", merchant: "New Vendor" })).structuredContent;

  // Another card's token can't see or decide it; the admin can see it.
  assert.equal((await tool(other, "get_approval", { approval_id: held.approval_id })).structuredContent.error.code, "not_found");
  const sig = await signJson(alice, (await tool(ADMIN, "get_approval", { approval_id: held.approval_id })).structuredContent.typed_data.approve);
  assert.equal((await tool(other, "submit_approval", { approval_id: held.approval_id, approve: true, signature: sig })).structuredContent.error.code, "not_found");

  // Free text can only be decided in the operator console; a name with no address can't sign.
  const ops = await issue("ops.xcard.eth", "the ops team");
  const h2 = (await tool(ops, "pay", { amount: 15, currency: "USD", mcc: "5734", merchant: "New Vendor" })).structuredContent;
  const v = (await tool(ops, "get_approval", { approval_id: h2.approval_id })).structuredContent;
  assert.equal(v.signable, false);
  assert.equal(v.typed_data, undefined);
  assert.equal((await tool(ops, "submit_approval", { approval_id: h2.approval_id, approve: true, signature: sig })).structuredContent.error.code, "approver_cannot_sign");

  const nobody = await issue("nobody.xcard.eth", "nobody.eth");
  const h3 = (await tool(nobody, "pay", { amount: 15, currency: "USD", mcc: "5734", merchant: "New Vendor" })).structuredContent;
  const r = await tool(nobody, "submit_approval", { approval_id: h3.approval_id, approve: true, signature: sig });
  assert.equal(r.structuredContent.error.code, "approver_cannot_sign");
  assert.match(r.structuredContent.error.message, /no ETH address/);
});

test("public /approvals/:id: GET the typed data, POST the signature, no token", async () => {
  const env = {
    KV: new MemoryKV().asKV(),
    ISSUER: "fake",
    MCP_ADMIN_TOKEN: ADMIN,
    APPROVAL_SECRET: "s",
    GATEWAY_SIGNER_KEY: "0x" + "11".repeat(32),
  } as unknown as Env;
  const call = (method: string, path: string, body?: unknown, token?: string) =>
    worker.fetch(new Request("https://w" + path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }), env);

  // A free-text approver keeps this test off mainnet: the route works, the signature path refuses cleanly.
  const issued = (await (await call("POST", "/api/cards", { name: "web.xcard.eth", policy: { limit_tx: 50, limit_monthly: 500, currencies: ["USD"], approver: "the ops team" } }, ADMIN)).json()) as any;
  const mcp = await call("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "request_funding", arguments: { amount: 300, currency: "USD" } } }, issued.agent_token);
  const id = ((await mcp.json()) as any).result.structuredContent.approval_id;

  const got = await call("GET", `/approvals/${id}`);
  assert.equal(got.status, 200);
  const view = (await got.json()) as any;
  assert.equal(view.card, "web.xcard.eth");
  assert.equal(view.approval.sig, undefined);
  assert.equal(view.signable, false);

  const post = await call("POST", `/approvals/${id}`, { approve: true, signature: "0x" + "ab".repeat(65) });
  assert.equal(post.status, 400);
  assert.equal(((await post.json()) as any).error.code, "approver_cannot_sign");
  assert.equal((await call("POST", `/approvals/${id}`, { approve: true })).status, 400);
  assert.equal((await call("GET", `/approvals/${crypto.randomUUID()}`)).status, 404);
});
