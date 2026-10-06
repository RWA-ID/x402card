// x402card demo runner: the six-step demo, end to end, against a live Worker.
//
//   node scripts/demo.ts                       # production Worker, waits for you to approve on the page
//   node scripts/demo.ts --auto-approve        # approves step 4 itself (unattended run)
//   node scripts/demo.ts --api http://127.0.0.1:8787 --admin-token local-test   # local (wrangler dev --var ISSUER:fake)
//
// Options: --name <label> (default researcher) · --pace <ms> between beats (default 1400)
//          --reuse (card already issued: act with the admin token instead of a fresh agent token)
//          --no-ens (skip the mainnet ENS reads)
// The admin token comes from --admin-token, $X402CARD_ADMIN_TOKEN, or MCP_ADMIN_TOKEN in .dev.vars.
import { readFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";

// ---------- args ----------
const argv = process.argv.slice(2);
const flag = (f: string) => argv.includes(f);
const opt = (f: string, d?: string) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const API = (opt("--api", "https://x402card.dmpay.workers.dev") as string).replace(/\/$/, "");
const LABEL = (opt("--name", "researcher") as string).toLowerCase();
const NAME = `${LABEL}.x402card.eth`;
const PACE = Number(opt("--pace", "1400"));
const AUTO = flag("--auto-approve");
const REUSE = flag("--reuse");
const LOCAL = /127\.0\.0\.1|localhost/.test(API);
const ENS = !flag("--no-ens") && !LOCAL;
const ADMIN = opt("--admin-token") || process.env.X402CARD_ADMIN_TOKEN || devVar("MCP_ADMIN_TOKEN");

function devVar(k: string): string | undefined {
  try {
    const line = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").split("\n").find((l) => l.startsWith(k + "="));
    return line?.slice(k.length + 1).replace(/^"|"$/g, "").trim() || undefined;
  } catch {
    return undefined;
  }
}

// ---------- output ----------
const tty = process.stdout.isTTY;
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = c("2"), bold = c("1"), blue = c("38;5;111"), green = c("38;5;114"), red = c("38;5;203"), amber = c("38;5;221"), ice = c("38;5;153");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const beat = () => sleep(PACE);
let stepNo = 0;
function step(title: string, cause: string) {
  stepNo++;
  console.log(`\n${blue(String(stepNo).padStart(2, "0"))}  ${bold(title)}`);
  console.log(`    ${dim("cause")}  ${cause}`);
}
const effect = (s: string) => console.log(`    ${dim("effect")} ${s}`);
const note = (s: string) => console.log(`    ${dim("·")} ${dim(s)}`);
function fail(msg: string): never {
  console.error(red(`\n✕ ${msg}`));
  process.exit(1);
  throw new Error(msg); // unreachable; satisfies `never` under the Workers types
}

if (!ADMIN) fail("No admin token: pass --admin-token, set X402CARD_ADMIN_TOKEN, or add MCP_ADMIN_TOKEN to .dev.vars");

// ---------- transport ----------
let rpcId = 0;
async function mcp(token: string, tool: string, args: Record<string, unknown> = {}) {
  const r = await fetch(`${API}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  if (r.status === 401) fail("MCP rejected the token");
  const body = (await r.json()) as { result?: { isError?: boolean; content: { text: string }[]; structuredContent: any }; error?: { message: string } };
  if (body.error) fail(`MCP ${tool}: ${body.error.message}`);
  if (body.result!.isError) throw new Error(body.result!.content[0].text);
  return body.result!.structuredContent;
}

async function admin(path: string, body?: unknown) {
  const r = await fetch(API + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${ADMIN}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) throw new Error(j?.error?.message ?? j?.error ?? `HTTP ${r.status}`);
  return j;
}

const ens = createPublicClient({ chain: mainnet, transport: http(process.env.MAINNET_RPC_URL || devVar("MAINNET_RPC_URL")) });
async function record(key: string): Promise<string> {
  if (ENS) {
    // Real ENS: ENSIP-10 wildcard → OffchainLookup → our gateway → signature checked on-chain.
    return (await ens.getEnsText({ name: NAME, key })) ?? "";
  }
  const r = await fetch(`${API}/public/cards/${NAME}`);
  return ((await r.json()) as any).records?.[key] ?? "";
}
const via = ENS ? "ENS (mainnet, CCIP-Read)" : "gateway records";

// ---------- the demo ----------
console.log(bold(`x402·card demo`) + dim(`  ·  ${NAME}  ·  ${API}${AUTO ? "  ·  auto-approve" : ""}`));
console.log(dim("Sandbox: no real money. ENS resolution is real."));

// 01 Issue
step("Issue a card by name", `issue_card("${LABEL}", tx ≤ $50 · month ≤ $500 · MCC 5734,7372)`);
let agent = ADMIN;
try {
  const r = await mcp(ADMIN, "issue_card", {
    name: LABEL,
    policy: { limit_tx: 50, limit_monthly: 500, currencies: ["USD"], mcc_allow: ["5734", "7372"], approver: "alice.eth" },
  });
  agent = r.agent_token;
  effect(`card issued · ${r.card.name} · ••${r.card.last4 ?? "····"} · ${green(r.card.status)}`);
  note(`agent token scoped to ${NAME} (the agent never sees the card number)`);
} catch (e) {
  const msg = (e as Error).message;
  if (msg.startsWith("exists") && REUSE) {
    effect(`${NAME} already issued, reusing it (--reuse)`);
  } else if (msg.startsWith("exists")) {
    fail(`${NAME} already has a card. Use --name <new-label>, or --reuse to run against it.`);
  } else {
    fail(`issue_card failed: ${msg}`);
  }
}
await beat();
const tx = await record("card.limit.tx");
const mcc = await record("card.mcc.allow");
effect(`${via}: card.limit.tx = ${tx} · card.mcc.allow = ${mcc} · card.status = ${await record("card.status")}`);
await beat();

// The agent pays over MCP; x402card pre-checks the ENS policy, then the issuer authorizes.
const pay = (amount: number, mcc: string, merchant: string) =>
  mcp(agent, "pay", { ...(REUSE ? { name: LABEL } : {}), amount, currency: "USD", mcc, merchant });
const outcome = (r: any) =>
  r.decision === "approved" ? green(`✓ APPROVED · $${r.amount}`)
  : r.decision === "blocked" ? red(`✕ BLOCKED by x402card · ${r.code} · ${r.reason}`)
  : red(`✕ DECLINED by the issuer · ${r.code}`);

// 02 Allowed payment
step("The agent pays in policy", 'pay($42.00, "ModelHub API", MCC 5734 software)');
const ok = await pay(42, "5734", "ModelHub API");
effect(outcome(ok));
note("pre-checked against the ENS policy, then authorized by the issuer; the agent never held the card number");
await beat();

// 03 Disallowed merchant
step("Out-of-policy merchant is stopped", 'pay($18.00, "SpinPalace", MCC 7995 gambling)');
const bad = await pay(18, "7995", "SpinPalace");
effect(bad.decision === "approved" ? amber("approved (unexpected: check card.mcc.allow)") : outcome(bad));
note("blocked before it reached the card network; the agent gets the rule it hit and can adapt");
await beat();

// 04 Funding escalates, human approves
step("The agent asks. A human says yes.", 'request_funding($300, "dataset license")');
const before = await record("card.limit.monthly");
const f = await mcp(agent, "request_funding", { ...(REUSE ? { name: LABEL } : {}), amount: 300, currency: "USD", purpose: "dataset license" });
if (f.decision !== "pending_human") fail(`expected an escalation, got ${f.decision}: ${f.reason}`);
effect(amber(`PAUSED · ${f.reason} · waiting for ${f.approver}`));
const approveUrl = LOCAL ? `http://127.0.0.1:8765/approve.html?api=${API}#${f.approval_id}` : f.approval_url;
if (AUTO) {
  await beat();
  await admin(`/api/approvals/${f.approval_id}`, { approve: true, by: f.approver });
  effect(green(`RELEASED · approved by ${f.approver} (--auto-approve)`));
} else {
  console.log(`    ${bold("→ approve it here:")} ${blue(approveUrl ?? "(approval page)")}`);
  process.stdout.write(`    ${dim("waiting for a decision")}`);
  const t0 = Date.now();
  for (;;) {
    const a = ((await admin("/api/approvals")).approvals as any[]).find((x) => x.id === f.approval_id);
    if (a?.status === "approved") { console.log(""); effect(green(`RELEASED · approved on the page`)); break; }
    if (a?.status === "denied") { console.log(""); fail("denied on the page; the rest of the demo needs an approval"); }
    if (Date.now() - t0 > 15 * 60_000) { console.log(""); fail("no decision after 15 minutes"); }
    if (tty) process.stdout.write(dim("."));
    await sleep(2000);
  }
}
await beat();
effect(`${via}: card.limit.monthly ${before} → ${bold(await record("card.limit.monthly"))}`);
await beat();

// 05 Anomaly → freeze
step("Anomaly in. Card frozen.", "a second disallowed-merchant attempt within 10 minutes");
const again = await pay(18, "7995", "SpinPalace");
note(`payment: ${again.decision} · ${again.code ?? ""}`);
effect(again.card_frozen ? ice(`FROZEN · ${again.card_frozen}`) : amber("anomaly rules did not fire"));
await beat();
effect(`${via}: card.status = ${ice(await record("card.status"))}`);
await beat();

// 06 Next payment
step("Frozen means frozen", 'pay($5.00, "ModelHub API", MCC 5734, normally allowed)');
const after = await pay(5, "5734", "ModelHub API");
effect(after.decision === "approved" ? red("approved (unexpected)") : ice(`✕ ${after.code}`));
note("the issuer card is INACTIVE too, so a charge that bypassed x402card would also be declined");
note("only a human can unfreeze: Unfreeze on the approval page, or POST /api/cards/:name/unfreeze");

console.log(`\n${green("✓")} ${bold("demo complete")} ${dim(`· feed: ${LOCAL ? "http://127.0.0.1:8765/#feed" : "https://demo.x402card.eth.limo/#feed"}`)}\n`);
