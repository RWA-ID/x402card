// End-to-end: OffchainResolver on a local Hardhat node + our gateway code.
// Run `npx hardhat node` in contracts/ first, then `node scripts/e2e-resolver.ts`.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  type Hex,
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  decodeErrorResult,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  namehash,
  parseAbi,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";
import { encodeDnsName, handleLookup, type RecordSource } from "../src/ens/gateway.ts";

const artifact = JSON.parse(
  readFileSync(new URL("../contracts/artifacts/contracts/OffchainResolver.sol/OffchainResolver.json", import.meta.url), "utf8"),
);

// Hardhat's well-known dev account #0 (local node only).
const DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const deployer = privateKeyToAccount(DEV_KEY);
const pub = createPublicClient({ chain: hardhat, transport: http(), ccipRead: false });
const wallet = createWalletClient({ chain: hardhat, transport: http(), account: deployer });

const signerKey = generatePrivateKey();
const signer = privateKeyToAccount(signerKey);

const hash = await wallet.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  args: ["http://localhost/gateway/{sender}/{data}.json", [signer.address]],
});
const { contractAddress } = await pub.waitForTransactionReceipt({ hash });
const resolver = contractAddress!;
console.log(`resolver deployed at ${resolver}, gateway signer ${signer.address}`);

const records: RecordSource = {
  async getRecords(label) {
    return label === "researcher"
      ? { "card.limit.tx": "100", "card.status": "active", "card.mcc.allow": "5734,7372" }
      : null;
  },
};

const profile = parseAbi(["function text(bytes32 node, string key) view returns (string)"]);
const resolverAbi = artifact.abi;

async function lookup(name: string, key: string, gatewayKey: Hex = signerKey, tamper = false): Promise<string> {
  const inner = encodeFunctionData({ abi: profile, functionName: "text", args: [namehash(name), key] });
  const dnsName = encodeDnsName(name);

  // 1. resolve() must revert with OffchainLookup.
  // Raw eth_call so nothing (viem's CCIP-Read handling) swallows the revert data.
  const rpc = await fetch("http://127.0.0.1:8545", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ to: resolver, data: encodeFunctionData({ abi: resolverAbi, functionName: "resolve", args: [dnsName, inner] }) }, "latest"],
    }),
  }).then((r) => r.json() as Promise<{ error?: { data?: Hex | { data?: Hex } } }>);
  const raw = rpc.error?.data;
  const revertData = (typeof raw === "string" ? raw : raw?.data) as Hex;
  assert.ok(revertData, "resolve() should revert with data");
  const err = decodeErrorResult({ abi: resolverAbi, data: revertData });
  assert.equal(err.errorName, "OffchainLookup");
  const lookupArgs = err.args!;
  const [sender, urls, callData, , extraData] = lookupArgs as [Hex, string[], Hex, Hex, Hex];
  assert.equal(sender.toLowerCase(), resolver.toLowerCase());
  assert.match(urls[0], /\{sender\}/);

  // 2. Gateway answers and signs.
  let response = await handleLookup(sender, callData, records, gatewayKey);
  if (tamper) {
    const [, expires, sig] = decodeAbiParameters([{ type: "bytes" }, { type: "uint64" }, { type: "bytes" }], response);
    const forged = encodeFunctionData({ abi: profile, functionName: "text", args: [namehash(name), "x"] }); // any other bytes
    response = encodeAbiParameters([{ type: "bytes" }, { type: "uint64" }, { type: "bytes" }], [forged, expires, sig]);
  }

  // 3. Contract verifies via resolveWithProof.
  const verified = (await pub.readContract({
    address: resolver,
    abi: resolverAbi,
    functionName: "resolveWithProof",
    args: [response, extraData],
  })) as Hex;
  return decodeFunctionResult({ abi: profile, functionName: "text", data: verified }) as string;
}

assert.equal(await lookup("researcher.x402card.eth", "card.limit.tx"), "100");
assert.equal(await lookup("researcher.x402card.eth", "card.mcc.allow"), "5734,7372");
assert.equal(await lookup("researcher.x402card.eth", "card.number"), "", "unknown keys resolve empty");
assert.equal(await lookup("nobody.x402card.eth", "card.status"), "");
console.log("ok: signed records verify on-chain");

await assert.rejects(lookup("researcher.x402card.eth", "card.status", generatePrivateKey()), /Invalid signature/);
console.log("ok: unknown gateway signer rejected");

await assert.rejects(lookup("researcher.x402card.eth", "card.status", signerKey, true), /Invalid signature|invalid signature/);
console.log("ok: tampered result rejected");

{
  const parentAddr = "0x5A578eDdD28Bac066464BB2462ff052a65103602";
  const addrAbi = parseAbi(["function addr(bytes32 node) view returns (address)"]);
  const inner = encodeFunctionData({ abi: addrAbi, functionName: "addr", args: [namehash("x402card.eth")] });
  const req = encodeFunctionData({ abi: resolverAbi, functionName: "resolve", args: [encodeDnsName("x402card.eth"), inner] });
  const resp = await handleLookup(resolver, req, records, signerKey, Date.now(), { parentAddr });
  const extra = encodeAbiParameters([{ type: "bytes" }, { type: "address" }], [req, resolver]);
  const out = (await pub.readContract({ address: resolver, abi: resolverAbi, functionName: "resolveWithProof", args: [resp, extra] })) as Hex;
  assert.equal(decodeFunctionResult({ abi: addrAbi, functionName: "addr", data: out }), parentAddr);
  console.log("ok: x402card.eth keeps its ETH address");
}

const supports = await pub.readContract({ address: resolver, abi: resolverAbi, functionName: "supportsInterface", args: ["0x9061b923"] });
assert.equal(supports, true);
console.log("ok: advertises ENSIP-10 (0x9061b923)");
