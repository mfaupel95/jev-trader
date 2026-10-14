/**
 * Gas saver: decide whether this block should post a new order, or keep the existing resting order.
 *
 * The old behaviour posted every block (cancel + place), which on Monad's ~3.4 blocks/s costs
 * ~0.0357 MON per block = ~437 MON/h. Posting only when the market moved (or after a refresh
 * interval) keeps the resting order in between, so the gas cost drops to only-when-it-matters.
 *
 * Pure function: no I/O, no state — the caller tracks `lastPost` and passes it in.
 */
export interface PostState {
  /** Block number of the last post. 0 = never posted (first block always posts). */
  block: number;
  /** Mid price (USDC per MON) at the last post. */
  mid: number;
}

export interface PostPolicy {
  /** Post when the mid moved at least this many bps since the last post. 0 = post every block. */
  moveBps: number;
  /** Post when this many blocks have passed since the last post, even without a move. */
  refreshBlocks: number;
}

/**
 * @param last  state of the last post (block 0 = never posted)
 * @param block current block number
 * @param mid   current mid price
 * @param p     policy
 * @returns true if a new order should be posted this block
 */
export function shouldPost(last: PostState, block: number, mid: number, p: PostPolicy): boolean {
  if (last.block === 0) return true; // first block always posts
  if (p.moveBps <= 0) return true; // 0 = old behaviour, post every block
  if (block - last.block >= p.refreshBlocks) return true; // refresh interval reached
  if (last.mid <= 0) return true; // no reference price yet
  const moveBps = Math.abs((mid - last.mid) / last.mid) * 10_000;
  return moveBps >= p.moveBps;
}
