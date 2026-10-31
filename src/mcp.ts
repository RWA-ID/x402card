// Remote MCP server (Streamable HTTP, stateless JSON responses).
// Auth: Bearer token. The admin token can do everything; each issued card
// gets an agent token that only works for its own name. Agents never see
// card numbers, Airwallex IDs or keys.
import { CardService, DEMO_CARDS, ServiceError, TEST_CARDS, describeError, fullName, normalizeLabel } from "./service.ts";
import type { Store } from "./store.ts";
import type { TextRecords } from "./policy/records.ts";
import { UI_MIME, approvalResource } from "./ui/approval.ts";
import { issueResource } from "./ui/issue.ts";
import { cardResource } from "./ui/card.ts";
import type { PolicyInput } from "./policy/changes.ts";

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "x402card", title: "X Card", version: "0.4.0" };

// owner = a person signed in over OAuth, by wallet or by email: the cards they approve or issued.
export type Caller = { kind: "admin" } | { kind: "agent"; label: string } | { kind: "owner"; address?: string; email?: string; labels: string[] };

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const nameProp = {
  type: "string",
  description:
    "Card name, e.g. researcher.xcard.eth or researcher.x402card.eth (a bare label means x402card.eth). May be omitted when the connection has a single card; list_cards shows them.",
};

/** The approval card (MCP Apps): shown in the chat for results that wait on card.approver. */
export const APPROVAL_UI = "ui://xcard/approval.html";
const approvalUi = { ui: { resourceUri: APPROVAL_UI }, "ui/resourceUri": APPROVAL_UI };
/** The card view (MCP Apps): the card face, its policy and records, like the home page. */
export const CARD_UI = "ui://xcard/card.html";
const cardUi = { ui: { resourceUri: CARD_UI }, "ui/resourceUri": CARD_UI };
/** The issue form (MCP Apps): the person sets the policy and submits. */
export const ISSUE_UI = "ui://xcard/issue.html";
const issueUi = { ui: { resourceUri: ISSUE_UI }, "ui/resourceUri": ISSUE_UI };

export const TOOLS = [
  {
    name: "issue_card",
    _meta: issueUi,
    title: "Issue an agent card",
    description:
      "Issue a virtual card with a spend policy published as ENS text records. Signed in (email or wallet): call it with no arguments, or with a suggested name and policy, and the person fills in the form in the chat and submits it: the limits, merchant categories, payee check and the approver (an email, a wallet or an ENS name; by default themselves). Signed in by email they name the card (<name>.xcard.eth; caps $500/transaction, $2,000/day, $5,000/month, USD, 5 cards); by wallet they get the next free testN.xcard.eth (caps $50/transaction, $200/day, $500/month, USD, 3 cards). An org's operator issues for the company within its caps, and sees all its cards. Never set submit yourself. The issued card in the chat shows the person an agent token, once, for an autonomous agent to use this card; it isn't in your result. Operator (admin token): pass name and policy; returns an agent token scoped to the card (shown once).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Label or full name, e.g. maria (email sign-in and operator; a wallet sign-in gets testN)" },
        policy: {
          type: "object",
          properties: {
            limit_tx: { type: "number", description: "Max per transaction (major units)" },
            limit_daily: { type: "number", description: "Max per day (major units); omit for none" },
            limit_monthly: { type: "number", description: "Monthly allowance (major units)" },
            currencies: { type: "array", items: { type: "string" }, description: "ISO codes; the first is the limit currency" },
            mcc_allow: { type: "array", items: { type: "string" }, description: "Allowed 4-digit merchant category codes; empty = any" },
            approver: { type: "string", description: "Who approves escalations: an email (they confirm by email), an ENS name or a wallet address (they sign), e.g. maria@acme.com or alice.eth" },
            payee: {
              type: "string",
              enum: ["any", "verified-or-escalate", "verified-only"],
              description: "What a payment needs to know about its payee. verified = the payee's ENS name lists the checkout's origin. Default any.",
            },
            payee_allow: { type: "array", items: { type: "string" }, description: "ENS names this card may pay, e.g. modelhub.eth; empty = any verified payee" },
          },
        },
        submit: { type: "boolean", description: "Set by the form in the chat when the person submits it" },
      },
    },
  },
  {
    name: "list_cards",
    _meta: cardUi,
    title: "List my cards",
    description: "Every card this connection can act for: name, status, last 4 digits, limits, currencies, approver and pending approvals.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_card",
    _meta: cardUi,
    title: "Get card",
    description: "Card status, policy records and pending approvals. Never returns the card number.",
    inputSchema: { type: "object", properties: { name: nameProp } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "pay",
    _meta: approvalUi,
    title: "Pay a merchant",
    description:
      "Pay a merchant with this card. x402card checks the ENS policy first (status, card.limit.tx, card.currencies, card.mcc.allow) and refuses before anything reaches the card network (decision: blocked); the issuer then enforces the same limits plus the monthly allowance (decision: declined). Pass merchant_url and payee_name so x402card can check the checkout really belongs to that ENS name: a name that doesn't list the URL's origin is blocked (PAYEE_MISMATCH), and depending on card.payee an unverified payee is blocked or held for card.approver (decision: pending_human; the charge happens when they approve). You never handle the card number. Pass the same request_id when retrying so a payment can't go through twice.",
    inputSchema: {
      type: "object",
      properties: {
        name: nameProp,
        amount: { type: "number", exclusiveMinimum: 0, description: "Major units, e.g. 42 for $42" },
        currency: { type: "string", description: "ISO code, must be in card.currencies" },
        mcc: { type: "string", pattern: "^\\d{4}$", description: "Merchant category code, e.g. 5734 (software)" },
        merchant: { type: "string", description: "Merchant name" },
        merchant_url: { type: "string", description: "URL of the checkout page or API you are paying, e.g. https://modelhub.example/checkout" },
        payee_name: { type: "string", description: "ENS name the merchant shows as its identity, e.g. modelhub.eth" },
        purpose: { type: "string", description: "What this is for (kept in the card's activity log)" },
        request_id: { type: "string", description: "Idempotency key; reuse it on retry" },
      },
      required: ["amount", "currency", "mcc", "merchant"],
    },
    annotations: { openWorldHint: true },
  },
  {
    name: "sign_request",
    _meta: cardUi,
    title: "Sign a request to a merchant (Visa TAP)",
    description:
      "Get Visa Trusted Agent Protocol headers (RFC 9421 Signature-Input and Signature) for your next HTTP request to url, so the merchant can tell a trusted agent from a bot. purpose browse (tag agent-browser-auth) works for any site, e.g. product pages. purpose checkout (tag agent-payer-auth) works only after pay approved a payment with this merchant_url's origin in the last 15 minutes. Send both headers unchanged on a request to exactly this host and path; they expire in 8 minutes and each works once.",
    inputSchema: {
      type: "object",
      properties: {
        name: nameProp,
        url: { type: "string", description: "The exact URL you will request, e.g. https://shop.example/checkout" },
        purpose: { type: "string", enum: ["browse", "checkout"] },
      },
      required: ["url", "purpose"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "request_funding",
    _meta: approvalUi,
    title: "Request funding",
    description:
      "Ask to raise the card's monthly allowance. Within card.limit.tx and above the wallet reserve it is approved at once; otherwise it waits for the human in card.approver. The approval is bound to this exact name, amount and currency.",
    inputSchema: {
      type: "object",
      properties: {
        name: nameProp,
        amount: { type: "number", exclusiveMinimum: 0, description: "Major units, e.g. 300 for $300" },
        currency: { type: "string", description: "ISO code, must be in card.currencies" },
        purpose: { type: "string", description: "What the money is for (shown to the approver)" },
      },
      required: ["amount", "currency"],
    },
  },
  {
    name: "update_policy",
    _meta: approvalUi,
    title: "Update card policy",
    description:
      "Change the card's limits (per transaction, daily, monthly), allowed merchant categories or payee rules. Pass only what changes. Tightening (lower limits, fewer categories, stricter payee checks) applies at once. If anything loosens the policy, nothing changes until card.approver signs the whole change with their wallet (decision pending_human, as with request_funding). For a one-off top-up of the monthly allowance prefer request_funding. The approver and currencies can't be changed here.",
    inputSchema: {
      type: "object",
      properties: {
        name: nameProp,
        limit_tx: { type: "number", exclusiveMinimum: 0, description: "Max per transaction (major units)" },
        limit_daily: { type: "number", minimum: 0, description: "Max per day (major units); 0 removes the daily limit" },
        limit_monthly: { type: "number", exclusiveMinimum: 0, description: "Monthly allowance (major units)" },
        mcc_allow: { type: "array", items: { type: "string" }, description: "Allowed 4-digit merchant category codes, the whole list; [] = any" },
        payee: { type: "string", enum: ["any", "verified-or-escalate", "verified-only"], description: "What a payment needs to know about its payee" },
        payee_allow: { type: "array", items: { type: "string" }, description: "ENS names this card may pay, the whole list; [] = any verified payee" },
        reason: { type: "string", description: "Why (shown to the approver)" },
      },
    },
  },
  {
    name: "get_approval",
    _meta: approvalUi,
    title: "Get an approval",
    description:
      "Status of a request waiting for card.approver (from pay, request_funding or update_policy with decision pending_human): pending, approved, denied or expired, with what it would do. The approver decides it themselves on approval_url: an email approver gets the request by email and confirms signed in with a code; a wallet or ENS approver signs with their wallet. You can't approve it, so give them the link and check back here.",
    inputSchema: { type: "object", properties: { approval_id: { type: "string" } }, required: ["approval_id"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "freeze",
    _meta: cardUi,
    title: "Freeze card",
    description: "Freeze the card immediately and set card.status=frozen in ENS. Agents may freeze their own card; only a human can unfreeze.",
    inputSchema: { type: "object", properties: { name: nameProp, reason: { type: "string" } } },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  {
    name: "list_transactions",
    _meta: cardUi,
    title: "List transactions",
    description: "Recent authorizations and clearings. A charge succeeded only when type is CLEARING; declines carry decline_reason (e.g. MERCHANT_CATEGORY_NOT_ALLOWED).",
    inputSchema: { type: "object", properties: { name: nameProp } },
    annotations: { readOnlyHint: true },
  },
] as const;

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function authenticate(req: Request, store: Store, adminToken: string): Promise<Caller | null> {
  const m = (req.headers.get("Authorization") ?? "").match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  const token = m[1];
  if (adminToken && timingSafeEqual(token, adminToken)) return { kind: "admin" };
  const label = await store.tokenLabel(await sha256Hex(token));
  return label ? { kind: "agent", label } : null;
}

export class McpServer {
  private svc: CardService;
  private store: Store;
  private caller: Caller;
  /** This server's origin: the approval card calls the API here. */
  private origin: string;

  constructor(svc: CardService, store: Store, caller: Caller, origin = "https://api.x-card.dev") {
    this.svc = svc;
    this.store = store;
    this.caller = caller;
    this.origin = origin;
  }

  async handle(req: Request): Promise<Response> {
    if (req.method !== "POST") {
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    }
    let msg: JsonRpcRequest;
    try {
      msg = await req.json();
    } catch {
      return rpc(null, undefined, { code: -32700, message: "parse error" });
    }
    if (Array.isArray(msg) || msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return rpc(null, undefined, { code: -32600, message: "invalid request" });
    }
    // Notifications get no body.
    if (msg.id === undefined || msg.id === null) return new Response(null, { status: 202 });

    try {
      switch (msg.method) {
        case "initialize": {
          const asked = String(msg.params?.protocolVersion ?? "");
          return rpc(msg.id, {
            protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
            capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions:
              "x402card: the name and policy layer for AI agent cards (<name>.xcard.eth or <name>.x402card.eth). Policy lives in ENS text records. Use pay to pay a merchant; it is checked against the policy before it reaches the card network. Use request_funding when you need more allowance; amounts above card.limit.tx wait for a human. Use update_policy to change limits (incl. a daily limit), merchant categories or payee rules; tightening is immediate, loosening waits for a human. A pending_human result is decided by card.approver, who signs it with their own wallet: apps that show the approval card let them approve right in the chat; otherwise give them approval_url. Then check get_approval. An approver named by email gets the request by email and confirms it signed in with a code. list_cards shows every card this connection can use. You never see card numbers.",
          });
        }
        case "ping":
          return rpc(msg.id, {});
        case "tools/list":
          return rpc(msg.id, {
            tools: this.caller.kind === "agent" ? TOOLS.filter((t) => t.name !== "issue_card") : TOOLS,
          });
        case "resources/list":
          return rpc(msg.id, {
            resources: [
              { uri: APPROVAL_UI, name: "approval", title: "X Card approval", mimeType: UI_MIME },
              { uri: ISSUE_UI, name: "issue", title: "Issue an X Card", mimeType: UI_MIME },
              { uri: CARD_UI, name: "card", title: "X Card", mimeType: UI_MIME },
            ],
          });
        case "resources/read": {
          if (msg.params?.uri === APPROVAL_UI) return rpc(msg.id, { contents: [approvalResource(this.origin)] });
          if (msg.params?.uri === ISSUE_UI) return rpc(msg.id, { contents: [issueResource()] });
          if (msg.params?.uri === CARD_UI) return rpc(msg.id, { contents: [cardResource()] });
          return rpc(msg.id, undefined, { code: -32002, message: "resource not found" });
        }
        case "tools/call":
          return rpc(msg.id, await this.callTool(String(msg.params?.name ?? ""), (msg.params?.arguments ?? {}) as Record<string, unknown>));
        default:
          return rpc(msg.id, undefined, { code: -32601, message: `method not found: ${msg.method}` });
      }
    } catch (e) {
      console.error("mcp", e);
      return rpc(msg.id, undefined, { code: -32603, message: "internal error" });
    }
  }

  /** Tool errors are returned as results with isError so the model can read them. */
  async callTool(name: string, args: Record<string, unknown>) {
    try {
      // ui_only goes to the view in the chat, not into the text the model reads.
      const { ui_only, ...data } = await this.dispatch(name, args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: { ...data, ...(ui_only as object | undefined) } };
    } catch (e) {
      const err = describeError(e);
      return { content: [{ type: "text", text: `${err.code}: ${err.message}` }], structuredContent: { error: err }, isError: true };
    }
  }

  private async dispatch(tool: string, a: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (tool) {
      case "issue_card": {
        if (this.caller.kind === "admin") return { ...(await issueWithToken(this.svc, this.store, str(a.name, "name"), a.policy)) };
        if (this.caller.kind !== "owner") throw toolError("forbidden", "an agent token can't issue cards");
        const { email, address } = this.caller;
        // An org's operator issues for the company, within its caps; anyone else gets a demo or test card.
        const org = email ? await this.store.orgOf(email) : null;
        const me = email ? { email, ...(org ? { org: org.name } : {}) } : { address };
        // The form shows first; the person submits it (submit: true) from the chat.
        if (a.submit !== true) {
          return {
            decision: "form",
            caps: org?.caps ?? (email ? DEMO_CARDS : TEST_CARDS),
            me,
            defaults: { ...TEST_DEFAULTS, ...pickPolicy(a.policy), ...(email && typeof a.name === "string" ? { name: a.name.trim().toLowerCase().replace(/\.xcard\.eth$/, "") } : {}) },
          };
        }
        const picked = pickPolicy(a.policy);
        // A blank daily limit on a named card isn't the test default: the service sets it from the caps.
        const { limit_daily: _testDaily, ...named } = TEST_DEFAULTS;
        const records = policyToRecords({ ...(email ? named : TEST_DEFAULTS), ...picked, currencies: ["USD"], approver: optStr(picked.approver) || email || address });
        const card = org
          ? await this.svc.issueOrgCard(email!, org, str(a.name, "name"), records)
          : email
          ? await this.svc.issueAccountCard(email, str(a.name, "name"), records)
          : await this.svc.issueTestCard(address!, records);
        // It joins this connection's cards now (the grant re-reads them on the next request).
        this.caller.labels = [...new Set([...this.caller.labels, normalizeLabel(card.name)])];
        const approver = card.records["card.approver"];
        const mine = approver === email || approver === address;
        const label = normalizeLabel(card.name);
        return {
          decision: "issued",
          card,
          note: `${card.name} is yours and this connection can use it now. ${mine ? "You're its approver." : `${approver} approves anything over its limits.`} The card in the chat shows the person an agent token for it, once, to give to an autonomous agent. You don't have that token and shouldn't ask for it in the chat.`,
          ui_only: { agent_token: await mintAgentToken(this.store, label) },
        };
      }
      case "list_cards": {
        const labels = this.caller.kind === "admin" ? await this.store.listLabels() : this.caller.kind === "agent" ? [this.caller.label] : this.caller.labels;
        const cards = await Promise.all(labels.map((l) => this.svc.getCard(l)));
        return {
          cards: cards.map((c) => ({
            name: c.name,
            status: c.status,
            ...(c.last4 ? { last4: c.last4 } : {}),
            limit_tx: c.records["card.limit.tx"],
            ...(c.records["card.limit.daily"] ? { limit_daily: c.records["card.limit.daily"] } : {}),
            limit_monthly: c.records["card.limit.monthly"],
            currencies: c.records["card.currencies"],
            mcc_allow: c.records["card.mcc.allow"],
            payee: c.records["card.payee"],
            approver: c.records["card.approver"],
            pending_approvals: c.pending_approvals.length,
          })),
        };
      }
      case "get_card":
        return { card: await this.svc.getCard(this.target(a)) };
      case "pay": {
        const amount = Number(a.amount);
        if (!Number.isFinite(amount) || amount <= 0) throw toolError("bad_amount", "amount must be a positive number");
        return {
          ...(await this.svc.pay(this.target(a), {
            amount,
            currency: str(a.currency, "currency"),
            mcc: str(a.mcc, "mcc"),
            merchant: str(a.merchant, "merchant").slice(0, 43),
            merchantUrl: optStr(a.merchant_url) || undefined,
            payeeName: optStr(a.payee_name).toLowerCase() || undefined,
            purpose: optStr(a.purpose),
            requestId: optStr(a.request_id) || undefined,
          })),
        };
      }
      case "sign_request": {
        const purpose = a.purpose === "checkout" ? "checkout" : a.purpose === "browse" ? "browse" : null;
        if (!purpose) throw toolError("bad_input", "purpose must be browse or checkout");
        return { ...(await this.svc.signRequest(this.target(a), str(a.url, "url"), purpose)) };
      }
      case "request_funding": {
        const amount = Number(a.amount);
        if (!Number.isFinite(amount) || amount <= 0) throw toolError("bad_amount", "amount must be a positive number");
        return { ...(await this.svc.requestFunding(this.target(a), amount, str(a.currency, "currency"), optStr(a.purpose))) };
      }
      case "update_policy": {
        const input: PolicyInput = {};
        const num = (v: unknown, f: string) => {
          const n = Number(v);
          if (!Number.isFinite(n) || n < 0) throw toolError("bad_input", `${f} must be a non-negative number`);
          return n;
        };
        if (a.limit_tx !== undefined) input["card.limit.tx"] = String(num(a.limit_tx, "limit_tx"));
        if (a.limit_daily !== undefined) input["card.limit.daily"] = num(a.limit_daily, "limit_daily") === 0 ? "" : String(num(a.limit_daily, "limit_daily"));
        if (a.limit_monthly !== undefined) input["card.limit.monthly"] = String(num(a.limit_monthly, "limit_monthly"));
        if (a.mcc_allow !== undefined) input["card.mcc.allow"] = list(a.mcc_allow, "mcc_allow");
        if (a.payee !== undefined) input["card.payee"] = str(a.payee, "payee");
        if (a.payee_allow !== undefined) input["card.payee.allow"] = list(a.payee_allow, "payee_allow").toLowerCase();
        if (!Object.keys(input).length) throw toolError("bad_input", "pass at least one of limit_tx, limit_daily, limit_monthly, mcc_allow, payee, payee_allow");
        return { ...(await this.svc.updatePolicy(this.target(a), input, { direct: this.caller.kind === "admin", purpose: optStr(a.reason) })) };
      }
      case "get_approval": {
        const { typed_data: _td, ...view } = await this.svc.approvalView(str(a.approval_id, "approval_id"), this.scope());
        // The public link masks an email approver; this connection already reaches the card, so it sees it in full.
        if (view.email_approver) view.approval.approver = (await this.store.getApproval(view.approval.id))?.approver ?? view.approval.approver;
        return { ...view };
      }
      case "freeze": {
        const by = this.caller.kind === "admin" ? "admin" : this.caller.kind === "owner" ? "owner" : "agent";
        return { card: await this.svc.freeze(this.target(a), optStr(a.reason) || `frozen by ${by}`) };
      }
      case "list_transactions":
        return { transactions: await this.svc.listTransactions(this.target(a)) };
      default:
        throw toolError("unknown_tool", `no tool named ${tool}`);
    }
  }

  /** An agent token only reaches its own card's approvals; an owner, their cards'. */
  private scope(): string | string[] | undefined {
    return this.caller.kind === "agent" ? this.caller.label : this.caller.kind === "owner" ? this.caller.labels : undefined;
  }

  /** Agents act on their own card only. */
  private target(a: Record<string, unknown>): string {
    const given = typeof a.name === "string" && a.name ? normalizeLabel(a.name) : undefined;
    if (this.caller.kind === "agent") {
      if (given && given !== this.caller.label) throw toolError("forbidden", `this token is for ${fullName(this.caller.label)}`);
      return this.caller.label;
    }
    if (this.caller.kind === "owner") {
      const mine = this.caller.labels;
      if (given) {
        if (!mine.includes(given)) throw toolError("forbidden", `${fullName(given)} isn't one of this connection's cards (${mine.map(fullName).join(", ") || "none"})`);
        return given;
      }
      if (mine.length === 1) return mine[0];
      throw toolError("bad_name", mine.length ? `name is required: one of ${mine.map(fullName).join(", ")}` : "this wallet approves no cards yet");
    }
    if (!given) throw toolError("bad_name", "name is required");
    return given;
  }
}

/** A new agent token for one card. Only its hash is stored, so it can be shown just once. */
async function mintAgentToken(store: Store, label: string) {
  const token = randomToken();
  await store.putToken(await sha256Hex(token), label);
  return token;
}

/**
 * Issue a card and mint its agent token (shown once). Shared by the issue_card
 * tool and the admin issue form (POST /api/cards).
 */
export async function issueWithToken(svc: CardService, store: Store, name: string, policy: unknown) {
  const label = normalizeLabel(name);
  const card = await svc.issueCard(label, policyToRecords(policy));
  const token = await mintAgentToken(store, label);
  return { card, agent_token: token, note: "Store agent_token now; it is not shown again. It only works for this card." };
}

/** A demo account or org operator issues a card on the console, with an agent token for it (shown once). */
export async function issueAccountWithToken(svc: CardService, store: Store, email: string, name: string, policy: unknown) {
  const records = policyToRecords({ currencies: ["USD"], ...(policy && typeof policy === "object" ? policy : {}) });
  // An empty approver means "me": the record defaults to the account's own email.
  if (!records["card.approver"]) delete records["card.approver"];
  const org = await store.orgOf(email);
  const card = org ? await svc.issueOrgCard(email, org, name, records) : await svc.issueAccountCard(email, name, records);
  const token = await mintAgentToken(store, normalizeLabel(card.name));
  return { card, agent_token: token, note: "Store agent_token now; it is not shown again. It only works for this card." };
}

/** What the issue form starts from for a self-serve test card. */
const TEST_DEFAULTS = { limit_tx: 25, limit_daily: 100, limit_monthly: 250, mcc_allow: ["5734", "7372"], payee: "verified-or-escalate" };

/** The policy fields a suggestion or the form may set; everything else is fixed. */
function pickPolicy(p: unknown): Record<string, unknown> {
  if (!p || typeof p !== "object") return {};
  const o = p as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ["limit_tx", "limit_daily", "limit_monthly", "mcc_allow", "payee", "payee_allow", "approver"]) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

function policyToRecords(p: unknown): TextRecords {
  if (!p || typeof p !== "object") throw toolError("bad_policy", "policy object is required");
  const o = p as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).join(",") : typeof v === "string" ? v : "");
  return {
    "card.limit.tx": String(o.limit_tx ?? ""),
    "card.limit.daily": o.limit_daily ? String(o.limit_daily) : "",
    "card.limit.monthly": String(o.limit_monthly ?? ""),
    "card.currencies": list(o.currencies),
    "card.mcc.allow": list(o.mcc_allow),
    "card.approver": String(o.approver ?? ""),
    "card.payee": String(o.payee ?? ""),
    "card.payee.allow": list(o.payee_allow),
  };
}

function toolError(code: string, message: string): ServiceError {
  return new ServiceError(code, message);
}

function list(v: unknown, field: string): string {
  if (!Array.isArray(v)) throw toolError("bad_input", `${field} must be an array`);
  return v.map((x) => String(x).trim()).filter(Boolean).join(",");
}

function str(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) throw toolError("bad_input", `${field} is required`);
  return v.trim();
}

function optStr(v: unknown): string {
  return typeof v === "string" ? v.trim().slice(0, 200) : "";
}

function randomToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return "x4c_" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function rpc(id: JsonRpcRequest["id"], result?: unknown, error?: { code: number; message: string }): Response {
  const body = error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result };
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}
