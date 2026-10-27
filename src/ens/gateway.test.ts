import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionResult, encodeFunctionData, namehash, parseAbi } from "viem";
import { answer, cardKeyOf, nameOfKey } from "./gateway.ts";

const ABI = parseAbi(["function text(bytes32 node, string key) view returns (string)", "function addr(bytes32 node) view returns (address)"]);
const SAFE = "0x5A578eDdD28Bac066464BB2462ff052a65103602";
const source = { getRecords: async (k: string) => ({ "card.status": k }) };

const text = async (name: string) =>
  decodeFunctionResult({ abi: ABI, functionName: "text", data: await answer(name, encodeFunctionData({ abi: ABI, functionName: "text", args: [namehash(name), "card.status"] }), source) });

test("card keys", () => {
  assert.equal(cardKeyOf("researcher.x402card.eth"), "researcher");
  assert.equal(cardKeyOf("Researcher.XCard.eth"), "researcher.xcard.eth");
  assert.equal(cardKeyOf("xcard.eth"), "");
  assert.equal(cardKeyOf("x402card.eth"), "");
  assert.equal(cardKeyOf("a.b.xcard.eth"), null);
  assert.equal(cardKeyOf("researcher.notxcard.eth"), null);
  assert.equal(nameOfKey("researcher"), "researcher.x402card.eth");
  assert.equal(nameOfKey("researcher.xcard.eth"), "researcher.xcard.eth");
});

test("gateway answers both namespaces from their own records", async () => {
  assert.equal(await text("scout.x402card.eth"), "scout");
  assert.equal(await text("scout.xcard.eth"), "scout.xcard.eth");
  assert.equal(await text("scout.other.eth"), "");
  for (const parent of ["x402card.eth", "xcard.eth"]) {
    const data = await answer(parent, encodeFunctionData({ abi: ABI, functionName: "addr", args: [namehash(parent)] }), source, { parentAddr: SAFE });
    assert.equal(decodeFunctionResult({ abi: ABI, functionName: "addr", data }), SAFE);
  }
});

test("shop.xcard.eth lists the gateway's own origin as its payee origin", async () => {
  const origins = async (name: string, selfOrigin?: string) =>
    decodeFunctionResult({
      abi: ABI,
      functionName: "text",
      data: await answer(name, encodeFunctionData({ abi: ABI, functionName: "text", args: [namehash(name), "org.x402.origins"] }), source, { selfOrigin }),
    });
  assert.equal(await origins("shop.xcard.eth", "https://x402card.dmpay.workers.dev"), "https://x402card.dmpay.workers.dev");
  assert.equal(await origins("Shop.XCard.eth", "https://x402card.dmpay.workers.dev"), "https://x402card.dmpay.workers.dev");
  assert.equal(await origins("shop.xcard.eth"), "", "no origin known: no record");
  assert.equal(await origins("shop.x402card.eth", "https://x402card.dmpay.workers.dev"), "", "only the xcard.eth name");
});
