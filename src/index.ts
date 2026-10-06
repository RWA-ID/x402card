// Worker entry.
//   /gateway/...           CCIP-Read gateway for *.x402card.eth (public)
//   /mcp                   MCP server for agents (bearer token)
//   /api/approvals[/:id]   list / decide escalated funding (admin token)
//   /api/cards             fleet: every card with records + pending count (admin token)
//   /api/cards/:name/unfreeze   human-only unfreeze (admin token)
//   /api/cards/:name/simulate   sandbox: a merchant charges the card directly, skipping the pre-check (admin token)
//   /api/cards/:name/check      run the anomaly rules now instead of waiting for cron (admin token)
//   /public/cards/:name    public ENS records for a name (same data the gateway serves)
//   /public/feed           recent policy events across cards, for the demo site
//   cron (every minute)    anomaly check -> freeze
import type { Address, Hex } from "viem";
import { AirwallexClient, KvTokenStore } from "./airwallex/client.ts";
import { gatewayResponse } from "./ens/gateway.ts";
import { McpServer, authenticate } from "./mcp.ts";
import { AirwallexIssuer, CardService, describeError, fullName, normalizeLabel } from "./service.ts";
import { Store } from "./store.ts";
import { FakeIssuer } from "./testing.ts";

export interface Env {
  KV: KVNamespace;
  GATEWAY_SIGNER_KEY: string;
  PARENT_ADDR?: string;
  AWX_CLIENT_ID: string;
  AWX_API_KEY: string;
  MCP_ADMIN_TOKEN: string;
  APPROVAL_SECRET: string;
  CARDHOLDER_EMAIL?: string;
  /** Where humans approve escalations; {id} is replaced. */
  APPROVAL_URL?: string;
  /** Local dev only (`wrangler dev --var ISSUER:fake`): in-memory issuer instead of Airwallex. */
  ISSUER?: string;
}

// One fake per isolate, so local dev keeps state between requests.
let fakeIssuer: FakeIssuer | undefined;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Protocol-Version",
};

function service(env: Env, store: Store): CardService {
  const issuer =
    env.ISSUER === "fake"
      ? (fakeIssuer ??= new FakeIssuer())
      : new AirwallexIssuer(
          new AirwallexClient({ clientId: env.AWX_CLIENT_ID, apiKey: env.AWX_API_KEY, tokenStore: new KvTokenStore(env.KV) }),
        );
  return new CardService(store, issuer, {
    approvalSecret: env.APPROVAL_SECRET,
    cardholderEmail: env.CARDHOLDER_EMAIL ?? "agents@x402card.dev",
    approvalUrl: env.APPROVAL_URL,
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const store = new Store(env.KV);

    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (path === "/health") return json({ ok: true });

    if (path.startsWith("/gateway")) {
      return gatewayResponse(req, path, store, env.GATEWAY_SIGNER_KEY as Hex, {
        parentAddr: env.PARENT_ADDR as Address | undefined,
      });
    }

    if (path.startsWith("/public/") && req.method === "GET") {
      const c = path.match(/^\/public\/cards\/([a-z0-9.-]+)$/);
      if (c) {
        let label: string;
        try {
          label = normalizeLabel(c[1]);
        } catch {
          return json({ error: "bad name" }, 400);
        }
        const records = await store.getRecords(label);
        if (!records) return json({ name: fullName(label), exists: false }, 404);
        return json({ name: fullName(label), exists: true, records });
      }
      if (path === "/public/feed") {
        const labels = await store.listLabels();
        const events = (await Promise.all(labels.map(async (l) => (await store.getEvents(l)).map((e) => ({ ...e, name: fullName(l) })))))
          .flat()
          .sort((a, b) => b.at - a.at)
          .slice(0, 20);
        return json({ events });
      }
      return json({ error: "not found" }, 404);
    }

    if (path === "/mcp") {
      const caller = await authenticate(req, store, env.MCP_ADMIN_TOKEN);
      if (!caller) {
        return new Response(JSON.stringify({ error: "missing or invalid bearer token" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer", ...CORS },
        });
      }
      const res = await new McpServer(service(env, store), store, caller).handle(req);
      for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
      return res;
    }

    if (path.startsWith("/api/")) {
      const caller = await authenticate(req, store, env.MCP_ADMIN_TOKEN);
      if (caller?.kind !== "admin") return json({ error: "admin token required" }, 401);
      const svc = service(env, store);
      try {
        if (path === "/api/approvals" && req.method === "GET") {
          return json({ approvals: (await store.listApprovals()).map(({ sig: _sig, ...a }) => a) });
        }
        const m = path.match(/^\/api\/approvals\/([0-9a-f-]{36})$/);
        if (m && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as { approve?: boolean; by?: string };
          if (typeof body.approve !== "boolean") return json({ error: "body must be {approve: boolean}" }, 400);
          const { sig: _sig, ...a } = { sig: "", ...(await svc.decide(m[1], body.approve, body.by || "admin")) };
          return json({ approval: a, card: await svc.getCard(a.name) });
        }
        if (path === "/api/cards" && req.method === "GET") {
          const labels = await store.listLabels();
          return json({ cards: await Promise.all(labels.map((l) => svc.getCard(l))) });
        }
        const u = path.match(/^\/api\/cards\/([a-z0-9.-]+)\/(unfreeze|simulate|check)$/);
        if (u && req.method === "POST") {
          const [, name, action] = u;
          if (action === "unfreeze") return json({ card: await svc.unfreeze(name, "admin") });
          if (action === "check") return json({ ...(await svc.checkActivity(name)), card: await svc.getCard(name) });
          const b = (await req.json().catch(() => ({}))) as { amount?: number; currency?: string; mcc?: string; merchant?: string };
          const result = await svc.simulateCharge(name, {
            amount: Number(b.amount),
            currency: String(b.currency ?? "USD"),
            mcc: String(b.mcc ?? ""),
            merchant: typeof b.merchant === "string" ? b.merchant.slice(0, 43) : undefined,
          });
          return json({ result });
        }
        return json({ error: "not found" }, 404);
      } catch (e) {
        const err = describeError(e);
        return json({ error: err }, err.code === "not_found" ? 404 : 400);
      }
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(service(env, new Store(env.KV)).checkAll());
  },
} satisfies ExportedHandler<Env>;
