// Deploy OffchainResolver. Usage (from contracts/):
//   GATEWAY_URL=https://.../gateway/{sender}/{data}.json GATEWAY_SIGNER=0x... \
//     npx hardhat run scripts/deploy.ts --network mainnet
// Does NOT change the x402card.eth resolver; that's a separate, explicit step.
import hre from "hardhat";
import { formatEther } from "viem";

const url = process.env.GATEWAY_URL;
const signer = process.env.GATEWAY_SIGNER as `0x${string}` | undefined;
if (!url?.includes("{sender}") || !url.includes("{data}")) throw new Error("GATEWAY_URL must contain {sender} and {data}");
if (!signer || !/^0x[0-9a-fA-F]{40}$/.test(signer)) throw new Error("GATEWAY_SIGNER must be an address");

async function main() {
const [deployer] = await hre.viem.getWalletClients();
const pub = await hre.viem.getPublicClient();
console.log(`network ${hre.network.name}, deployer ${deployer.account.address}`);
console.log(`balance ${formatEther(await pub.getBalance({ address: deployer.account.address }))} ETH`);

const resolver = await hre.viem.deployContract("OffchainResolver", [url, [signer]]);
console.log(`OffchainResolver deployed at ${resolver.address}`);
console.log(`url ${await resolver.read.url()}`);
console.log(`signer allowed: ${await resolver.read.signers([signer])}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
