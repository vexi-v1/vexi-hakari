// Copies PushCostLens's creation bytecode + ABI from forge's artifact into web/lens-artifact.json,
// so the static web page can inject the lens with an eth_call state override in the browser.
import { readFileSync } from "node:fs";
import { writeData } from "./chain.ts";

const artifact = JSON.parse(readFileSync(new URL("../../out/PushCostLens.sol/PushCostLens.json", import.meta.url), "utf8"));
// roundTripCosts: the view walk CostModel.maxSafeExposure prices the ladder with; the page's live bound uses it too
const abi = artifact.abi.filter((f: any) => ["quotePush", "quotePushToPrice", "quotePushLadder", "depthToMove", "roundTripCost", "roundTripCosts"].includes(f.name));
writeData(new URL("../../web/lens-artifact.json", import.meta.url).pathname, {
  contract: "PushCostLens",
  creationBytecode: artifact.bytecode.object,
  abi,
  solc: artifact.metadata?.compiler?.version ?? null,
  exportedAt: new Date().toISOString(),
});
console.log("wrote web/lens-artifact.json", artifact.bytecode.object.length / 2 - 1, "bytes of creation code");
