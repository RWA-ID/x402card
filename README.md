# X Card

**Company cards you run by name.**
Every card has a name. Run them all from your AI app.

X Card is not a card issuer. Card programs issue the cards (Airwallex is the first one we plug into). X Card gives each card a company issues, to an employee, a team or an AI agent, a name with its spend policy on it. The name is the whole interface: a manager says "give maria.xcard.eth $300 for the offsite" or "freeze sam's card" to their AI app, and anything over the limits goes to the card's approver by email (or to their wallet). Nobody handles a card number.

X Card adds the parts a card needs before anyone should let a person or an agent spend with it:

- **A name.** Each agent card gets a human-readable ENS name such as `researcher.xcard.eth` (or `researcher.x402card.eth`: you pick the namespace) that stays the same when the card underneath is reissued, rotated or moved to another program.
- **A public policy.** Limits, currencies, allowed merchant categories, status and approver are ENS text records. Anyone (a merchant, another agent, an auditor) can check them with any ENS client, and every answer is signed and verified on-chain.
- **No credentials in the agent.** The agent works through an MCP server with a token scoped to its own card. It never sees the card number, CVC, card ID or an issuer API key.
- **A human in the loop.** Spending inside policy goes through. Funding requests above policy, and payments to merchants X Card can't verify, wait for the named approver: an email (they confirm with a code sent to it) or a wallet / ENS name (they sign). An anomaly freezes the card, flips `card.status` to `frozen` in ENS, and only a human can unfreeze it.
- **Trust in both directions.** Before a payment, X Card checks that the checkout really belongs to the merchant the agent means to pay ([verified payee](#verified-payee), using the open x402 `payee-name` records). At checkout, X Card signs the agent's request with [Visa's Trusted Agent Protocol](#visa-trusted-agent-protocol-tap) so the merchant can tell a trusted agent from a bot. Both checks are about the same domain.

The policy is enforced twice: by X Card before anything is sent, and by the card program's own authorization controls when the charge reaches the network.

| | |
|---|---|
| Site | https://x-card.dev (IPFS mirror: https://ai.xcard.eth.limo, https://demo.x402card.eth.limo) |
| ENS resolver (mainnet, verified) | [`0xf11eb8f6fbd761c25bd01064bab2e48ad90792a0`](https://etherscan.io/address/0xf11eb8f6fbd761c25bd01064bab2e48ad90792a0#code) |
| CCIP-Read gateway | `https://x402card.dmpay.workers.dev/gateway/{sender}/{data}.json` |
| MCP endpoint | `https://mcp.x-card.dev/mcp` |
| REST API | `https://api.x-card.dev` (also `https://x402card.dmpay.workers.dev`, which keeps working) |
| Visa TAP public key | [`https://api.x-card.dev/keys`](https://api.x-card.dev/keys) (keyid `BCwc4nK__9sgdXJKh-4w_AV76G4lsBXaSDWvk5orgoY`) |
| Demo merchant (verifies TAP) | `https://api.x-card.dev/demo-merchant/*` (`shop.xcard.eth` lists this origin and the workers.dev one) |
| Card rails | [Airwallex Issuing](https://www.airwallex.com/docs/issuing) (sandbox) |
| Contact | hello@x-card.dev · [@xcard_dev](https://x.com/xcard_dev) on X |

> **Sandbox, no real money.** ENS resolution and the payee check are real (Ethereum mainnet), and so are the TAP signatures. Cards, charges and balances run on the Airwallex sandbox.
>
> Built for the [Airwallex Agentic Banking Hackathon](https://airwallex.hackerearth.com/) (build phase, October to November 2026).

---

## Contents

- [How it works](#how-it-works)
- [How an agent pays](#how-an-agent-pays-without-the-card-number)
- [Trust both ways](#trust-both-ways)
- [Verified payee](#verified-payee)
- [Visa Trusted Agent Protocol (TAP)](#visa-trusted-agent-protocol-tap)
- [Governance](#governance)
- [Status](#status)
- [ENS records](#ens-records-the-policy)
- [Policy engine](#policy-engine)
- [Integrate: agents (MCP)](#integrate-agents-over-mcp)
- [Integrate: read policy from any ENS client](#integrate-read-a-cards-policy-from-any-ens-client)
- [Demo accounts and email approvals](#demo-accounts-and-email-approvals)
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
- [Built on](#built-on)

---

## How it works

```
                       ┌──────────────────────────────────────────────┐
  any ENS client       │ Ethereum mainnet                             │
  (viem, ethers,  ───▶ │ ENS registry: xcard.eth + x402card.eth       │
   wallets, apps)      │   └─ resolver: OffchainResolver (ENSIP-10)   │
                       │        reverts OffchainLookup(EIP-3668) ─────┼──┐
                       └──────────────────────────────────────────────┘  │
                                                                         ▼
  AI agent ──MCP──▶ ┌────────────────────────────── Cloudflare Worker ──────────┐
  (Claude, any     │  /mcp       10 tools + in-chat views (MCP Apps); OAuth     │
   MCP client)     │             wallet sign-in or scoped tokens                │
                   │  /gateway   signed answers to text()/addr() lookups        │
  human / platform │  /api       approvals (funding + held payments), unfreeze  │
  ──REST────────▶  │  /keys      Visa TAP public key (JWK set + registry shape) │
  merchant ─────▶  │  cron       anomaly check every minute → freeze            │
                   │                                                            │
                   │  policy engine + payee gate   KV: records · card refs ·    │
                   │  TAP signer (Ed25519)              approvals · events      │
                   └──────┬────────────────────────────────────────┬────────────┘
                          │ REST (x-client-id / x-api-key)         │ ETH_RPC_URL
                          ▼                                        ▼
              Airwallex Issuing (sandbox): cardholders,   Ethereum mainnet ENS:
              cards, authorization controls,              merchant names'
              transactions, simulation                    org.x402.origins
```

1. **Register.** `issue_card("researcher", policy)` creates a DELEGATE cardholder and a non-personalized virtual card on Airwallex, with the policy mapped to Airwallex `authorization_controls`. It publishes the policy as ENS text records and returns an **agent token** scoped to that one name.
2. **Pay.** `pay(amount, currency, mcc, merchant, merchant_url, payee_name)` is checked against the ENS policy first and refused before it reaches the card network if it breaks a rule. Then the [payee gate](#verified-payee) checks that the checkout's origin belongs to the ENS name the agent says it is paying. Airwallex then checks the authorization against the card's controls again: per-transaction limit, monthly limit, currencies and MCC allow-list. Either way a refusal carries the rule it hit (`MERCHANT_CATEGORY_NOT_ALLOWED`, `PAYEE_MISMATCH`, `LIMIT_EXCEEDED`, …), so the agent can adapt instead of retrying. See [How an agent pays](#how-an-agent-pays-without-the-card-number).
3. **Sign the checkout.** After an approved payment, `sign_request(url, "checkout")` returns [Visa TAP](#visa-trusted-agent-protocol-tap) headers for the agent's request to that merchant, which the merchant verifies against X Card's published key.
4. **Fund.** `request_funding(amount, currency)` either raises the monthly allowance right away (within `card.limit.tx` and above the wallet reserve floor) or creates a **pending approval** for the human in `card.approver`. The approval is HMAC-bound to the exact name, amount and currency.
5. **Change the policy.** `update_policy` changes limits (per transaction, daily, monthly), merchant categories or payee rules. Tightening applies at once; anything that loosens the policy waits for `card.approver` to sign the exact change. See [Changing the policy](#changing-the-policy).
6. **Freeze.** A cron job checks each card's recent activity. Two disallowed-merchant attempts or two payee mismatches within 10 minutes, or a burst of authorizations, freezes the card on Airwallex and sets `card.status=frozen` in ENS. Agents can freeze their own card; only a human can unfreeze.

## How an agent pays without the card number

The agent never holds a payment credential. It asks X Card to pay, and the credential travels from the card program to the merchant without passing through the agent:

```
  agent ──pay(merchant, merchant_url, payee_name, amount, currency, mcc)──▶ xcard
                                                  │ 1. pre-check against the ENS policy:
                                                  │    status, card.limit.tx, currency, card.mcc.allow
                                                  │    → refuse here, before anything reaches the network
                                                  │ 2. payee gate: does payee_name list merchant_url's origin?
                                                  │    → pay · block a lookalike · hold for card.approver
                                                  ▼
                                           card program (issuer adapter)
                                                  │ 3. credential goes to the merchant:
                                                  │    network token, or vaulted PAN at checkout
                                                  ▼
                                    card network authorization
                                                  │ 4. issuer enforces the same limits again
                                                  ▼
                                    approved · or declined with the rule it hit
  agent ──sign_request(merchant_url, checkout)──▶ xcard
                                                  │ 5. Visa TAP headers, only for an origin just paid
                                                  ▼
  agent ──checkout request + TAP headers──▶ merchant verifies with GET /keys
```

In production, step 2 uses whatever the card program offers for agent checkout: an agent-scoped **network token** (as in Visa Intelligent Commerce or Mastercard Agent Pay), or a **vault** that swaps the real card number into the merchant's checkout on the server side. Either way the agent's MCP token can't be turned into a card number, and the card number can't be used outside its authorization controls.

**What runs today:** steps 1, 2, 4 and 5 run as described: the agent calls the `pay` MCP tool, X Card pre-checks it and reads the payee's ENS records on mainnet, the issuer authorizes it against the card's controls, and `sign_request` returns real TAP signatures. Step 3 is simulated because the sandbox has no real merchants: the adapter uses Airwallex's simulation endpoint, which runs a real authorization against the card's controls. A production adapter swaps in network-token or vaulted checkout behind the same `Issuer` interface.

`pay` answers with one of four decisions, so the agent knows which layer stopped it:

| `decision` | Meaning |
|---|---|
| `approved` | Pre-check and payee gate passed and the issuer authorized the charge |
| `blocked` | Refused by X Card (`stage: "x402card"`); nothing reached the card network |
| `declined` | Passed X Card's checks, refused by the issuer (`stage: "issuer"`), e.g. the monthly allowance is spent |
| `pending_human` | The payee gate held it for `card.approver` (`approval_id`, `approval_url`); approving it makes the charge |

Every result carries `payee` (the gate's check) when the payee was evaluated. Codes are the same at both layers where they overlap (`MERCHANT_CATEGORY_NOT_ALLOWED`, `LIMIT_EXCEEDED`, `CURRENCY_NOT_ALLOWED`, `CARD_FROZEN`, …); the payee gate adds `PAYEE_MISMATCH`, `PAYEE_UNVERIFIED` and `PAYEE_NOT_ALLOWED`, and a held payment the approver denied replays as `DENIED_BY_APPROVER`. Blocked and declined attempts both count toward the anomaly rules, and a refusal runs them right away, so the second disallowed-merchant attempt freezes the card in the same call. Passing the same `request_id` on a retry replays the first result instead of charging again.

## Trust both ways

Card limits answer *how much* and *what kind of merchant*. Two more questions decide whether an agent payment is safe, and X Card answers both:

| Question | Who asks | How X Card answers | Standard |
|---|---|---|---|
| Is this checkout really the merchant I mean to pay? | the agent (and its card policy) | [Verified payee](#verified-payee): the merchant's ENS name lists the origins it takes payments on; X Card reads them on mainnet before charging | x402 [`payee-name`](https://github.com/x402-foundation/wg-identity/issues/36) records |
| Is this request from a trusted agent or a bot? | the merchant (or its CDN) | [Visa TAP](#visa-trusted-agent-protocol-tap): X Card signs the agent's request; the merchant verifies against X Card's published key | Visa Trusted Agent Protocol, RFC 9421 |

The two are bound to the same domain. The payee gate verifies the checkout's origin, and X Card issues a TAP checkout signature only for an origin it just approved a payment to, so the merchant that receives a trusted-agent signature is the one the agent's policy checked.

```
  agent                         xcard                               merchant (shop.example)
    │ pay(merchant_url=https://shop.example/checkout, payee_name=shop.eth)
    │──────────────────────────▶│ policy pre-check
    │                           │ ENS: shop.eth → org.x402.origins ∋ https://shop.example ✓
    │                           │ issuer authorizes the charge
    │◀── approved ──────────────│ opens a 15-minute checkout window for https://shop.example
    │ sign_request(url=https://shop.example/checkout, checkout)
    │──────────────────────────▶│
    │◀── Signature-Input, Signature (agent-payer-auth, 8 min, one use)
    │ GET /checkout + headers ─────────────────────────────────────────▶│ GET xcard /keys
    │                                                                   │ verify tag, time, key,
    │◀────────────────────────────────── trusted agent: express checkout│ signature, nonce
```

## Verified payee

Limits and MCCs say how much and what kind of merchant. The payee gate asks **who**: is this checkout really the merchant the agent means to pay? A prompt-injected page, a typosquatted domain or a fake "checkout" link all look like ordinary merchants to a card authorization. The payee gate catches them before the card is charged.

### How a merchant opts in

A merchant (or any payee) sets one text record on its ENS name, listing the origins it takes payments on, separated by spaces:

```
shop.eth   org.x402.origins = "https://shop.example https://api.shop.example"
```

This is the origin half of the x402 [`payee-name`](https://github.com/x402-foundation/wg-identity/issues/36) extension from [x402 Identity Hub](https://x402id.dev). Any ENS manager can set it (the ENS app, a Safe, a script). Nothing else is needed: no registration with X Card, no API key.

### What the agent passes

```jsonc
// MCP tools/call → pay
{ "amount": 20, "currency": "USD", "mcc": "5734", "merchant": "ModelHub API",
  "merchant_url": "https://api.modelhub.example/v1/checkout",   // the page or API it is paying
  "payee_name": "modelhub.eth",                                 // the name the merchant shows
  "request_id": "order-1182" }
```

X Card takes the origin of `merchant_url` (`https://api.modelhub.example`) and reads `payee_name`'s records on Ethereum mainnet with [`@x402identity/payee`](https://www.npmjs.com/package/@x402identity/payee) ([`src/policy/payee.ts`](src/policy/payee.ts)). The check runs only after the policy pre-check passes, so a payment that breaks a limit never costs a chain read.

### Outcomes

| Check (`payee.status`) | When | Reason codes (`payee.reason`) |
|---|---|---|
| **verified** | the name is live and lists the checkout's origin | `origin-bound` |
| **mismatch** | the name lists other origins, or has expired, or isn't normalized: the shape of a lookalike checkout | `origin-not-listed`, `name-expired`, `name-not-normalized` |
| **unverified** | nothing to check against | `no-payee-name`, `no-merchant-url`, `no-origins-listed` (the name exists but never opted in), `no-records`, `name-in-grace`, `resolution-failed` (the RPC read failed), `unsupported-name` (not `.eth`) |

What happens next is the card's `card.payee` record:

| | `any` (default) | `verified-or-escalate` | `verified-only` |
|---|---|---|---|
| **verified** | pay | pay | pay |
| **verified, not in `card.payee.allow`** | n/a | hold for `card.approver` | block `PAYEE_NOT_ALLOWED` |
| **mismatch** | pay (check reported) | block `PAYEE_MISMATCH` | block `PAYEE_MISMATCH` |
| **unverified** | pay (check reported) | hold for `card.approver` | block `PAYEE_UNVERIFIED` |

- **A mismatch is a strike.** Two `PAYEE_MISMATCH` blocks within 10 minutes freeze the card, the same way repeated disallowed-MCC attempts do: one is a typo, two means something is steering the agent.
- **A held payment** returns `decision: "pending_human"` with `approval_id`, `approver` and `approval_url`. The approval's HMAC binds the card, amount, currency, MCC, merchant URL and payee name, so approving it can't pay anyone else. Approving re-checks the card's policy as it stands then and makes the charge; denying records `DENIED_BY_APPROVER`. A retry with the same `request_id` returns whatever the human decided.
- **A failed chain read never passes a payment.** It comes back `unverified` (`resolution-failed`) and is held or blocked like any other unverified payee.
- **Under `any`** the gate still runs when the agent names a payee, and the result is reported in `payee`, but it never blocks. Cards issued before the payee gate have no `card.payee` record and behave exactly as before.
- **Verified payees show by name.** The activity feed and approval page show `ModelHub API (modelhub.eth ✓)` instead of the free-text merchant the agent typed.

### Example result

```json
{
  "decision": "blocked", "stage": "x402card", "code": "PAYEE_MISMATCH",
  "reason": "modelhub.eth at https://modelhub-pay.example: origin-not-listed",
  "payee": { "status": "mismatch", "name": "modelhub.eth", "origin": "https://modelhub-pay.example",
             "reason": "origin-not-listed", "checked_at": "2026-10-27T03:13:46.506Z" }
}
```

### Limits

- **The origin comes from the agent.** This protects an honest agent from a lookalike checkout, prompt injection or a typo. It doesn't stop an agent that deliberately reports a false URL; the issuer's limits and MCCs still bind that agent, and the TAP signature it gets is only valid on the domain it reported.
- **Card payments use the origin half only.** A card payment has no `payTo` address (the card network routes the money), so the address-binding half of `payee-name` doesn't apply. The verifier checks origin before `payTo`, so X Card passes a placeholder `payTo` that can never match and reads `payto-not-listed` as "origin verified". A dedicated origin-only export in `@x402identity/payee` is on the roadmap.
- **Most merchants haven't opted in yet,** so most will read `unverified`. Use `verified-or-escalate` to keep paying them with a human in the loop, and `card.payee.allow` to pin a card to the merchants it should use.

## Visa Trusted Agent Protocol (TAP)

The payee gate tells the agent who the merchant is. [TAP](https://developer.visa.com/capabilities/trusted-agent-protocol) tells the merchant who the agent is. The agent sends an [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421) HTTP message signature over the request's `@authority` and `@path`, tagged `agent-browser-auth` (browsing) or `agent-payer-auth` (checkout). A merchant, or the CDN in front of it, verifies it against the agent's public key and can serve the agent instead of blocking it as a bot. X Card acts as the agent's signing provider: the private key stays in the Worker, and the agent gets per-request headers.

### Getting signatures

```jsonc
// MCP tools/call → sign_request
{ "url": "https://api.modelhub.example/checkout", "purpose": "checkout" }

// result
{
  "url": "https://api.modelhub.example/checkout",
  "tag": "agent-payer-auth",
  "headers": {
    "Signature-Input": "sig2=(\"@authority\" \"@path\");created=1793071683;expires=1793072163;keyid=\"BCwc…\";keyId=\"BCwc…\";alg=\"ed25519\";nonce=\"qRXN…\";tag=\"agent-payer-auth\"",
    "Signature": "sig2=:jdq0SqOw…:"
  },
  "keyid": "BCwc4nK__9sgdXJKh-4w_AV76G4lsBXaSDWvk5orgoY",
  "expires_at": "2026-10-27T04:16:03.000Z",
  "keys_url": "https://api.x-card.dev/keys"
}
```

The agent sends both headers, unchanged, on its request to exactly that host and path.

| `purpose` | Tag | When X Card signs |
|---|---|---|
| `browse` | `agent-browser-auth` | any http(s) URL: product pages, availability, prices |
| `checkout` | `agent-payer-auth` | only for an origin this card paid with policy approval in the last 15 minutes, directly or after `card.approver` released a held payment. Otherwise `no_approved_payment`. |

A frozen card signs nothing (`frozen`), and a deployment without a key returns `tap_not_configured`. Each signature lasts 8 minutes (the spec's cap) and carries a fresh 256-bit nonce, so it works once.

### Verifying as a merchant

1. Read the `sig2` member of `Signature-Input`. No `agent-browser-auth` / `agent-payer-auth` tag means it isn't a TAP agent; handle it as you do today.
2. Require `created`, `expires`, `keyid` (or `keyId`), `alg`, `nonce` and `tag`, covering `("@authority" "@path")`.
3. `created` must be in the past, `expires` in the future, at most 8 minutes apart.
4. Fetch the key: `GET https://api.x-card.dev/keys?keyID=<keyid>` (cache it).
5. Rebuild the signature base and verify Ed25519:
   ```
   "@authority": api.modelhub.example
   "@path": /checkout
   "@signature-params": ("@authority" "@path");created=…;expires=…;keyid="…";keyId="…";alg="ed25519";nonce="…";tag="agent-payer-auth"
   ```
   (`@signature-params` is the `Signature-Input` member verbatim, without the `sig2=` label.)
6. Reject a nonce you've seen in the last 8 minutes.

[`src/tap/verify.ts`](src/tap/verify.ts) implements these steps (with the nonce claimed only after the signature verifies, so a forged request can't burn a real agent's nonce). The Worker's `/demo-merchant/*` runs it:

```sh
curl -s https://api.x-card.dev/demo-merchant/checkout \
  -H 'Signature-Input: sig2=(…)' -H 'Signature: sig2=:…:'
# {"merchant":"demo","page":"/checkout","trusted_agent":true,"tag":"agent-payer-auth",
#  "keyid":"BCwc…","message":"Trusted agent at checkout: express checkout offered."}
# the same headers again → 403 {"code":"REPLAYED",…}; no headers → {"code":"NOT_AGENT",…}
```

### Keys

| Endpoint | Returns | For |
|---|---|---|
| `GET /keys` (optionally `?keyID=`) | `{"keys":[{"kty":"OKP","crv":"Ed25519","x":"…","kid":"…","use":"sig","alg":"EdDSA"}]}` | the spec's Public Key Retrieval (JWK set) |
| `GET /keys/:keyid` | `{"key_id":"…","algorithm":"ed25519","public_key":"<base64 raw 32 bytes>","is_active":true}` | Visa's [reference merchant](https://github.com/visa/trusted-agent-protocol), which fetches this shape from its agent registry |

The `keyid` is the key's RFC 7638 JWK thumbprint. To rotate: generate a new key with `scripts/tap-keygen.ts`, `wrangler secret put TAP_PRIVATE_KEY`, and the new keyid is served at once; signatures made with the old key stop verifying when they expire (8 minutes at most).

### Compatibility with Visa's spec and reference code

Visa's published spec and its reference implementation disagree in a few places. X Card signs so that both accept it:

| | Published spec | Reference code (`cdn-proxy`) | X Card |
|---|---|---|---|
| key parameter | `keyid` | reads `keyId` | sends **both**, both inside the signed parameters |
| `alg` | `Ed25519` | `ed25519` | `ed25519` (the RFC 9421 registered name); the verifier accepts either case |
| signature base | sample includes `sig2=` in `@signature-params` | `Signature-Input` verbatim minus `sig2=` | RFC 9421 form, the same as the reference code |
| key lookup | `GET /keys?keyID=` → JWK | `GET {registry}/keys/{keyId}` → `{key_id, algorithm, public_key}` | serves both |

[`src/tap/tap.test.ts`](src/tap/tap.test.ts) runs every X Card signature through a line-for-line port of the reference merchant's verifier, checks the RFC 8037 thumbprint test vector, and covers replay, wrong host or path, expired and future timestamps, unknown keys and other dictionary members.

### Not yet

The spec's two body objects, the Agentic Consumer Recognition Object and the Agentic Payment Container, carry a Visa-issued ID token and payment credentials from Visa Intelligent Commerce (VIC). They need VIC onboarding and an issuer that supports it, so they aren't implemented. The message signature (agent recognition) is independent of them, and is what merchants check first.

## Governance

Who can change what, and what it takes:

| Control | What it can do | Held by |
|---|---|---|
| `xcard.eth` (wrapped; NameWrapper owner) | point every `*.xcard.eth` card name at a different resolver | [2-of-3 Safe](https://app.safe.global/home?safe=eth:0x5A578eDdD28Bac066464BB2462ff052a65103602) ([resolver](https://etherscan.io/tx/0xdff8b9bdbc5c6ac4d6772f31d57d9cb00ea1082fd474eaa3a2b39f2c70b6439a), [transfer](https://etherscan.io/tx/0x5e0679de420376f941fe51f290221cb264fd65e35fadefb61ca32f5e37e7c329)) |
| `x402card.eth` (registrant + ENS registry owner) | point every `*.x402card.eth` card name at a different resolver | [2-of-3 Safe](https://app.safe.global/home?safe=eth:0x5A578eDdD28Bac066464BB2462ff052a65103602) ([registry](https://etherscan.io/tx/0x394c41ea2ca7993d428bb64ce8f524a944b1693d4d586a0e25037d69a73e050f), [registrant](https://etherscan.io/tx/0x85d92ef888c2d74f4d7763052dc388ec715cbce388a158b55670a93526b6fb84)) |
| `OffchainResolver` owner | change the gateway URL (`setUrl`) and trusted signers (`setSigner`), i.e. decide which answers count as valid | [2-of-3 Safe](https://app.safe.global/home?safe=eth:0x5A578eDdD28Bac066464BB2462ff052a65103602) ([tx](https://etherscan.io/tx/0x054742a8579fdb91d8ab7a9ad43199b5338934b0cb9c76483dc6e5375c033d30)) |
| Gateway signing key | sign record answers, valid 5 minutes each | Worker secret; separate from the owner key, revocable by the owner |
| TAP signing key | sign agents' requests to merchants (8 minutes, one use) | Worker secret `TAP_PRIVATE_KEY`; separate from every on-chain key; rotated with one secret update |
| Approvals | raise limits, release held payments, loosen policy | `card.approver`: an email approver signed in with a code to that address, or a wallet signature (EIP-712; ERC-1271 for a Safe); or the Worker admin token |
| Unfreeze | unfreeze cards | the card's demo account (its issuer or approver, signed in by email), or the Worker admin token |
| Agent token | its own card only: read, pay, sign requests, request funding, freeze | the agent |

**Target model**

- **A 2-of-3 Safe owns the root** (done). The name and the resolver are owned by Safe [`0x5A578eDdD28Bac066464BB2462ff052a65103602`](https://app.safe.global/home?safe=eth:0x5A578eDdD28Bac066464BB2462ff052a65103602) (Safe v1.5.0, threshold 2, three owners). Re-pointing the names, swapping the gateway or trusting a new signer needs two independent signatures, and a single leaked key can't make a frozen card read as `active`.
- **Approvals are signed by the approver.** `card.approver` names a wallet or a Safe. A funding request above policy, or an unfreeze, applies only with an EIP-712 signature from that approver (ERC-1271 for a Safe), bound to the exact card, amount, currency and request ID. The admin token stops being able to approve on its own.
- **Everything is visible.** Policy lives in public, signed ENS records, policy events are published at `/public/feed`, and the root's changes are on-chain Safe transactions.

What's already in place: agents hold only scoped tokens, approvals are HMAC-bound to their exact terms and apply once, an agent can freeze but never unfreeze, and the signing key is separate from the owner key. See [Security model](#security-model).

## Status

| Component | State |
|---|---|
| ENS OffchainResolver on mainnet, `xcard.eth` and `x402card.eth` pointed at it | ✅ live, source verified |
| CCIP-Read gateway (signed records) | ✅ live |
| MCP server (10 tools; OAuth wallet sign-in or scoped tokens) | ✅ live at `mcp.x-card.dev` |
| In-chat views (MCP Apps): card view, approval card, issue form, TAP signature | ✅ live; rendered in Claude.ai |
| `update_policy` + daily limit (tighten now, loosen with a wallet signature) | ✅ live; first live policy approval signed in Claude.ai on 2026-10-28 |
| Self-serve test cards (`testN.xcard.eth`, issued from the chat) | ✅ live |
| Policy engine, approvals, anomaly freeze | ✅ live; tested end to end against a fake issuer |
| Site on `x-card.dev` (Cloudflare) with an IPFS mirror (`ai.xcard.eth`) | ✅ live |
| Airwallex card creation | ✅ live on an Airwallex demo account: real sandbox virtual Visa cards with our controls applied |
| Airwallex charges (`pay`) | ⏳ the sandbox's transaction simulator is down for Airwallex maintenance ([status page](https://status.airwallex.com/): "Degraded performance in Sandbox simulation features", since 2026-10-26), so charges fail at the issuer step. Everything before it (pre-check, payee gate, held payments) works live; tests run the full flow against `FakeIssuer`. |
| Root governance: names + resolver owned by a 2-of-3 Safe | ✅ done; both parent names and the resolver are owned by the Safe |
| Agent `pay` tool with policy pre-check | ✅ live; tested end to end against a fake issuer |
| Verified payee (payee gate, `card.payee`, held payments) | ✅ live; tested end to end, verifier checked against mainnet ENS. Not yet exercised on a live card (needs Airwallex issuance). |
| Visa TAP signing (`sign_request`, `/keys`, demo merchant) | ✅ live; signatures verified by a port of Visa's reference merchant |
| TAP body objects (consumer recognition, payment container) | ⏳ need Visa Intelligent Commerce onboarding |
| Demo accounts (email code sign-in), the console (`/console`), email approvers with branded approval emails | ✅ built 2026-10-29; codes and approval emails from `x-card.dev` via Resend; approver emails masked on every public surface |
| Wallet-signed approvals (EIP-712 / ERC-1271) | ✅ built: `approval_url` opens the request on the approval page, which signs with the approver's own wallet and posts to `/approvals/:id`; tested with real signatures, in a browser, and checked against mainnet ENS. Unfreeze still needs the admin token. |

## ENS records (the policy)

Every card name, `<label>.xcard.eth` or `<label>.x402card.eth`, exposes these text records. They're public, so they hold **policy only**: never the card number, CVC or card ID.

| Key | Example | Meaning |
|---|---|---|
| `card.limit.tx` | `50` | Max per transaction, in major units of the first currency. Funding requests above this need a human. |
| `card.limit.daily` | `200` | Max per day. Optional: empty means no daily limit. Must sit between `card.limit.tx` and `card.limit.monthly`. Sent to Airwallex as a `DAILY` limit. |
| `card.limit.monthly` | `500` | Monthly allowance. Approved funding raises it. |
| `card.currencies` | `USD` | Allowed transaction currencies, comma-separated. The first is the limit currency. |
| `card.mcc.allow` | `5734,7372` | Allowed 4-digit merchant category codes. Empty means any. |
| `card.status` | `active` \| `frozen` | Mirrors the Airwallex card state. |
| `card.approver` | `alice.eth` | Who approves escalations. |
| `card.payee` | `verified-or-escalate` | What a payment must prove about its payee: `any` (the default), `verified-or-escalate` or `verified-only`. See [Verified payee](#verified-payee). |
| `card.payee.allow` | `modelhub.eth,aws.eth` | ENS names this card may pay. Empty means any verified payee. Needs `card.payee` other than `any`. |

**Namespaces.** Both parents resolve through the same resolver and gateway. The same label under each is a separate card with its own policy and token. Pass the full name to choose; a bare label (`researcher`) means `x402card.eth`, the original namespace.

Reserved labels that can't be issued: `ai`, `www`, `app`, `api`, `gateway`, `shop` under both parents, and `demo` under `x402card.eth` only. `ai.xcard.eth` and `demo.x402card.eth` have their own on-chain resolver and host the site; `shop.xcard.eth` is the demo merchant's payee name, served by the gateway. `demo.xcard.eth` is an ordinary card name.

## Policy engine

Plain, deterministic TypeScript with no LLM ([`src/policy/engine.ts`](src/policy/engine.ts)):

| Input | Rule | Outcome |
|---|---|---|
| Records | → `authorization_controls`: `PER_TRANSACTION`, `DAILY` (when set), `MONTHLY`, `allowed_currencies`, `allowed_merchant_categories` | enforced by Airwallex at authorization time |
| Funding request | card frozen, currency not allowed, bad decimals | **deny** |
| Funding request | amount > `card.limit.tx`, or > global ceiling ($250), or wallet would drop below reserve floor ($1,000) | **escalate** to `card.approver` |
| Funding request | otherwise | **approve**: raise `card.limit.monthly` and the Airwallex `MONTHLY` limit together |
| Payment (`pay`) | card frozen, bad amount or MCC, currency not allowed, MCC not in `card.mcc.allow`, amount > `card.limit.tx` or > `card.limit.daily` | **block** before the card network; otherwise pass to the issuer, which also enforces what's left of `DAILY` and `MONTHLY` |
| Policy change (`update_policy`) | every change tightens (lower limit, fewer categories, stricter payee rule, a new daily limit) | **apply** now, records and Airwallex controls together |
| Policy change (`update_policy`) | any change loosens | **escalate** the whole change to `card.approver`; nothing changes until they sign it |
| Payment (`pay`) | passed the pre-check: payee gate per `card.payee` | **block** a lookalike (`PAYEE_MISMATCH`); **block** or **escalate** an unverified payee; otherwise pay |
| Activity (cron, and after every refused payment) | ≥ 2 disallowed-MCC attempts in 10 min, ≥ 2 payee mismatches in 10 min, or > 10 payment attempts in 10 min (issuer authorizations + pre-check blocks) | **freeze**: card `INACTIVE` + `card.status=frozen`. A human unfreeze starts a clean window. |

Amounts are major units (`300` = $300), rounded to the currency's decimals. A charge counts as successful only once it reaches `CLEARING`; declines carry `failure_reason`.

---

## Integrate: agents over MCP

The MCP server speaks **Streamable HTTP** (stateless JSON responses; protocol versions `2025-06-18`, `2025-03-26`, `2024-11-05`) and takes a bearer token: an OAuth access token from signing in with your wallet, or one of the static tokens.

- **OAuth, for Claude.ai, ChatGPT and other apps that add a connector by URL.** Add `https://mcp.x-card.dev/mcp` as a custom connector. The app finds the sign-in on its own (RFC 9728 metadata on the `401`, then dynamic client registration or a client ID metadata document, PKCE). You sign in with your wallet (Sign-In with Ethereum) and pick what to connect:
  - **All my cards** (offered first): every card whose `card.approver` resolves to your wallet, read again on each request, so cards issued to you later show up and reassigned ones drop off. Offered even with no cards yet, so a new wallet can connect and issue itself a test card.
  - **one card whose `card.approver` resolves to your wallet.** The app acts as that card's agent, with the same tools and limits as its agent token.
  - **every card**, if your wallet is listed in the Worker's `OPERATORS`. Same as the admin token.

  Connecting never lets the app approve anything: requests over the policy still need your signature on the approval page. A connection ends if the card's `card.approver` changes. Tokens last an hour and refresh for up to 30 days.
- **Admin token**: can call every tool; `issue_card` with any name and policy, and `update_policy` applies directly. Keep it on the operator side.
- **Agent token** (`x4c_…`): returned once by `issue_card`. It only works for its own card, and `issue_card` is hidden from it. Give this to the agent.

### Claude Code

```sh
claude mcp add --transport http xcard https://mcp.x-card.dev/mcp \
  --header "Authorization: Bearer x4c_your_agent_token"
```

### Claude Desktop, Cursor, VS Code and other JSON-configured clients

```json
{
  "mcpServers": {
    "xcard": {
      "type": "http",
      "url": "https://mcp.x-card.dev/mcp",
      "headers": { "Authorization": "Bearer x4c_your_agent_token" }
    }
  }
}
```

For clients that only speak stdio, bridge with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):
`npx mcp-remote https://mcp.x-card.dev/mcp --header "Authorization: Bearer x4c_…"`

### Raw JSON-RPC

```sh
curl -s https://mcp.x-card.dev/mcp \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"request_funding","arguments":{"amount":300,"currency":"USD","purpose":"dataset license"}}}'
```

### Tools

| Tool | Arguments | Returns |
|---|---|---|
| `issue_card` | Operator: `name`, `policy: { limit_tx, limit_daily?, limit_monthly, currencies[], mcc_allow[], approver, payee?, payee_allow[]? }`. Wallet sign-in: no arguments, or a suggested `policy` | Operator: `card`, `agent_token` (shown once). Wallet sign-in: `decision: "form"` with defaults and caps; the person submits the form in the chat and gets the next free `testN.xcard.eth` with their wallet as approver (caps: $50/transaction, $200/day, $500/month, USD, 3 per wallet). The issued card in the chat shows an agent token once, for an autonomous agent; it stays out of the text the model reads |
| `list_cards` | | every card this connection can use: `name`, `status`, `last4`, limits, categories, payee rule, approver, `pending_approvals` |
| `get_card` | `name?` | `name`, `status`, `last4`, `records`, `pending_approvals[]` |
| `pay` | `name?`, `amount`, `currency`, `mcc`, `merchant`, `merchant_url?`, `payee_name?`, `purpose?`, `request_id?` | `approved` · `blocked` + `code`, `reason` (X Card pre-check or payee gate) · `declined` + `code` (issuer) · `pending_human` + `approval_id`, `approval_url` (payee held); `payee` check; `card_frozen` if this attempt froze the card |
| `sign_request` | `name?`, `url`, `purpose: browse \| checkout` | Visa TAP `headers` (`Signature-Input`, `Signature`) for one request to `url`, `tag`, `keyid`, `expires_at`, `keys_url`. `checkout` needs an approved `pay` to that origin in the last 15 min. See [Visa TAP](#visa-trusted-agent-protocol-tap). |
| `request_funding` | `name?`, `amount`, `currency`, `purpose?` | `approved` + `new_monthly_limit` · `pending_human` + `approval_id`, `approver`, `approval_url` · `denied` + `reason` |
| `update_policy` | `name?`, any of `limit_tx`, `limit_daily` (`0` removes it), `limit_monthly`, `mcc_allow[]`, `payee`, `payee_allow[]`; `reason?` | `applied` + `changes`, `card` · `pending_human` + `changes`, `approval_id`, `approval_url` · `unchanged`. See [Changing the policy](#changing-the-policy). |
| `get_approval` | `approval_id` | `approval` (status: pending, approved, denied or expired; amount, merchant…), `card`, `approval_url`. The agent can't decide it: `card.approver` signs on the approval page. See [Approving with a wallet](#approving-with-a-wallet). |
| `freeze` | `name?`, `reason?` | `card` (now `frozen`) |
| `list_transactions` | `name?` | `type`, `status`, `settled`, `amount`, `currency`, `merchant`, `mcc`, `decline_reason`, `at` |

With an agent token, or a connection with a single card, `name` is optional and defaults to that card. Tool failures come back as results with `isError: true` and a `code: message` the model can read (`forbidden`, `not_found`, `bad_policy`, `airwallex_…`).

### In-chat views (MCP Apps)

In apps that support [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) (Claude.ai among them), every tool's result shows as an interactive view in the chat. Each is a `ui://` resource (`text/html;profile=mcp-app`) linked from the tool's `_meta.ui.resourceUri`; other clients get the same JSON as before.

| View | Tools | What it shows |
|---|---|---|
| `ui://xcard/card.html` | `get_card`, `list_cards`, `freeze`, `list_transactions`, `sign_request` | The card face as on the site (mark, chip, last 4, name; iced with a FROZEN stamp when frozen), policy tags, approver, waiting requests and the ENS text records; a grid for `list_cards`; a transaction list; a TAP signature with its headers and a live expiry |
| `ui://xcard/approval.html` | `pay`, `request_funding`, `update_policy`, `get_approval` | The request (amount, or each policy change from → to) with **Approve** and **Deny**. They sign the EIP-712 approval with the wallet in the frame when the app exposes one; otherwise a small popup on the approval page asks the wallet right away and closes itself (a tab if popups are blocked), and the card follows the decision. Then it tells the chat. |
| `ui://xcard/issue.html` | `issue_card` | A form for the policy: limits within the caps, categories as chips, payee check. Submitting issues the card through the app (`tools/call`), and the view turns into the issued card. |

Wallet extensions don't inject into the chat's sandboxed frame in Claude.ai, so there the popup is what signs.

### Changing the policy

`update_policy` takes only what changes, validates the result as a whole (`card.limit.tx ≤ card.limit.daily ≤ card.limit.monthly`), and classifies each change ([`src/policy/changes.ts`](src/policy/changes.ts)):

| Change | Tightens | Loosens |
|---|---|---|
| A limit | lower, or adding a daily limit | higher, or removing the daily limit |
| `card.mcc.allow`, `card.payee.allow` (empty = any) | fewer entries, or a list where there was none | a new entry, or emptying the list |
| `card.payee` | towards `verified-only` | towards `any` |

If every change tightens, it applies at once, to the ENS records and the Airwallex controls together. If any change loosens, nothing changes: the whole change becomes an approval for `card.approver`, who signs EIP-712 typed data of primary type `PolicyChange(string id, string decision, string card, string changes, string approver, uint256 expires)`, where `changes` reads like `card.limit.tx 50 → 100; card.limit.daily 200 → 300`, so the wallet shows exactly what is being allowed. The approval is HMAC-bound to every change (record, from, to). It is refused, not applied on top, if any of those records changed after the request. The approver and currencies can't be changed this way, and only a human can unfreeze. With the admin token, changes apply directly.

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
curl https://api.x-card.dev/public/cards/researcher.x402card.eth
```

**Use it as a pre-flight check.** A merchant, marketplace or another agent can refuse to start work for `card.status != active`, or quote within `card.limit.tx`, before any payment is attempted.

## Demo accounts and email approvals

Card programs and finance teams aren't crypto teams, so nothing on the main path needs a wallet.

- **Sign in with an email.** "Create a demo account" on [x-card.dev](https://x-card.dev) asks for an email and mails a 6-digit code from `login@x-card.dev`. The code is stored only as a keyed hash, works once, for 10 minutes, with 5 tries; sending is limited to 5 codes per address and 20 per IP an hour. A good code returns a 7-day session token (`xs_…`), which the site keeps in local storage and sends as a Bearer token.
- **The console** ([x-card.dev/console](https://x-card.dev/console)) is where cards are managed. A demo account picks a name under `xcard.eth` (the name check shows whether it's free), sets the per-transaction, daily and monthly limits, merchant categories and payee rule, and names the approver: its own email by default, a colleague's email, or a wallet / ENS name. Caps: $500 per transaction, $2,000 a day, $5,000 a month, USD, 5 cards per account. Every card comes with an agent token for it (shown once). The account sees the cards it issued and the cards it approves, as a grid of card faces, with pending requests and history.
- **Email approvers.** When an agent asks for more than a card allows and `card.approver` is an email, X Card emails them (`approvals@x-card.dev`) the card, the amount, the rule it hit and a "Review and decide" link to `x-card.dev/approve#<id>`. The decision only counts if they're signed in as that email, so a forwarded email can't approve anything. Someone else signed in gets `403 not_approver`.
- **Privacy.** ENS records are public, so an email approver is masked everywhere public: the gateway answer, `/public/cards`, the public approval link and the feed show `m•••@acme.com`. The full address stays private and is used only to email and sign in that approver.
- **Wallets still work.** A card whose approver is a wallet or an ENS name is approved with an EIP-712 signature exactly as before ([Approving with a wallet](#approving-with-a-wallet)).

Endpoints (no token for the first two; `Authorization: Bearer xs_…` for the rest):

| Method | Path | Body | Purpose |
|---|---|---|---|
| `POST` | `/auth/email/start` | `{ "email": "maria@acme.com" }` | Mail a sign-in code |
| `POST` | `/auth/email/verify` | `{ "email", "code" }` | `{ token, email }`: a 7-day session |
| `POST` | `/auth/signout` | | End the session |
| `GET` | `/api/me` | | `{ email, caps }` |
| `GET` | `/api/names/:name` | | `{ name, available, reason? }` |
| `GET` | `/api/cards` | | The account's cards (issued or approved), `issued_by_me` on its own |
| `POST` | `/api/cards` | `{ "name": "maria", "policy": { limit_tx, limit_daily?, limit_monthly, mcc_allow[], approver?, payee?, payee_allow[]? } }` | Issue under `xcard.eth` within the caps; returns `card` and `agent_token` |
| `GET` | `/api/approvals` | | Requests on the account's cards or naming it as approver, each with `can_decide` |
| `POST` | `/api/approvals/:id` | `{ "approve": true \| false }` | Decide, as the email approver |
| `POST` | `/api/cards/:name/unfreeze` | | Unfreeze one of the account's cards |

## Integrate: platforms (approvals and oversight)

Admin endpoints (`Authorization: Bearer <admin token>`):

| Method | Path | Body | Purpose |
|---|---|---|---|
| `GET` | `/api/approvals` | | Pending and decided approvals, newest first: funding requests (`kind: "funding"`) and payments the payee gate held (`kind: "payment"`, with `payment: { merchant, merchantUrl, payeeName, payeeStatus, mcc, purpose }`) |
| `POST` | `/api/orgs` | `{ "slug": "acme", "name": "Acme", "operators": ["ops@acme.com"], "caps"?: { tx, daily, monthly, cards } }` | Create or replace a company. Its operators sign in by email, issue its cards within its caps over the connector and see them all; approvals stay with each card's approver |
| `POST` | `/api/approvals/:id` | `{ "approve": true \| false, "by": "alice.eth" }` | Decide. Applies exactly what was signed: funding raises the allowance; a held payment is re-checked against the policy and charged (the response's `approval.charge` says whether the issuer approved it). A second decision fails. |
| `POST` | `/api/cards/:name/unfreeze` | | Human-only unfreeze; also flips `card.status` back to `active` |

Public, unauthenticated:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/public/cards/:name` | The card's public records (same data the gateway signs) |
| `GET` | `/public/feed` | Recent policy events: issued, charged, blocked (with `code`, e.g. `PAYEE_MISMATCH`), declined, funded, escalated, approved, denied, frozen, unfrozen |
| `GET` | `/approvals/:id` | One approval and the typed data its approver signs (the random approval ID is the link; same shape as `get_approval`) |
| `POST` | `/approvals/:id` | `{ "approve": true \| false, "signature": "0x…" }`: decide with `card.approver`'s wallet signature. No token: the signature is the authority. `403` for a wrong signer. |
| `GET` | `/keys`, `/keys/:keyid` | Visa TAP public key (see [Keys](#keys)) |
| `GET` | `/demo-merchant/*` | A merchant that verifies TAP headers, for demos and integration tests |

**Console:** [`x-card.dev/console`](https://x-card.dev/console) is a static UI over these endpoints (and the [account endpoints](#demo-accounts-and-email-approvals)). Signed in with the admin token, it shows every card and decides any request. It shows pending requests (funding with an allowance preview; held payments with the checkout URL, payee name and its check, and an "Approve & pay" button), Approve/Deny, the fleet with Unfreeze, and decision history. Escalated `request_funding` and held `pay` results include an `approval_url` that deep-links to the request, so the agent can hand it to its human. That link opens `x-card.dev/approve#<id>`, a page with just that request: an email approver confirms signed in with a code, a wallet approver signs (see [Approving with a wallet](#approving-with-a-wallet)). The admin token is kept in the tab's session storage only. Add `?api=http://127.0.0.1:8787` to point the page at a local Worker.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/cards` | Fleet: every card with records, status and pending approvals (admin) |

Typical platform flows:

- **Agent platform / framework:** issue one card per agent with the admin token, and pass the scoped agent token into the agent's MCP config. Your platform never stores card numbers.
- **Finance / ops console:** poll `/api/approvals`, show the request with its purpose, and post the decision. Watch `/public/feed` or the ENS records for freezes.
- **Merchant / counterparty:** resolve `card.status` and limits over ENS before accepting an order from an agent; verify the agent's [TAP signature](#verifying-as-a-merchant) at checkout; set `org.x402.origins` on your own ENS name so X Card agents see you as a [verified payee](#how-a-merchant-opts-in).

### Approving with a wallet

`card.approver` can decide a request by signing it, with no admin token. The approval is [EIP-712](https://eips.ethereum.org/EIPS/eip-712) typed data, domain `{ name: "X Card", version: "1", chainId: 1 }`, primary type `Approval`:

```
Approval(string id, string decision, string card, string kind, string amount, string currency,
         string merchant, string checkout, string payee, string approver, uint256 expires)
```

`decision` is `approve` or `deny`, and each has its own message, so a denial can't be replayed as an approval. `amount` is a decimal string so no signer rounds it. X Card resolves `card.approver` on mainnet ENS when the signature arrives (a bare `0x` address works too). It accepts the decision only if that address signed this exact message, verified with viem's `verifyTypedData`, so an EOA, a Safe (ERC-1271) and a not-yet-deployed smart wallet (ERC-6492) all work. The approver is the one recorded when the request was made. The HMAC binding and single use from the [Security model](#security-model) still apply. An approver that is free text (not a name or address) can only be decided in the operator console.

**In the chat.** In apps that show [in-chat views](#in-chat-views-mcp-apps), the approval card's Approve button starts this same signature: with the wallet in the frame if there is one, otherwise in a small popup on the approval page (`approve?popup=approve#<id>`) that shows only that request, asks the wallet at once and closes when done. A policy change is signed as `PolicyChange` typed data (see [Changing the policy](#changing-the-policy)).

**On the approval page.** `pending_human` results carry an `approval_url` (`approve#<id>`). The page loads the request from `GET /approvals/:id` with no sign-in, shows exactly what it would do, and asks the approver's wallet to sign it with `eth_signTypedData_v4` (free, nothing goes on-chain). It checks the connected account is the one `card.approver` resolves to and posts the signature to `POST /approvals/:id`. On a phone, open the link in a wallet app's browser.

**Not through the agent.** The MCP server has no tool to submit an approval, and `get_approval` returns status but not the typed data. That only means something if the approver's key is out of the agent's reach. So `card.approver` should be a wallet you sign with yourself (a browser or hardware wallet, or a Safe), never an agent wallet that signs on its own, like a PayBox wallet in autonomous mode.

## Integrate: bring your own card issuer

X Card never issues the card itself. It's a **naming and policy layer**: a portable, human-readable identity (`<agent>.xcard.eth`) with public spend policy, scoped agent access, human approvals and a kill switch. A card from any program can sit behind that name. Agent-card programs from card networks, issuing platforms and wallet/crypto card providers can all attach their cards to an X Card name instead of building naming, policy publication and approval flows themselves.

What an issuer gets by attaching to a name:

- **A stable handle that outlives card numbers.** Reissue, rotate or swap the underlying card; agents, merchants and dashboards keep using `researcher.xcard.eth`.
- **Policy anyone can read.** Merchants and counterparties check `card.status` and limits over ENS before accepting an order, with no integration with the issuer's API.
- **Approvals and freezes in one place,** applied consistently whatever rails the card runs on.
- **Agents never hold credentials.** The agent talks MCP to X Card; the issuer's API keys and PANs stay server-side.

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

| X Card record | What the adapter needs from the issuer |
|---|---|
| `card.limit.tx` | per-authorization amount limit |
| `card.limit.monthly` | rolling or calendar-month spend limit, updatable after issuance |
| `card.currencies` | allowed transaction currencies (or reject in the adapter if unsupported) |
| `card.mcc.allow` | MCC allow-list (or block-list inverted) |
| `card.status` | freeze / unfreeze without closing the card |
| transactions | list authorizations and clearings with decline reasons |

If a program can't enforce one of these at authorization time (for example, no MCC controls), the adapter should leave it to the policy engine's after-the-fact anomaly checks and say so in the card's records. Two ways to integrate:

1. **Adapter in this repo:** implement `Issuer` for your API and select it per card. Each card's issuer is recorded privately, never in public records.
2. **Attach an existing card:** keep issuing on your own platform, and register the card under a name with your policy. X Card publishes the records, runs approvals and calls your freeze/limit endpoints. *(Planned: `attach_card` tool and a `card.issuer` record naming the program.)*

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
| **Visa TAP** | RFC 9421 Ed25519 signatures over `@authority` + `@path`; accepted by the published spec's steps and by Visa's reference merchant (`keyid` and `keyId`, `/keys` and `/keys/:keyid`) |
| **Payee identity** | x402 `payee-name` records (`org.x402.origins`) on any `.eth` name or subname, via [`@x402identity/payee`](https://www.npmjs.com/package/@x402identity/payee) |
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
- **Scoped tokens.** Agent tokens are random 256-bit values stored only as SHA-256 hashes and accepted only for their own name. Only a human can issue cards, decide approvals or unfreeze: the admin token, a demo account signed in by email (its own cards), or the approver themselves.
- **Approvals can't be retargeted.** Each pending approval is HMAC-signed over `(id, name, amount, currency)`, plus `(mcc, merchant, merchant URL, payee name)` for a held payment, and re-verified at decision time; it's marked decided before it is applied, so a double click applies once.
- **The payee gate fails closed.** A failed ENS read is `unverified`, never `verified`: the payment is held or blocked, not passed. Lookalike checkouts count toward freezing the card.
- **A payer signature follows an approval.** `sign_request(checkout)` works only for an origin the card paid with policy approval in the last 15 minutes. Signatures expire in 8 minutes and carry a random nonce; the verifier claims the nonce only after the signature checks out. The demo merchant's nonce store is KV, which is eventually consistent, so two replays racing within a second could both pass there; a production merchant should use a strongly consistent store.
- **The TAP key is its own secret.** It can't move funds or change ENS records; rotating it is one secret update.
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
for k in GATEWAY_SIGNER_KEY AWX_CLIENT_ID AWX_API_KEY MCP_ADMIN_TOKEN APPROVAL_SECRET ETH_RPC_URL; do
  npx wrangler secret put $k            # ETH_RPC_URL: a mainnet RPC for the payee gate (no domain allowlist)
done
node scripts/tap-keygen.ts ./tap-key.json   # Visa TAP key (mode 600); prints the keyid
npx wrangler secret put TAP_PRIVATE_KEY < ./tap-key.json && rm ./tap-key.json
npx wrangler deploy
curl https://<your-worker>/keys           # the TAP key set merchants fetch

# Resolver (from contracts/; reads PRIVATE_KEY + RPC from your env file)
cd contracts && npm install
GATEWAY_URL='https://<your-worker>/gateway/{sender}/{data}.json' \
GATEWAY_SIGNER=<address of GATEWAY_SIGNER_KEY> \
  npx hardhat run scripts/deploy.ts --network mainnet
# then setResolver(namehash("<your-name>.eth"), <resolver>) on the ENS registry
```

The site is a separate, assets-only Worker: `npx wrangler deploy -c site/wrangler.jsonc` (custom domains in that file). Keep `"workers_dev": true` on the main Worker if your resolver's gateway URL is its workers.dev address: with `routes` set and the line missing, wrangler turns workers.dev off.

Change `PARENT_NAME` in `src/ens/gateway.ts` and `PARENT_ADDR` in `wrangler.jsonc` for your own name. If the parent name has records today (an address, a contenthash), serve them from the gateway before switching resolvers, as `PARENT_ADDR` does.

## Demo runner

[`scripts/demo.ts`](scripts/demo.ts) runs the nine-step demo against a live Worker: as the **agent** over MCP (with the scoped token it gets at issuance), and as the **operator** over the admin API (optionally, the approvals). The merchant is the Worker's own `/demo-merchant/`, whose ENS name `shop.xcard.eth` lists the Worker's origin in `org.x402.origins` (the gateway serves that record), so the payee gate verifies it and its checkout accepts TAP signatures.

| Step | What happens |
|---|---|
| 01 | `issue_card("researcher", tx ≤ $50, month ≤ $500, MCC 5734,7372, card.payee = verified-or-escalate)` → card + agent token; records read back over ENS |
| 02 | agent `pay`s $42 at the demo merchant, naming `shop.xcard.eth` → the name lists the checkout's origin on mainnet → approved, payee verified |
| 03 | agent `pay`s $18 at MCC 7995 → blocked by X Card, `MERCHANT_CATEGORY_NOT_ALLOWED`, never reaches the network |
| 04 | the same $42 from a lookalike checkout claiming `shop.xcard.eth` → blocked, `PAYEE_MISMATCH` |
| 05 | $15 to a merchant with no name → held for `alice.eth`; a human approves on the page → charged |
| 06 | `sign_request(checkout)` for the demo merchant → its checkout verifies the Visa TAP signature: trusted agent; the same headers again → `REPLAYED`; a checkout signature for the lookalike → refused (`no_approved_payment`) |
| 07 | agent requests $300 → paused (`300 > card.limit.tx`); a human approves → `card.limit.monthly` 500 → 800 |
| 08 | second MCC 7995 attempt → anomaly rule fires in the same call → card frozen, `card.status = frozen` over ENS |
| 09 | $5 at the verified merchant → `CARD_FROZEN` (the issuer card is `INACTIVE` too) |

```sh
npm run demo                              # production; waits for you to approve on the page
npm run demo -- --auto-approve            # unattended
npm run demo -- --name researcher2        # each run needs a fresh name (or --reuse)
npm run demo -- --api http://127.0.0.1:8787 --admin-token local-test   # local, with ISSUER=fake (+ TAP_PRIVATE_KEY in .dev.vars for step 06)
```

Against a local Worker, the card is issued with `card.payee = any`: `shop.xcard.eth` lists the production Worker's origin, so a local one can't verify it, and steps 04 and 05 pay instead of blocking or holding (the runner says so).

Options: `--pace <ms>` between beats (default 1400, for screen recording), `--no-ens` to read records from the gateway instead of mainnet ENS. Operator-side tools: `POST /api/cards/:name/simulate` has a merchant charge the card directly, skipping the pre-check, to show the issuer layer on its own; `POST /api/cards/:name/check` runs the anomaly rules immediately instead of waiting for the cron.

## Development

```sh
npm test                 # policy engine, approvals, payee gate, Visa TAP, MCP protocol + full demo script (fake issuer)
npm run typecheck

# Full stack locally, no Airwallex: in-memory issuer + throwaway admin token
npx wrangler dev --var ISSUER:fake --var MCP_ADMIN_TOKEN:local-test
(cd site/www && python3 -m http.server 8765)   # open /console.html?api=http://127.0.0.1:8787 (with ISSUER=fake and no RESEND_API_KEY, sign-in codes come back in the response)
cd contracts && npx hardhat node &          # then, from the repo root:
node scripts/e2e-resolver.ts                # resolver + gateway end to end on a local chain
```

The test suite (27 tests) runs the whole demo against `FakeIssuer` ([`src/testing.ts`](src/testing.ts)), which enforces card controls the way the sandbox does: issue `researcher`, an allowed `pay` clears, a disallowed MCC is blocked before the issuer, a $25 top-up auto-approves, a $300 request escalates and is approved, and a second disallowed MCC attempt freezes the card. It also covers the payee gate (verified, lookalike, held then approved or denied, allow-lists, a second mismatch freezing the card, the real verifier against a fake ENS reader) and TAP (signing, the spec's verification steps, the RFC 8037 vector, Visa's reference verifier, checkout signing only after an approved payment).

To try TAP locally, put a `TAP_PRIVATE_KEY` in `.dev.vars` (from `scripts/tap-keygen.ts`) and call `/demo-merchant/` with headers from `sign_request`.

## Repository layout

```
src/
  index.ts              Worker routes + cron
  worker.ts             entry: OAuth (wallet sign-in) around the app
  mcp.ts                MCP server (JSON-RPC over HTTP), auth, tool schemas, ui:// resources
  oauth/                consent page (SIWE), what a wallet may grant
  ui/                   in-chat views (MCP Apps): card.ts, approval.ts, issue.ts
  service.ts            card operations behind the tools (Issuer interface)
  store.ts              KV layout
  ens/gateway.ts        CCIP-Read gateway + signing
  policy/records.ts     ENS record schema + validation
  policy/engine.ts      records → controls, funding decisions, anomaly rules
  policy/approvals.ts   HMAC-bound approvals (funding, held payments, policy changes)
  policy/approver.ts    EIP-712 approvals signed by card.approver
  policy/changes.ts     update_policy: what tightens, what loosens
  policy/payee.ts       payee gate: x402 payee-name check + card.payee decision
  tap/sign.ts           Visa TAP signing (RFC 9421, Ed25519), keyid, key generation
  tap/verify.ts         Visa TAP verification (the merchant side)
  airwallex/client.ts   auth, token cache, retries, request_id
  airwallex/issuing.ts  cardholders, cards, transactions
  airwallex/simulator.ts  every sandbox simulation call behind one interface
contracts/              OffchainResolver.sol + Hardhat deploy
scripts/                Airwallex checks, resolver e2e, IPFS pinning, TAP key generation
site/www/               site + approvals page (static; served on x-card.dev, mirrored to IPFS), brand/ logos, og.png
site/wrangler.jsonc     the site's assets-only Worker
site/og/                source of the og.png share card
```

## Roadmap

- **Production checkout behind `pay`:** network-token (Visa Intelligent Commerce / Mastercard Agent Pay) or vaulted-PAN checkout in the issuer adapter, replacing the sandbox simulation.
- **TAP body objects:** the Agentic Consumer Recognition Object and Payment Container, once Visa Intelligent Commerce credentials are available.
- **Cards for teams:** an operator issues named cards (one per employee) with a manager as `card.approver`, and emails each employee a one-time claim link; signing in with their wallet makes them the card's holder for their own agent. Self-serve test cards become the case where holder and approver are the same wallet.
- **Voice:** let the model submit the issue form after the person confirms the policy out loud, for apps where the form doesn't show (voice mode).
- **An origin-only verifier** exported from `@x402identity/payee`, replacing the placeholder-`payTo` call.
- **A strongly consistent nonce store** (Durable Object) for the demo merchant.
- **Wallet-signed unfreeze** (approvals already are), replacing the admin token there too.
- **Issuer-agnostic attach:** `attach_card` for cards issued elsewhere, a `card.issuer` record, and adapters beyond Airwallex.
- **Paid self-serve issuance over x402**: let agents issue their own card name by paying a small fee in USDC, with the payer wallet becoming `card.approver`.
- **The same policy for x402 payments:** apply a name's ENS policy to x402 / USDC payments on Base, so one name governs both card and stablecoin spending.
- Airwallex webhooks for real-time freezes instead of the one-minute cron.

## Built on

| | Role in X Card |
|---|---|
| [Airwallex](https://www.airwallex.com/) | Card issuing: the first issuer adapter, and the sandbox the cards run on |
| [Visa Trusted Agent Protocol](https://developer.visa.com/capabilities/trusted-agent-protocol) | How merchants recognize an X Card agent at checkout |
| [ENS](https://ens.domains/) | Every card is a name; its policy is text records on Ethereum mainnet |
| [x402 Identity Hub](https://x402id.dev) | The open `payee-name` records and verifier behind verified payees |

Logos and names are trademarks of their owners. X Card is an independent open-source project built for the Airwallex Agentic Banking Hackathon. It is not affiliated with or endorsed by Airwallex, Visa, ENS Labs or the ENS DAO.

## License

MIT. See [LICENSE](LICENSE).
