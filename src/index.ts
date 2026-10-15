import { config } from "./config";
import { startBlockFeed } from "./chain";
import { Market as KuruMarket } from "./market";
import { Market as HlMarket } from "./market-hl";
import { createModel } from "./model";
import { Trader } from "./trader";
import { log10 } from "./book";
import { startServer } from "./server";

const market = config.engine === "hyperliquid" ? new HlMarket() : new KuruMarket();
await market.init();
const model = createModel();

const server = startServer(
  { model: model.name, wallet: market.address, dryRun: config.dryRun, market: config.market, startedAt: Date.now() },
  () => trader.history,
);
const trader = new Trader(
  market,
  model,
  (e, t) => {
    server.broadcast(e);
    if (e.decision && !e.decision.late) {
      const p = e.decision.probabilities;
      const q = e.quote;
      const quote = !q ? ` NO QUOTE (${e.skipReason === "no-move" ? "no move, keeping resting order" : "cap or funds on both sides"})` : ` ${q.side.toUpperCase()} ${q.size} @ ${q.price.toFixed(6)}${q.capped ? " capped" : ""}${q.status === "sim" ? " (sim)" : ` cancel ${q.cancel.length} ${q.txHash}`}`;
      console.log(`#${e.block} ${e.mid.toFixed(6)} b${(p.buy * 100).toFixed(0)} s${(p.sell * 100).toFixed(0)} ${e.decision.latencyMs}ms${quote} pnl $${e.totals.pnlUsd}${t ? ` · read ${t.readMs}ms loop ${t.loopMs}ms` : ""}`);
    }
  },
  (block, fill) => {
    server.broadcastFill(block, fill);
    console.log(`#${block} FILL ${fill.side} ${fill.size} @ ${fill.price.toFixed(6)}${fill.simulated ? " (sim)" : ` order ${fill.orderId} ${fill.txHash}`}`);
  },
  (block, quote) => {
    server.broadcastQuote(block, quote);
    if (quote.status !== "placed") console.log(`#${block} ${quote.status.toUpperCase()} ${quote.side} @ ${quote.price.toFixed(6)} gas ${quote.gasMon.toFixed(6)} MON ${quote.txHash}`);
  },
);
// Kuru: attach the on-chain trade-log feed for fills. Hyperliquid polls userFills in the market client.
if (config.engine === "kuru") trader.attachTradeFeed(log10(market.params.sizePrecision));

console.log(`jev-trader · engine=${config.engine} · model=${model.name} · post-only ${config.quoteInsideTicks} tick inside the touch · horizon ${config.horizonBlocks} blocks · ${config.dryRun ? "DRY RUN" : `wallet ${market.address}`} · market ${config.market} · read ${config.readRpcUrl} · :${config.port}`);
if (config.engine === "hyperliquid") {
  // Hyperliquid has no on-chain block feed; tick every 300ms (Kuru block cadence).
  let block = 0;
  setInterval(() => trader.onBlock(++block), 300);
} else {
  startBlockFeed((block) => trader.onBlock(block));
}
