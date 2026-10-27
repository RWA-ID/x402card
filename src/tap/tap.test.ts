import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, verify as nodeVerify } from "node:crypto";
import { fromB64, generateTapKey, jwkThumbprint, tapSigner } from "./sign.ts";
import { dictMember, verifyTap, type NonceStore } from "./verify.ts";

const NOW = 1_800_000_000;

function memNonces(): NonceStore {
  const seen = new Set<string>();
  return { claim: async (n) => (seen.has(n) ? false : (seen.add(n), true)) };
}

async function setup() {
  const signer = await tapSigner(await generateTapKey());
  const opts = {
    resolveKey: async (kid: string) => (kid === signer.keyid ? signer.publicJwk : null),
    nonces: memNonces(),
    nowS: NOW + 5,
  };
  const req = (url: string, h: { "Signature-Input"?: string; Signature?: string }) => {
    const headers = new Headers();
    if (h["Signature-Input"]) headers.set("Signature-Input", h["Signature-Input"]);
    if (h.Signature) headers.set("Signature", h.Signature);
    return { url, headers };
  };
  return { signer, opts, req };
}

test("tap: a signed checkout verifies once, for that authority and path only", async () => {
  const { signer, opts, req } = await setup();
  const url = "https://shop.example/checkout?cart=7";
  const h = await signer.sign(url, "agent-payer-auth", NOW);
  assert.match(h["Signature-Input"], /^sig2=\("@authority" "@path"\);created=\d+;expires=\d+;keyid="[\w-]{43}";keyId="[\w-]{43}";alg="ed25519";nonce="[^"]+";tag="agent-payer-auth"$/);
  assert.equal(h.expires - NOW, 480);

  const ok = await verifyTap(req(url, h), opts);
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.tag, "agent-payer-auth");
  // @path excludes the query, so another query on the same path still verifies (with a fresh signature).
  assert.equal((await verifyTap(req("https://shop.example/checkout", await signer.sign(url, "agent-payer-auth", NOW)), opts)).ok, true);

  const code = async (u: string, hh: { "Signature-Input"?: string; Signature?: string }, o = opts) => {
    const v = await verifyTap(req(u, hh), o);
    return v.ok ? "ok" : v.code;
  };
  assert.equal(await code(url, h), "REPLAYED");
  const fresh = () => signer.sign(url, "agent-payer-auth", NOW);
  assert.equal(await code("https://evil.example/checkout", await fresh()), "BAD_SIGNATURE");
  assert.equal(await code("https://shop.example/admin", await fresh()), "BAD_SIGNATURE");
  assert.equal(await code(url, { ...(await fresh()), "Signature-Input": (await fresh())["Signature-Input"].replace("agent-payer-auth", "agent-browser-auth") }), "BAD_SIGNATURE");
  assert.equal(await code(url, await fresh(), { ...opts, nowS: NOW + 481 }), "BAD_TIMESTAMPS");
  assert.equal(await code(url, await signer.sign(url, "agent-payer-auth", NOW + 120)), "BAD_TIMESTAMPS", "created in the future");
  assert.equal(await code(url, await fresh(), { ...opts, resolveKey: async () => null }), "UNKNOWN_KEY");
  assert.equal(await code(url, {}), "NOT_AGENT");
  assert.equal(await code(url, { "Signature-Input": 'sig2=("@authority" "@path");created=1;tag="crawler"', Signature: "sig2=:AA==:" }), "NOT_AGENT");
  const noNonce = (await fresh())["Signature-Input"].replace(/;nonce="[^"]+"/, "");
  assert.equal(await code(url, { ...(await fresh()), "Signature-Input": noNonce }), "MISSING_FIELDS");
});

test("tap: keyid is the RFC 7638 thumbprint", async () => {
  // RFC 8037 Appendix A.3 test vector.
  const x = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
  assert.equal(await jwkThumbprint({ kty: "OKP", crv: "Ed25519", x }), "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k");
});

test("tap: other members of the dictionary header are ignored", async () => {
  const { signer, opts, req } = await setup();
  const url = "https://shop.example/p/1";
  const h = await signer.sign(url, "agent-browser-auth", NOW);
  const v = await verifyTap(req(url, {
    "Signature-Input": `sig1=("@method");created=1;keyid="x", ${h["Signature-Input"]}`,
    Signature: `sig1=:AAAA:, ${h.Signature}`,
  }), opts);
  assert.equal(v.ok, true);
  assert.equal(dictMember('a=("x, y");k="1,2", sig2=:QQ==:', "sig2"), ":QQ==:");
});

/**
 * Visa's reference merchant (visa/trusted-agent-protocol cdn-proxy/server.js,
 * parseRFC9421SignatureInput + buildRFC9421SignatureString + verifyEd25519Signature),
 * ported line for line. xcard's signatures must pass it unchanged.
 */
function visaReferenceVerify(signatureInput: string, signature: string, host: string, path: string, publicKeyB64: string): { keyId: string; ok: boolean } {
  const signatureMatch = signatureInput.match(/sig2=\(([^)]+)\);\s*(.+)/)!;
  const [, paramString, attributesString] = signatureMatch;
  const params = paramString.split(/\s+/).map((p) => p.replace(/['"]/g, ""));
  const attributes: Record<string, string | number> = {};
  for (const [, key, value] of attributesString.matchAll(/(\w+)=("[^"]*"|\d+)/g)) {
    attributes[key] = value.startsWith('"') ? value.slice(1, -1) : parseInt(value);
  }
  const components: string[] = [];
  for (const param of params) {
    if (param === "@authority") components.push(`"@authority": ${host}`);
    if (param === "@path") components.push(`"@path": ${path}`);
  }
  components.push(`"@signature-params": ${signatureInput.startsWith("sig2=") ? signatureInput.substring(5) : signatureInput}`);
  const base = components.join("\n");
  const sig = signature.match(/sig2=:([^:]+):/)![1];
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKeyB64, "base64")]);
  const key = createPublicKey({ key: der, format: "der", type: "spki" });
  return { keyId: String(attributes.keyId), ok: nodeVerify(null, Buffer.from(base), key, Buffer.from(sig, "base64")) };
}

test("tap: verifies under Visa's reference merchant code", async () => {
  const { signer } = await setup();
  const h = await signer.sign("https://shop.example/checkout", "agent-payer-auth", NOW);
  const rawPub = Buffer.from(fromB64(signer.publicJwk.x)).toString("base64");
  const r = visaReferenceVerify(h["Signature-Input"], h.Signature, "shop.example", "/checkout", rawPub);
  assert.equal(r.keyId, signer.keyid, "the reference code reads keyId");
  assert.equal(r.ok, true);
  assert.equal(visaReferenceVerify(h["Signature-Input"], h.Signature, "shop.example", "/other", rawPub).ok, false);
});
