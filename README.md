# x402·card

**The name and policy layer for AI agent cards.**
Give an agent a name, not a card number.

x402card is not a card issuer. Card programs issue the cards (Airwallex is the first one we plug into). x402card sits on top of them and adds the parts an AI agent needs before anyone should let it spend:

- **A name.** Each agent card gets a human-readable ENS name, `researcher.x402card.eth`, that stays the same when the card underneath is reissued, rotated or moved to another program.
- **A public policy.** Limits, currencies, allowed merchant categories, status and approver are ENS text records. Anyone (a merchant, another agent, an auditor) can check them with any ENS client, and every answer is signed and verified on-chain.
- **No credentials in the agent.** The agent works through an MCP server with a token scoped to its own card. It never sees the card number, CVC, card ID or an issuer API key.
- **A human in the loop.** Spending inside policy goes through. Funding requests above policy wait for the named approver. An anomaly freezes the card, flips `card.status` to `frozen` in ENS, and only a human can unfreeze it.

The policy is enforced twice: by x402card before anything is sent, and by the card program's own authorization controls when the charge reaches the network.

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
- [How an agent pays](#how-an-agent-pays-without-the-card-number)
- [Governance](#governance)
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
- [Demo runner](#demo-runner)
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
  (Claude, any     │  /mcp       tools: issue_card, get_card, pay,              │
   MCP client)     │             request_funding, freeze, list_transactions     │
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

1. **Register.** `issue_card("researcher", policy)` creates a DELEGATE cardholder and a non-personalized virtual card on Airwallex, with the policy mapped to Airwallex `authorization_controls`. It publishes the policy as ENS text records and returns an **agent token** scoped to that one name.
2. **Pay.** `pay(amount, currency, mcc, merchant)` is checked against the ENS policy first and refused before it reaches the card network if it breaks a rule. Airwallex then checks the authorization against the card's controls again: per-transaction limit, monthly limit, currencies and MCC allow-list. Either way a refusal carries the rule it hit (`MERCHANT_CATEGORY_NOT_ALLOWED`, `LIMIT_EXCEEDED`, …), so the agent can adapt instead of retrying. See [How an agent pays](#how-an-agent-pays-without-the-card-number).
3. **Fund.** `request_funding(amount, currency)` either raises the monthly allowance right away (within `card.limit.tx` and above the wallet reserve floor) or creates a **pending approval** for the human in `card.approver`. The approval is HMAC-bound to the exact name, amount and currency.
4. **Freeze.** A cron job checks each card's recent activity. Two disallowed-merchant attempts within 10 minutes, or a burst of authorizations, freezes the card on Airwallex and sets `card.status=frozen` in ENS. Agents can freeze their own card; only a human can unfreeze.

## How an agent pays without the card number

The agent never holds a payment credential. It asks x402card to pay, and the credential travels from the card program to the merchant without passing through the agent:

```
  agent ──pay(merchant, amount, currency, mcc)──▶ x402card
                                                  │ 1. pre-check against the ENS policy:
                                                  │    status, card.limit.tx, currency, card.mcc.allow
                                                  │    → refuse here, before anything reaches the network
                                                  ▼
                                           card program (issuer adapter)
                                                  │ 2. credential goes to the merchant:
                                                  │    network token, or vaulted PAN at checkout
                                                  ▼
                                    card network authorization
                                                  │ 3. issuer enforces the same limits again
                                                  ▼
                                    approved · or declined with the rule it hit
```

In production, step 2 uses whatever the card program offers for agent checkout: an agent-scoped **network token** (as in Visa Intelligent Commerce or Mastercard Agent Pay), or a **vault** that swaps the real card number into the merchant's checkout on the server side. Either way the agent's MCP token can't be turned into a card number, and the card number can't be used outside its authorization controls.

**What runs today:** steps 1 and 3 run as described: the agent calls the `pay` MCP tool, x402card pre-checks it, and the issuer authorizes it against the card's controls. Step 2 is simulated because the sandbox has no real merchants: the adapter uses Airwallex's simulation endpoint, which runs a real authorization against the card's controls. A production adapter swaps in network-token or vaulted checkout behind the same `Issuer` interface.

`pay` answers with one of three decisions, so the agent knows which layer stopped it:

| `decision` | Meaning |
|---|---|
| `approved` | Pre-check passed and the issuer authorized the charge |
| `blocked` | Refused by x402card (`stage: "x402card"`); nothing reached the card network |
| `declined` | Passed the pre-check, refused by the issuer (`stage: "issuer"`), e.g. the monthly allowance is spent |

Codes are the same at both layers (`MERCHANT_CATEGORY_NOT_ALLOWED`, `LIMIT_EXCEEDED`, `CURRENCY_NOT_ALLOWED`, `CARD_FROZEN`, …). Blocked and declined attempts both count toward the anomaly rules, and a refusal runs them right away, so the second disallowed-merchant attempt freezes the card in the same call. Passing the same `request_id` on a retry replays the first result instead of charging again.

## Governance

Who can change what, and what it takes:

| Control | What it can do | Held by |
|---|---|---|
| `x402card.eth` (registrant + ENS registry owner) | point every card name at a different resolver | [2-of-3 Safe](https://app.safe.global/home?safe=eth:0x5A578eDdD28Bac066464BB2462ff052a65103602) ([registry](https://etherscan.io/tx/0x394c41ea2ca7993d428bb64ce8f524a944b1693d4d586a0e25037d69a73e050f), [registrant](https://etherscan.io/tx/0x85d92ef888c2d74f4d7763052dc388ec715cbce388a158b55670a93526b6fb84)) |
| `OffchainResolver` owner | change the gateway URL (`setUrl`) and trusted signers (`setSigner`), i.e. decide which answers count as valid | [2-of-3 Safe](https://app.safe.global/home?safe=eth:0x5A578eDdD28Bac066464BB2462ff052a65103602) ([tx](https://etherscan.io/tx/0x054742a8579fdb91d8ab7a9ad43199b5338934b0cb9c76483dc6e5375c033d30)) |
| Gateway signing key | sign record answers, valid 5 minutes each | Worker secret; separate from the owner key, revocable by the owner |
| Approvals, unfreeze, policy edits | raise limits, unfreeze cards, publish records | Worker admin token → moving to wallet-signed approvals |
| Agent token | its own card only: read, request funding, freeze | the agent |

**Target model**

- **A 2-of-3 Safe owns the root** (done). The name and the resolver are owned by Safe [`0x5A578eDdD28Bac066464BB2462ff052a65103602`](https://app.safe.global/home?safe=eth:0x5A578eDdD28Bac066464BB2462ff052a65103602) (Safe v1.5.0, threshold 2, three owners). Re-pointing the names, swapping the gateway or trusting a new signer needs two independent signatures, and a single leaked key can't make a frozen card read as `active`.
- **Approvals are signed by the approver.** `card.approver` names a wallet or a Safe. A funding request above policy, or an unfreeze, applies only with an EIP-712 signature from that approver (ERC-1271 for a Safe), bound to the exact card, amount, currency and request ID. The admin token stops being able to approve on its own.
- **Everything is visible.** Policy lives in public, signed ENS records, policy events are published at `/public/feed`, and the root's changes are on-chain Safe transactions.

What's already in place: agents hold only scoped tokens, approvals are HMAC-bound to their exact terms and apply once, an agent can freeze but never unfreeze, and the signing key is separate from the owner key. See [Security model](#security-model).

## Status

| Component | State |
|---|---|
| ENS OffchainResolver on mainnet, `x402card.eth` pointed at it | ✅ live, source verified |
| CCIP-Read gateway (signed records) | ✅ live |
| MCP server (6 tools, scoped tokens) | ✅ live |
| Policy engine, approvals, anomaly freeze | ✅ live; tested end to end against a fake issuer |
| Demo site on IPFS (`demo.x402card.eth`) | ✅ live |
| Airwallex card creation | ⏳ waiting on Airwallex to enable a card program on the sandbox account. Cardholders, config and balances work; `cards/create` returns `Invalid issuance details`. Until then the full flow runs against `FakeIssuer`, which enforces controls the way the sandbox does. |
| Root governance: name + resolver owned by a 2-of-3 Safe | ✅ done; registrant, registry owner and resolver owner are the Safe |
| Agent `pay` tool with policy pre-check | ✅ live; tested end to end against a fake issuer |
| Wallet-signed approvals (EIP-712 / ERC-1271) | ⏳ planned |

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
| Payment (`pay`) | card frozen, bad amount or MCC, currency not allowed, MCC not in `card.mcc.allow`, amount > `card.limit.tx` | **block** before the card network; otherwise pass to the issuer, which also enforces `MONTHLY` |
| Activity (cron, and after every refused payment) | ≥ 2 disallowed-MCC attempts in 10 min, or > 10 payment attempts in 10 min (issuer authorizations + pre-check blocks) | **freeze**: card `INACTIVE` + `card.status=frozen`. A human unfreeze starts a clean window. |

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
| `pay` | `name?`, `amount`, `currency`, `mcc`, `merchant`, `purpose?`, `request_id?` | `approved` · `blocked` + `code`, `reason` (x402card pre-check) · `declined` + `code` (issuer); `card_frozen` if this attempt froze the card |
| `request_funding` | `name?`, `amount`, `currency`, `purpose?` | `approved` + `new_monthly_limit` · `pending_human` + `approval_id`, `approver`, `approval_url` · `denied` + `reason` |
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

**Approval page:** [`demo.x402card.eth.limo/approve.html`](https://demo.x402card.eth.limo/approve.html) is a static UI over these endpoints. It shows pending requests with an allowance preview, Approve/Deny, the fleet with Unfreeze, and decision history. Escalated `request_funding` results include an `approval_url` that deep-links to the request, so the agent can hand it to its human. The admin token is kept in the tab's session storage only. Add `?api=http://127.0.0.1:8787` to point the page at a local Worker.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/cards` | Fleet: every card with records, status and pending approvals (admin) |

Typical platform flows:

- **Agent platform / framework:** issue one card per agent with the admin token, and pass the scoped agent token into the agent's MCP config. Your platform never stores card numbers.
- **Finance / ops console:** poll `/api/approvals`, show the request with its purpose, and post the decision. Watch `/public/feed` or the ENS records for freezes.
- **Merchant / counterparty:** resolve `card.status` and limits over ENS before accepting an order from an agent.

## Integrate: bring your own card issuer

x402card never issues the card itself. It's a **naming and policy layer**: a portable, human-readable identity (`<agent>.x402card.eth`) with public spend policy, scoped agent access, human approvals and a kill switch. A card from any program can sit behind that name. Agent-card programs from card networks, issuing platforms and wallet/crypto card providers can all attach their cards to an x402card name instead of building naming, policy publication and approval flows themselves.

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

## Demo runner

[`scripts/demo.ts`](scripts/demo.ts) runs the six-step demo against a live Worker: as the **agent** over MCP (with the scoped token it gets at issuance), and as the **operator** over the admin API (optionally, the approval).

| Step | What happens |
|---|---|
| 01 | `issue_card("researcher", tx ≤ $50, month ≤ $500, MCC 5734,7372)` → card + agent token; records read back over ENS |
| 02 | agent `pay`s $42 at MCC 5734 → approved |
| 03 | agent `pay`s $18 at MCC 7995 → blocked by x402card, `MERCHANT_CATEGORY_NOT_ALLOWED`, never reaches the network |
| 04 | agent requests $300 → paused (`300 > card.limit.tx`); a human approves on the approval page → `card.limit.monthly` 500 → 800 |
| 05 | second MCC 7995 attempt → anomaly rule fires in the same call → card frozen, `card.status = frozen` over ENS |
| 06 | $5 at an allowed merchant → `CARD_FROZEN` (the issuer card is `INACTIVE` too) |

```sh
npm run demo                              # production; waits for you to approve on the page
npm run demo -- --auto-approve            # unattended
npm run demo -- --name researcher2        # each run needs a fresh name (or --reuse)
npm run demo -- --api http://127.0.0.1:8787 --admin-token local-test   # local, with ISSUER=fake
```

Options: `--pace <ms>` between beats (default 1400, for screen recording), `--no-ens` to read records from the gateway instead of mainnet ENS. Operator-side tools: `POST /api/cards/:name/simulate` has a merchant charge the card directly, skipping the pre-check, to show the issuer layer on its own; `POST /api/cards/:name/check` runs the anomaly rules immediately instead of waiting for the cron.

## Development

```sh
npm test                 # policy engine, approvals, MCP protocol + full demo script (fake issuer)
npm run typecheck

# Full stack locally, no Airwallex: in-memory issuer + throwaway admin token
npx wrangler dev --var ISSUER:fake --var MCP_ADMIN_TOKEN:local-test
(cd site/www && python3 -m http.server 8765)   # open /approve.html?api=http://127.0.0.1:8787
cd contracts && npx hardhat node &          # then, from the repo root:
node scripts/e2e-resolver.ts                # resolver + gateway end to end on a local chain
```

The test suite runs the whole demo against `FakeIssuer` ([`src/testing.ts`](src/testing.ts)), which enforces card controls the way the sandbox does: issue `researcher`, an allowed `pay` clears, a disallowed MCC is blocked before the issuer, a $25 top-up auto-approves, a $300 request escalates and is approved, and a second disallowed MCC attempt freezes the card.

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
site/www/               demo site + approvals page (static; pinned to IPFS)
```

## Roadmap

- **Production checkout behind `pay`:** network-token (Visa Intelligent Commerce / Mastercard Agent Pay) or vaulted-PAN checkout in the issuer adapter, replacing the sandbox simulation.
- **Wallet-signed approvals** (EIP-712 from `card.approver`, ERC-1271 for Safes) replacing the admin token for approvals and unfreezes.
- **Issuer-agnostic attach:** `attach_card` for cards issued elsewhere, a `card.issuer` record, and adapters beyond Airwallex.
- **Paid self-serve issuance over x402**: let agents issue their own card name by paying a small fee in USDC, with the payer wallet becoming `card.approver`.
- **The same policy for x402 payments:** apply a name's ENS policy to x402 / USDC payments on Base, so one name governs both card and stablecoin spending.
- Airwallex webhooks for real-time freezes instead of the one-minute cron.

## License

MIT. See [LICENSE](LICENSE).
