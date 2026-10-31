// Demo accounts: email sign-in, issuing on the console, and email approvers.
// Resend is stubbed at fetch, so the codes are read out of the emails sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { type Env } from "./index.ts";
import { MemoryKV } from "./testing.ts";

const env = {
  KV: new MemoryKV().asKV(),
  ISSUER: "fake",
  MCP_ADMIN_TOKEN: "admin-token",
  APPROVAL_SECRET: "s",
  GATEWAY_SIGNER_KEY: "0x" + "11".repeat(32),
  RESEND_API_KEY: "re_test",
  APPROVAL_URL: "https://x-card.dev/approve#{id}",
} as unknown as Env;

const sent: { to: string[]; subject: string; text: string; html: string; from: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url === "https://api.resend.com/emails") {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: "e1" }), { status: 200 });
  }
  return realFetch(input, init);
}) as typeof fetch;

const call = async (method: string, path: string, body?: unknown, token?: string, ip = "1.2.3.4") => {
  const r = await worker.fetch(new Request("https://w" + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: body ? JSON.stringify(body) : undefined,
  }), env);
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};

const lastCode = (to: string) => {
  const m = [...sent].reverse().find((s) => s.to[0] === to && /sign-in code/.test(s.text));
  return m!.text.match(/(\d{3}) (\d{3})/)!.slice(1).join("");
};

async function signIn(email: string): Promise<string> {
  assert.equal((await call("POST", "/auth/email/start", { email })).status, 200);
  const v = await call("POST", "/auth/email/verify", { email, code: lastCode(email.toLowerCase()) });
  assert.equal(v.status, 200);
  assert.match(v.body.token, /^xs_[0-9a-f]{64}$/);
  return v.body.token;
}

test("sign-in codes: branded email, never in the response, one use, limited tries", async () => {
  const start = await call("POST", "/auth/email/start", { email: "Maria@Acme.com" });
  assert.equal(start.status, 200);
  assert.equal(start.body.dev_code, undefined);
  const mail = sent.at(-1)!;
  assert.deepEqual(mail.to, ["maria@acme.com"]);
  assert.equal(mail.from, "X Card <login@x-card.dev>");
  assert.match(mail.html, /Sign in to X Card/);
  const code = lastCode("maria@acme.com");

  const wrong = await call("POST", "/auth/email/verify", { email: "maria@acme.com", code: code === "000000" ? "111111" : "000000" });
  assert.equal(wrong.body.error.code, "wrong_code");
  const ok = await call("POST", "/auth/email/verify", { email: "maria@acme.com", code });
  assert.equal(ok.body.email, "maria@acme.com");
  // Used once: the same code again is gone.
  assert.equal((await call("POST", "/auth/email/verify", { email: "maria@acme.com", code })).body.error.code, "code_expired");

  const me = await call("GET", "/api/me", undefined, ok.body.token);
  assert.equal(me.body.email, "maria@acme.com");
  assert.equal((await call("POST", "/auth/signout", {}, ok.body.token)).status, 200);
  assert.equal((await call("GET", "/api/me", undefined, ok.body.token)).status, 401);

  assert.equal((await call("POST", "/auth/email/start", { email: "nope" })).body.error.code, "bad_email");
  // Five wrong codes burn it.
  await call("POST", "/auth/email/start", { email: "eve@x.io" });
  for (let i = 0; i < 4; i++) assert.equal((await call("POST", "/auth/email/verify", { email: "eve@x.io", code: "999999" })).body.error.code, lastCode("eve@x.io") === "999999" ? undefined : "wrong_code");
  assert.equal((await call("POST", "/auth/email/verify", { email: "eve@x.io", code: "999999" })).body.error.code, "code_expired");
  // Rate limit: six codes in an hour to one inbox.
  for (let i = 0; i < 4; i++) await call("POST", "/auth/email/start", { email: "flood@x.io" }, undefined, `9.9.9.${i}`);
  await call("POST", "/auth/email/start", { email: "flood@x.io" }, undefined, "9.9.9.8");
  assert.equal((await call("POST", "/auth/email/start", { email: "flood@x.io" }, undefined, "9.9.9.9")).status, 429);
});

test("a demo account issues a named card, approves it by email, and the public sees it masked", async () => {
  const maria = await signIn("maria@acme.com");
  assert.equal((await call("GET", "/api/names/maria", undefined, maria)).body.available, true);
  assert.equal((await call("GET", "/api/names/shop", undefined, maria)).body.available, false);

  const issued = await call("POST", "/api/cards", { name: "maria", policy: { limit_tx: 100, limit_daily: 300, limit_monthly: 1000, mcc_allow: [], payee: "any" } }, maria);
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  assert.equal(issued.body.card.name, "maria.xcard.eth");
  assert.equal(issued.body.card.records["card.approver"], "maria@acme.com");
  assert.match(issued.body.agent_token, /^x4c_/);
  assert.equal((await call("GET", "/api/names/maria", undefined, maria)).body.available, false);

  // Over the demo caps, or another namespace: refused.
  assert.equal((await call("POST", "/api/cards", { name: "big", policy: { limit_tx: 900, limit_monthly: 1000 } }, maria)).body.error.code, "over_demo_caps");
  assert.equal((await call("POST", "/api/cards", { name: "x.x402card.eth", policy: { limit_tx: 9, limit_monthly: 10 } }, maria)).body.error.code, "bad_name");

  // Public surfaces never show the email.
  const pub = await call("GET", "/public/cards/maria.xcard.eth");
  assert.equal(pub.body.records["card.approver"], "m•••@acme.com");

  // The agent asks for more than card.limit.tx: held, and the approver is emailed.
  const before = sent.length;
  const rpc = await call("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "request_funding", arguments: { amount: 250, currency: "USD", purpose: "team offsite" } } }, issued.body.agent_token);
  const res = rpc.body.result.structuredContent;
  assert.equal(res.decision, "pending_human");
  assert.equal(res.approval_url, `https://x-card.dev/approve#${res.approval_id}`);
  const mail = sent.slice(before).find((s) => s.from === "X Card <approvals@x-card.dev>")!;
  assert.deepEqual(mail.to, ["maria@acme.com"]);
  assert.match(mail.subject, /Approve \$250 for maria\.xcard\.eth/);
  assert.ok(mail.html.includes(res.approval_url));
  assert.match(mail.text, /team offsite/);

  // The public approval link shows a masked approver and the email path.
  const view = await call("GET", `/approvals/${res.approval_id}`);
  assert.equal(view.body.email_approver, true);
  assert.equal(view.body.signable, false);
  assert.equal(view.body.approval.approver, "m•••@acme.com");
  // Over the card's own connection, get_approval shows the approver in full.
  const ga = await call("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_approval", arguments: { approval_id: res.approval_id } } }, issued.body.agent_token);
  assert.equal(ga.body.result.structuredContent.approval.approver, "maria@acme.com");

  // Someone else signed in can't decide it; the approver can.
  const bob = await signIn("bob@acme.com");
  assert.equal((await call("POST", `/api/approvals/${res.approval_id}`, { approve: true }, bob)).status, 403);
  assert.equal((await call("GET", "/api/approvals", undefined, bob)).body.approvals.length, 0);
  const list = await call("GET", "/api/approvals", undefined, maria);
  assert.equal(list.body.approvals[0].can_decide, true);
  const decided = await call("POST", `/api/approvals/${res.approval_id}`, { approve: true }, maria);
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal(decided.body.approval.status, "approved");
  assert.equal(decided.body.card.records["card.limit.monthly"], "1250");
  // The public feed names the decider masked.
  const feed = await call("GET", "/public/feed");
  assert.ok(feed.body.events.some((e: any) => e.detail === "approved by m•••@acme.com (email)"));
  assert.ok(!JSON.stringify(feed.body).includes("maria@acme.com"));
});

test("a card approved by a colleague's email shows on both accounts; only the approver decides", async () => {
  const ops = await signIn("ops@acme.com");
  const r = await call("POST", "/api/cards", { name: "dev-ana", policy: { limit_tx: 20, limit_monthly: 200, approver: "Lead@Acme.com" } }, ops);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.card.records["card.approver"], "lead@acme.com");
  const lead = await signIn("lead@acme.com");
  const leadCards = (await call("GET", "/api/cards", undefined, lead)).body.cards;
  assert.deepEqual(leadCards.map((c: any) => c.name), ["dev-ana.xcard.eth"]);
  assert.equal(leadCards[0].issued_by_me, undefined);
  const opsCards = (await call("GET", "/api/cards", undefined, ops)).body.cards;
  assert.equal(opsCards[0].issued_by_me, true);

  const rpc = await call("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "request_funding", arguments: { amount: 50, currency: "USD" } } }, r.body.agent_token);
  const id = rpc.body.result.structuredContent.approval_id;
  const seen = (await call("GET", "/api/approvals", undefined, ops)).body.approvals.find((a: any) => a.id === id);
  assert.equal(seen.can_decide, false);
  assert.equal(seen.approver, "l•••@acme.com");
  assert.equal((await call("POST", `/api/approvals/${id}`, { approve: false }, ops)).status, 403);
  assert.equal((await call("POST", `/api/approvals/${id}`, { approve: false }, lead)).body.approval.status, "denied");
});

test("issue_card in the chat for an email sign-in: names the card, approver from the form", async () => {
  const { McpServer } = await import("./mcp.ts");
  const { service } = await import("./index.ts");
  const { Store } = await import("./store.ts");
  const store = new Store(env.KV);
  const owner = async (args: Record<string, unknown>) => {
    const req = new Request("https://x/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "issue_card", arguments: args } }) });
    return ((await (await new McpServer(service(env, store), store, { kind: "owner", email: "chat@acme.com", labels: [] }).handle(req)).json()) as any).result.structuredContent;
  };
  const f = await owner({ name: "chat-bot" });
  assert.equal(f.decision, "form");
  assert.deepEqual(f.me, { email: "chat@acme.com" });
  assert.equal(f.defaults.name, "chat-bot");
  assert.equal(f.caps.tx, 500);
  const r = await owner({ submit: true, name: "chat-bot", policy: { limit_tx: 100, limit_monthly: 1000, approver: "boss@acme.com" } });
  assert.equal(r.card.name, "chat-bot.xcard.eth");
  assert.equal(r.card.records["card.approver"], "boss@acme.com");
  const mine = await owner({ submit: true, name: "chat-two", policy: { limit_tx: 10, limit_monthly: 100 } });
  assert.equal(mine.card.records["card.approver"], "chat@acme.com", "no approver given: the signed-in email");
});

test("orgs: an operator issues for the company within its caps, sees its cards, and can't loosen one alone", async () => {
  const { McpServer } = await import("./mcp.ts");
  const { Store } = await import("./store.ts");
  const { emailCards, callerFor } = await import("./oauth/access.ts");
  const { service } = await import("./index.ts");
  const store = new Store(env.KV);
  const made = await call("POST", "/api/orgs", { slug: "acme", name: "Acme", operators: ["Ops@Acme.com", "ops2@acme.com"], caps: { tx: 100, cards: 2 } }, "admin-token");
  assert.equal(made.status, 201);
  assert.equal(made.body.org.caps.daily, 2000, "unset caps take the defaults");
  assert.equal((await call("POST", "/api/orgs", { slug: "acme", name: "Acme", operators: ["x@y.com"] })).status, 401);
  assert.equal((await call("POST", "/api/orgs", { slug: "Bad Slug", name: "A", operators: ["x@y.com"] }, "admin-token")).status, 400);
  assert.equal((await call("POST", "/api/orgs", { slug: "other", name: "O", operators: ["ops@acme.com"] }, "admin-token")).status, 400, "one org per operator");

  const svc = service(env, store);
  const as = async (email: string, name: string, args: Record<string, unknown>) => {
    const caller = await callerFor({ email, grant: { kind: "wallet" } }, { store, resolve: async () => null });
    const req = new Request("https://x/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    return ((await (await new McpServer(svc, store, caller!).handle(req)).json()) as any).result;
  };
  const f = (await as("ops@acme.com", "issue_card", {})).structuredContent;
  assert.equal(f.caps.tx, 100);
  assert.equal(f.me.org, "Acme");

  const policy = { limit_tx: 50, limit_monthly: 200, approver: "manager@acme.com" };
  const one = await as("ops@acme.com", "issue_card", { submit: true, name: "orgmaria", policy });
  assert.equal(one.structuredContent.card.name, "orgmaria.xcard.eth");
  assert.match(one.structuredContent.agent_token, /^x4c_/);
  assert.equal((await store.getCard("orgmaria.xcard.eth"))!.org, "acme");
  assert.equal(one.structuredContent.card.records["card.limit.daily"], "200", "blank daily: the most the caps allow, never above monthly");
  assert.match((await as("ops@acme.com", "issue_card", { submit: true, name: "orgbig", policy: { ...policy, limit_tx: 101 } })).content[0].text, /over_org_caps/);

  // The second operator sees it, can manage it, and can't loosen it alone.
  assert.deepEqual((await emailCards("ops2@acme.com", store)).map((c) => c.label), ["orgmaria.xcard.eth"]);
  assert.equal((await as("ops2@acme.com", "get_card", { name: "orgmaria.xcard.eth" })).structuredContent.card.name, "orgmaria.xcard.eth");
  const loosen = (await as("ops2@acme.com", "update_policy", { name: "orgmaria.xcard.eth", limit_monthly: 300 })).structuredContent;
  assert.equal(loosen.decision, "pending_human", "loosening still waits for the approver");
  assert.ok(!(await emailCards("outsider@else.com", store)).length);
  assert.match((await as("outsider@else.com", "get_card", { name: "orgmaria.xcard.eth" })).content[0].text, /forbidden/);

  // The caps count cards, and many cards can share one approver and one issuer.
  await as("ops@acme.com", "issue_card", { submit: true, name: "orgjon", policy });
  assert.match((await as("ops@acme.com", "issue_card", { submit: true, name: "organa", policy })).content[0].text, /limit_reached/);

  // Removed operators lose the org at once.
  await call("POST", "/api/orgs", { slug: "acme", name: "Acme", operators: ["ops@acme.com"], caps: { tx: 100, cards: 2 } }, "admin-token");
  assert.equal(await store.orgOf("ops2@acme.com"), null);
  assert.ok(!(await emailCards("ops2@acme.com", store)).length);
});
