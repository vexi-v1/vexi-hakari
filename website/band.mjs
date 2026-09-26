// SPDX-License-Identifier: MIT
// Integer arithmetic matching the public quote policy for the illustrative lab.
export const WAD = 10n ** 18n;
const ceilDiv = (a, b) => (a + b - 1n) / b;
export function calculateBand(deviationBps, expired = false, movedAnchor = false) {
  const center = 400n * WAD;
  const current = center * (10000n + BigInt(deviationBps)) / 10000n;
  const distance = current >= center ? current - center : center - current;
  const halfWidth = center * 500n / 10000n;
  const u = ceilDiv(distance * WAD, halfWidth);
  const cap = u >= WAD ? 0n : 50n * (WAD - u) / WAD;
  const bandOpen = u <= WAD && cap > 0n;
  const extraBps = bandOpen ? ceilDiv(2000n * u * u, WAD * WAD) : 0n;
  const anchor = movedAnchor ? center * 10000n / 10600n : center;
  const anchorDistance = current >= anchor ? current - anchor : anchor - current;
  const anchorValid = anchorDistance <= anchor * 500n / 10000n;
  const reason = !bandOpen ? 'OutsideBand' : expired ? 'QuoteExpired' : !anchorValid ? 'QuoteOffAnchor' : null;
  const premium = reason ? null : ceilDiv(8000000n * (10000n + extraBps), 10000n);
  return { current, u, cap, bandOpen, extraBps, anchorValid, reason, premium };
}
export function units(value, decimals = 18, places = 4) {
  let n = BigInt(value);
  const sign = n < 0n ? '−' : '';
  if (n < 0n) n = -n;
  const scale = 10n ** BigInt(decimals);
  const whole = (n / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (n % scale).toString().padStart(decimals, '0').slice(0, places).replace(/0+$/, '');
  return sign + whole + (fraction ? `.${fraction}` : '');
}
