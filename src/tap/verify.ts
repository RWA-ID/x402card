// TAP, merchant side: the verification steps from the Trusted Agent Protocol
// spec, in its order: tag, minimum fields, timestamps, nonce, key, signature.
// Lenient on the two spellings the ecosystem uses (keyid/keyId, Ed25519/ed25519)
// because the signed parameters are taken verbatim from the header either way.
import { LABEL, MAX_WINDOW_S, fromB64, signatureBase, type Ed25519PublicJwk, type TapTag } from "./sign.ts";

export type TapVerdict =
  | { ok: true; tag: TapTag; keyid: string; nonce: string; created: number; expires: number }
  | { ok: false; code: TapFailure; reason: string };

export type TapFailure =
  | "NOT_AGENT" // no TAP tag: not a trusted agent; the merchant decides what to do
  | "MISSING_FIELDS"
  | "BAD_TIMESTAMPS"
  | "REPLAYED"
  | "UNKNOWN_KEY"
  | "UNSUPPORTED_ALG"
  | "BAD_SIGNATURE";

/** Remembers nonces for the 8-minute window. Returns false when the nonce was already seen. */
export interface NonceStore {
  claim(nonce: string, ttlS: number): Promise<boolean>;
}

export type KeyResolver = (keyid: string) => Promise<Ed25519PublicJwk | null>;

const TAGS: readonly string[] = ["agent-browser-auth", "agent-payer-auth"];

export interface TapRequest {
  url: string;
  headers: { get(name: string): string | null };
}

export async function verifyTap(
  req: TapRequest,
  opts: { resolveKey: KeyResolver; nonces: NonceStore; nowS?: number; skewS?: number },
): Promise<TapVerdict> {
  const nowS = opts.nowS ?? Math.floor(Date.now() / 1000);
  const skew = opts.skewS ?? 30;
  const input = req.headers.get("signature-input");
  const signature = req.headers.get("signature");

  // Only the sig2 member is read: the label TAP agents use.
  const member = input ? dictMember(input, LABEL) : null;
  const parsed = member ? parseParams(member) : null;
  if (!parsed || !TAGS.includes(String(parsed.params.tag))) {
    return fail("NOT_AGENT", "no Signature-Input with an agent-browser-auth or agent-payer-auth tag");
  }
  const { components, params } = parsed;
  const keyid = String(params.keyid ?? params.keyId ?? "");
  const { created, expires, nonce, alg } = params;
  if (typeof created !== "number" || typeof expires !== "number" || !keyid || !nonce || !alg || !signature) {
    return fail("MISSING_FIELDS", "created, expires, keyid, alg, nonce, tag and a Signature are all required");
  }
  if (components.join(" ") !== '"@authority" "@path"') {
    return fail("MISSING_FIELDS", `covered components must be ("@authority" "@path"), got (${components.join(" ")})`);
  }

  if (created > nowS + skew || expires <= nowS || expires - created > MAX_WINDOW_S) {
    return fail("BAD_TIMESTAMPS", `created ${created}, expires ${expires}, now ${nowS}: must be past, future, and ≤ ${MAX_WINDOW_S}s apart`);
  }
  if (String(alg).toLowerCase() !== "ed25519") return fail("UNSUPPORTED_ALG", `alg ${alg}`);

  const sigMember = dictMember(signature, LABEL);
  const sigB64 = sigMember?.match(/^:([A-Za-z0-9+/=]+):$/)?.[1];
  if (!sigB64) return fail("MISSING_FIELDS", "Signature must be sig2=:<base64>:");

  const jwk = await opts.resolveKey(keyid);
  if (!jwk) return fail("UNKNOWN_KEY", `no public key for keyid ${keyid}`);

  const u = new URL(req.url);
  const base = signatureBase(u.host, u.pathname, member!);
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("Ed25519", key, fromB64(sigB64), new TextEncoder().encode(base));
  if (!valid) return fail("BAD_SIGNATURE", "signature does not match this authority, path and parameters");

  // The spec checks the nonce before the signature; claiming it only for a
  // valid signature gives the same verdicts, and a forged request can't burn
  // a real agent's nonce or fill the store.
  if (!(await opts.nonces.claim(String(nonce), MAX_WINDOW_S))) return fail("REPLAYED", "nonce already used");

  return { ok: true, tag: params.tag as TapTag, keyid, nonce: String(nonce), created, expires };
}

function fail(code: TapFailure, reason: string): TapVerdict {
  return { ok: false, code, reason };
}

/**
 * The raw value of one member of a structured-field dictionary header,
 * e.g. sig2 in `sig1=(...);a=1, sig2=(...);b=2`. Commas inside quoted strings
 * and inner lists don't split members.
 */
export function dictMember(header: string, label: string): string | null {
  let depth = 0, quoted = false, start = 0;
  const members: string[] = [];
  for (let i = 0; i < header.length; i++) {
    const c = header[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      members.push(header.slice(start, i));
      start = i + 1;
    }
  }
  members.push(header.slice(start));
  for (const m of members) {
    const t = m.trim();
    if (t.startsWith(`${label}=`)) return t.slice(label.length + 1);
  }
  return null;
}

/** `("@authority" "@path");created=1;keyid="k"` → components + params. Tolerates spaces after ';'. */
export function parseParams(member: string): { components: string[]; params: Record<string, string | number> } | null {
  const m = member.match(/^\(([^)]*)\)(.*)$/s);
  if (!m) return null;
  const components = m[1].trim().split(/\s+/).filter(Boolean);
  const params: Record<string, string | number> = {};
  for (const p of m[2].matchAll(/;\s*([A-Za-z][\w-]*)=(?:"((?:[^"\\]|\\.)*)"|(-?\d+))/g)) {
    params[p[1]] = p[2] !== undefined ? p[2] : Number(p[3]);
  }
  return { components, params };
}
