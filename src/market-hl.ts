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

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

export class Market {
  readonly wallet: Wallet | null = config.dryRun ? null : new Wallet(config.privateKey!);
  margin = { mon: 0, usdc: 0 };
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
    await this.refresh();
  }

  /** Every `config.refreshBlocks`: USDC balance + open orders. */
  async refresh() {
    if (!this.wallet) return;
    try {
      const state = await this.info.clearinghouseState({ user: this.wallet.address });
      this.margin.usdc = Number(state.marginSummary?.accountValue ?? 0);
    } catch (e) {
      // wallet may not exist on testnet yet — leave margin at 0
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
        // ALO canceled because it would cross = reverted (the book moved through our price)
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
        if (openIds.has(Number(oid))) continue; // still resting
        this.pending.delete(oid);
        out.push({ block: p.block, quote: { ...p.quote, status: "placed" }, canceled: [] });
      }
    } catch (e) {
      // transient — leave pending
    }
    return out;
  }
}
