// Test the gas-saver post policy: shouldPost decides whether to post a new order or keep the
// existing resting one. Pure function, no I/O. Run: bun run scripts/test-postpolicy.ts
import { shouldPost } from "../src/postpolicy";

let failed = 0;
const check = (label: string, ok: boolean) => { console.log(`${ok ? "ok  " : "FAIL"} ${label}`); if (!ok) failed = 1; };

const P = { moveBps: 5, refreshBlocks: 20 };

// 1. First block always posts.
check("first block posts", shouldPost({ block: 0, mid: 0 }, 100, 0.0247, P) === true);

// 2. No move, within refresh -> skip (keep resting order).
check("no move skips", shouldPost({ block: 100, mid: 0.0247 }, 105, 0.0247, P) === false);

// 3. Small move below threshold -> skip.
check("small move skips", shouldPost({ block: 100, mid: 0.0247 }, 105, 0.02471, P) === false);

// 4. Move at/above threshold -> post.
check("move >= bps posts", shouldPost({ block: 100, mid: 0.0247 }, 105, 0.0247 * (1 + 6 / 10_000), P) === true);

// 5. Refresh interval reached even without a move -> post.
check("refresh interval posts", shouldPost({ block: 100, mid: 0.0247 }, 120, 0.0247, P) === true);

// 6. moveBps = 0 -> post every block (old behaviour).
check("moveBps 0 posts always", shouldPost({ block: 100, mid: 0.0247 }, 101, 0.0247, { moveBps: 0, refreshBlocks: 20 }) === true);

// 7. No reference mid yet -> post.
check("no ref mid posts", shouldPost({ block: 100, mid: 0 }, 101, 0.0247, P) === true);

// 8. Downward move also triggers (absolute value).
check("down move posts", shouldPost({ block: 100, mid: 0.0247 }, 105, 0.0247 * (1 - 6 / 10_000), P) === true);

console.log(failed ? "\nFAILED" : "\nALL OK");
process.exit(failed);
