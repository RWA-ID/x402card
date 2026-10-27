// card.approver decides with a wallet signature on the approval page: the
// service path (approvalView -> sign -> decideSigned), the public
// /approvals/:id endpoint, and what an agent sees over MCP (status only, no
// way to submit). Real secp256k1 signatures throughout.
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
  // What the approval page does: the view's typed data, signed, then POSTed.
  const view = (id: string, scope?: string) => svc.approvalView(id, scope) as Promise<any>;
  const submit = async (id: string, approve: boolean, signature: string, scope?: string): Promise<any> => {
    try {
      return await svc.decideSigned(id, approve, signature, scope);
    } catch (e: any) {
      return { error: { code: e.code, message: e.message } };
    }
  };
  return { store, issuer, svc, tool, issue, view, submit };
}

// What a wallet does with eth_signTypedData_v4 JSON: parse it and sign it as is.
const signJson = (account: typeof alice, td: unknown) => account.signTypedData(JSON.parse(JSON.stringify(td)));

test("a held payment is approved with the approver's wallet signature", async () => {
  const { tool, issue, issuer, view, submit } = setup();
  const agent = await issue("scout.xcard.eth");

  const held = (await tool(agent, "pay", { amount: 15, currency: "USD", mcc: "5734", merchant: "New Vendor", merchant_url: "https://new-vendor.example/buy" })).structuredContent;
  assert.equal(held.decision, "pending_human");

  const v = await view(held.approval_id);
  assert.equal(v.card, "scout.xcard.eth");
  assert.equal(v.signable, true);
  assert.equal(v.approver_address, alice.address);
  const msg = v.typed_data.approve.message;
  assert.deepEqual(
    [msg.decision, msg.card, msg.kind, msg.amount, msg.currency, msg.merchant, msg.checkout, msg.approver],
    ["approve", "scout.xcard.eth", "payment", "15", "USD", "New Vendor", "https://new-vendor.example/buy", "alice.eth"],
  );
  assert.equal(v.typed_data.deny.message.decision, "deny");
  assert.equal(v.approval.sig, undefined, "the HMAC never leaves the Worker");

  // Someone else's wallet, or the deny message offered as an approval, is refused.
  const code = async (signature: string, approve = true) => (await submit(held.approval_id, approve, signature)).error?.code;
  assert.equal(await code(await signJson(mallory, v.typed_data.approve)), "bad_signature");
  assert.equal(await code(await signJson(alice, v.typed_data.deny)), "bad_signature");
  assert.equal(await code("0x1234"), "bad_signature");

  const ok = await submit(held.approval_id, true, await signJson(alice, v.typed_data.approve));
  assert.equal(ok.error, undefined, ok.error?.message);
  assert.equal(ok.status, "approved");
  assert.equal(ok.charge.approved, true);
  assert.equal(ok.sig, undefined);
  const [card] = issuer.cards.values();
  assert.ok(card.txs.some((t) => t.transaction_type === "CLEARING" && t.transaction_amount === 15), "approving charged the card");

  // The same signature can't decide it twice.
  assert.equal(await code(await signJson(alice, v.typed_data.approve)), "already_decided");
});

test("funding: a signed approval raises the allowance; a signed denial refuses it", async () => {
  const { tool, issue, view, submit, svc } = setup();
  const agent = await issue("researcher.xcard.eth");
  const ask = async () => (await tool(agent, "request_funding", { amount: 300, currency: "USD", purpose: "dataset" })).structuredContent;

  const a = await ask();
  const v = await view(a.approval_id);
  assert.equal(v.typed_data.approve.message.kind, "funding");
  await submit(a.approval_id, true, await signJson(alice, v.typed_data.approve));
  assert.equal((await svc.getCard("researcher.xcard.eth")).records["card.limit.monthly"], "800");

  const b = await ask();
  const v2 = await view(b.approval_id);
  // A signature over another approval's message doesn't carry over.
  assert.equal((await submit(b.approval_id, true, await signJson(alice, v.typed_data.approve))).error.code, "bad_signature");
  const d = await submit(b.approval_id, false, await signJson(alice, v2.typed_data.deny));
  assert.equal(d.status, "denied");
  assert.equal((await svc.getCard("researcher.xcard.eth")).records["card.limit.monthly"], "800");
});

test("agents see status only: no typed data, no way to submit", async () => {
  const { tool, issue } = setup();
  const scout = await issue("scout.xcard.eth");
  const other = await issue("other.xcard.eth");
  const held = (await tool(scout, "pay", { amount: 15, currency: "USD", mcc: "5734", merchant: "New Vendor" })).structuredContent;

  const got = (await tool(scout, "get_approval", { approval_id: held.approval_id })).structuredContent;
  assert.equal(got.approval.status, "pending");
  assert.equal(got.typed_data, undefined, "an agent never gets the message to sign");
  assert.equal((await tool(scout, "submit_approval", { approval_id: held.approval_id, approve: true, signature: "0x" + "ab".repeat(65) })).structuredContent.error.code, "unknown_tool");
  // Another card's token can't see it.
  assert.equal((await tool(other, "get_approval", { approval_id: held.approval_id })).structuredContent.error.code, "not_found");
});

test("approvers that can't sign", async () => {
  const { tool, issue, view, submit } = setup();
  const scout = await issue("scout.xcard.eth");
  const held = (await tool(scout, "pay", { amount: 15, currency: "USD", mcc: "5734", merchant: "New Vendor" })).structuredContent;
  const sig = await signJson(alice, (await view(held.approval_id)).typed_data.approve);
  // Scope: another card's agent can't decide it.
  assert.equal((await submit(held.approval_id, true, sig, "other.xcard.eth")).error.code, "not_found");

  // Free text can only be decided in the operator console; a name with no address can't sign.
  const ops = await issue("ops.xcard.eth", "the ops team");
  const h2 = (await tool(ops, "pay", { amount: 15, currency: "USD", mcc: "5734", merchant: "New Vendor" })).structuredContent;
  const v = await view(h2.approval_id);
  assert.equal(v.signable, false);
  assert.equal(v.typed_data, undefined);
  assert.equal((await submit(h2.approval_id, true, sig)).error.code, "approver_cannot_sign");

  const nobody = await issue("nobody.xcard.eth", "nobody.eth");
  const h3 = (await tool(nobody, "pay", { amount: 15, currency: "USD", mcc: "5734", merchant: "New Vendor" })).structuredContent;
  assert.equal((await view(h3.approval_id)).approver_address, undefined);
  const r = await submit(h3.approval_id, true, sig);
  assert.equal(r.error.code, "approver_cannot_sign");
  assert.match(r.error.message, /no ETH address/);
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
