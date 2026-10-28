// Worker entry: OAuth for MCP clients (Claude, ChatGPT, Grok) around the app.
//
//   /mcp                                   MCP, as an OAuth protected resource. Also still accepts the
//                                          admin token and agent tokens (x4c_…) for Claude Code and scripts.
//   /.well-known/oauth-protected-resource  RFC 9728 metadata: where to get a token for /mcp
//   /.well-known/oauth-authorization-server, /oauth/*   discovery, client registration, tokens
//   /authorize                             wallet sign-in + consent (oauth/authorize.ts)
//   everything else                        the app (index.ts)
//
// The issuer is the origin the request came in on, so the same code serves
// x402card.dmpay.workers.dev and a custom domain; a token is only good on the
// origin that issued it.
import {
  AuthorizationError,
  CimdFetchError,
  OAuthAuthorizationServer,
  OAuthResourceServer,
} from "@cloudflare/workers-oauth-provider";
import app, { CORS, ethClient, service, type Env } from "./index.ts";
import { McpServer, authenticate, type Caller } from "./mcp.ts";
import { callerFor, type AccessDeps, type GrantProps } from "./oauth/access.ts";
import { SCOPE, handleAuthorize } from "./oauth/authorize.ts";
import { ensApproverAuth } from "./policy/approver.ts";
import { Store } from "./store.ts";

/** Token props: an OAuth grant, or a static token validated the old way. */
type Props = GrantProps | { static: Caller };

const roles = new Map<string, { as: OAuthAuthorizationServer<Env>; rs: OAuthResourceServer<Env, Props> }>();

function rolesFor(origin: string) {
  let r = roles.get(origin);
  if (r) return r;
  const resource = `${origin}/mcp`;
  const as = new OAuthAuthorizationServer<Env>({
    issuer: origin,
    resources: [resource],
    scopesSupported: [SCOPE],
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
  });
  const rs = new OAuthResourceServer<Env, Props>({
    resourceMetadata: { resource, authorization_servers: [origin], resource_name: "X Card" },
    validateToken: (env) => async (res, token) => {
      // Static tokens first, recognised by shape, so an OAuth token is never compared against them.
      if (token === env.MCP_ADMIN_TOKEN || token.startsWith("x4c_")) {
        const caller = await authenticate(new Request(resource, { headers: { Authorization: `Bearer ${token}` } }), new Store(env.KV), env.MCP_ADMIN_TOKEN);
        return caller ? { props: { static: caller }, audience: res } : null;
      }
      return as.validateToken<GrantProps>(res, token, env);
    },
    handler: {
      async fetch(req, env, ctx) {
        const store = new Store(env.KV);
        const p = ctx.props;
        const caller = "static" in p ? p.static : await callerFor(p, accessDeps(env, store));
        if (!caller) {
          return Response.json({ error: "this connection's card changed its approver or is gone; connect again" }, {
            status: 401,
            headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' },
          });
        }
        const origin = new URL(req.url).origin;
        return new McpServer(service(env, store, origin), store, caller, origin).handle(req);
      },
    },
  });
  r = { as, rs };
  roles.set(origin, r);
  return r;
}

function accessDeps(env: Env, store: Store): AccessDeps {
  const eth = ethClient(env);
  return {
    store,
    resolve: ensApproverAuth(eth).resolve,
    verifyMessage: (address, message, signature) => eth.verifyMessage({ address, message, signature }),
    operators: (env.OPERATORS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}

const withCors = (res: Response) => {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  out.headers.set("Access-Control-Expose-Headers", "WWW-Authenticate");
  return out;
};

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (req.method === "OPTIONS" || !env.OAUTH_KV) return app.fetch(req, env);
    const { as, rs } = rolesFor(url.origin);

    if (path === "/authorize" || path.startsWith("/authorize/")) {
      return handleAuthorize(req, as.getOAuthApi(env), {
        isAuthorizationError: (e): e is AuthorizationError => e instanceof AuthorizationError,
        isCimdFetchError: (e) => e instanceof CimdFetchError,
      }, accessDeps(env, new Store(env.KV)));
    }
    if (path === "/mcp" || path.startsWith("/.well-known/oauth-protected-resource")) {
      return withCors(await rs.fetch(req, env, ctx));
    }
    if (path.startsWith("/.well-known/oauth-authorization-server") || path.startsWith("/.well-known/openid-configuration") || path.startsWith("/oauth/")) {
      return withCors(await as.fetch(req, env, ctx));
    }
    return app.fetch(req, env);
  },

  scheduled: app.scheduled,
} satisfies ExportedHandler<Env>;
