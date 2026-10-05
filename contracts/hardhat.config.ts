import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox-viem";
import * as dotenv from "dotenv";

// Deployer key and RPC are shared with the x402-identity-hub project; read
// them from there rather than keeping a second copy of the key.
dotenv.config({ path: "../../x402-identity-hub/.env.local" });

const deployer = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  networks: {
    mainnet: { url: process.env.NEXT_PUBLIC_ALCHEMY_MAINNET || "", accounts: deployer },
    sepolia: { url: process.env.NEXT_PUBLIC_ALCHEMY_SEPOLIA || "", accounts: deployer },
  },
  etherscan: { apiKey: process.env.ETHERSCAN_API_KEY },
};

export default config;
