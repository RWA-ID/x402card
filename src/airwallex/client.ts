// Airwallex sandbox REST client. Amounts are MAJOR units (100 = $100).
// Every write takes a request_id: generate one per operation with
// newRequestId() and reuse it only when retrying that same operation.

export const SANDBOX_BASE_URL = "https://api.sandbox.airwallex.com/api/v1";

// Refresh well before the 30-minute expiry; this Mac's clock has run slow.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const MAX_429_RETRIES = 3;

export interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

export interface TokenStore {
  get(): Promise<CachedToken | null>;
  put(token: CachedToken): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryTokenStore implements TokenStore {
  private value: CachedToken | null = null;
  async get() { return this.value; }
  async put(token: CachedToken) { this.value = token; }
  async clear() { this.value = null; }
}

const KV_TOKEN_KEY = "awx:token";

export class KvTokenStore implements TokenStore {
  private kv: KVNamespace;
  constructor(kv: KVNamespace) { this.kv = kv; }
  async get() { return this.kv.get<CachedToken>(KV_TOKEN_KEY, "json"); }
  async put(token: CachedToken) {
    const ttlSeconds = Math.floor((token.expiresAt - Date.now()) / 1000);
    // KV rejects TTLs under 60s; a token that close to expiry isn't worth caching.
    if (ttlSeconds < 60) return;
    await this.kv.put(KV_TOKEN_KEY, JSON.stringify(token), { expirationTtl: ttlSeconds });
  }
  async clear() { await this.kv.delete(KV_TOKEN_KEY); }
}

export class AirwallexError extends Error {
  status: number;
  code: string | undefined;
  body: unknown;
  constructor(status: number, body: unknown, path: string) {
    const b = body as { code?: string; message?: string } | null;
    super(`Airwallex ${status} on ${path}: ${b?.code ?? "unknown"} ${b?.message ?? ""}`.trim());
    this.status = status;
    this.code = b?.code;
    this.body = body;
  }
}

export function newRequestId(): string {
  return crypto.randomUUID();
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** Connected-account id (acct_...) for customer-scoped calls. */
  onBehalfOf?: string;
}

export interface AirwallexClientOptions {
  clientId: string;
  apiKey: string;
  baseUrl?: string;
  tokenStore?: TokenStore;
}

export class AirwallexClient {
  private clientId: string;
  private apiKey: string;
  private baseUrl: string;
  private tokens: TokenStore;

  constructor(opts: AirwallexClientOptions) {
    if (!opts.clientId || !opts.apiKey) throw new Error("Airwallex clientId and apiKey are required");
    this.clientId = opts.clientId;
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? SANDBOX_BASE_URL;
    this.tokens = opts.tokenStore ?? new MemoryTokenStore();
  }

  async login(): Promise<CachedToken> {
    const res = await fetch(`${this.baseUrl}/authentication/login`, {
      method: "POST",
      headers: { "x-client-id": this.clientId, "x-api-key": this.apiKey },
    });
    const body = await readJson(res);
    if (!res.ok) throw new AirwallexError(res.status, body, "/authentication/login");
    const { token, expires_at } = body as { token: string; expires_at?: string };
    const parsed = expires_at ? Date.parse(expires_at) : NaN;
    const cached = {
      token,
      expiresAt: (Number.isFinite(parsed) ? parsed : Date.now() + 30 * 60 * 1000) - TOKEN_REFRESH_MARGIN_MS,
    };
    await this.tokens.put(cached);
    return cached;
  }

  private async bearer(): Promise<string> {
    const cached = await this.tokens.get();
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    return (await this.login()).token;
  }

  async request<T>(method: "GET" | "POST", path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    let reauthed = false;
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { Authorization: `Bearer ${await this.bearer()}` };
      if (opts.body !== undefined) headers["Content-Type"] = "application/json";
      if (opts.onBehalfOf) headers["x-on-behalf-of"] = opts.onBehalfOf;

      // The body (and its request_id) is identical on every retry, so a
      // retried write can't create a second object.
      const res = await fetch(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });

      if (res.status === 401 && !reauthed) {
        reauthed = true;
        await this.tokens.clear();
        continue;
      }
      if (res.status === 429 && attempt < MAX_429_RETRIES) {
        await sleep(500 * 2 ** attempt);
        continue;
      }

      const body = await readJson(res);
      if (!res.ok) throw new AirwallexError(res.status, body, path);
      return body as T;
    }
  }

  get<T>(path: string, opts?: Omit<RequestOptions, "body">) { return this.request<T>("GET", path, opts); }
  post<T>(path: string, body: unknown, opts?: Omit<RequestOptions, "body">) {
    return this.request<T>("POST", path, { ...opts, body });
  }

  // --- Reads used to verify the connection ---

  getCurrentBalances(onBehalfOf?: string) {
    return this.get<Balance[]>("/balances/current", { onBehalfOf });
  }

  listGlobalAccounts() {
    return this.get<{ items: GlobalAccount[]; has_more?: boolean }>("/global_accounts");
  }
}

export interface Balance {
  currency: string;
  available_amount: number;
  pending_amount: number;
  reserved_amount: number;
  total_amount: number;
}

export interface GlobalAccount {
  id: string;
  account_name?: string;
  country_code?: string;
  status?: string;
  required_features?: { currency: string; transfer_method: string }[];
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { message: text.slice(0, 500) }; }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
