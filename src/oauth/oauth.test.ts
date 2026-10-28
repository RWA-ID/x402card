// Wallet sign-in for MCP clients: who may grant what, SIWE checks, and the
// /authorize steps against a stand-in for the OAuth library's consent helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyMessage, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Store } from "../store.ts";
import { MemoryKV } from "../testing.ts";
import { accessOptions, callerFor, siweMessage, verifySiwe, type AccessDeps, type GrantProps } from "./access.ts";
import { handleAuthorize, type ConsentApi } from "./authorize.ts";

const ORIGIN = "https://mcp.x-card.dev";
const alice = privateKeyToAccount(generatePrivateKey());
const bob = privateKeyToAccount(generatePrivateKey());
const op = privateKeyToAccount(generatePrivateKey());

async function setup() {
  const store = new Store(new MemoryKV().asKV());
  const rec = (approver: string) => ({ "card.limit.tx": "50", "card.limit.monthly": "500", "card.currencies": "USD", "card.status": "active", "card.approver": approver });
  const cards: [string, string][] = [["scout.xcard.eth", "alice.eth"], ["researcher", alice.address], ["ops.xcard.eth", "the ops team"], ["bobs.xcard.eth", "bob.eth"]];
  for (const [label, approver] of cards) {
    await store.putCard(label, { cardholderId: "h", cardId: label, createdAt: 0 });
    await store.putRecords(label, rec(approver));
  }
  const ens: Record<string, Address> = { "alice.eth": alice.address, "bob.eth": bob.address };
  let reads = 0;
  const deps: AccessDeps = {
    store,
    resolve: async (a) => { reads++; return a.startsWith("0x") ? (a as Address) : ens[a] ?? null; },
    verifyMessage: (address, message, signature) => verifyMessage({ address, message, signature }),
    operators: [op.address.toLowerCase()],
  };
  return { store, deps, reads: () => reads };
}

test("accessOptions: cards whose approver is this wallet; operators get the fleet", async () => {
  const { deps } = await setup();
  const a = await accessOptions(alice.address, deps);
  assert.equal(a[0].id, "wallet", "all my cards comes first");
  assert.equal(a[0].name, "All my cards (2)");
  assert.deepEqual(a.slice(1).map((o) => o.id).sort(), ["card:researcher", "card:scout.xcard.eth"]);
  assert.deepEqual(a.slice(1).map((o) => o.name).sort(), ["researcher.x402card.eth", "scout.xcard.eth"]);
  assert.deepEqual((await accessOptions(op.address, deps)).map((o) => o.id), ["fleet", "wallet"]);
  // A wallet with no cards can still connect, to issue itself a test card.
  const fresh = await accessOptions(privateKeyToAccount(generatePrivateKey()).address, deps);
  assert.deepEqual(fresh.map((o) => [o.id, o.name]), [["wallet", "My cards (none yet)"]]);
});

test("callerFor: a grant ends when the card's approver changes", async () => {
  const { store, deps } = await setup();
  const p: GrantProps = { address: alice.address, grant: { kind: "card", card: "scout.xcard.eth" }, approver: "alice.eth" };
  assert.deepEqual(await callerFor(p, deps), { kind: "agent", label: "scout.xcard.eth" });
  assert.deepEqual(await callerFor({ address: op.address, grant: { kind: "fleet" } }, deps), { kind: "admin" });
  const r = (await store.getRecords("scout.xcard.eth"))!;
  await store.putRecords("scout.xcard.eth", { ...r, "card.approver": "mallory.eth" });
  assert.equal(await callerFor(p, deps), null);
  assert.equal(await callerFor({ ...p, grant: { kind: "card", card: "gone.xcard.eth" } }, deps), null);
});

test("callerFor: a wallet grant follows the cards the wallet approves now", async () => {
  const { store, deps } = await setup();
  const p: GrantProps = { address: alice.address, grant: { kind: "wallet" } };
  const labels = async () => ((await callerFor(p, deps)) as { labels: string[] }).labels.sort();
  assert.deepEqual(await labels(), ["researcher", "scout.xcard.eth"]);
  // Issued later: joins. Reassigned: leaves.
  await store.putCard("new.xcard.eth", { cardholderId: "h", cardId: "n", createdAt: 0 });
  await store.putRecords("new.xcard.eth", { ...(await store.getRecords("scout.xcard.eth"))!, "card.approver": alice.address });
  await store.putRecords("scout.xcard.eth", { ...(await store.getRecords("scout.xcard.eth"))!, "card.approver": "bob.eth" });
  assert.deepEqual(await labels(), ["new.xcard.eth", "researcher"]);
});

test("verifySiwe: right wallet, this domain, this nonce, not expired", async () => {
  const { deps } = await setup();
  const nonce = "abcdefgh12345678";
  const message = siweMessage(ORIGIN, alice.address, nonce);
  const sig = await alice.signMessage({ message });
  const exp = { address: alice.address, nonce, message };
  assert.equal(await verifySiwe(ORIGIN, exp, sig, deps), true);
  assert.equal(await verifySiwe(ORIGIN, exp, await bob.signMessage({ message }), deps), false, "another wallet");
  assert.equal(await verifySiwe("https://evil.example", exp, sig, deps), false, "another domain");
  assert.equal(await verifySiwe(ORIGIN, { ...exp, nonce: "zzzzzzzz12345678" }, sig, deps), false, "another nonce");
  assert.equal(await verifySiwe(ORIGIN, exp, sig, deps, new Date(Date.now() + 11 * 60 * 1000)), false, "expired");
  assert.equal(await verifySiwe(ORIGIN, exp, "0x12", deps), false);
});

// The library's consent helpers, reduced to what the page relies on.
function fakeApi() {
  const completed: any[] = [];
  let begun = 0;
  const api: ConsentApi = {
    parseAuthRequest: async () => ({ clientId: "claude", redirectUri: "https://claude.ai/api/mcp/auth_callback", scope: [], state: "s" } as any),
    describeConsent: async () => ({ clientId: "claude", clientName: "Claude <script>", redirectUri: "", redirectHost: "claude.ai", redirectIsLoopback: false, scope: [] }),
    beginConsent: async () => ({ handle: `h${++begun}`, headers: new Headers({ "X-Frame-Options": "DENY" }) }),
    approveConsent: async (_req, handle) => ({ request: { handle } as any, headers: new Headers() }),
    denyConsent: async () => ({ request: {} as any, redirectTo: "https://claude.ai/cb?error=access_denied", headers: new Headers() }),
    completeAuthorization: async (o) => { completed.push(o); return { redirectTo: "https://claude.ai/cb?code=c" }; },
  };
  return { api, completed };
}
const errors = { isAuthorizationError: (_e: unknown): _e is { description: string } => false, isCimdFetchError: () => false };

test("/authorize: sign in with the wallet, pick a card, the client gets that card", async () => {
  const { deps } = await setup();
  const { api, completed } = fakeApi();
  const go = (path: string, init: RequestInit = {}, cookie?: string) =>
    handleAuthorize(new Request(ORIGIN + path, { ...init, headers: { ...(init.headers as object), ...(cookie ? { Cookie: cookie } : {}) } }), api, errors, deps);
  const json = (path: string, body: object, cookie?: string) => go(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, cookie);

  const pageRes = await go("/authorize?client_id=claude");
  assert.equal(pageRes.status, 200);
  assert.equal(pageRes.headers.get("X-Frame-Options"), "DENY");
  const html = await pageRes.text();
  assert.ok(html.includes("Claude &#60;script&#62;") && !html.includes("Claude <script>"), "client name is escaped");
  const cookie = pageRes.headers.get("Set-Cookie")!.split(";")[0];
  assert.match(cookie, /^__Host-xcard-authz=[0-9a-f]{64}$/);

  // Without this browser's cookie, a leaked handle goes nowhere.
  assert.equal((await json("/authorize/siwe", { handle: "h1", address: alice.address })).status, 400);
  assert.equal((await json("/authorize/siwe", { handle: "h1", address: alice.address }, "__Host-xcard-authz=" + "0".repeat(64))).status, 400);

  const { message } = (await (await json("/authorize/siwe", { handle: "h1", address: alice.address }, cookie)).json()) as any;
  assert.match(message, /^mcp\.x-card\.dev wants you to sign in with your Ethereum account:/);
  assert.equal((await json("/authorize/verify", { handle: "h1", signature: await bob.signMessage({ message }) }, cookie)).status, 403);
  const v = (await (await json("/authorize/verify", { handle: "h1", signature: await alice.signMessage({ message }) }, cookie)).json()) as any;
  assert.deepEqual(v.options.map((o: any) => o.id).sort(), ["card:researcher", "card:scout.xcard.eth", "wallet"]);
  // A signed-in session can't be re-pointed at another wallet.
  assert.equal((await json("/authorize/siwe", { handle: "h1", address: bob.address }, cookie)).status, 400);

  const form = (fields: Record<string, string>) => go("/authorize", { method: "POST", body: new URLSearchParams(fields) }, cookie);
  assert.equal((await form({ handle: "h1", decision: "approve", choice: "card:bobs.xcard.eth" })).status, 400, "only an offered option");
  const done = await form({ handle: "h1", decision: "approve", choice: "card:scout.xcard.eth" });
  assert.equal(done.status, 302);
  assert.equal(done.headers.get("Location"), "https://claude.ai/cb?code=c");
  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0].props, { address: alice.address, grant: { kind: "card", card: "scout.xcard.eth" }, approver: "alice.eth" });
  assert.deepEqual(completed[0].scope, ["mcp"]);
  // One use: the session is gone.
  assert.equal((await form({ handle: "h1", decision: "approve", choice: "card:scout.xcard.eth" })).status, 400);
});

test("/authorize: deny needs no sign-in and goes back to the client", async () => {
  const { deps } = await setup();
  const { api, completed } = fakeApi();
  const r = await handleAuthorize(new Request(ORIGIN + "/authorize", { method: "POST", body: new URLSearchParams({ handle: "h9", decision: "deny" }) }), api, errors, deps);
  assert.equal(r.status, 302);
  assert.match(r.headers.get("Location")!, /error=access_denied/);
  assert.equal(completed.length, 0);
});
