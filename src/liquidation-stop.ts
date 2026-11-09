/** Pure price calculation; no config, wallet, SDK or network imports. */
export function liquidationStopPrice(signedSize: number, liquidationPx: number | null, bufferBps: number): number | null {
  if (!Number.isFinite(signedSize) || signedSize === 0 || liquidationPx === null ||
      !Number.isFinite(liquidationPx) || liquidationPx <= 0 ||
      !Number.isFinite(bufferBps) || bufferBps <= 0 || bufferBps >= 10_000) return null;

  const buffer = bufferBps / 10_000;
  // Long exits on a falling price ABOVE liquidation; short on a rising price BELOW it.
  const stopPx = signedSize > 0 ? liquidationPx * (1 + buffer) : liquidationPx * (1 - buffer);
  if (!Number.isFinite(stopPx) || stopPx <= 0) return null;
  // Reject a buffer too small to produce a distinct floating-point price.
  return (signedSize > 0 ? stopPx > liquidationPx : stopPx < liquidationPx) ? stopPx : null;
}
