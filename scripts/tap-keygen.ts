// New Visa TAP signing key for the Worker. Writes the private JWK to a file
// (mode 600) and prints only the public keyid, so the key never lands in a
// terminal log. Then: npx wrangler secret put TAP_PRIVATE_KEY < <file>, and delete the file.
//   node scripts/tap-keygen.ts <out-file>
import { writeFileSync } from "node:fs";
import { generateTapKey, tapSigner } from "../src/tap/sign.ts";

const out = process.argv[2];
if (!out) {
  console.error("usage: node scripts/tap-keygen.ts <out-file>");
  process.exit(1);
}
const jwk = await generateTapKey();
writeFileSync(out, jwk, { mode: 0o600, flag: "wx" });
console.log(`wrote ${out}`);
console.log(`keyid ${(await tapSigner(jwk)).keyid}`);
