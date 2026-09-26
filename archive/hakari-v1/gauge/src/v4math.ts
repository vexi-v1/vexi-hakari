// A BigInt port of the pieces of Uniswap v4 math the gauge needs: TickMath.getSqrtPriceAtTick,
// SqrtPriceMath.getAmount0Delta / getAmount1Delta, and the tick walk PushCostLens.depthToMove does
// on-chain — here over a list of positions instead of the bitmap, so it can run on a reconstructed
// (historical) pool. Checked against the Solidity walk by test/v4math.test.ts.

export const Q96 = 1n << 96n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
const MAX_UINT256 = (1n << 256n) - 1n;

const MAGIC: bigint[] = [
  0xfffcb933bd6fad37aa2d162d1a594001n,
  0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n,
  0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n,
  0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
];

/** sqrt(1.0001^tick) in Q64.96, exactly as TickMath.getSqrtPriceAtTick. */
export function getSqrtPriceAtTick(tick: number): bigint {
  if (tick < MIN_TICK || tick > MAX_TICK) throw new Error(`tick out of range: ${tick}`);
  const absTick = tick < 0 ? -tick : tick;
  let price = absTick & 1 ? MAGIC[0] : 1n << 128n;
  for (let i = 1; i < MAGIC.length; i++) {
    if (absTick & (1 << i)) price = (price * MAGIC[i]) >> 128n;
  }
  if (tick > 0) price = MAX_UINT256 / price;
  // round up on the shift-down from Q128 to Q96
  return (price >> 32n) + (price % (1n << 32n) === 0n ? 0n : 1n);
}

/** Largest tick whose sqrt price is <= sqrtPriceX96 (binary search; the gauge does not need the assembly version). */
export function getTickAtSqrtPrice(sqrtPriceX96: bigint): number {
  let lo = MIN_TICK;
  let hi = MAX_TICK;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (getSqrtPriceAtTick(mid) <= sqrtPriceX96) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  return (a * b) / d;
}

export function mulDivRoundingUp(a: bigint, b: bigint, d: bigint): bigint {
  const p = a * b;
  return p / d + (p % d === 0n ? 0n : 1n);
}

/** Token0 between two sqrt prices for liquidity L. */
export function getAmount0Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  const numerator1 = liquidity << 96n;
  const numerator2 = sqrtB - sqrtA;
  if (roundUp) {
    const x = mulDivRoundingUp(numerator1, numerator2, sqrtB);
    return x / sqrtA + (x % sqrtA === 0n ? 0n : 1n);
  }
  return mulDiv(numerator1, numerator2, sqrtB) / sqrtA;
}

/** Token1 between two sqrt prices for liquidity L. */
export function getAmount1Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return roundUp ? mulDivRoundingUp(liquidity, sqrtB - sqrtA, Q96) : mulDiv(liquidity, sqrtB - sqrtA, Q96);
}

export interface Position {
  tickLower: number;
  tickUpper: number;
  liquidity: bigint; // net, > 0 for a live position
}

export interface PoolState {
  sqrtPriceX96: bigint;
  tick: number;
  /** initialized tick -> liquidityNet (crossing upward adds it) */
  ticks: Map<number, bigint>;
  /** liquidity in range at `tick` */
  liquidity: bigint;
}

/** Fold positions into per-tick liquidityNet and the active liquidity at `sqrtPriceX96`. */
export function poolStateFromPositions(positions: Position[], sqrtPriceX96: bigint): PoolState {
  const tick = getTickAtSqrtPrice(sqrtPriceX96);
  const ticks = new Map<number, bigint>();
  let liquidity = 0n;
  for (const p of positions) {
    if (p.liquidity === 0n) continue;
    ticks.set(p.tickLower, (ticks.get(p.tickLower) ?? 0n) + p.liquidity);
    ticks.set(p.tickUpper, (ticks.get(p.tickUpper) ?? 0n) - p.liquidity);
    if (p.tickLower <= tick && tick < p.tickUpper) liquidity += p.liquidity;
  }
  for (const [t, net] of ticks) if (net === 0n) ticks.delete(t);
  return { sqrtPriceX96, tick, ticks, liquidity };
}

export interface WalkResult {
  amountIn: bigint; // gross of fee
  amountOut: bigint;
  feePaid: bigint;
  complete: boolean;
  sqrtPriceReached: bigint;
}

/**
 * Move the price by `ticks` (up: buy token0 with token1; down: sell token0) and report what it takes,
 * the way PushCostLens.depthToMove does, with `swapFee` in pips (LP fee with protocol fee folded in).
 */
export function walk(state: PoolState, ticks: number, up: boolean, swapFee: number, maxSteps = 1024): WalkResult {
  if (ticks <= 0) throw new Error("ticks must be > 0");
  let targetTick = up ? state.tick + ticks : state.tick - ticks;
  if (targetTick <= MIN_TICK) targetTick = MIN_TICK + 1;
  if (targetTick >= MAX_TICK) targetTick = MAX_TICK - 1;
  const target = getSqrtPriceAtTick(targetTick);
  const sorted = [...state.ticks.keys()].sort((a, b) => a - b);
  let sqrtP = state.sqrtPriceX96;
  let liquidity = state.liquidity;
  let tick = state.tick;
  let netIn = 0n;
  let amountOut = 0n;
  let steps = 0;
  while (sqrtP !== target && steps < maxSteps) {
    // next initialized tick strictly above (up) or at/below (down); crossing the tick at `tick` going down
    // means leaving it, so the boundary is the tick itself when it is initialized.
    let next: number | undefined;
    if (up) next = sorted.find((t) => t > tick);
    else {
      for (let i = sorted.length - 1; i >= 0; i--) {
        if (sorted[i] <= tick) {
          next = sorted[i];
          break;
        }
      }
    }
    const boundary = next ?? (up ? MAX_TICK : MIN_TICK);
    const sqrtNext = getSqrtPriceAtTick(boundary);
    const sqrtStep = up ? (sqrtNext > target ? target : sqrtNext) : sqrtNext < target ? target : sqrtNext;
    if (liquidity > 0n) {
      if (up) {
        netIn += getAmount1Delta(sqrtP, sqrtStep, liquidity, true);
        amountOut += getAmount0Delta(sqrtP, sqrtStep, liquidity, false);
      } else {
        netIn += getAmount0Delta(sqrtStep, sqrtP, liquidity, true);
        amountOut += getAmount1Delta(sqrtStep, sqrtP, liquidity, false);
      }
    }
    sqrtP = sqrtStep;
    if (sqrtStep === sqrtNext && next !== undefined) {
      const net = state.ticks.get(next)!;
      liquidity += up ? net : -net;
      tick = up ? next : next - 1;
    } else if (sqrtStep === sqrtNext) {
      tick = boundary;
    } else {
      tick = getTickAtSqrtPrice(sqrtP);
    }
    steps++;
  }
  const fee = BigInt(swapFee);
  const amountIn = netIn === 0n ? 0n : mulDivRoundingUp(netIn, 1_000_000n, 1_000_000n - fee);
  return { amountIn, amountOut, feePaid: amountIn - netIn, complete: sqrtP === target, sqrtPriceReached: sqrtP };
}

/** Same as Pool.swap: fold the directional protocol fee (pips, <= 1000) into the LP fee. */
export function swapFeeFor(lpFee: number, protocolFeePacked: number, zeroForOne: boolean): number {
  const p = zeroForOne ? protocolFeePacked & 0xfff : protocolFeePacked >> 12;
  if (p === 0) return lpFee;
  const numerator = BigInt(p) * BigInt(lpFee);
  return Number(BigInt(p) + BigInt(lpFee) - numerator / 1_000_000n);
}

/** Round-trip cost in the input token: fee on the push + the sell-back's fee valued at the start price. */
export function roundTripCost(state: PoolState, ticks: number, up: boolean, swapFeeIn: number, swapFeeBack: number) {
  const w = walk(state, ticks, up, swapFeeIn);
  const backFeeOut = mulDivRoundingUp(w.amountOut, BigInt(swapFeeBack), 1_000_000n);
  const s = state.sqrtPriceX96;
  // up: input is token1, output token0: value token0 in token1 = × price
  // down: input is token0, output token1: value token1 in token0 = ÷ price
  const backFeeIn = up ? mulDiv(mulDiv(backFeeOut, s, Q96), s, Q96) : mulDiv(mulDiv(backFeeOut, Q96, s), Q96, s);
  return { ...w, cost: w.feePaid + backFeeIn };
}

/** Token1 held by a position at the current sqrt price (curve principal, no fees). */
export function amount1Of(p: Position, sqrtPriceX96: bigint): bigint {
  const lower = getSqrtPriceAtTick(p.tickLower);
  const upper = getSqrtPriceAtTick(p.tickUpper);
  if (sqrtPriceX96 <= lower) return 0n;
  if (sqrtPriceX96 >= upper) return getAmount1Delta(lower, upper, p.liquidity, false);
  return getAmount1Delta(lower, sqrtPriceX96, p.liquidity, false);
}

/** Token0 held by a position at the current sqrt price. */
export function amount0Of(p: Position, sqrtPriceX96: bigint): bigint {
  const lower = getSqrtPriceAtTick(p.tickLower);
  const upper = getSqrtPriceAtTick(p.tickUpper);
  if (sqrtPriceX96 >= upper) return 0n;
  if (sqrtPriceX96 <= lower) return getAmount0Delta(lower, upper, p.liquidity, false);
  return getAmount0Delta(sqrtPriceX96, upper, p.liquidity, false);
}
