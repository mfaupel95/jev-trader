# Hyperliquid liquidation-stop direction

Base: f071bd4eda33ce69e8f7b204fcb7fb3710b0952f (origin/main).

The previous formula in src/market-hl.ts put a long stop BELOW liquidation and a
short stop ABOVE liquidation. On a move against the position, liquidation is
therefore reached before the stop trigger. This change places a long stop above
liquidation and a short stop below it, using the configured basis-point buffer.
The reduce-only side, size, order type and submission path are unchanged.

The pure liquidationStopPrice helper rejects missing/invalid prices, zero or
non-finite sizes, non-positive or >=10000 bps buffers, overflow and prices that
cannot be distinguished from liquidation. A rejected input suppresses this stop
attempt; it does NOT flatten the position or establish a fail-closed risk gate.

## Offline verification

From this worktree:

    bun --no-env-file --no-install test ./src/liquidation-stop.test.ts
    git diff --check

Only bun:test and the pure helper are imported. No wallet, config, SDK, network,
filesystem-write or process-control code is in this test dependency graph. Bun's
automatic env loading and dependency installation are disabled. Do not run the
trading entry point or a broad test discovery as a substitute for this check.

Coverage: long/short direction and exact prices, bps scaling, multiple prices and
buffers, invalid inputs, overflow and floating-point equality. This is a price
calculation regression test, NOT an exchange/adapter integration or live test.

## Not a live acceptance

Price direction alone cannot guarantee execution before liquidation. Tick/price
precision, trigger reference price, gap/slippage, API rejection and actual
exchange order acceptance remain unverified. The existing stop-replacement logic
returns early when it finds a tracked stop; repricing on liquidation-price or
position-size changes is not implemented by this patch despite the old adapter
comment. Invalid inputs have no new alert or entry veto. These need separate
review before any live use. No existing exchange stops are modified by this
local change.

The older funding finding also remains: refresh() uses market fundingHistory and
multiplies fundingRate by optional oi without an account/position payment source.
fundingUsd has no consumer elsewhere in src at this base. It is lower priority
than the stop-direction error and was deliberately not changed in this task.

Lesson: for a protective threshold, test the order in which an adverse price move
crosses the stop and the liquidation boundary, for BOTH position directions.

Next step: an independent reviewer runs the two offline commands above and
inspects the diff against the stated base. Acceptance is a separate decision;
no push, merge, deploy, process restart or trading permission is implied.
