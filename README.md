# x402·card

**Spend cards for AI agents, addressed by ENS name.**
Fund an agent by name. Never hand it a card number.

`researcher.x402card.eth` is a virtual card. Its spend policy (limits, currencies, allowed merchant categories, status, approver) lives in ENS text records that anyone can read. Agents use the card through an MCP server and never see the 16-digit number, the card ID or an API key. Charges within policy go through. Funding requests above policy wait for a human, and an anomaly freezes the card and flips `card.status` to `frozen` in ENS.

| | |
|---|---|
| Demo site | https://demo.x402card.eth.limo |
| ENS resolver (mainnet, verified) | [`0xf11eb8f6fbd761c25bd01064bab2e48ad90792a0`](https://etherscan.io/address/0xf11eb8f6fbd761c25bd01064bab2e48ad90792a0#code) |
| CCIP-Read gateway | `https://x402card.dmpay.workers.dev/gateway/{sender}/{data}.json` |
| MCP endpoint | `https://x402card.dmpay.workers.dev/mcp` |
| Card rails | [Airwallex Issuing](https://www.airwallex.com/docs/issuing) (sandbox) |

> **Sandbox, no real money.** ENS resolution is real (Ethereum mainnet). Cards, charges and balances run on the Airwallex sandbox.

---

## Contents

- [How it works](#how-it-works)
- [Status](#status)
- [ENS records](#ens-records-the-policy)
- [Policy engine](#policy-engine)
- [Integrate: agents (MCP)](#integrate-agents-over-mcp)
- [Integrate: read policy from any ENS client](#integrate-read-a-cards-policy-from-any-ens-client)
- [Integrate: platforms (approvals API)](#integrate-platforms-approvals-and-oversight)
- [Integrate: bring your own card issuer](#integrate-bring-your-own-card-issuer)
- [Compatibility](#compatibility)
- [Gateway protocol](#gateway-protocol-for-verifiers)
- [Security model](#security-model)
- [Self-hosting](#self-hosting)
- [Development](#development)
- [Repository layout](#repository-layout)
- [Roadmap](#roadmap)

---

## How it works

```
                       ┌──────────────────────────────────────────────┐
  any ENS client       │ Ethereum mainnet                             │
  (viem, ethers,  ───▶ │ ENS registry: x402card.eth                   │
   wallets, apps)      │   └─ resolver: OffchainResolver (ENSIP-10)   │
                       │        reverts OffchainLookup(EIP-3668) ─────┼──┐
                       └──────────────────────────────────────────────┘  │
                                                                         ▼
  AI agent ──MCP──▶ ┌────────────────────────────── Cloudflare Worker ──────────┐
  (Claude, any     │  /mcp       tools: issue_card, get_card, request_funding,  │
   MCP client)     │             freeze, list_transactions                      │
                   │  /gateway   signed answers to text()/addr() lookups        │
  human / platform │  /api       approvals, unfreeze (admin)                     │
  ──REST────────▶  │  cron       anomaly check every minute → freeze            │
                   │                                                            │
                   │  policy engine (plain code)   KV: records · card refs ·    │
                   │                                    approvals · events      │
                   └───────────────┬────────────────────────────────────────────┘
                                   │ REST (x-client-id / x-api-key → bearer)
                                   ▼
                       Airwallex Issuing (sandbox): cardholders, cards,
                       authorization controls, transactions, simulation
```

1. **Issue.** `issue_card("researcher", policy)` creates a DELEGATE cardholder and a non-personalized virtual card on Airwallex, with the policy mapped to Airwallex `authorization_controls`. It publishes the policy as ENS text records and returns an **agent token** scoped to that one name.
2. **Spend.** Airwallex checks every authorization against the card's controls: per-transaction limit, monthly limit, currencies and MCC allow-list. A decline carries the rule it hit (`MERCHANT_CATEGORY_NOT_ALLOWED`, `LIMIT_EXCEEDED`, …), so the agent can adapt instead of retrying.
3. **Fund.** `request_funding(amount, currency)` either raises the monthly allowance right away (within `card.limit.tx` and above the wallet reserve floor) or creates a **pending approval** for the human in `card.approver`. The approval is HMAC-bound to the exact name, amount and currency.
4. **Freeze.** A cron job checks each card's recent activity. Two disallowed-merchant attempts within 10 minutes, or a burst of authorizations, freezes the card on Airwallex and sets `card.status=frozen` in ENS. Agents can freeze their own card; only a human can unfreeze.

## Status

| Component | State |
|---|---|
| ENS OffchainResolver on mainnet, `x402card.eth` pointed at it | ✅ live, source verified |
| CCIP-Read gateway (signed records) | ✅ live |
| MCP server (5 tools, scoped tokens) | ✅ live |
| Policy engine, approvals, anomaly freeze | ✅ live; tested end to end against a fake issuer |
| Demo site on IPFS (`demo.x402card.eth`) | ✅ live |
| Airwallex card creation | ⏳ waiting on Airwallex to enable a card program on the sandbox account. Cardholders, config and balances work; `cards/create` returns `Invalid issuance details`. |

## ENS records (the policy)

Every card name `<label>.x402card.eth` exposes these text records. They're public, so they hold **policy only**: never the card number, CVC or card ID.

| Key | Example | Meaning |
|---|---|---|
| `card.limit.tx` | `50` | Max per transaction, in major units of the first currency. Funding requests above this need a human. |
| `card.limit.monthly` | `500` | Monthly allowance. Approved funding raises it. |
| `card.currencies` | `USD` | Allowed transaction currencies, comma-separated. The first is the limit currency. |
| `card.mcc.allow` | `5734,7372` | Allowed 4-digit merchant category codes. Empty means any. |
| `card.status` | `active` \| `frozen` | Mirrors the Airwallex card state. |
| `card.approver` | `alice.eth` | Who approves escalations. |

Reserved labels that can't be issued: `demo`, `www`, `app`, `api`, `gateway`. `demo.x402card.eth` has its own on-chain resolver and hosts the site.

## Policy engine

Plain, deterministic TypeScript with no LLM ([`src/policy/engine.ts`](src/policy/engine.ts)):

| Input | Rule | Outcome |
|---|---|---|
| Records | → `authorization_controls`: `PER_TRANSACTION`, `MONTHLY`, `allowed_currencies`, `allowed_merchant_categories` | enforced by Airwallex at authorization time |
| Funding request | card frozen, currency not allowed, bad decimals | **deny** |
| Funding request | amount > `card.limit.tx`, or > global ceiling ($250), or wallet would drop below reserve floor ($1,000) | **escalate** to `card.approver` |
| Funding request | otherwise | **approve**: raise `card.limit.monthly` and the Airwallex `MONTHLY` limit together |
| Activity (cron) | ≥ 2 disallowed-MCC attempts in 10 min, or > 10 authorizations in 10 min | **freeze**: card `INACTIVE` + `card.status=frozen` |

Amounts are major units (`300` = $300), rounded to the currency's decimals. A charge counts as successful only once it reaches `CLEARING`; declines carry `failure_reason`.

---

## Integrate: agents over MCP

The MCP server speaks **Streamable HTTP** (stateless JSON responses; protocol versions `2025-06-18`, `2025-03-26`, `2024-11-05`) and authenticates with a bearer token.

- **Admin token**: can call every tool, including `issue_card`. Keep it on the operator side.
- **Agent token** (`x4c_…`): returned once by `issue_card`. It only works for its own card, and `issue_card` is hidden from it. Give this to the agent.

### Claude Code

```sh
claude mcp add --transport http x402card https://x402card.dmpay.workers.dev/mcp \
  --header "Authorization: Bearer x4c_your_agent_token"
```

### Claude Desktop, Cursor, VS Code and other JSON-configured clients

```json
{
  "mcpServers": {
    "x402card": {
      "type": "http",
      "url": "https://x402card.dmpay.workers.dev/mcp",
      "headers": { "Authorization": "Bearer x4c_your_agent_token" }
    }
  }
}
```

For clients that only speak stdio, bridge with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):
`npx mcp-remote https://x402card.dmpay.workers.dev/mcp --header "Authorization: Bearer x4c_…"`

### Raw JSON-RPC

```sh
curl -s https://x402card.dmpay.workers.dev/mcp \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"request_funding","arguments":{"amount":300,"currency":"USD","purpose":"dataset license"}}}'
```

### Tools

| Tool | Arguments | Returns |
|---|---|---|
| `issue_card` *(admin)* | `name`, `policy: { limit_tx, limit_monthly, currencies[], mcc_allow[], approver }` | `card`, `agent_token` (shown once) |
| `get_card` | `name?` | `name`, `status`, `last4`, `records`, `pending_approvals[]` |
| `request_funding` | `name?`, `amount`, `currency`, `purpose?` | `approved` + `new_monthly_limit` · `pending_human` + `approval_id`, `approver` · `denied` + `reason` |
| `freeze` | `name?`, `reason?` | `card` (now `frozen`) |
| `list_transactions` | `name?` | `type`, `status`, `settled`, `amount`, `currency`, `merchant`, `mcc`, `decline_reason`, `at` |

With an agent token, `name` is optional and defaults to the token's own card. Tool failures come back as results with `isError: true` and a `code: message` the model can read (`forbidden`, `not_found`, `bad_policy`, `airwallex_…`).

## Integrate: read a card's policy from any ENS client

Records resolve through standard [ENSIP-10](https://docs.ens.domains/ensip/10) wildcard resolution with [EIP-3668](https://eips.ethereum.org/EIPS/eip-3668) CCIP-Read. No SDK is needed; any CCIP-Read-capable client works.

**viem** (CCIP-Read is on by default)

```ts
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";

const client = createPublicClient({ chain: mainnet, transport: http() });
const status = await client.getEnsText({ name: "researcher.x402card.eth", key: "card.status" });
const limit = await client.getEnsText({ name: "researcher.x402card.eth", key: "card.limit.tx" });
```

**ethers v6**

```ts
const resolver = await provider.getResolver("researcher.x402card.eth");
const status = await resolver?.getText("card.status"); // CCIP-Read handled by the resolver
```

**web3.py**

```py
w3.ens.get_text("researcher.x402card.eth", "card.status")  # ccip_read_enabled defaults to True
```

**Plain HTTP** (no chain access; same data, unsigned)

```sh
curl https://x402card.dmpay.workers.dev/public/cards/researcher.x402card.eth
```

**Use it as a pre-flight check.** A merchant, marketplace or another agent can refuse to start work for `card.status != active`, or quote within `card.limit.tx`, before any payment is attempted.

## Integrate: platforms (approvals and oversight)

Admin endpoints (`Authorization: Bearer <admin token>`):

| Method | Path | Body | Purpose |
|---|---|---|---|
| `GET` | `/api/approvals` | | Pending and decided funding requests (newest first) |
| `POST` | `/api/approvals/:id` | `{ "approve": true \| false, "by": "alice.eth" }` | Decide. Applies exactly the signed name, amount and currency; a second decision fails. |
| `POST` | `/api/cards/:name/unfreeze` | | Human-only unfreeze; also flips `card.status` back to `active` |

Public, unauthenticated:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/public/cards/:name` | The card's public records (same data the gateway signs) |
| `GET` | `/public/feed` | Recent policy events: issued, funded, escalated, approved, denied, frozen, unfrozen |

Typical platform flows:

- **Agent platform / framework:** issue one card per agent with the admin token, and pass the scoped agent token into the agent's MCP config. Your platform never stores card numbers.
- **Finance / ops console:** poll `/api/approvals`, show the request with its purpose, and post the decision. Watch `/public/feed` or the ENS records for freezes.
- **Merchant / counterparty:** resolve `card.status` and limits over ENS before accepting an order from an agent.

## Integrate: bring your own card issuer

x402card doesn't have to issue the card. It's a **naming and policy layer**: a portable, human-readable identity (`<agent>.x402card.eth`) with public spend policy, scoped agent access, human approvals and a kill switch. A card from any program can sit behind that name. Agent-card programs from card networks, issuing platforms and wallet/crypto card providers can all attach their cards to an x402card name instead of building naming, policy publication and approval flows themselves.

What an issuer gets by attaching to a name:

- **A stable handle that outlives card numbers.** Reissue, rotate or swap the underlying card; agents, merchants and dashboards keep using `researcher.x402card.eth`.
- **Policy anyone can read.** Merchants and counterparties check `card.status` and limits over ENS before accepting an order, with no integration with the issuer's API.
- **Approvals and freezes in one place,** applied consistently whatever rails the card runs on.
- **Agents never hold credentials.** The agent talks MCP to x402card; the issuer's API keys and PANs stay server-side.

Airwallex is the first adapter. Card operations go through one interface ([`src/service.ts`](src/service.ts)):

```ts
export interface Issuer {
  createCardholder(email: string): Promise<{ cardholderId: string }>;
  createCard(input: { cardholderId: string; nickName: string; controls: AuthorizationControls; requestId: string }):
    Promise<{ cardId: string; last4?: string; status: string }>;
  getCardStatus(cardId: string): Promise<string>;
  updateCard(cardId: string, input: { status?: "ACTIVE" | "INACTIVE"; controls?: Partial<AuthorizationControls> }): Promise<void>;
  listTransactions(cardId: string): Promise<IssuingTransaction[]>;
  walletAvailable(currency: string): Promise<number>;
}
```

An adapter for another program maps each record to whatever control that program supports:

| x402card record | What the adapter needs from the issuer |
|---|---|
| `card.limit.tx` | per-authorization amount limit |
| `card.limit.monthly` | rolling or calendar-month spend limit, updatable after issuance |
| `card.currencies` | allowed transaction currencies (or reject in the adapter if unsupported) |
| `card.mcc.allow` | MCC allow-list (or block-list inverted) |
| `card.status` | freeze / unfreeze without closing the card |
| transactions | list authorizations and clearings with decline reasons |

If a program can't enforce one of these at authorization time (for example, no MCC controls), the adapter should leave it to the policy engine's after-the-fact anomaly checks and say so in the card's records. Two ways to integrate:

1. **Adapter in this repo:** implement `Issuer` for your API and select it per card. Each card's issuer is recorded privately, never in public records.
2. **Attach an existing card:** keep issuing on your own platform, and register the card under a name with your policy. x402card publishes the records, runs approvals and calls your freeze/limit endpoints. *(Planned: `attach_card` tool and a `card.issuer` record naming the program.)*

## Compatibility

| Area | Supported |
|---|---|
| **MCP clients** | Any Streamable HTTP client: Claude Code, Claude Desktop, Claude.ai connectors, Cursor, VS Code, OpenAI Agents SDK, LangChain/LangGraph MCP adapters. stdio-only clients via `mcp-remote`. |
| **MCP protocol** | `2025-06-18`, `2025-03-26`, `2024-11-05`; stateless JSON responses (no SSE needed) |
| **ENS clients** | Anything with ENSIP-10 + EIP-3668: viem ≥ 1, ethers v6 (and v5 with CCIP enabled), web3.py ≥ 6, ENS App, eth.limo gateways, most wallets with ENS display |
| **Records** | `text(bytes32,string)`; `addr(bytes32)` and `addr(bytes32,60)` for the parent; `contenthash` returns empty |
| **Chains** | ENS on Ethereum mainnet. The resolver contract is chain-agnostic (Sepolia works the same). |
| **Card rails** | Airwallex Issuing API ≥ `2024-03-31` (cardholders + `program` model); sandbox simulation endpoints for demo charges |
| **Currencies** | Any currency enabled in the account's Issuing config (USD, EUR, GBP, AUD, HKD, SGD, JPY, …). Zero-decimal currencies (JPY, KRW, …) are rounded correctly. |
| **Runtime** | Cloudflare Workers + KV; Node ≥ 22.18 for scripts/tests (native TypeScript) |

## Gateway protocol (for verifiers)

The resolver reverts with:

```
OffchainLookup(address(this), [url], callData, resolveWithProof.selector, abi.encode(callData, address(this)))
```

The gateway answers `GET /gateway/{sender}/{data}.json` (or `POST {sender, data}`) with `{ "data": response }`, where:

```
response = abi.encode(bytes result, uint64 expires, bytes signature)
hash     = keccak256(0x1900 ‖ sender ‖ expires ‖ keccak256(callData) ‖ keccak256(result))
```

`resolveWithProof` recovers the signer from `hash` and checks it against the contract's `signers` set. Answers are valid for 5 minutes. The owner can rotate the URL (`setUrl`) and signers (`setSigner`) without redeploying. Current gateway signer: `0x10d95862957943f0b488CEAb7043adA8d23E123A`.

## Security model

- **Agents never see card credentials.** Tools return policy, status, last 4 and transactions; Airwallex IDs stay in a private KV prefix the gateway never serves. A test asserts the card ID never appears in tool output.
- **Scoped tokens.** Agent tokens are random 256-bit values stored only as SHA-256 hashes and accepted only for their own name. Only the admin token can issue cards, decide approvals or unfreeze.
- **Approvals can't be retargeted.** Each pending approval is HMAC-signed over `(id, name, amount, currency)` and re-verified at decision time; it's marked decided before it is applied, so a double click applies once.
- **Idempotent writes.** Every Airwallex write carries a `request_id` that is reused only when retrying the same operation, so a retried create can't issue two cards.
- **Signed ENS answers.** Records verify on-chain against the gateway signer; a tampered result or an unknown signer is rejected (covered by `scripts/e2e-resolver.ts`).
- **Separate keys.** The gateway signing key isn't the deployer key; compromising the Worker can't move funds, and the resolver owner can revoke the signer.
- **Secrets** live in Wrangler secrets / `.dev.vars` (gitignored), never in records, logs or responses.

## Self-hosting

Prerequisites: an Airwallex sandbox account with Issuing and a card program enabled, a Cloudflare account, an ENS name you control, and a funded deployer key.

```sh
git clone https://github.com/RWA-ID/x402card && cd x402card
npm install
cp .dev.vars.example .dev.vars        # fill in AWX_CLIENT_ID, AWX_API_KEY, generate the rest
npm run verify:airwallex              # login + balances
npm run smoke:issuing                 # cardholder → card → allowed + declined charge

# Worker
npx wrangler kv namespace create KV   # put the id in wrangler.jsonc
for k in GATEWAY_SIGNER_KEY AWX_CLIENT_ID AWX_API_KEY MCP_ADMIN_TOKEN APPROVAL_SECRET; do
  npx wrangler secret put $k
done
npx wrangler deploy

# Resolver (from contracts/; reads PRIVATE_KEY + RPC from your env file)
cd contracts && npm install
GATEWAY_URL='https://<your-worker>/gateway/{sender}/{data}.json' \
GATEWAY_SIGNER=<address of GATEWAY_SIGNER_KEY> \
  npx hardhat run scripts/deploy.ts --network mainnet
# then setResolver(namehash("<your-name>.eth"), <resolver>) on the ENS registry
```

Change `PARENT_NAME` in `src/ens/gateway.ts` and `PARENT_ADDR` in `wrangler.jsonc` for your own name. If the parent name has records today (an address, a contenthash), serve them from the gateway before switching resolvers, as `PARENT_ADDR` does.

## Development

```sh
npm test                 # policy engine, approvals, MCP protocol + full demo script (fake issuer)
npm run typecheck
cd contracts && npx hardhat node &          # then, from the repo root:
node scripts/e2e-resolver.ts                # resolver + gateway end to end on a local chain
```

The test suite runs the whole demo against `FakeIssuer` ([`src/testing.ts`](src/testing.ts)), which enforces card controls the way the sandbox does: issue `researcher`, an allowed charge clears, a disallowed MCC declines, a $25 top-up auto-approves, a $300 request escalates and is approved, and a second disallowed MCC attempt freezes the card.

## Repository layout

```
src/
  index.ts              Worker routes + cron
  mcp.ts                MCP server (JSON-RPC over HTTP), auth, tool schemas
  service.ts            card operations behind the tools (Issuer interface)
  store.ts              KV layout
  ens/gateway.ts        CCIP-Read gateway + signing
  policy/records.ts     ENS record schema + validation
  policy/engine.ts      records → controls, funding decisions, anomaly rules
  policy/approvals.ts   HMAC-bound approvals
  airwallex/client.ts   auth, token cache, retries, request_id
  airwallex/issuing.ts  cardholders, cards, transactions
  airwallex/simulator.ts  every sandbox simulation call behind one interface
contracts/              OffchainResolver.sol + Hardhat deploy
scripts/                Airwallex checks, resolver e2e, IPFS pinning
site/www/               demo site (static; pinned to IPFS)
```

## Roadmap

- **Issuer-agnostic attach:** `attach_card` for cards issued elsewhere, a `card.issuer` record, and adapters beyond Airwallex.
- **Paid self-serve issuance over x402**: let agents issue their own card name by paying a small fee in USDC, with the payer wallet becoming `card.approver`.
- Approval page and fleet dashboard (UI over `/api/approvals` and `/public/feed`).
- Airwallex webhooks for real-time freezes instead of the one-minute cron.
- Wallet-signed approvals (EIP-191 / SIWE from `card.approver`) instead of the admin token.

## License

MIT. See [LICENSE](LICENSE).
