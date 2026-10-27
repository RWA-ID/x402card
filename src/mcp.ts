// Remote MCP server (Streamable HTTP, stateless JSON responses).
// Auth: Bearer token. The admin token can do everything; each issued card
// gets an agent token that only works for its own name. Agents never see
// card numbers, Airwallex IDs or keys.
import { CardService, ServiceError, describeError, fullName, normalizeLabel } from "./service.ts";
import type { Store } from "./store.ts";
import type { TextRecords } from "./policy/records.ts";

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "x402card", version: "0.3.0" };

export type Caller = { kind: "admin" } | { kind: "agent"; label: string };

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const nameProp = {
  type: "string",
  description: "Card name, e.g. researcher.xcard.eth or researcher.x402card.eth (a bare label means x402card.eth). Agent tokens may omit it.",
};

export const TOOLS = [
  {
    name: "issue_card",
    title: "Issue an agent card",
    description:
      "Issue a virtual card addressed by <name>.xcard.eth or <name>.x402card.eth (pick the namespace with the full name) with the given spend policy. The policy is published as ENS text records. Returns an agent token scoped to this card (shown once). Admin only.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Label or full name, e.g. researcher" },
        policy: {
          type: "object",
          properties: {
            limit_tx: { type: "number", description: "Max per transaction (major units)" },
            limit_monthly: { type: "number", description: "Monthly allowance (major units)" },
            currencies: { type: "array", items: { type: "string" }, description: "ISO codes; the first is the limit currency" },
            mcc_allow: { type: "array", items: { type: "string" }, description: "Allowed 4-digit merchant category codes; empty = any" },
            approver: { type: "string", description: "Who approves escalations, e.g. alice.eth" },
            payee: {
              type: "string",
              enum: ["any", "verified-or-escalate", "verified-only"],
              description: "What a payment needs to know about its payee. verified = the payee's ENS name lists the checkout's origin. Default any.",
            },
            payee_allow: { type: "array", items: { type: "string" }, description: "ENS names this card may pay, e.g. modelhub.eth; empty = any verified payee" },
          },
          required: ["limit_tx", "limit_monthly", "currencies", "approver"],
        },
      },
      required: ["name", "policy"],
    },
  },
  {
    name: "get_card",
    title: "Get card",
    description: "Card status, policy records and pending approvals. Never returns the card number.",
    inputSchema: { type: "object", properties: { name: nameProp } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "pay",
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
    name: "freeze",
    title: "Freeze card",
    description: "Freeze the card immediately and set card.status=frozen in ENS. Agents may freeze their own card; only a human can unfreeze.",
    inputSchema: { type: "object", properties: { name: nameProp, reason: { type: "string" } } },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  {
    name: "list_transactions",
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

  constructor(svc: CardService, store: Store, caller: Caller) {
    this.svc = svc;
    this.store = store;
    this.caller = caller;
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
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions:
              "x402card: the name and policy layer for AI agent cards (<name>.xcard.eth or <name>.x402card.eth). Policy lives in ENS text records. Use pay to pay a merchant; it is checked against the policy before it reaches the card network. Use request_funding when you need more allowance; amounts above card.limit.tx wait for a human. You never see card numbers.",
          });
        }
        case "ping":
          return rpc(msg.id, {});
        case "tools/list":
          return rpc(msg.id, {
            tools: this.caller.kind === "admin" ? TOOLS : TOOLS.filter((t) => t.name !== "issue_card"),
          });
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
      const data = await this.dispatch(name, args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
    } catch (e) {
      const err = describeError(e);
      return { content: [{ type: "text", text: `${err.code}: ${err.message}` }], structuredContent: { error: err }, isError: true };
    }
  }

  private async dispatch(tool: string, a: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (tool) {
      case "issue_card": {
        if (this.caller.kind !== "admin") throw toolError("forbidden", "issue_card needs the admin token");
        return { ...(await issueWithToken(this.svc, this.store, str(a.name, "name"), a.policy)) };
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
      case "freeze": {
        const by = this.caller.kind === "admin" ? "admin" : "agent";
        return { card: await this.svc.freeze(this.target(a), optStr(a.reason) || `frozen by ${by}`) };
      }
      case "list_transactions":
        return { transactions: await this.svc.listTransactions(this.target(a)) };
      default:
        throw toolError("unknown_tool", `no tool named ${tool}`);
    }
  }

  /** Agents act on their own card only. */
  private target(a: Record<string, unknown>): string {
    const given = typeof a.name === "string" && a.name ? normalizeLabel(a.name) : undefined;
    if (this.caller.kind === "agent") {
      if (given && given !== this.caller.label) throw toolError("forbidden", `this token is for ${fullName(this.caller.label)}`);
      return this.caller.label;
    }
    if (!given) throw toolError("bad_name", "name is required");
    return given;
  }
}

/**
 * Issue a card and mint its agent token (shown once). Shared by the issue_card
 * tool and the admin issue form (POST /api/cards).
 */
export async function issueWithToken(svc: CardService, store: Store, name: string, policy: unknown) {
  const label = normalizeLabel(name);
  const card = await svc.issueCard(label, policyToRecords(policy));
  const token = randomToken();
  await store.putToken(await sha256Hex(token), label);
  return { card, agent_token: token, note: "Store agent_token now; it is not shown again. It only works for this card." };
}

function policyToRecords(p: unknown): TextRecords {
  if (!p || typeof p !== "object") throw toolError("bad_policy", "policy object is required");
  const o = p as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).join(",") : typeof v === "string" ? v : "");
  return {
    "card.limit.tx": String(o.limit_tx ?? ""),
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
