// Visa Trusted Agent Protocol (TAP), agent side: RFC 9421 HTTP message
// signatures over @authority and @path, tagged agent-browser-auth or
// agent-payer-auth, so a merchant can tell an xcard agent from a bot.
//
// Wire format, chosen to verify under both the published TAP spec and Visa's
// reference merchant (github.com/visa/trusted-agent-protocol, cdn-proxy):
//   Signature-Input: sig2=("@authority" "@path");created=…;expires=…;keyid="…";keyId="…";alg="ed25519";nonce="…";tag="…"
//   Signature:       sig2=:<base64>:
// The spec names the key parameter keyid; the reference code reads keyId. Both
// are carried, and both are inside the signed parameters, so neither can be
// swapped. alg is the RFC 9421 registered name, which the reference code also uses.

export type TapTag = "agent-browser-auth" | "agent-payer-auth";

/** The spec caps created→expires at 8 minutes. */
export const MAX_WINDOW_S = 8 * 60;
export const LABEL = "sig2";

export interface Ed25519PublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

export interface TapSigner {
  keyid: string;
  publicJwk: Ed25519PublicJwk;
  sign(url: string, tag: TapTag, nowS?: number): Promise<{ "Signature-Input": string; Signature: string; expires: number }>;
}

/** Private key as a JWK JSON string ({kty:"OKP", crv:"Ed25519", d, x}), e.g. the TAP_PRIVATE_KEY secret. */
export async function tapSigner(privateJwkJson: string): Promise<TapSigner> {
  const jwk = JSON.parse(privateJwkJson) as Ed25519PublicJwk & { d?: string };
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.d || !jwk.x) throw new Error("TAP key must be an Ed25519 private JWK");
  const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x }, { name: "Ed25519" }, false, ["sign"]);
  const publicJwk: Ed25519PublicJwk = { kty: "OKP", crv: "Ed25519", x: jwk.x };
  const keyid = await jwkThumbprint(publicJwk);

  return {
    keyid,
    publicJwk,
    async sign(url, tag, nowS = Math.floor(Date.now() / 1000)) {
      const u = new URL(url);
      const created = nowS;
      const expires = nowS + MAX_WINDOW_S;
      const nonce = b64(crypto.getRandomValues(new Uint8Array(32)));
      const params =
        `("@authority" "@path");created=${created};expires=${expires};keyid="${keyid}";keyId="${keyid}";` +
        `alg="ed25519";nonce="${nonce}";tag="${tag}"`;
      const sig = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(signatureBase(u.host, u.pathname, params)));
      return { "Signature-Input": `${LABEL}=${params}`, Signature: `${LABEL}=:${b64(new Uint8Array(sig))}:`, expires };
    },
  };
}

/** RFC 9421 §2.5 signature base for the two covered components. */
export function signatureBase(authority: string, path: string, params: string): string {
  return `"@authority": ${authority.toLowerCase()}\n"@path": ${path}\n"@signature-params": ${params}`;
}

/** RFC 7638 JWK thumbprint (base64url SHA-256): the keyid, like the spec's examples. */
export async function jwkThumbprint(jwk: Ed25519PublicJwk): Promise<string> {
  const canonical = `{"crv":"Ed25519","kty":"OKP","x":"${jwk.x}"}`;
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))));
}

/** A fresh key pair for TAP_PRIVATE_KEY (scripts/tap-keygen.ts). */
export async function generateTapKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return JSON.stringify({ kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x });
}

export function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64(s: string): Uint8Array {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
