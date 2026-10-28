// The app: every route except OAuth (worker.ts wraps it and owns /mcp in production).
//   /gateway/...           CCIP-Read gateway for *.x402card.eth and *.xcard.eth (public)
//   /mcp                   MCP server for agents (bearer token)
//   /api/approvals[/:id]   list / decide escalated funding (admin token)
//   /api/cards             GET fleet: every card with records + pending count; POST issue a card {name, policy} (admin token)
//   /api/cards/:name/unfreeze   human-only unfreeze (admin token)
//   /api/cards/:name/simulate   sandbox: a merchant charges the card directly, skipping the pre-check (admin token)
//   /api/cards/:name/check      run the anomaly rules now instead of waiting for cron (admin token)
//   /public/cards/:name    public ENS records for a name (same data the gateway serves)
//   /approvals/:id         GET an approval + the EIP-712 typed data card.approver signs; POST {approve, signature} decides it (no token: the signature is the authority)
//   /public/feed           recent policy events across cards, for the demo site
//   /keys[?keyID=]         Visa TAP public keys as a JWK set (the spec's Public Key Retrieval)
//   /keys/:keyid           the same key in the agent-registry shape Visa's reference merchant fetches
//   /demo-merchant/*       a merchant that verifies TAP signatures, for the demo
//   cron (every minute)    anomaly check -> freeze
import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
import { mainnet } from "viem/chains";
import { viemReader } from "@x402identity/payee";
import { AirwallexClient, KvTokenStore } from "./airwallex/client.ts";
import { gatewayResponse } from "./ens/gateway.ts";
import { McpServer, authenticate, issueWithToken } from "./mcp.ts";
import { ensApproverAuth } from "./policy/approver.ts";
import { ensPayeeChecker } from "./policy/payee.ts";
import { b64, fromB64, tapSigner, type TapSigner } from "./tap/sign.ts";
import { verifyTap } from "./tap/verify.ts";
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
  /** Ethereum mainnet RPC for the payee gate's ENS reads. Public RPCs throttle Workers; a failed read holds the payment, never passes it. */
  ETH_RPC_URL?: string;
  /** Visa TAP signing key: an Ed25519 private JWK (scripts/tap-keygen.ts). */
  TAP_PRIVATE_KEY?: string;
  /** Local dev only (`wrangler dev --var ISSUER:fake`): in-memory issuer instead of Airwallex. */
  ISSUER?: string;
  /** OAuth grants, clients and tokens for MCP clients (worker.ts; @cloudflare/workers-oauth-provider). */
  OAUTH_KV?: KVNamespace;
  /** Operator wallets, comma-separated: signing in with one grants every card over OAuth. */
  OPERATORS?: string;
  /** More origins for shop.xcard.eth's org.x402.origins, space-separated (custom domains of this Worker). */
  DEMO_MERCHANT_ORIGINS?: string;
}

// One fake per isolate, so local dev keeps state between requests.
let fakeIssuer: FakeIssuer | undefined;
// The imported TAP key, per isolate (keyed by the secret, so a rotation takes effect).
let tapCache: { secret: string; signer: Promise<TapSigner> } | undefined;

function tap(env: Env): (() => Promise<TapSigner>) | undefined {
  const secret = env.TAP_PRIVATE_KEY;
  if (!secret) return undefined;
  return () => {
    if (tapCache?.secret !== secret) tapCache = { secret, signer: tapSigner(secret) };
    return tapCache.signer;
  };
}

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Protocol-Version, Signature-Input, Signature",
};

/** Mainnet client for ENS reads and signature checks (payee gate, approvers, sign-in). */
export function ethClient(env: Env): PublicClient {
  return createPublicClient({ chain: mainnet, transport: http(env.ETH_RPC_URL) }) as PublicClient;
}

export function service(env: Env, store: Store, origin?: string): CardService {
  const issuer =
    env.ISSUER === "fake"
      ? (fakeIssuer ??= new FakeIssuer())
      : new AirwallexIssuer(
          new AirwallexClient({ clientId: env.AWX_CLIENT_ID, apiKey: env.AWX_API_KEY, tokenStore: new KvTokenStore(env.KV) }),
        );
  const eth = ethClient(env);
  return new CardService(store, issuer, {
    approvalSecret: env.APPROVAL_SECRET,
    cardholderEmail: env.CARDHOLDER_EMAIL ?? "agents@x402card.dev",
    approvalUrl: env.APPROVAL_URL,
    tap: tap(env),
    ...(origin ? { tapKeysUrl: `${origin}/keys` } : {}),
    checkPayee: ensPayeeChecker(viemReader(eth)),
    approverAuth: ensApproverAuth(eth),
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
        // The gateway is reached on the URL set on-chain, so list the custom domains too.
        selfOrigin: [...new Set([url.origin, ...(env.DEMO_MERCHANT_ORIGINS ?? "").split(/\s+/).filter(Boolean)])].join(" "),
      });
    }

    if ((path === "/keys" || path.startsWith("/keys/")) && req.method === "GET") {
      const signer = await tap(env)?.();
      if (!signer) return json({ error: "TAP is not configured" }, 404);
      const wanted = path.startsWith("/keys/") ? decodeURIComponent(path.slice(6)) : url.searchParams.get("keyID");
      if (wanted && wanted !== signer.keyid) return json({ error: "unknown keyID" }, 404);
      if (path.startsWith("/keys/")) {
        // Visa's reference merchant reads {key_id, algorithm, public_key} with the raw key in base64.
        return json({ key_id: signer.keyid, algorithm: "ed25519", public_key: b64(fromB64(signer.publicJwk.x)), is_active: true });
      }
      return json({ keys: [{ ...signer.publicJwk, kid: signer.keyid, use: "sig", alg: "EdDSA" }] });
    }

    if (path.startsWith("/demo-merchant/")) {
      // Stands in for a merchant (or its CDN) that checks TAP before serving an agent.
      // A real merchant fetches the key from /keys; this one shares the Worker's key.
      const signer = await tap(env)?.();
      if (!signer) return json({ error: "TAP is not configured" }, 404);
      const verdict = await verifyTap(req, {
        resolveKey: async (kid) => (kid === signer.keyid ? signer.publicJwk : null),
        nonces: { claim: (n, ttl) => store.claimTapNonce(n, ttl) },
      });
      const page = path.slice("/demo-merchant".length);
      if (!verdict.ok) return json({ merchant: "demo", page, trusted_agent: false, ...verdict }, verdict.code === "NOT_AGENT" ? 200 : 403);
      const checkout = verdict.tag === "agent-payer-auth";
      return json({
        merchant: "demo",
        page,
        trusted_agent: true,
        tag: verdict.tag,
        keyid: verdict.keyid,
        message: checkout ? "Trusted agent at checkout: express checkout offered." : "Trusted agent browsing: product data served.",
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

    const ap = path.match(/^\/approvals\/([0-9a-f-]{36})$/);
    if (ap) {
      const svc = service(env, store);
      try {
        if (req.method === "GET") return json(await svc.approvalView(ap[1]));
        if (req.method === "POST") {
          const b = (await req.json().catch(() => ({}))) as { approve?: unknown; signature?: unknown };
          if (typeof b.approve !== "boolean" || typeof b.signature !== "string") {
            return json({ error: { code: "bad_input", message: "body must be {approve: boolean, signature: string}" } }, 400);
          }
          const approval = await svc.decideSigned(ap[1], b.approve, b.signature);
          return json({ approval, card: await svc.getCard(approval.name) });
        }
        return json({ error: "method not allowed" }, 405);
      } catch (e) {
        const err = describeError(e);
        return json({ error: err }, err.code === "not_found" ? 404 : err.code === "bad_signature" ? 403 : 400);
      }
    }

    if (path === "/mcp") {
      const caller = await authenticate(req, store, env.MCP_ADMIN_TOKEN);
      if (!caller) {
        return new Response(JSON.stringify({ error: "missing or invalid bearer token" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer", ...CORS },
        });
      }
      const res = await new McpServer(service(env, store, url.origin), store, caller).handle(req);
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
        if (path === "/api/cards" && req.method === "POST") {
          const b = (await req.json().catch(() => ({}))) as { name?: unknown; policy?: unknown };
          if (typeof b.name !== "string" || !b.name.trim()) return json({ error: { code: "bad_input", message: "name is required" } }, 400);
          return json(await issueWithToken(svc, store, b.name, b.policy), 201);
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
