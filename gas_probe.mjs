import { ethers } from "ethers";
import { config } from "./src/config.ts";
const rpc = new ethers.providers.JsonRpcProvider(config.rpcUrl);
const f = await rpc.getFeeData();
console.log("baseFee", ethers.utils.formatUnits(f.lastBaseFeePerGas ?? 0, "gwei"), "gwei");
console.log("maxFee", ethers.utils.formatUnits(f.maxFeePerGas ?? 0, "gwei"), "gwei");
// cost of one post-only order at gasLimit 350k
const gwei = Number(ethers.utils.formatUnits(f.lastBaseFeePerGas ?? 0, "gwei"));
const monPerOrder = 350000 * gwei * 1e-9;
console.log("MON per order (350k gas):", monPerOrder.toFixed(6));
