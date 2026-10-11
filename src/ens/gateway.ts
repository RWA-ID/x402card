// CCIP-Read gateway (EIP-3668 / ENSIP-10) for *.x402card.eth and *.xcard.eth.
// The OffchainResolver reverts with OffchainLookup(sender, urls, callData, ...);
// clients then call this gateway with {sender, data=callData}. We answer the
// inner resolver call from KV and sign it the way the ENS reference
// SignatureVerifier expects:
//   hash = keccak256(0x1900 ‖ target ‖ uint64 expires ‖ keccak256(request) ‖ keccak256(result))
//   response = abi.encode(bytes result, uint64 expires, bytes sig)
import {
  type Address,
  type Hex,
  bytesToHex,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  encodePacked,
  hexToBytes,
  isAddress,
  keccak256,
  namehash,
  parseAbi,
  zeroAddress,
} from "viem";
import { sign, serializeSignature } from "viem/accounts";
import type { TextRecords } from "../policy/records.ts";

/** The first namespace; its cards are stored under the bare label. */
export const LEGACY_PARENT = "x402card.eth";
/** Namespaces this gateway answers for. The same label under each is a separate card. */
export const PARENT_NAMES = [LEGACY_PARENT, "xcard.eth"];
/** Subnames with their own on-chain resolver (demo.x402card.eth, ai.xcard.eth = hosted sites); never issue cards under these. */
export const RESERVED_LABELS = new Set(["demo", "ai", "www", "app", "api", "gateway"]);
const TTL_SECONDS = 300;

const RESOLVER_ABI = parseAbi(["function resolve(bytes name, bytes data) view returns (bytes)"]);
const PROFILE_ABI = parseAbi([
  "function text(bytes32 node, string key) view returns (string)",
  "function addr(bytes32 node) view returns (address)",
  "function addr(bytes32 node, uint256 coinType) view returns (bytes)",
  "function contenthash(bytes32 node) view returns (bytes)",
]);

export interface RecordSource {
  /** Records for a card key (see cardKeyOf), or null if the name doesn't exist. */
  getRecords(key: string): Promise<TextRecords | null>;
}

export interface GatewayOptions {
  /** ETH address for each parent name itself. */
  parentAddr?: Address;
}

export class GatewayError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** "a.b.eth" -> DNS wire-format bytes (ENSIP-10). */
export function encodeDnsName(name: string): Hex {
  const out: number[] = [];
  for (const label of name.split(".")) {
    const b = new TextEncoder().encode(label);
    if (b.length === 0 || b.length > 63) throw new GatewayError(400, "bad label");
    out.push(b.length, ...b);
  }
  out.push(0);
  return bytesToHex(new Uint8Array(out));
}

/** DNS wire-format name (ENSIP-10) -> "a.b.eth". */
export function decodeDnsName(bytes: Uint8Array): string {
  const labels: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const len = bytes[i];
    if (len === 0) return labels.join(".");
    if (i + 1 + len > bytes.length) break;
    labels.push(new TextDecoder().decode(bytes.subarray(i + 1, i + 1 + len)));
    i += 1 + len;
  }
  throw new GatewayError(400, "malformed DNS name");
}

/**
 * Card storage key for a full name: "researcher.x402card.eth" -> "researcher"
 * (stored that way before xcard.eth existed), "researcher.xcard.eth" ->
 * "researcher.xcard.eth". A parent itself -> "". Anything else -> null.
 */
export function cardKeyOf(name: string): string | null {
  const n = name.toLowerCase();
  if (PARENT_NAMES.includes(n)) return "";
  const parent = PARENT_NAMES.find((p) => n.endsWith("." + p));
  if (!parent) return null;
  const label = n.slice(0, -(parent.length + 1));
  if (!/^[a-z0-9-]{1,63}$/.test(label)) return null;
  return parent === LEGACY_PARENT ? label : n;
}

/** Card key -> full ENS name. */
export const nameOfKey = (key: string) => (key.includes(".") ? key : `${key}.${LEGACY_PARENT}`);

/** Answer the inner resolver call (text/addr/contenthash) as ABI-encoded result bytes. */
export async function answer(name: string, inner: Hex, source: RecordSource, opts: GatewayOptions = {}): Promise<Hex> {
  const key = cardKeyOf(name);
  const records = key === null ? null : key === "" ? {} : await source.getRecords(key);

  const call = decodeFunctionData({ abi: PROFILE_ABI, data: inner });
  if (call.args[0] !== namehash(name)) throw new GatewayError(400, "node does not match name");

  switch (call.functionName) {
    case "text": {
      const key = call.args[1] as string;
      const value = (records as Record<string, string> | null)?.[key] ?? "";
      return encodeFunctionResult({ abi: PROFILE_ABI, functionName: "text", result: value });
    }
    case "addr": {
      // Only the parent has an address; card names have none ("not set").
      const a = key === "" ? opts.parentAddr : undefined;
      if (call.args.length === 1) {
        return encodeAbiParameters([{ type: "address" }], [a ?? zeroAddress]);
      }
      const eth = call.args[1] === 60n && a ? a : "0x";
      return encodeAbiParameters([{ type: "bytes" }], [eth]);
    }
    case "contenthash":
      return encodeFunctionResult({ abi: PROFILE_ABI, functionName: "contenthash", result: "0x" });
  }
}

export function signatureHash(target: Hex, expires: bigint, request: Hex, result: Hex): Hex {
  return keccak256(
    encodePacked(["bytes2", "address", "uint64", "bytes32", "bytes32"], ["0x1900", target, expires, keccak256(request), keccak256(result)]),
  );
}

/**
 * Full gateway handling for one CCIP-Read request.
 * `sender` is the resolver contract; `data` is resolve(bytes,bytes) calldata.
 */
export async function handleLookup(
  sender: string,
  data: string,
  source: RecordSource,
  signerKey: Hex,
  now: number = Date.now(),
  opts: GatewayOptions = {},
): Promise<Hex> {
  if (!isAddress(sender)) throw new GatewayError(400, "bad sender");
  if (!/^0x[0-9a-fA-F]*$/.test(data)) throw new GatewayError(400, "bad data");
  const request = data as Hex;

  let name: string;
  let inner: Hex;
  try {
    const call = decodeFunctionData({ abi: RESOLVER_ABI, data: request });
    name = decodeDnsName(hexToBytes(call.args[0]));
    inner = call.args[1];
  } catch (e) {
    if (e instanceof GatewayError) throw e;
    throw new GatewayError(400, "expected resolve(bytes,bytes) calldata");
  }

  let result: Hex;
  try {
    result = await answer(name, inner, source, opts);
  } catch (e) {
    if (e instanceof GatewayError) throw e;
    throw new GatewayError(400, "unsupported resolver call");
  }

  const expires = BigInt(Math.floor(now / 1000) + TTL_SECONDS);
  const sig = await sign({ hash: signatureHash(sender as Hex, expires, request, result), privateKey: signerKey });
  return encodeAbiParameters(
    [{ type: "bytes" }, { type: "uint64" }, { type: "bytes" }],
    [result, expires, serializeSignature(sig)],
  );
}

/** HTTP wrapper: GET /gateway/{sender}/{data}.json or POST /gateway {sender,data}. */
export async function gatewayResponse(
  req: Request,
  path: string,
  source: RecordSource,
  signerKey: Hex,
  opts: GatewayOptions = {},
): Promise<Response> {
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
  try {
    let sender: string;
    let data: string;
    if (req.method === "POST") {
      const body = (await req.json()) as { sender?: string; data?: string };
      sender = body.sender ?? "";
      data = body.data ?? "";
    } else {
      const m = path.match(/^\/gateway\/(0x[0-9a-fA-F]{40})\/(0x[0-9a-fA-F]*)(?:\.json)?$/);
      if (!m) throw new GatewayError(404, "use /gateway/{sender}/{data}.json");
      [, sender, data] = m;
    }
    const out = await handleLookup(sender, data, source, signerKey, Date.now(), opts);
    return new Response(JSON.stringify({ data: out }), { headers });
  } catch (e) {
    const status = e instanceof GatewayError ? e.status : 500;
    const message = e instanceof GatewayError ? e.message : "internal error";
    return new Response(JSON.stringify({ message }), { status, headers });
  }
}
