// Pin site/www to IPFS via Pinata (same JWT as x402-identity-hub; read from
// its .env.local rather than copied). Prints the CID for demo.x402card.eth.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const env = Object.fromEntries(
  readFileSync(new URL("../../x402-identity-hub/.env.local", import.meta.url), "utf8")
    .split("\n")
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const JWT = process.env.PINATA_JWT || env.PINATA_JWT;
if (!JWT) throw new Error("PINATA_JWT not found");

const SITE = new URL("../site/www", import.meta.url).pathname;
const files = (function walk(dir) {
  return readdirSync(dir).flatMap((e) => {
    const full = join(dir, e);
    return statSync(full).isDirectory() ? walk(full) : [{ full, rel: relative(SITE, full) }];
  });
})(SITE);

const form = new FormData();
for (const { full, rel } of files) form.append("file", new Blob([readFileSync(full)]), `x402card-demo/${rel}`);
form.append("pinataMetadata", JSON.stringify({ name: "x402card-demo" }));
form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));

console.log(`Pinning ${files.length} files: ${files.map((f) => f.rel).join(", ")}`);
const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
  method: "POST",
  headers: { Authorization: `Bearer ${JWT}` },
  body: form,
});
const data = await res.json();
if (!res.ok || !data.IpfsHash) {
  console.error(res.status, data);
  process.exit(1);
}
console.log(`CID: ${data.IpfsHash}`);
console.log(`Preview: https://ipfs.io/ipfs/${data.IpfsHash}/`);
console.log(`Set demo.x402card.eth contenthash to: ipfs://${data.IpfsHash}`);
