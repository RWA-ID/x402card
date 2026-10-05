// Step-3 check: log in to the Airwallex sandbox, then read balances and
// Global Accounts. Reads credentials from .dev.vars (or the environment)
// and never prints them.
import { readFileSync } from "node:fs";
import { AirwallexClient } from "../src/airwallex/client.ts";

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
const clientId = vars.AWX_CLIENT_ID;
const apiKey = vars.AWX_API_KEY;
if (!clientId || !apiKey) {
  console.error("Missing AWX_CLIENT_ID / AWX_API_KEY. Copy .dev.vars.example to .dev.vars and fill it in.");
  process.exit(1);
}

const awx = new AirwallexClient({ clientId, apiKey });

const token = await awx.login();
console.log(`login OK - token valid until ${new Date(token.expiresAt).toISOString()} (5 min safety margin applied)`);

const balances = await awx.getCurrentBalances();
console.log(`\nbalances (${balances.length} currencies):`);
for (const b of balances) {
  console.log(`  ${b.currency.padEnd(4)} available ${b.available_amount}  pending ${b.pending_amount}  total ${b.total_amount}`);
}

const gas = await awx.listGlobalAccounts();
console.log(`\nglobal accounts (${gas.items.length}):`);
for (const g of gas.items) {
  const features = (g.required_features ?? []).map((f) => `${f.currency}/${f.transfer_method}`).join(", ");
  console.log(`  ${g.id}  ${g.country_code ?? "?"}  ${g.status ?? "?"}  ${features}`);
}
