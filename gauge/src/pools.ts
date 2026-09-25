// Pools on Robinhood Chain 4663 the gauge reports on. Keys verified against StateView.getSlot0 (non-zero
// price) on 2026-09-25; ids are keccak256(abi.encode(key)).
export interface PoolInfo {
  name: string;
  id: `0x${string}`;
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
  /** which side is the USD-ish quote; costs are reported in it */
  quoteIsCurrency0: boolean;
  decimals0: number;
  decimals1: number;
  /** stock tokens have a Robinhood mint/redeem window; memecoins do not */
  stockSymbol?: string;
}

export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
export const ZERO = "0x0000000000000000000000000000000000000000" as const;

export const POOLS: PoolInfo[] = [
  {
    name: "TSLA/USDG",
    id: "0x8517f8071ae5b831b738052f12125e8e3d6c158b78728aa44ce3b25e5104d32e",
    currency0: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
    currency1: USDG,
    fee: 3000,
    tickSpacing: 60,
    hooks: ZERO,
    quoteIsCurrency0: false,
    decimals0: 18,
    decimals1: 6,
    stockSymbol: "TSLA",
  },
  {
    name: "NVDA/USDG",
    id: "0x3bb34a44f1b2b5f32c034c38a53065a521a47b199700fa9bd19d60985ff24bf1",
    currency0: USDG,
    currency1: "0xD0601CE157dB5bdc3162bBAc2A2c8Af5320D9EEc",
    fee: 3000,
    tickSpacing: 60,
    hooks: ZERO,
    quoteIsCurrency0: true,
    decimals0: 6,
    decimals1: 18,
    stockSymbol: "NVDA",
  },
  {
    name: "HIMS/USDG",
    id: "0x68d4f28f1432e0ad714658853edb2e6b0b1ac4060355ff3d169fea656b1d1c52",
    currency0: USDG,
    currency1: "0xCCee82fE024c36Fa15E1005EdE3E9E4787E23d09",
    fee: 9000,
    tickSpacing: 90,
    hooks: ZERO,
    quoteIsCurrency0: true,
    decimals0: 6,
    decimals1: 18,
    stockSymbol: "HIMS",
  },
  {
    name: "AI/USDG (memecoin)",
    id: "0x508ab5b7a7b447598017eba58530c2a2a5d647b8074a2dc85aa533dfbed4d543",
    currency0: "0x2E8c31162b855a2fFa90F6f8634643Ad6f111e18",
    currency1: USDG,
    fee: 25000,
    tickSpacing: 500,
    hooks: ZERO,
    quoteIsCurrency0: false,
    decimals0: 18,
    decimals1: 6,
  },
];

export const HIMS_USDG = POOLS[2];

export function poolKeyOf(p: PoolInfo) {
  return { currency0: p.currency0, currency1: p.currency1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: p.hooks };
}

/** ticks for a percentage move: ln(1+x)/ln(1.0001) */
export function ticksForPct(pct: number): number {
  return Math.round(Math.log(1 + pct / 100) / Math.log(1.0001));
}
