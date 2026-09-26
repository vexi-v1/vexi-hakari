// Who else settles on a v4 pool's price on Robinhood Chain 4663 today, and what the bound says for each. Read-only:
// logs, eth_call and eth_getCode on the public RPC, the lens injected by state override (lens.ts). Writes
// data/consumers.json.
//
// Two third-party consumers are surveyed from their own contracts:
//   Morpho Blue (0x9D53…1010): every CreateMarket log, then each market's oracle bytecode classified by the selectors it
//     carries (Chainlink latestRoundData, Uniswap v3 observe, the v4 PoolManager address + extsload), and market() for
//     supply and borrow. An oracle that carries the PoolManager address and extsload reads the pool's own storage: slot0.
//   Panoptic V2 (factories at the same addresses as on Ethereum): every PoolDeployed log from the v3 and v4 factories,
//     each pool's collateral trackers, its risk engine's parameters (the xStocks engine is a parameter-only fork with
//     MAX_TICKS_DELTA 953 and doubled EMA periods), and the live oracle ticks.
// Then the bound, CostModel.maxSafeExposure with nobody pushing back, from PushCostLens.roundTripCosts at one block, for
// every v4 pool one of them reads, next to what that consumer has riding on the price.
import { decodeFunctionResult, encodeFunctionData, formatUnits, parseAbi, parseAbiItem, toFunctionSelector, type Hex } from "viem";
import { erc20Abi, lensAbi, poolManagerEvents, stateViewAbi } from "./abi.ts";
import { mainnet, POOL_MANAGER, run, sleep, STATE_VIEW, withRetry, writeData } from "./chain.ts";
import { LENS_OVERRIDE_ADDRESS, lensRuntimeCode } from "./lens.ts";
import { USDG } from "./pools.ts";
import { LADDER, MAX_WALK_STEPS, maxSafeFromQuotes, mintWindowClosed, priceInQuote } from "../../web/live/core.js";

export const MORPHO = "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010" as const;
export const PANOPTIC_FACTORY_V4 = "0x0000000000000c51d0f8cf4bd9adE7191372a625" as const;
export const PANOPTIC_FACTORY_V3 = "0x0000000000000aDC9A108591e718F2aee963a2a7" as const;
/** Panoptic's first pool on 4663 (2026-09-14); logs are read from here. */
const PANOPTIC_FROM_BLOCK = 62_901_925n;

const morphoAbi = parseAbi([
  "struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }",
  "event CreateMarket(bytes32 indexed id, MarketParams marketParams)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
]);
const oracleAbi = parseAbi(["function price() view returns (uint256)"]);
const panopticV4Deployed = parseAbiItem("event PoolDeployed(address indexed poolAddress, bytes32 indexed idV4, address collateralTracker0, address collateralTracker1, address riskEngine)");
const panopticV3Deployed = parseAbiItem("event PoolDeployed(address indexed poolAddress, address indexed uniswapPool, address collateralTracker0, address collateralTracker1, address riskEngine)");
const panopticAbi = parseAbi([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function getCurrentTick() view returns (int24)",
  "function getTWAP() view returns (int24)",
  "function isSafeMode() view returns (uint8)",
  "function MAX_TICKS_DELTA() view returns (int256)",
  "function MAX_TWAP_DELTA_DISPATCH() view returns (uint16)",
  "function MAX_CLAMP_DELTA() view returns (int24)",
  "function EMA_PERIODS() view returns (uint96)",
  "function SELLER_COLLATERAL_RATIO() view returns (uint256)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
]);

/** What an oracle's runtime code carries. A selector appears as PUSH4 data before a comparison; an address as PUSH20. */
const MARKS: Record<string, string> = {
  poolManager: POOL_MANAGER.slice(2).toLowerCase(),
  extsload: toFunctionSelector("function extsload(bytes32)").slice(2),
  observe: toFunctionSelector("function observe(uint32[])").slice(2),
  slot0: toFunctionSelector("function slot0()").slice(2),
  latestRoundData: toFunctionSelector("function latestRoundData()").slice(2),
  latestAnswer: toFunctionSelector("function latestAnswer()").slice(2),
  convertToAssets: toFunctionSelector("function convertToAssets(uint256)").slice(2),
  uiMultiplier: toFunctionSelector("function uiMultiplier()").slice(2),
};
export type OracleKind = "uniswap-v4-spot" | "uniswap-v3-twap" | "uniswap-v3-twap+chainlink" | "chainlink" | "no-known-selector";
export function classify(marks: string[]): OracleKind {
  const v4 = marks.includes("poolManager") && marks.includes("extsload");
  const v3 = marks.includes("observe");
  const link = marks.includes("latestRoundData") || marks.includes("latestAnswer");
  if (v4) return "uniswap-v4-spot";
  if (v3) return link ? "uniswap-v3-twap+chainlink" : "uniswap-v3-twap";
  if (link) return "chainlink";
  return "no-known-selector";
}
export function marksIn(code: string): string[] {
  const c = code.toLowerCase();
  return Object.entries(MARKS).filter(([, v]) => c.includes(v)).map(([k]) => k);
}

/** Longbow's 55 market ids, as the DefiLlama Longbow adapter lists them (secondary; the ids are checked against the chain). */
const LONGBOW_ADAPTER = "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/longbow/index.js";
const LONGBOW_MARKETS = new Set([
  "0x7c820d6a09502d63be80bb8025ec479d29d7c06e70f8df65a92aaeed23a366e2", "0x66306c087add8907752320b309934abcc354d21626de8115c79df49d9c214edc",
  "0x8b2af4d69ad861a4099b995b6279aeaf6a905225a0ee889bce424c7faf19b7d9", "0x4edbd2f2f3b33bc5f80ab588def67fab8c10945fc99f855d80ff4bef2c4aa1f0",
  "0x7e6ebfdc58a893a5cddba0fba0483baf4fac2efece627ad50821dbe27d6f9738", "0x30a2a5f1a098b23ed91eadc4529a8d1c967f2cdc2e40a709f3a5992004b01ac0",
  "0x14973a168cf6c6b1148309f5d567c255b292863ffe9cca59f4284e1426636f00", "0xf049167e6bf18a1b41b8e2acefcf7bc9b13ea013d8d65c7fbc7cbaeb3fe9b4e2",
  "0x8114b65dfc5e64222103e5588de261eca9defd25f47ea4ae2f91d49fe4fa2993", "0x96d3d5f9bc842e4c8a935c5628abd02fb0e10115560c35a9add768781434f471",
  "0x1b3555f7c1273688f01ae82da7dc8e508e6a7841ec0038dbb15767154a277b86", "0x039503b6308d6d818d181e626d3fbc667d6e68393c3d74332a6124cd2dd6e755",
  "0x597227ca652ea5e8afb6e4801ecd766a4d6eb9b3b9fafa9127ba88a8b1f19629", "0x50bc39b5722fb5634c436d74c6787f3c125b879e7b73cf9e9ecc01bbb57b8e55",
  "0x315b99abb698487891243a84afd28a5ff56fe02143f203c03edd3f103936bf60", "0x4979137c23c8fb519cd507adc290944c3c2120e8a3191547531fced28360e9c2",
  "0x6b8a1f62d88d1cd1e8de609aef07cafc8226172ba703e57c52c3730350e61df1", "0xafc86936af4f7edf083eb2550b8c42311b83c685982742b9271b309a58268855",
  "0xf6f3dbe0a19e948147e79e66502c6b05709d8dfde977fec7db1528fc8f0ebdfa", "0x2ab6a14c9f68d4216dcb3b4e6ed607cf82f2e6badfa2bd5618d7f69d012d7fab",
  "0xb41b34c5989420ad080e79363a9cfe3e23bec7459fcd2d88029250da370288df", "0x69400cfe81f2ae381b9a9f27076a4d637338379d999e9ffdfbde52f0876312ee",
  "0x4d2075836fd32183b10e5be1b383f6430de859df6d2bd5ec5b859970c4dd14e8", "0x9df4f54a2e46b35bd326cec97dbabc4203fa6c64a8e4182128f277adba8fefaf",
  "0xb5ba72c0d55c353fa37c0bea104eb117afb2f4934473bcb736d2218ae5686746", "0xda5584635e8b14ea18f674dbe4243365505910fefd8e3aa1ac9bfaac0eba74e8",
  "0x74fece475178af9e06d31fb64f405046a305f8f0abc588782f596d6f261c1fbb", "0xee04847a312224d551d2267bb5c2c2695777af5fd1f05347bdcca397e8f54336",
  "0x508b47fb12dbb8747644d4436aae65489b5f2819936adefc8a591323f64a5b01", "0x243ac165f79a75a0590d2e994ffa9e260b70292fd1ca134ace95f3640895b19f",
  "0x01baec96478004fc7b74c8dfe38abef8d716fea59ffd481b6ec74db915d3bc80", "0xf0959f62e748938cf260ca6fe7cb21a412e0a6643913460f4a6770c3f4b90af6",
  "0xbe881499e682850931951c998e76cfbf38c7979b1beeae7cbbb97a39b3336a07", "0xdd578ca54b4ef6a7827c6e9fc06905699a577f6e2f00712853d8aab13383bc38",
  "0xd8b502d5c43f6e5cfff7f938c7ef18e684f114fb5b362611981144397e5d5aef", "0x003390b057d753bd839981a0d45f9a567aa0b0ed6373fd42e951eac8ee86c2ba",
  "0xc6e16cff2bcf185639562ab937b7a1c381522768ff16aefc85a25ff6ab1c45ea", "0x071fb8a90e74f8b3ff3f517f581db96875f3b609a4f0f42efa5c158da9f4b0be",
  "0xaba3ac501ce4c6b80c08ed0dba19e1ac0de495f17af3ed692a38e92d176a6c9e", "0x6e6762ae397a2b3f2500ea2f48f8adce0eadfbf54cbc37f6108602e907e844ad",
  "0x378713071c58206c6a826287d0051bcae113d83d6e3d3b6370b7e73128d06162", "0x6c12c02536aa27831f713d658b59f74e149cc62b48528cb74455e79fab32f772",
  "0x298e8ff9b31f22be90507bc61b55e66ab93e78b55a60593035e309ed93137cb8", "0xb33399a677e1a21152fa9969f02c57a7a342e692ec45608a3fa0d3d92519c343",
  "0x3be7fe1b6b439cfeb737d9921e9b83c92095a23a4f50aeee0d6d04f44446170f", "0x0066bc47b87597993af0bca6f526175c0abae011b764d4bf12a3def45e1f4e78",
  "0x43c51f6ff44ab406ab9c97cb5512c881f4a7498209f94bbcfd874d8f97fad79d", "0xe6284cf12d0603aee18ff5ab412e262cf99f120e967579111d7a51f37f276f54",
  "0xe8d9b45cdbedc4401a3145be7726c9f72b715e03c5399c961439f11636ee9fb6", "0x46eea143d473cdb8587505f8886dad452037f285f7729a7763e8c233c63b2e8e",
  "0x8338aed363a309039b2f271a83558831e7e445f2d13c6e72c576ec0b8a969415", "0xf47c7a7a1ff6c7444e6fcfa20a71f439e4525f4f9640fe6ba5c080f6f2a9d33f",
  "0xaa586d26a6fe62d9c0f0948fede6e2130500ac7a655587447e2d4a37e6330589", "0x4e92b336ecad6c842be20ae2ae27b28b3cf5ced6c5388a808167c03a8d75fdf8",
  "0x141c2b1d2bbecf7f8a76563307d7e5bf586457e873c3d97c4bb1502e57b77952",
]);

const PAUSE = 60;
const tokenInfo = new Map<string, { symbol: string; decimals: number }>();
async function token(client: any, address: Hex) {
  const a = address.toLowerCase();
  if (!tokenInfo.has(a)) {
    const [symbol, decimals] = await Promise.all([
      withRetry(`${a} symbol`, () => client.readContract({ address, abi: erc20Abi, functionName: "symbol" })).catch(() => a.slice(0, 10)),
      withRetry(`${a} decimals`, () => client.readContract({ address, abi: erc20Abi, functionName: "decimals" })),
    ]);
    tokenInfo.set(a, { symbol: symbol as string, decimals: Number(decimals) });
    await sleep(PAUSE);
  }
  return tokenInfo.get(a)!;
}

/** PUSH32 constants in runtime code: an immutable pool id shows up as one (a v4 key is hashed, so the id is all an oracle needs). */
function push32s(code: string): Hex[] {
  return [...code.toLowerCase().matchAll(/7f([0-9a-f]{64})/g)].map((m) => `0x${m[1]}` as Hex);
}

export async function main() {
  const client = mainnet();
  const head = await client.getBlock();
  const block = head.number;
  const at = new Date(Number(head.timestamp) * 1000);
  console.log("block", block.toString(), at.toISOString(), "mint window", mintWindowClosed(at) ? "closed" : "open");

  // ── Morpho Blue ──
  const created = await withRetry("CreateMarket", () => client.getLogs({ address: MORPHO, event: morphoAbi.find((i: any) => i.type === "event" && i.name === "CreateMarket") as any, fromBlock: 0n, toBlock: block }));
  const markets = created.map((l: any) => ({ id: l.args.id as Hex, createdBlock: l.blockNumber as bigint, ...(l.args.marketParams as any) })) as Array<{ id: Hex; createdBlock: bigint; loanToken: Hex; collateralToken: Hex; oracle: Hex; irm: Hex; lltv: bigint }>;
  console.log("Morpho markets", markets.length);
  const oracleMarks = new Map<string, { codeBytes: number; marks: string[]; kind: OracleKind; push32: Hex[] }>();
  for (const o of new Set(markets.map((m) => m.oracle.toLowerCase()))) {
    const code = (await withRetry(`code ${o}`, () => client.getCode({ address: o as Hex, blockNumber: block }))) ?? "0x";
    const marks = marksIn(code);
    oracleMarks.set(o, { codeBytes: (code.length - 2) / 2, marks, kind: classify(marks), push32: push32s(code) });
    await sleep(PAUSE);
  }
  const byKind: Record<string, number> = {};
  for (const m of markets) byKind[oracleMarks.get(m.oracle.toLowerCase())!.kind] = (byKind[oracleMarks.get(m.oracle.toLowerCase())!.kind] ?? 0) + 1;
  console.log("oracles", oracleMarks.size, byKind);
  const state = new Map<string, { supply: bigint; borrow: bigint }>();
  for (const m of markets) {
    const [supply, , borrow] = await withRetry(`market ${m.id}`, () => client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "market", args: [m.id], blockNumber: block }));
    state.set(m.id, { supply, borrow });
    await sleep(PAUSE);
  }
  const usdg = await token(client, USDG);
  const usdgByKind: Record<string, { markets: number; supplyUsdg: number; borrowUsdg: number }> = {};
  for (const m of markets) {
    if (m.loanToken.toLowerCase() !== USDG) continue;
    const k = oracleMarks.get(m.oracle.toLowerCase())!.kind;
    const s = state.get(m.id)!;
    const row = (usdgByKind[k] ??= { markets: 0, supplyUsdg: 0, borrowUsdg: 0 });
    row.markets++;
    row.supplyUsdg += Number(formatUnits(s.supply, usdg.decimals));
    row.borrowUsdg += Number(formatUnits(s.borrow, usdg.decimals));
  }
  const uniswapMarkets = [] as any[];
  for (const m of markets) {
    const o = oracleMarks.get(m.oracle.toLowerCase())!;
    if (!o.kind.startsWith("uniswap")) continue;
    const loan = await token(client, m.loanToken);
    const coll = await token(client, m.collateralToken);
    const s = state.get(m.id)!;
    const raw = await withRetry(`price ${m.oracle}`, () => client.readContract({ address: m.oracle, abi: oracleAbi, functionName: "price", blockNumber: block })).catch(() => null);
    const createdAt = await withRetry(`block ${m.createdBlock}`, () => client.getBlock({ blockNumber: m.createdBlock }));
    uniswapMarkets.push({
      id: m.id, createdBlock: m.createdBlock.toString(), createdAt: new Date(Number(createdAt.timestamp) * 1000).toISOString(),
      collateral: coll.symbol, collateralToken: m.collateralToken, loan: loan.symbol, loanToken: m.loanToken, oracle: m.oracle, oracleKind: o.kind,
      oracleMarks: o.marks, oracleCodeBytes: o.codeBytes, lltv: Number(formatUnits(m.lltv, 18)),
      supply: Number(formatUnits(s.supply, loan.decimals)), borrow: Number(formatUnits(s.borrow, loan.decimals)),
      // Morpho: price of 1 collateral in loan, scaled by 1e36 * 10^(loanDec - collDec)
      price: raw == null ? null : Number(raw) / 10 ** (36 + loan.decimals - coll.decimals),
      longbowListed: LONGBOW_MARKETS.has(m.id.toLowerCase()),
      // a pool id is used more than once in the code and the regex also catches windows inside other data: dedupe, then resolve
      poolIdCandidates: o.kind === "uniswap-v4-spot" ? [...new Set(o.push32.filter((c) => !/^0x0{24}/.test(c)))] : [],
    });
    await sleep(PAUSE);
  }
  const longbow = markets.filter((m) => LONGBOW_MARKETS.has(m.id.toLowerCase()));
  const longbowKinds: Record<string, number> = {};
  for (const m of longbow) { const k = oracleMarks.get(m.oracle.toLowerCase())!.kind; longbowKinds[k] = (longbowKinds[k] ?? 0) + 1; }
  const longbowUsdg = longbow.filter((m) => m.loanToken.toLowerCase() === USDG).reduce((a, m) => { const s = state.get(m.id)!; a.supply += Number(formatUnits(s.supply, usdg.decimals)); a.borrow += Number(formatUnits(s.borrow, usdg.decimals)); return a; }, { supply: 0, borrow: 0 });

  // ── Panoptic V2 ──
  const v4Logs = await withRetry("Panoptic v4 PoolDeployed", () => client.getLogs({ address: PANOPTIC_FACTORY_V4, event: panopticV4Deployed, fromBlock: PANOPTIC_FROM_BLOCK, toBlock: block }));
  const v3Logs = await withRetry("Panoptic v3 PoolDeployed", () => client.getLogs({ address: PANOPTIC_FACTORY_V3, event: panopticV3Deployed, fromBlock: PANOPTIC_FROM_BLOCK, toBlock: block }));
  const engines = new Map<string, any>();
  async function engine(address: Hex) {
    const a = address.toLowerCase();
    if (!engines.has(a)) {
      const rd = (fn: any) => withRetry(`${a} ${fn}`, () => client.readContract({ address, abi: panopticAbi, functionName: fn, blockNumber: block }));
      const [maxTicksDelta, maxTwapDeltaDispatch, maxClampDelta, emaPeriods, sellerRatio] = await Promise.all([rd("MAX_TICKS_DELTA"), rd("MAX_TWAP_DELTA_DISPATCH"), rd("MAX_CLAMP_DELTA"), rd("EMA_PERIODS"), rd("SELLER_COLLATERAL_RATIO")]);
      const p = BigInt(emaPeriods as bigint);
      const periods = [0n, 24n, 48n, 72n].map((s) => Number((p >> s) & 0xffffffn));
      engines.set(a, {
        address, maxTicksDelta: Number(maxTicksDelta), maxTwapDeltaDispatch: Number(maxTwapDeltaDispatch), maxClampDelta: Number(maxClampDelta),
        emaPeriodsSeconds: periods, sellerCollateralRatio: Number(sellerRatio) / 1e6,
        // RiskEngineXStocks.sol: "PARAMETER-ONLY FORK of RiskEngine.sol with more conservative ('xstocks') risk": 953 and 120/240/480/1920 s vs 724 and 60/120/240/960 s
        profile: Number(maxTicksDelta) === 953 && periods[0] === 120 ? "xstocks" : Number(maxTicksDelta) === 724 && periods[0] === 60 ? "default" : "unknown",
      });
      await sleep(PAUSE);
    }
    return engines.get(a);
  }
  const panopticPools = [] as any[];
  async function trackers(ct0: Hex, ct1: Hex) {
    const out = [] as any[];
    for (const ct of [ct0, ct1]) {
      const asset = await withRetry(`${ct} asset`, () => client.readContract({ address: ct, abi: panopticAbi, functionName: "asset", blockNumber: block }));
      const total = await withRetry(`${ct} totalAssets`, () => client.readContract({ address: ct, abi: panopticAbi, functionName: "totalAssets", blockNumber: block }));
      const t = await token(client, asset as Hex);
      out.push({ tracker: ct, asset, symbol: t.symbol, totalAssets: Number(formatUnits(total as bigint, t.decimals)) });
    }
    return out;
  }
  for (const l of v4Logs as any[]) {
    const pool = l.args.poolAddress as Hex;
    const id = l.args.idV4 as Hex;
    const [init] = await withRetry(`Initialize ${id}`, () => client.getLogs({ address: POOL_MANAGER, event: poolManagerEvents.Initialize, args: { id }, fromBlock: 0n, toBlock: block }));
    const key = { currency0: (init as any).args.currency0 as Hex, currency1: (init as any).args.currency1 as Hex, fee: Number((init as any).args.fee), tickSpacing: Number((init as any).args.tickSpacing), hooks: (init as any).args.hooks as Hex };
    const t0 = await token(client, key.currency0); const t1 = await token(client, key.currency1);
    const deployed = await withRetry(`block ${l.blockNumber}`, () => client.getBlock({ blockNumber: l.blockNumber }));
    const rd = (fn: any) => withRetry(`${pool} ${fn}`, () => client.readContract({ address: pool, abi: panopticAbi, functionName: fn, blockNumber: block }));
    const [currentTick, twapTick, safeMode] = await Promise.all([rd("getCurrentTick"), rd("getTWAP"), rd("isSafeMode")]);
    panopticPools.push({
      uniswap: "v4", panopticPool: pool, poolId: id, key, pair: `${t0.symbol}/${t1.symbol}`, deployedBlock: l.blockNumber.toString(), deployedAt: new Date(Number(deployed.timestamp) * 1000).toISOString(), deployTx: l.transactionHash,
      riskEngine: await engine(l.args.riskEngine as Hex), collateral: await trackers(l.args.collateralTracker0, l.args.collateralTracker1),
      oracle: { currentTick: Number(currentTick), twapTick: Number(twapTick), safeMode: Number(safeMode) },
    });
  }
  for (const l of v3Logs as any[]) {
    const uni = l.args.uniswapPool as Hex;
    const rd = (fn: any) => withRetry(`${uni} ${fn}`, () => client.readContract({ address: uni, abi: panopticAbi, functionName: fn, blockNumber: block }));
    const [a0, a1, fee] = await Promise.all([rd("token0"), rd("token1"), rd("fee")]);
    const t0 = await token(client, a0 as Hex); const t1 = await token(client, a1 as Hex);
    const deployed = await withRetry(`block ${l.blockNumber}`, () => client.getBlock({ blockNumber: l.blockNumber }));
    panopticPools.push({
      uniswap: "v3", panopticPool: l.args.poolAddress, uniswapPool: uni, pair: `${t0.symbol}/${t1.symbol}`, fee: Number(fee), deployedBlock: l.blockNumber.toString(), deployedAt: new Date(Number(deployed.timestamp) * 1000).toISOString(), deployTx: l.transactionHash,
      riskEngine: await engine(l.args.riskEngine as Hex), collateral: await trackers(l.args.collateralTracker0, l.args.collateralTracker1),
    });
  }

  // ── the bound for every v4 pool a consumer reads ──
  const code = await lensRuntimeCode(client);
  async function bound(key: any, quoteIsCurrency0: boolean, dec0: number, dec1: number) {
    const id = (await withRetry("id", async () => key.id)) as Hex;
    const [sqrtPriceX96, tick, protocolFee, lpFee] = await withRetry(`${id} slot0`, () => client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [id], blockNumber: block }));
    const liquidity = await withRetry(`${id} liquidity`, () => client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getLiquidity", args: [id], blockNumber: block }));
    const walk = async (up: boolean) => {
      const data = encodeFunctionData({ abi: lensAbi, functionName: "roundTripCosts", args: [key.key, LADDER, up, BigInt(MAX_WALK_STEPS)] });
      const { data: out } = await withRetry(`${id} roundTripCosts ${up}`, () => client.call({ to: LENS_OVERRIDE_ADDRESS, data, blockNumber: block, stateOverride: [{ address: LENS_OVERRIDE_ADDRESS, code }] }));
      return decodeFunctionResult({ abi: lensAbi, functionName: "roundTripCosts", data: out! }) as any;
    };
    const [up, down] = [await walk(true), await walk(false)];
    const b = maxSafeFromQuotes(up, down, LADDER, quoteIsCurrency0);
    const quoteDec = quoteIsCurrency0 ? dec0 : dec1;
    return {
      priceUsdg: priceInQuote(sqrtPriceX96, dec0, dec1, quoteIsCurrency0), tick: Number(tick), lpFee: Number(lpFee), protocolFee: Number(protocolFee), liquidity: liquidity.toString(),
      maxSafeExposureUsdg: b.exposure / 10 ** quoteDec, complete: b.rungs.every((r: any) => r.complete),
      binding: { ticks: b.binding.ticks, assetUp: b.binding.assetUp, roundTripCostUsdg: Number(b.binding.cost) / 10 ** quoteDec, complete: b.binding.complete },
      rungs: b.rungs.map((r: any) => ({ ticks: r.ticks, assetUp: r.assetUp, roundTripCostUsdg: Number(r.cost) / 10 ** quoteDec, exposureUsdg: r.exposure / 10 ** quoteDec, complete: r.complete })),
    };
  }
  const bounds = [] as any[];
  for (const p of panopticPools.filter((p) => p.uniswap === "v4")) {
    const quoteIsCurrency0 = p.key.currency0.toLowerCase() === USDG;
    const t0 = tokenInfo.get(p.key.currency0.toLowerCase())!; const t1 = tokenInfo.get(p.key.currency1.toLowerCase())!;
    const b = await bound({ id: p.poolId, key: p.key }, quoteIsCurrency0, t0.decimals, t1.decimals);
    const stock = p.collateral.find((c: any) => c.symbol !== "USDG"); const cash = p.collateral.find((c: any) => c.symbol === "USDG");
    const exposureUsdg = (stock?.totalAssets ?? 0) * b.priceUsdg + (cash?.totalAssets ?? 0);
    bounds.push({ consumer: "Panoptic V2", reads: "the pool's current tick (extsload) into an 8-slot median ring and four EMAs; liquidations use twapEMA", pool: p.pair, poolId: p.poolId, key: p.key, quoteIsCurrency0, hooked: p.key.hooks !== "0x0000000000000000000000000000000000000000", ...b, exposureUsdg, exposureNote: "collateral on deposit in its two trackers, the stock side valued at the pool's price: the most a mispriced liquidation could move", ratio: exposureUsdg / b.maxSafeExposureUsdg, stockToken: stock?.symbol ?? null });
  }
  for (const m of uniswapMarkets.filter((m) => m.oracleKind === "uniswap-v4-spot")) {
    for (const id of m.poolIdCandidates) {
      const [init] = await withRetry(`Initialize ${id}`, () => client.getLogs({ address: POOL_MANAGER, event: poolManagerEvents.Initialize, args: { id }, fromBlock: 0n, toBlock: block }));
      if (!init) continue;
      m.poolIdCandidates = [id];
      const key = { currency0: (init as any).args.currency0 as Hex, currency1: (init as any).args.currency1 as Hex, fee: Number((init as any).args.fee), tickSpacing: Number((init as any).args.tickSpacing), hooks: (init as any).args.hooks as Hex };
      const t0 = await token(client, key.currency0); const t1 = await token(client, key.currency1);
      const quoteIsCurrency0 = key.currency0.toLowerCase() === USDG;
      const b = await bound({ id, key }, quoteIsCurrency0, t0.decimals, t1.decimals);
      m.poolId = id; m.poolKey = key; m.poolInitBlock = (init as any).blockNumber.toString();
      m.oracleEqualsSlot0 = m.price != null && Math.abs(m.price / b.priceUsdg - 1) < 1e-4;
      bounds.push({ consumer: `Morpho Blue market ${m.id.slice(0, 10)}…${m.longbowListed ? " (Longbow-listed)" : ""}`, reads: "the pool's slot0 through the PoolManager's extsload: the live spot price, no averaging", pool: `${t0.symbol}/${t1.symbol}`, poolId: id, key, quoteIsCurrency0, hooked: key.hooks !== "0x0000000000000000000000000000000000000000", ...b, exposureUsdg: m.supply, exposureNote: `USDG supplied to the market (${m.borrow.toFixed(2)} borrowed): the most its lenders can lose to a mispriced liquidation or an over-borrow`, ratio: m.supply / b.maxSafeExposureUsdg, oracle: m.oracle, lltv: m.lltv, oraclePriceUsdg: m.price });
    }
  }

  const out = {
    chainId: 4663, block: block.toString(), timestamp: Number(head.timestamp), at: at.toISOString(), generatedAt: new Date().toISOString(), mintWindowClosed: mintWindowClosed(at),
    method: "Morpho: CreateMarket logs from block 0; each oracle's runtime code searched for the v4 PoolManager address and the extsload, observe, slot0, latestRoundData, latestAnswer, convertToAssets and uiMultiplier selectors; market() for supply and borrow. Panoptic: PoolDeployed logs from both factories; trackers' asset() and totalAssets(); risk-engine constants; getCurrentTick / getTWAP / isSafeMode. Bound: CostModel.maxSafeExposure with nobody pushing back, from PushCostLens.roundTripCosts by eth_call state override (web/live/core.js maxSafeFromQuotes), the same call the live board makes.",
    morpho: { address: MORPHO, markets: markets.length, oracles: oracleMarks.size, marketsByOracleKind: byKind, usdgLoanMarketsByOracleKind: usdgByKind, uniswapPricedMarkets: uniswapMarkets, longbow: { source: LONGBOW_ADAPTER, listed: LONGBOW_MARKETS.size, foundOnChain: longbow.length, byOracleKind: longbowKinds, usdgSupply: longbowUsdg.supply, usdgBorrow: longbowUsdg.borrow } },
    panoptic: { factoryV4: PANOPTIC_FACTORY_V4, factoryV3: PANOPTIC_FACTORY_V3, source: "https://github.com/panoptic-labs/panoptic-v2-core (contracts/RiskEngine.sol, contracts/RiskEngineXStocks.sol, contracts/libraries/V4StateReader.sol)", pools: panopticPools },
    bounds,
  };
  writeData(new URL("../data/consumers.json", import.meta.url).pathname, out);
  console.log("Morpho USDG-loan markets by oracle kind:", usdgByKind);
  console.log("Uniswap-priced markets:", uniswapMarkets.map((m) => `${m.oracleKind} ${m.collateral}/${m.loan} supply ${m.supply} borrow ${m.borrow}${m.longbowListed ? " longbow" : ""}`));
  console.log("Panoptic pools:", panopticPools.map((p) => `${p.uniswap} ${p.pair}${p.fee ? " " + p.fee : ""} engine=${p.riskEngine.profile} collateral=${p.collateral.map((c: any) => `${c.totalAssets} ${c.symbol}`).join(" + ")}`));
  for (const b of bounds) console.log(`${b.consumer} on ${b.pool}${b.hooked ? " (hooked)" : ""}: price ${b.priceUsdg.toFixed(4)} bound ${b.maxSafeExposureUsdg.toFixed(0)} USDG (${b.binding.ticks} ticks ${b.binding.assetUp ? "up" : "down"}, ${b.complete ? "complete" : "capped"}) exposure ${b.exposureUsdg.toFixed(0)} USDG → ${b.ratio.toFixed(4)} of the line`);
  console.log("wrote data/consumers.json at block", block.toString());
}

if (import.meta.url === `file://${process.argv[1]}`) run(main);
