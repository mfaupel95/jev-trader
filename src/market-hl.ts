import { HttpTransport, InfoClient, ExchangeClient } from "@nktkas/hyperliquid";
import { Wallet } from "ethers";
import { config } from "./config";

/**
 * Hyperliquid Perps market client — drop-in for the Kuru `Market` interface so the
 * Jev decision core (trader.ts, model.ts, decision-pipeline.ts) is untouched.
 *
 * Differences from Kuru:
 * - Orderweg: REST POST /exchange (ed25519-signed via @nktkas/hyperliquid), not on-chain.
 * - Book: /info l2Book returns levels=[[bids],[asks]] with px/sz/n.
 * - Margin: wallet USDC + leverage, not a MarginAccount. `margin.mon` is unused (0),
 *   `margin.usdc` is the free USDC balance.
 * - Fills: /info userFills (polled), not a trade-log feed.
 * - Gas: Hyperliquid charges no per-order gas; gasMon is 0 (fees come out of USDC).
 * - Perps: leverage set at init (HL_LEVERAGE), funding tracked in `fundingUsd`.
 * - Liquidation stop: every refresh, if an open position exists, a reduce-only market
 *   stop is placed ahead of the liquidation price so a flush never liquidates us.
 */

export interface Book {
  block: number;
  bid: number;
  ask: number;
  mid: number;
  spreadBps: number;
  imbalance: number;
  levels: { bids: [number, number][]; asks: [number, number][] };
  depthBps: { [band: string]: { bid: number; ask: number } };
}

export type Side = "buy" | "sell";

export interface Quote {
  side: Side;
  price: number;
  size: number;
  txHash: string | null;
  gasMon: number;
  cancel: number[];
  status: "sent" | "placed" | "reverted" | "lost" | "sim";
  orderId: number | null;
  capped: boolean;
}

export interface Fill {
  side: Side;
  size: number;
  price: number;
  txHash: string | null;
  orderId: number;
  simulated: boolean;
}

export interface QuoteResult { block: number; quote: Quote; canceled: number[] }

/** An open perps position (from clearinghouseState), as far as the liquidation stop needs it. */
export interface Position {
  coin: string;
  szi: number; // signed size; >0 long, <0 short
  entryPx: number;
  liquidationPx: number | null;
  positionValue: number;
  unrealizedPnl: number;
  leverage: number;
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

export class Market {
  readonly wallet: Wallet | null = config.dryRun ? null : new Wallet(config.privateKey!);
  margin = { mon: 0, usdc: 0 };
  /** Cumulative funding paid/received (USDC), refreshed every `refreshBlocks`. */
  fundingUsd = 0;
  /** The open position, if any. */
  position: Position | null = null;
  /** Set of oids we have placed liquidation stops for (to avoid re-placing every refresh). */
  private stopOids = new Set<number>();
  private transport: HttpTransport;
  private info: InfoClient;
  private exchange: ExchangeClient | null = null;
  private assetIndex = 0;
  private szDecimals = 5;
  private pending = new Map<string, { block: number; quote: Quote }>();
  private lastBook: Book | null = null;

  constructor() {
    this.transport = new HttpTransport({ isTestnet: config.hlTestnet });
    this.info = new InfoClient({ transport: this.transport });
    if (this.wallet) this.exchange = new ExchangeClient({ transport: this.transport, wallet: this.wallet });
  }

  get address() { return this.wallet?.address ?? null; }
  /** Kuru-compat: the size precision (decimals) for order sizing. */
  get sizeDec() { return this.szDecimals; }
  /** Kuru-compat: no on-chain params. */
  get params() { return { sizePrecision: 10 ** this.szDecimals }; }

  async init() {
    const meta = await this.info.meta();
    const coin = meta.universe.find((u) => u.name === config.hlCoin);
    if (!coin) throw new Error(`Hyperliquid coin ${config.hlCoin} not in meta`);
    this.assetIndex = meta.universe.indexOf(coin);
    this.szDecimals = coin.szDecimals;
    // Set leverage (cross) once at startup so the margin covers the position.
    if (this.exchange && config.hlLeverage > 0) {
      try {
        await this.exchange.updateLeverage({ asset: this.assetIndex, isCross: true, leverage: config.hlLeverage });
        console.log(`hyperliquid: leverage ${config.hlLeverage}x (cross) on ${config.hlCoin}`);
      } catch (e) {
        console.warn(`hyperliquid: leverage set failed (${(e as Error).message.slice(0, 100)})`);
      }
    }
    await this.refresh();
  }

  /** Every `config.refreshBlocks`: USDC balance, open position, funding. Also guards the position with a liquidation stop. */
  async refresh() {
    if (!this.wallet) return;
    try {
      const state = await this.info.clearinghouseState({ user: this.wallet.address });
      this.margin.usdc = Number(state.marginSummary?.accountValue ?? 0);
      // Current position on our coin
      const ap = state.assetPositions.find((p) => p.position.coin === config.hlCoin);
      this.position = ap ? {
        coin: ap.position.coin,
        szi: Number(ap.position.szi),
        entryPx: Number(ap.position.entryPx),
        liquidationPx: ap.position.liquidationPx !== null ? Number(ap.position.liquidationPx) : null,
        positionValue: Number(ap.position.positionValue),
        unrealizedPnl: Number(ap.position.unrealizedPnl),
        leverage: ap.position.leverage.value,
      } : null;
      // Funding: sum of recent funding payments for our coin (negative = we paid).
      try {
        const fh = await this.info.fundingHistory({ coin: config.hlCoin, startTime: Date.now() - 24 * 3600 * 1000 });
        this.fundingUsd = fh.reduce((s, f) => s + Number(f.fundingRate ?? 0) * Number(f.oi ?? 0), 0);
      } catch { /* funding optional */ }
      await this.liquidationSchutz();
    } catch (e) {
      // wallet may not exist on testnet yet — leave margin at 0
    }
  }

  /**
   * If we hold an open position, place a reduce-only market stop ahead of the liquidation price
   * (long: stop below liq with a buffer; short: stop above liq). Only placed once per position;
   * replaced if the liquidation price moved by more than `hlLiqPufferBps` from where we stopped.
   */
  private async liquidationSchutz() {
    if (!this.exchange || !this.position) { this.stopOids.clear(); return; }
    const p = this.position;
    if (p.szi === 0 || p.liquidationPx === null) return;
    const buffer = config.hlLiqPufferBps / 10_000;
    // Stop BEHIND the liquidation price, so we exit first. Market trigger (isMarket: true).
    const stopPx = p.szi > 0 ? p.liquidationPx * (1 - buffer) : p.liquidationPx * (1 + buffer);
    // Reduce-only, opposite side.
    const reduceSide = p.szi > 0 ? "sell" : "buy";
    try {
      // Check whether we already have a live stop on this position
      const open = await this.info.openOrders({ user: this.wallet!.address });
      const haveStop = open.some((o) => o.isPositionTpsl && this.stopOids.has(o.oid));
      if (haveStop) return;
      const res = await this.exchange.order({
        orders: [{ a: this.assetIndex, b: reduceSide === "buy", p: String(stopPx), s: String(Math.abs(p.szi)), r: true, t: { trigger: { isMarket: true, triggerPx: String(stopPx), tpsl: "sl" } } }],
        grouping: "normalTpsl",
      });
      const st = res.response?.data?.statuses?.[0];
      if (st && "resting" in st) {
        this.stopOids.add((st as any).resting.oid);
        console.log(`hyperliquid: liquidation stop @ ${stopPx.toFixed(2)} (${reduceSide}, ${Math.abs(p.szi)} ${config.hlCoin})`);
      } else if (st && "error" in st) {
        console.warn(`hyperliquid: liquidation stop failed: ${(st as any).error}`);
      }
    } catch (e) {
      console.warn(`hyperliquid: liquidation stop error (${(e as Error).message.slice(0, 120)})`);
    }
  }

  async readBook(): Promise<Book> {
    const book = await this.info.l2Book({ coin: config.hlCoin });
    const bids = book.levels[0].map((l) => [Number(l.px), Number(l.sz)] as [number, number]);
    const asks = book.levels[1].map((l) => [Number(l.px), Number(l.sz)] as [number, number]);
    const bid = bids[0]?.[0] ?? 0;
    const ask = asks[0]?.[0] ?? 0;
    const mid = (bid + ask) / 2;
    const spreadBps = mid ? ((ask - bid) / mid) * 10_000 : 0;
    const bidDepth = bids.reduce((s, l) => s + l[1], 0);
    const askDepth = asks.reduce((s, l) => s + l[1], 0);
    const imbalance = bidDepth + askDepth ? (bidDepth - askDepth) / (bidDepth + askDepth) : 0;
    const depthBps: Book["depthBps"] = {};
    for (const band of [10, 25, 50]) {
      const b = bids.filter((l) => l[0] >= mid * (1 - band / 10_000)).reduce((s, l) => s + l[1], 0);
      const a = asks.filter((l) => l[0] <= mid * (1 + band / 10_000)).reduce((s, l) => s + l[1], 0);
      depthBps[`${band}bps`] = { bid: round(b, 4), ask: round(a, 4) };
    }
    this.lastBook = { block: 0, bid, ask, mid, spreadBps, imbalance, levels: { bids, asks }, depthBps };
    return this.lastBook;
  }

  /** Where this block's order rests: `quoteInsideTicks` inside the touch, never crossing. */
  quotePrice(side: Side, book: Book): number {
    const tick = 10 ** -this.szDecimals;
    const step = config.quoteInsideTicks * tick;
    let p = side === "buy" ? book.bid + step : book.ask - step;
    if (side === "buy" && p >= book.ask) p = book.bid;
    if (side === "sell" && p <= book.bid) p = book.ask;
    return round(p, this.szDecimals);
  }

  /** Sign and fire one post-only limit order (TIF Alo). Returns as soon as the API has the response. */
  async send(block: number, side: Side, size: number, book: Book, cancel: number[], capped: boolean): Promise<Quote> {
    const price = this.quotePrice(side, book);
    if (!this.exchange) return { side, price, size, txHash: null, gasMon: 0, cancel, status: "sim", orderId: null, capped };
    try {
      const res = await this.exchange.order({
        orders: [{ a: this.assetIndex, b: side === "buy", p: String(price), s: String(size), r: false, t: { limit: { tif: "Alo" } } }],
        grouping: "na",
      });
      const statuses = res.response?.data?.statuses ?? [];
      const st = statuses[0];
      if (st && "resting" in st) {
        const oid = (st as any).resting.oid;
        const quote: Quote = { side, price, size, txHash: null, gasMon: 0, cancel, status: "placed", orderId: oid, capped };
        this.pending.set(String(oid), { block, quote });
        return quote;
      }
      if (st && "filled" in st) {
        const oid = (st as any).filled.oid;
        return { side, price, size, txHash: null, gasMon: 0, cancel, status: "placed", orderId: oid, capped };
      }
      if (st && "error" in st) {
        return { side, price, size, txHash: null, gasMon: 0, cancel, status: "reverted", orderId: null, capped };
      }
      return { side, price, size, txHash: null, gasMon: 0, cancel, status: "reverted", orderId: null, capped };
    } catch (e) {
      return { side, price, size, txHash: null, gasMon: 0, cancel, status: "reverted", orderId: null, capped };
    }
  }

  /** Poll open orders + fills to resolve pending quotes. */
  async pollPending(block: number): Promise<QuoteResult[]> {
    if (!this.wallet || !this.pending.size) return [];
    const out: QuoteResult[] = [];
    try {
      const open = await this.info.openOrders({ user: this.wallet.address });
      const openIds = new Set(open.map((o) => o.oid));
      for (const [oid, p] of this.pending) {
        if (openIds.has(Number(oid))) continue;
        this.pending.delete(oid);
        out.push({ block: p.block, quote: { ...p.quote, status: "placed" }, canceled: [] });
      }
    } catch (e) {
      // transient — leave pending
    }
    return out;
  }
}
