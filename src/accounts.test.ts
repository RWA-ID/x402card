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
  const { McpServer, sha256Hex } = await import("./mcp.ts");
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
  const { McpServer, sha256Hex } = await import("./mcp.ts");
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
  assert.equal(one.structuredContent.card.name, "orgmaria.acme.xcard.eth");
  assert.match(one.structuredContent.agent_token, /^x4c_/);
  assert.equal((await store.getCard("orgmaria.acme.xcard.eth"))!.org, "acme");
  assert.equal(one.structuredContent.card.records["card.limit.daily"], "200", "blank daily: the most the caps allow, never above monthly");
  assert.match((await as("ops@acme.com", "issue_card", { submit: true, name: "orgbig", policy: { ...policy, limit_tx: 101 } })).content[0].text, /over_org_caps/);

  // The second operator sees it, can manage it, and can't loosen it alone.
  assert.deepEqual((await emailCards("ops2@acme.com", store)).map((c) => c.label), ["orgmaria.acme.xcard.eth"]);
  assert.equal((await as("ops2@acme.com", "get_card", { name: "orgmaria.acme.xcard.eth" })).structuredContent.card.name, "orgmaria.acme.xcard.eth");
  const loosen = (await as("ops2@acme.com", "update_policy", { name: "orgmaria.acme.xcard.eth", limit_monthly: 300 })).structuredContent;
  assert.equal(loosen.decision, "pending_human", "loosening still waits for the approver");
  // The console: the operator sees the request and who decides it, and can't decide it.
  const opSession = "xs_operator";
  await store.putSession(await sha256Hex(opSession), "ops2@acme.com");
  const seen = (await call("GET", "/api/approvals", undefined, opSession)).body.approvals.find((x: any) => x.id === loosen.approval_id);
  assert.equal(seen.approver, "manager@acme.com");
  assert.equal(seen.can_decide, false);
  assert.equal((await call("POST", `/api/approvals/${loosen.approval_id}`, { approve: true }, opSession)).status, 403);
  assert.deepEqual((await call("GET", "/api/me", undefined, opSession)).body.org, { slug: "acme", name: "Acme", operators: ["ops@acme.com", "ops2@acme.com"] });
  assert.equal((await call("GET", "/api/cards", undefined, opSession)).body.cards[0].org, "acme");
  assert.ok(!(await emailCards("outsider@else.com", store)).length);
  assert.match((await as("outsider@else.com", "get_card", { name: "orgmaria.acme.xcard.eth" })).content[0].text, /forbidden/);

  // The caps count cards, and many cards can share one approver and one issuer.
  await as("ops@acme.com", "issue_card", { submit: true, name: "orgjon", policy });
  assert.match((await as("ops@acme.com", "issue_card", { submit: true, name: "organa", policy })).content[0].text, /limit_reached/);

  // Removed operators lose the org at once.
  await call("POST", "/api/orgs", { slug: "acme", name: "Acme", operators: ["ops@acme.com"], caps: { tx: 100, cards: 2 } }, "admin-token");
  assert.equal(await store.orgOf("ops2@acme.com"), null);
  assert.ok(!(await emailCards("ops2@acme.com", store)).length);
});

test("claim links: one holder, many cards; only that email claims; the token goes to them, once", async () => {
  const { sha256Hex } = await import("./mcp.ts");
  const { Store } = await import("./store.ts");
  const { emailCards } = await import("./oauth/access.ts");
  const store = new Store(env.KV);
  const session = async (email: string) => { const t = "xs_" + email; await store.putSession(await sha256Hex(t), email); return t; };
  assert.equal((await call("POST", "/api/orgs", { slug: "beta", name: "Beta Inc", operators: ["boss@beta.com"] }, "admin-token")).status, 201);
  const boss = await session("boss@beta.com"), holder = await session("staff@beta.com"), stranger = await session("stranger@else.com");
  const policy = { limit_tx: 50, limit_monthly: 200, approver: "boss@beta.com" };
  const linkFor = (card: string) => {
    const m = [...sent].reverse().find((x) => x.to[0] === "staff@beta.com" && x.text.includes(card));
    return m!.text.match(/claim#(clm_[0-9a-f]{64})/)![1];
  };

  const one = await call("POST", "/api/cards", { name: "claimone", holder: "Staff@Beta.com", policy }, boss);
  assert.equal(one.status, 201);
  assert.equal(one.body.agent_token, undefined, "the operator never gets the holder's token");
  assert.equal(one.body.card.claim_sent, true);
  assert.equal((await call("POST", "/api/cards", { name: "claimtwo", holder: "staff@beta.com", policy }, boss)).status, 201, "one email can hold many cards");
  assert.equal((await call("POST", "/api/cards", { name: "nope", holder: "x@y.com", policy }, stranger)).status, 400, "only an operator names a holder");
  assert.equal((await call("POST", "/api/cards", { name: "bad-holder", holder: "not-an-email", policy }, boss)).status, 400);

  const link = linkFor("claimone.beta.xcard.eth");
  const view = await call("GET", `/claims/${link}`);
  assert.equal(view.body.org, "Beta Inc");
  assert.ok(!JSON.stringify(view.body).includes("staff@beta.com"), "the public view masks the holder");
  assert.ok(!(await emailCards("staff@beta.com", store)).length, "no access before claiming");

  // A resend ends the old link.
  assert.equal((await call("POST", "/api/cards/claimone.beta.xcard.eth/claim", {}, stranger)).status, 403);
  assert.equal((await call("POST", "/api/cards/claimone.beta.xcard.eth/claim", {}, boss)).body.sent, true);
  const fresh = linkFor("claimone.beta.xcard.eth");
  assert.notEqual(fresh, link);
  assert.equal((await call("GET", `/claims/${link}`)).status, 404);

  assert.equal((await call("POST", `/claims/${fresh}`)).status, 401);
  assert.equal((await call("POST", `/claims/${fresh}`, {}, stranger)).status, 403, "a forwarded link doesn't work");
  const got = await call("POST", `/claims/${fresh}`, {}, holder);
  assert.equal(got.status, 200);
  assert.match(got.body.agent_token, /^x4c_/);
  assert.equal((await call("POST", `/claims/${fresh}`, {}, holder)).status, 404, "the link works once");
  assert.equal((await call("POST", "/api/cards/claimone.beta.xcard.eth/claim", {}, boss)).status, 400, "already claimed");

  // The holder has it, and only it; the unclaimed one stays out.
  assert.deepEqual((await emailCards("staff@beta.com", store)).map((c) => c.label), ["claimone.beta.xcard.eth"]);
  const list = (await call("GET", "/api/cards", undefined, holder)).body.cards;
  assert.deepEqual(list.map((c: any) => c.name), ["claimone.beta.xcard.eth"]);
  assert.equal(list[0].claimed, true);
  assert.equal((await call("POST", "/api/cards/claimone.beta.xcard.eth/unfreeze", {}, holder)).status, 403, "the holder can't lift a freeze");
  assert.equal((await call("GET", "/api/cards", undefined, boss)).body.cards.find((c: any) => c.name === "claimone.beta.xcard.eth").holder, "staff@beta.com");
});

test("company namespaces: maria.<org>.xcard.eth, only from that company's operators", async () => {
  const { sha256Hex } = await import("./mcp.ts");
  const { Store } = await import("./store.ts");
  const store = new Store(env.KV);
  const session = async (email: string) => { const t = "xs_" + email; await store.putSession(await sha256Hex(t), email); return t; };
  await call("POST", "/api/orgs", { slug: "gamma", name: "Gamma", operators: ["op@gamma.com"] }, "admin-token");
  await call("POST", "/api/orgs", { slug: "delta", name: "Delta", operators: ["op@delta.com"] }, "admin-token");
  const gamma = await session("op@gamma.com"), delta = await session("op@delta.com"), solo = await session("solo@else.com");
  const policy = { limit_tx: 50, limit_monthly: 200, approver: "op@gamma.com" };

  for (const name of ["maria", "maria.xcard.eth"]) {
    const r = await call("POST", "/api/cards", { name, policy }, gamma);
    if (name === "maria") assert.equal(r.body.card.name, "maria.gamma.xcard.eth");
    else assert.equal(r.status, 400, "same word, same card");
  }
  assert.equal((await call("POST", "/api/cards", { name: "maria", policy }, delta)).body.card.name, "maria.delta.xcard.eth", "two companies can both have a maria");
  assert.equal((await call("POST", "/api/cards", { name: "jon.gamma.xcard.eth", policy }, delta)).status, 400, "another company's namespace");
  assert.equal((await call("POST", "/api/cards", { name: "jon.gamma.xcard.eth", policy }, solo)).status, 400);
  assert.equal((await call("POST", "/api/cards", { name: "jon.gamma.xcard.eth", policy: { ...policy, currencies: ["USD"] } }, "admin-token")).status, 400, "the admin token doesn't issue into a company either");
  assert.equal((await call("POST", "/api/cards", { name: "gamma.xcard.eth", policy }, solo)).status, 400, "a company's name isn't a card");
  assert.equal((await call("POST", "/api/cards", { name: "plain", policy }, solo)).body.card.name, "plain.xcard.eth", "others stay flat");
  assert.equal((await call("POST", "/api/orgs", { slug: "plain", name: "P", operators: ["p@p.com"] }, "admin-token")).status, 400, "a name already a card can't become a company");
  assert.equal((await call("POST", "/api/orgs", { slug: "shop", name: "S", operators: ["s@s.com"] }, "admin-token")).status, 400);

  const free = await call("GET", "/api/names/nadia.xcard.eth", undefined, gamma);
  assert.deepEqual([free.body.name, free.body.available], ["nadia.gamma.xcard.eth", true]);
  assert.equal((await call("GET", "/api/names/maria", undefined, gamma)).body.available, false);
  // It reads back by its deep name, publicly.
  assert.equal((await call("GET", "/public/cards/maria.gamma.xcard.eth")).body.exists, true);
});

test("CSV batches: a preview issues nothing, every row is checked, the job issues what was previewed", async () => {
  const { sha256Hex, McpServer } = await import("./mcp.ts");
  const { Store } = await import("./store.ts");
  const { parseCsv, advanceRunning } = await import("./batch.ts");
  const { service } = await import("./index.ts");
  const store = new Store(env.KV);
  const session = async (email: string) => { const t = "xs_" + email; await store.putSession(await sha256Hex(t), email); return t; };
  await call("POST", "/api/orgs", { slug: "omega", name: "Omega", operators: ["op@omega.com"], caps: { tx: 100, cards: 8 } }, "admin-token");
  const op = await session("op@omega.com"), solo = await session("solo2@else.com");
  assert.deepEqual(parseCsv('\uFEFFa,b\r\n"x, ""y""\nz",2\r\n\r\n'), [["a", "b"], ['x, "y"\nz', "2"]]);

  const csv = [
    "name,holder_email,limit_tx,limit_monthly,limit_daily,approver,mcc_allow",
    "ana,same@omega.com,50,200,,boss@omega.com,5734;7372",
    "bo,same@omega.com,50,200,100,,",
    "cy,not-an-email,50,200,,,",
    "di,same@omega.com,500,900,,,",
    "ana,same@omega.com,50,200,,,",
    "e_bad!,same@omega.com,50,200,,,",
  ].join("\n");
  assert.equal((await call("POST", "/api/batches", { csv }, solo)).status, 403);
  assert.match((await call("POST", "/api/batches", { csv: "name,holder_email,limit_tx\na,b@c.co,1" }, op)).body.error.message, /limit_monthly/);
  assert.match((await call("POST", "/api/batches", { csv: "name,holder_email,limit_tx,limit_monthly,limit_montly\na,b@c.co,1,2,3" }, op)).body.error.message, /unknown column/);

  const before = (await store.orgIndex("omega")).length;
  const p = (await call("POST", "/api/batches", { csv }, op)).body;
  assert.equal((await store.orgIndex("omega")).length, before, "a preview issues nothing");
  assert.deepEqual(p.rows.map((r: any) => r.status), ["pending", "pending", "invalid", "invalid", "invalid", "invalid"]);
  assert.equal(p.rows[0].name, "ana.omega.xcard.eth");
  assert.equal(p.rows[1].approver, "op@omega.com", "the operator by default");
  assert.match(p.rows[3].error, /per transaction max 100/);
  assert.match(p.rows[4].error, /already in the file/);

  // Someone else's company can't see or start it.
  await call("POST", "/api/orgs", { slug: "sigma", name: "Sigma", operators: ["op@sigma.com"] }, "admin-token");
  assert.equal((await call("POST", `/api/batches/${p.batch_id}/start`, {}, await session("op@sigma.com"))).status, 404);

  const before2 = sent.length;
  const r = (await call("POST", `/api/batches/${p.batch_id}/start`, {}, op)).body;
  assert.equal(r.status, "done");
  assert.deepEqual([r.totals.issued, r.totals.invalid, r.totals.emails_unsent], [2, 4, 0]);
  assert.equal(sent.slice(before2).filter((m) => /issued you a card/.test(m.subject)).length, 2, "one claim email per card, to the same inbox");
  assert.equal((await store.getCard("ana.omega.xcard.eth"))!.holder, "same@omega.com");
  assert.equal((await store.getRecords("ana.omega.xcard.eth"))!["card.mcc.allow"], "5734,7372");
  // Starting again issues nothing more.
  assert.equal((await call("POST", `/api/batches/${p.batch_id}/start`, {}, op)).body.totals.issued, 2);

  // The room left is checked before starting: 6 left, 7 rows.
  const many = ["name,holder_email,limit_tx,limit_monthly", ...Array.from({ length: 7 }, (_, i) => `n${i},same@omega.com,5,50`)].join("\n");
  const big = (await call("POST", "/api/batches", { csv: many }, op)).body;
  assert.match((await call("POST", `/api/batches/${big.batch_id}/start`, {}, op)).body.error.message, /room for 6/);

  // A big file: a few rows per request, and the cron carries on with no page open.
  const six = ["name,holder_email,limit_tx,limit_monthly", ...Array.from({ length: 6 }, (_, i) => `m${i},same@omega.com,5,50`)].join("\n");
  const b6 = (await call("POST", "/api/batches", { csv: six }, op)).body;
  const first = (await call("POST", `/api/batches/${b6.batch_id}/start`, {}, op)).body;
  assert.deepEqual([first.status, first.totals.issued, first.totals.pending], ["running", 5, 1]);
  await advanceRunning(service(env, store), store);
  const end = (await call("GET", `/api/batches/${b6.batch_id}`, undefined, op)).body;
  assert.deepEqual([end.status, end.totals.issued], ["done", 6]);

  // Over the connector: the agent can't; the operator previews; a confirm starts it.
  const mcp = async (caller: any, args: any) => {
    const req = new Request("https://x/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "issue_cards", arguments: args } }) });
    return ((await (await new McpServer(service(env, store), store, caller).handle(req)).json()) as any).result;
  };
  assert.match((await mcp({ kind: "agent", label: "x" }, { csv })).content[0].text, /forbidden/);
  const prev = (await mcp({ kind: "owner", email: "op@sigma.com", labels: [] }, { csv: "name,holder_email,limit_tx,limit_monthly\nzed,z@sigma.com,5,50" })).structuredContent;
  assert.equal(prev.decision, "preview");
  assert.equal((await store.getCard("zed.sigma.xcard.eth")), null);
  const done = (await mcp({ kind: "owner", email: "op@sigma.com", labels: [] }, { batch_id: prev.batch_id, submit: true })).structuredContent;
  assert.deepEqual([done.status, done.totals.issued], ["done", 1]);
});
