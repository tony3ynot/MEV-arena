/**
 * Display formatting. Amounts stay BigInt until here; only `toFloat` makes a lossy Number, and only for
 * drawing the chart.
 */
import { SCALE, toBigInt, type DecimalString, type Side } from "./contract";

/** Decimal places shown per asset. */
const DISPLAY_DP: Record<string, number> = { ETH: 4, USDC: 2 };
const MINUS = "−"; // a real minus sign lines up with "+" in tables

export function displayDp(asset: string): number {
  return DISPLAY_DP[asset] ?? 4;
}

/**
 * Minimal units (1e18 per token) -> "1,234.5678". Rounds half away from zero at `dp` places.
 * `signed` adds "+" to positive values.
 */
export function formatUnits(value: bigint, dp: number, signed = false): string {
  if (dp < 0 || dp > 18) throw new Error("dp must be in [0, 18]");
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const step = 10n ** BigInt(18 - dp);
  const rounded = (abs + step / 2n) / step; // = abs * 10^dp / 1e18, rounded
  const unit = 10n ** BigInt(dp);
  const whole = (rounded / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = dp > 0 ? "." + (rounded % unit).toString().padStart(dp, "0") : "";
  const sign = rounded === 0n ? "" : negative ? MINUS : signed ? "+" : "";
  return sign + whole + fraction;
}

/** An amount of `asset`, e.g. formatAsset("1500000000000000000", "ETH") -> "1.5000". */
export function formatAsset(value: bigint | DecimalString, asset: string, signed = false): string {
  return formatUnits(typeof value === "bigint" ? value : toBigInt(value), displayDp(asset), signed);
}

/** The asset paid in and received for a side. */
export function assetsFor(side: Side, baseAsset: string, quoteAsset: string): { assetIn: string; assetOut: string } {
  return side === "sell" ? { assetIn: baseAsset, assetOut: quoteAsset } : { assetIn: quoteAsset, assetOut: baseAsset };
}

/** A SCALE fixed-point price (quote per base), shown with the quote asset's decimals. */
export function formatPrice(price: bigint | DecimalString, quoteAsset: string): string {
  return formatAsset(price, quoteAsset);
}

/** Lossy: minimal units -> a float, for chart geometry only. */
export function toFloat(value: bigint | DecimalString): number {
  const v = typeof value === "bigint" ? value : toBigInt(value);
  return Number(v) / Number(SCALE);
}

export function formatBps(bps: number | null, dp = 0): string {
  return bps === null ? "–" : `${bps.toFixed(dp)} bps`;
}

/** "a1b2c3d4…" for long ids and hashes. */
export function shortHash(hash: string, length = 8): string {
  return hash.length > length ? `${hash.slice(0, length)}…` : hash;
}

export function policyLabel(policy: string): string {
  return policy === "priority_fee" ? "priority fee" : policy;
}
