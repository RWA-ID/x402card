// Live sandbox check for the Issuing calls: delegate cardholder -> card with
// policy controls -> allowed charge -> disallowed-MCC charge -> transactions.
// Never prints card numbers or credentials.
import { readFileSync } from "node:fs";
import { AirwallexClient, AirwallexError, newRequestId } from "../src/airwallex/client.ts";
import { createCard, createDelegateCardholder, getCard, listTransactions } from "../src/airwallex/issuing.ts";
import { AirwallexSandboxSimulator } from "../src/airwallex/simulator.ts";
import { parseRecords } from "../src/policy/records.ts";
import { toAuthorizationControls } from "../src/policy/engine.ts";

function loadDevVars(): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return {};
  }
}

const vars = { ...loadDevVars(), ...process.env };
const awx = new AirwallexClient({ clientId: vars.AWX_CLIENT_ID!, apiKey: vars.AWX_API_KEY! });
const sim = new AirwallexSandboxSimulator(awx);

const policy = parseRecords({
  "card.limit.tx": "100",
  "card.limit.monthly": "1000",
  "card.currencies": "USD",
  "card.mcc.allow": "5734,7372", // software stores, computer services
  "card.status": "active",
  "card.approver": "x402card.eth",
});

try {
  const holder = await createDelegateCardholder(awx, `smoke+${Date.now()}@x402card.dev`);
  console.log(`cardholder ${holder.cardholder_id} ${holder.type} ${holder.status}`);

  const card = await createCard(awx, {
    cardholderId: holder.cardholder_id,
    nickName: "smoke.x402card.eth",
    createdBy: "x402card",
    controls: toAuthorizationControls(policy),
    requestId: newRequestId(),
  });
  console.log(`card ${card.card_id} ${card.card_status}`);

  // Virtual cards go PENDING -> ACTIVE on their own; wait briefly.
  let status = card.card_status;
  for (let i = 0; i < 10 && status !== "ACTIVE"; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    status = (await getCard(awx, card.card_id)).card_status;
  }
  console.log(`card status now ${status}`);

  const ok = await sim.charge({ cardId: card.card_id, amount: 25, currency: "USD", mcc: "5734" });
  console.log(`allowed charge: ${ok.type}/${ok.subtype} ${ok.process_result} ${ok.failure_reason ?? ""}`);

  const bad = await sim.charge({ cardId: card.card_id, amount: 25, currency: "USD", mcc: "7995" });
  console.log(`disallowed charge: ${bad.type}/${bad.subtype} ${bad.process_result} ${bad.failure_reason ?? ""}`);

  await new Promise((r) => setTimeout(r, 2000));
  const txs = await listTransactions(awx, card.card_id);
  console.log(`\ntransactions (${txs.items.length}):`);
  for (const t of txs.items) {
    console.log(`  ${t.transaction_type.padEnd(13)} ${t.status.padEnd(9)} ${t.transaction_amount} ${t.transaction_currency} mcc=${t.merchant?.category_code ?? "?"} ${t.failure_reason ?? ""}`);
  }
} catch (e) {
  if (e instanceof AirwallexError) {
    console.error(`FAILED: ${e.message}`);
    console.error(JSON.stringify(e.body, null, 2));
    process.exit(1);
  }
  throw e;
}
