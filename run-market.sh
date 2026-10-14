#!/usr/bin/env bash
# Run jev-trader against a named Kuru market (dry-run unless PRIVATE_KEY is set).
# Usage: ./run-market.sh <mon|weth|cbbtc|xaut0> [port]
# NOTE: all markets share data/events.jsonl — run one at a time for clean logs.
set -euo pipefail
case "${1:-mon}" in
  mon)   MARKET=0x065C9d28E428A0db40191a54d33d5b7c71a9C394 LABEL=MON-USDC BASE=MON TRADE=200 MAXPOS=1000 MARGIN_MON=600 MARGIN_USDC=20 BANK=100 ;;
  weth)  MARKET=0xa6afd386135b7d41a6c40c525abc4a1019b0d132 LABEL=WETH-USDC BASE=WETH TRADE=0.01 MAXPOS=0.05 MARGIN_MON=0 MARGIN_USDC=20 BANK=100 ;;
  cbbtc) MARKET=0x40c49f171202f91ff5d2fae34c22dd2bfdd22af0 LABEL=cbBTC-USDC BASE=cbBTC TRADE=0.0005 MAXPOS=0.002 MARGIN_MON=0 MARGIN_USDC=20 BANK=100 ;;
  xaut0) MARKET=0x851145eaefdc37956b08da829fa31722199f3f07 LABEL=XAUt0-USDC BASE=XAUt0 TRADE=0.02 MAXPOS=0.1 MARGIN_MON=0 MARGIN_USDC=20 BANK=100 ;;
  *) echo "unknown market: $1 (use mon|weth|cbbtc|xaut0)"; exit 1 ;;
esac
PORT="${2:-3000}"
export MARKET MARKET_LABEL="$LABEL" BASE_SYMBOL="$BASE" \
  MARGIN_ACCOUNT="0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5" \
  TRADE_SIZE_MON="$TRADE" MAX_POSITION_MON="$MAXPOS" \
  MARGIN_MON="$MARGIN_MON" MARGIN_USDC="$MARGIN_USDC" BANKROLL_USD="$BANK" PORT="$PORT"
echo "==> $LABEL (port $PORT) · trade $TRADE $BASE · maxpos $MAXPOS $BASE · bankroll \$$BANK"
exec bun run src/index.ts
