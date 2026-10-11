// The admin issue endpoint behind the approvals page's form.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { type Env } from "./index.ts";
import { MemoryKV } from "./testing.ts";

const ADMIN = "admin-token";
const env = {
  KV: new MemoryKV().asKV(),
  ISSUER: "fake",
  MCP_ADMIN_TOKEN: ADMIN,
  APPROVAL_SECRET: "s",
  GATEWAY_SIGNER_KEY: "0x" + "11".repeat(32),
} as unknown as Env;

const call = (method: string, path: string, body?: unknown, token = ADMIN) =>
  worker.fetch(new Request("https://w" + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }), env);

const policy = { limit_tx: 50, limit_monthly: 500, currencies: ["USD"], mcc_allow: ["5734"], approver: "alice.eth" };

test("POST /api/cards issues in the chosen namespace and returns a scoped token", async () => {
  for (const name of ["test.xcard.eth", "test.x402card.eth"]) {
    const r = await call("POST", "/api/cards", { name, policy });
    assert.equal(r.status, 201);
    const b = (await r.json()) as any;
    assert.equal(b.card.name, name);
    assert.match(b.agent_token, /^x4c_[0-9a-f]{64}$/);
    // The token reaches its own card over MCP, and nothing else.
    const mcp = (args: object) => call("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_card", arguments: args } }, b.agent_token);
    assert.equal(((await (await mcp({})).json()) as any).result.structuredContent.card.name, name);
    const other = name.startsWith("test.xcard") ? "test.x402card.eth" : "test.xcard.eth";
    assert.ok(((await (await mcp({ name: other })).json()) as any).result.isError);
  }

  const pub = (await (await call("GET", "/public/cards/test.xcard.eth")).json()) as any;
  assert.equal(pub.records["card.limit.tx"], "50");
  const fleet = (await (await call("GET", "/api/cards")).json()) as any;
  assert.deepEqual(fleet.cards.map((c: any) => c.name).sort(), ["test.x402card.eth", "test.xcard.eth"]);

  const dup = await call("POST", "/api/cards", { name: "test.xcard.eth", policy });
  assert.equal(dup.status, 400);
  assert.equal(((await dup.json()) as any).error.code, "exists");
  assert.equal((await call("POST", "/api/cards", { name: "ai.xcard.eth", policy })).status, 400);
  assert.equal((await call("POST", "/api/cards", { policy })).status, 400);
  assert.equal((await call("POST", "/api/cards", { name: "x.xcard.eth", policy }, "x4c_nope")).status, 401);
});
