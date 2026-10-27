// /authorize: an MCP client (Claude, ChatGPT…) asks to act for someone's
// cards. The page signs the person in with their wallet (SIWE), lists what
// that wallet may grant (oauth/access.ts), and completes the OAuth
// authorization for the one they pick.
//
//   GET  /authorize          the consent page (validated by the OAuth library)
//   POST /authorize/siwe     {handle, address} -> the SIWE message to sign
//   POST /authorize/verify   {handle, signature} -> what this wallet may grant
//   POST /authorize          form {handle, decision, choice} -> redirect to the client
//
// The sign-in is kept server-side under the consent handle and bound to this
// browser by a cookie, so a leaked handle can't be finished elsewhere.
import type { ApprovedConsent, AuthRequest, CompleteAuthorizationOptions, ConsentDescription, ConsentTransaction, DeniedConsent } from "@cloudflare/workers-oauth-provider";
import { generateSiweNonce } from "viem/siwe";
import { sha256Hex } from "../mcp.ts";
import { accessOptions, siweMessage, verifySiwe, type AccessDeps, type AccessOption, type GrantProps } from "./access.ts";

/** The OAuth library's helpers this page uses (getOAuthApi(env)); faked in tests. */
export interface ConsentApi {
  parseAuthRequest(request: Request): Promise<AuthRequest>;
  describeConsent(authRequest: AuthRequest): Promise<ConsentDescription>;
  beginConsent(authRequest: AuthRequest): Promise<ConsentTransaction>;
  approveConsent(request: Request, handle: string, options?: { scope?: string[] }): Promise<ApprovedConsent>;
  denyConsent(request: Request, handle: string): Promise<DeniedConsent>;
  completeAuthorization(options: CompleteAuthorizationOptions): Promise<{ redirectTo: string }>;
}

/** Errors the library throws for a bad or expired request; rendered here, never redirected blindly. */
export interface AuthorizeErrors {
  isAuthorizationError(e: unknown): e is { description: string; redirectTo?: string };
  isCimdFetchError(e: unknown): boolean;
}

interface Session {
  cookie: string; // sha256 of the browser cookie
  nonce: string;
  client: string;
  address?: string;
  message?: string;
  options?: AccessOption[];
}

export const SCOPE = "mcp";
const COOKIE = "__Host-xcard-authz";

export async function handleAuthorize(req: Request, api: ConsentApi, errors: AuthorizeErrors, deps: AccessDeps): Promise<Response> {
  const url = new URL(req.url);
  try {
    if (url.pathname === "/authorize" && req.method === "GET") return await page(req, api, deps);
    if (url.pathname === "/authorize/siwe" && req.method === "POST") return await challenge(req, url.origin, deps);
    if (url.pathname === "/authorize/verify" && req.method === "POST") return await verify(req, url.origin, deps);
    if (url.pathname === "/authorize" && req.method === "POST") return await decide(req, api, deps);
    return text("Not found", 404);
  } catch (e) {
    if (errors.isAuthorizationError(e)) {
      if (e.redirectTo) return new Response(null, { status: 302, headers: { Location: e.redirectTo } });
      return text(e.description, 400);
    }
    if (errors.isCimdFetchError(e)) return text("This app could not be verified.", 400);
    if (e instanceof StepError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

class StepError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

async function page(req: Request, api: ConsentApi, deps: AccessDeps): Promise<Response> {
  const request = await api.parseAuthRequest(req);
  const details = await api.describeConsent(request); // first: a failed lookup leaves nothing behind
  const consent = await api.beginConsent(request);
  const cookie = randomHex(32);
  await deps.store.putAuthz(consent.handle, { cookie: await sha256Hex(cookie), nonce: generateSiweNonce(), client: details.clientName } satisfies Session);
  consent.headers.set("Content-Type", "text/html; charset=utf-8");
  consent.headers.append("Set-Cookie", `${COOKIE}=${cookie}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`);
  return new Response(consentPage(details, consent.handle), { headers: consent.headers });
}

async function session(req: Request, handle: unknown, deps: AccessDeps): Promise<{ handle: string; s: Session }> {
  if (typeof handle !== "string" || !handle) throw new StepError("This sign-in expired. Start again from your AI app.");
  const s = await deps.store.getAuthz<Session>(handle);
  const cookie = cookieValue(req, COOKIE);
  if (!s || !cookie || (await sha256Hex(cookie)) !== s.cookie) throw new StepError("This sign-in expired or was opened in another browser. Start again from your AI app.");
  return { handle, s };
}

async function challenge(req: Request, origin: string, deps: AccessDeps): Promise<Response> {
  const b = (await req.json().catch(() => ({}))) as { handle?: unknown; address?: unknown };
  const { handle, s } = await session(req, b.handle, deps);
  if (s.options) throw new StepError("Already signed in on this page.");
  if (typeof b.address !== "string") throw new StepError("address is required");
  let message: string;
  try {
    message = siweMessage(origin, b.address, s.nonce);
  } catch {
    throw new StepError("That isn't an Ethereum address.");
  }
  await deps.store.putAuthz(handle, { ...s, address: b.address, message } satisfies Session);
  return Response.json({ message });
}

async function verify(req: Request, origin: string, deps: AccessDeps): Promise<Response> {
  const b = (await req.json().catch(() => ({}))) as { handle?: unknown; signature?: unknown };
  const { handle, s } = await session(req, b.handle, deps);
  if (s.options) throw new StepError("Already signed in on this page.");
  if (!s.address || !s.message) throw new StepError("Connect your wallet first.");
  if (typeof b.signature !== "string" || !(await verifySiwe(origin, { address: s.address, nonce: s.nonce, message: s.message }, b.signature, deps))) {
    throw new StepError("That signature isn't from this wallet, or the sign-in expired.", 403);
  }
  const options = await accessOptions(s.address as `0x${string}`, deps);
  await deps.store.putAuthz(handle, { ...s, options } satisfies Session);
  return Response.json({ address: s.address, options: options.map(({ id, name, detail }) => ({ id, name, detail })) });
}

async function decide(req: Request, api: ConsentApi, deps: AccessDeps): Promise<Response> {
  const form = await req.clone().formData();
  const handle = form.get("handle");
  if (form.get("decision") !== "approve") {
    const denied = await api.denyConsent(req, String(handle ?? ""));
    if (typeof handle === "string") await deps.store.deleteAuthz(handle);
    denied.headers.set("Location", denied.redirectTo);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  let s: Session;
  try {
    ({ s } = await session(req, handle, deps));
  } catch (e) {
    if (e instanceof StepError) return text(e.message, 400); // a form post: show it, not JSON
    throw e;
  }
  const choice = s.options?.find((o) => o.id === form.get("choice"));
  if (!s.address || !choice) return text("Sign in with your wallet and pick what to connect.", 400);
  const approved = await api.approveConsent(req, String(handle), { scope: [SCOPE] });
  const props: GrantProps = { address: s.address as `0x${string}`, grant: choice.grant, ...(choice.approver ? { approver: choice.approver } : {}) };
  const { redirectTo } = await api.completeAuthorization({
    request: approved.request,
    userId: s.address.toLowerCase(),
    metadata: { grant: choice.id, client: s.client },
    scope: [SCOPE],
    props,
  });
  await deps.store.deleteAuthz(String(handle));
  approved.headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}

function text(body: string, status: number) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

function cookieValue(req: Request, name: string): string | null {
  for (const part of (req.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function consentPage(d: ConsentDescription, handle: string): string {
  const name = esc(d.clientName || "An app");
  const who = d.clientDomain ? `Published by <b>${esc(d.clientDomain)}</b>.` : "This app registered itself, so its name isn't verified.";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Connect ${name} · X Card</title>
<style>
:root{color-scheme:dark;--bg:#0a0b0d;--surface:#14161a;--line:rgba(255,255,255,.09);--text:#eef0f3;--muted:#9aa0aa;--dim:#6b717c;--accent:oklch(.74 .19 258);--ok:oklch(.8 .16 155);--err:oklch(.7 .19 25);--warn:oklch(.84 .14 80)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:520px;margin:0 auto;padding:48px 16px}.wm{font-weight:600;letter-spacing:-.02em;font-size:17px;color:var(--muted)}
.box{margin-top:24px;background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:24px;display:flex;flex-direction:column;gap:16px}
h1{font-size:24px;line-height:1.25;margin:0;font-weight:600;letter-spacing:-.02em}p{margin:0;color:var(--muted)}b{color:var(--text);font-weight:500}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}.warn{color:var(--warn)}.err{color:var(--err);font-size:13px;min-height:1em}
button{font:inherit;font-weight:500;border-radius:10px;padding:11px 20px;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--text)}
button.go{background:var(--accent);color:var(--bg);border:none}button:disabled{opacity:.45;cursor:default}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.opt{display:flex;gap:12px;align-items:flex-start;padding:12px 14px;border:1px solid var(--line);border-radius:12px;cursor:pointer}
.opt input{margin-top:4px;accent-color:var(--accent)}.opt span{display:flex;flex-direction:column;gap:2px;min-width:0}.opt small{color:var(--dim);font-size:13px}
.opts{display:flex;flex-direction:column;gap:8px}[hidden]{display:none!important}ul{margin:0;padding-left:18px;color:var(--muted);font-size:14px}
</style></head><body><main>
<div class="wm">X Card</div>
<div class="box">
  <h1>Connect ${name} to X Card</h1>
  <p>${who} Access goes to <b>${esc(d.redirectHost)}</b>.</p>
  ${d.redirectIsLoopback ? `<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>` : ""}
  <ul>
    <li>It can pay with the card you pick, within that card's policy.</li>
    <li>It can't approve anything. Requests over the policy still need your wallet signature on the approval page.</li>
    <li>It never sees a card number.</li>
  </ul>
  <div data-step="connect" class="row"><button class="go" type="button" data-connect>Sign in with your wallet</button></div>
  <form method="post" action="/authorize" data-form>
    <input type="hidden" name="handle" value="${esc(handle)}">
    <input type="hidden" name="decision" value="approve" data-decision>
    <div class="opts" data-opts hidden></div>
    <p data-none hidden>This wallet isn't the approver of any card. A card lists its approver in <span class="mono">card.approver</span>; ask whoever issued it.</p>
    <div class="row" style="margin-top:16px"><button class="go" type="submit" data-allow disabled>Allow</button><button type="submit" data-deny>Deny</button></div>
  </form>
  <p class="mono" data-status aria-live="polite"></p>
  <div class="err" data-err aria-live="polite"></div>
</div>
</main>
<script>
(() => {
  const $ = (s) => document.querySelector(s);
  const handle = ${JSON.stringify(handle).replace(/</g, "\\u003c")};
  const wallets = [];
  addEventListener("eip6963:announceProvider", (e) => { if (e.detail?.provider) wallets.push(e.detail); });
  dispatchEvent(new Event("eip6963:requestProvider"));
  const err = (m) => { $("[data-err]").textContent = m || ""; };
  const post = async (path, body) => {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
    return j;
  };
  $("[data-deny]").addEventListener("click", () => { $("[data-decision]").value = "deny"; });
  $("[data-connect]").addEventListener("click", async (e) => {
    const btn = e.currentTarget, p = wallets[0]?.provider || window.ethereum;
    err("");
    if (!p) { err("No wallet in this browser. Open this page where your wallet extension is installed, or in your wallet app's browser."); return; }
    btn.disabled = true;
    try {
      btn.textContent = "Connecting…";
      const [address] = await p.request({ method: "eth_requestAccounts" });
      const { message } = await post("/authorize/siwe", { handle, address });
      btn.textContent = "Sign in your wallet…";
      const hex = "0x" + Array.from(new TextEncoder().encode(message), (b) => b.toString(16).padStart(2, "0")).join("");
      const signature = await p.request({ method: "personal_sign", params: [hex, address] });
      const v = await post("/authorize/verify", { handle, signature });
      $("[data-step=connect]").hidden = true;
      const box = $("[data-opts]");
      v.options.forEach((o, i) => {
        const l = document.createElement("label"); l.className = "opt";
        const r = document.createElement("input"); r.type = "radio"; r.name = "choice"; r.value = o.id; r.checked = i === 0;
        const s = document.createElement("span"); const n = document.createElement("b"); n.className = "mono"; n.textContent = o.name;
        const d = document.createElement("small"); d.textContent = o.detail; s.append(n, d); l.append(r, s); box.append(l);
      });
      box.hidden = !v.options.length; $("[data-none]").hidden = !!v.options.length;
      $("[data-allow]").disabled = !v.options.length;
      $("[data-status]").textContent = "Signed in as " + v.address.slice(0, 6) + "…" + v.address.slice(-4);
    } catch (x) {
      btn.disabled = false; btn.textContent = "Sign in with your wallet";
      err(x && x.code === 4001 ? "You cancelled in your wallet." : x.message);
    }
  });
})();
</script>
</body></html>`;
}
