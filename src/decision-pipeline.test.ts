import { describe, expect, test } from "bun:test";
import { DecisionPipeline } from "./decision-pipeline";
import type { Decision, Model, TradeState } from "./model";

/** Lets a settled promise's .then/.catch/.finally chain fully run before asserting. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeState(block: number): TradeState {
  return {
    market: "MON-USDC",
    block,
    horizonBlocks: 100,
    blockMs: 300,
    mid: 0.02,
    spreadBps: 10,
    bookImbalance: 0,
    depth: {},
    book: { bids: [], asks: [] },
    returnsBps: { last1: 0, last5: 0, last20: 0, last100: 0 },
    recentMids: "",
    trades: { count: 0, buyMon: 0, sellMon: 0, cvdMon: 0, vwap: null, lastPrice: null, lastSide: null },
    recentTrades: [],
    allowed: { buy: true, sell: true },
  };
}

function makeDecision(action: Decision["action"]): Decision {
  return { action, probabilities: { buy: 0.6, sell: 0.4, hold: 0 }, upIn10: 0.6, latencyMs: 1, inputTokens: 10 };
}

/** A Model whose decide() only resolves/rejects when the test tells it to. */
class ControllableModel implements Model {
  readonly name = "controllable";
  calls = 0;
  private resolveFn: ((d: Decision) => void) | null = null;
  private rejectFn: ((e: unknown) => void) | null = null;

  decide(_state: TradeState): Promise<Decision> {
    this.calls++;
    return new Promise((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
  }

  resolveLatest(decision: Decision) {
    this.resolveFn?.(decision);
  }

  rejectLatest(err: unknown) {
    this.rejectFn?.(err);
  }
}

describe("DecisionPipeline", () => {
  test("current() is null before any decision has completed", () => {
    const pipeline = new DecisionPipeline(new ControllableModel());
    expect(pipeline.current()).toBeNull();
  });

  test("current() returns the decision once request()'s model call resolves", async () => {
    const model = new ControllableModel();
    const pipeline = new DecisionPipeline(model);

    pipeline.request(5, makeState(5));
    model.resolveLatest(makeDecision("buy"));
    await Promise.resolve(); // let the .then() microtask run

    const current = pipeline.current();
    expect(current?.decision.action).toBe("buy");
    expect(current?.block).toBe(5);
  });

  test("request() while a decision is still in flight does not start a second model call", () => {
    const model = new ControllableModel();
    const pipeline = new DecisionPipeline(model);

    pipeline.request(5, makeState(5));
    pipeline.request(6, makeState(6));
    pipeline.request(7, makeState(7));

    expect(model.calls).toBe(1);
  });

  test("current() keeps the previous decision while a newer request is still in flight", async () => {
    const model = new ControllableModel();
    const pipeline = new DecisionPipeline(model);

    pipeline.request(5, makeState(5));
    model.resolveLatest(makeDecision("buy"));
    await Promise.resolve();

    pipeline.request(6, makeState(6)); // starts a new in-flight call, doesn't resolve yet

    const current = pipeline.current();
    expect(current?.decision.action).toBe("buy");
    expect(current?.block).toBe(5);
  });

  test("once the in-flight call resolves, a later request() starts a new one", async () => {
    const model = new ControllableModel();
    const pipeline = new DecisionPipeline(model);

    pipeline.request(5, makeState(5));
    model.resolveLatest(makeDecision("buy"));
    await flush();

    pipeline.request(6, makeState(6));

    expect(model.calls).toBe(2);
  });

  test("a rejected decide() call does not crash and clears the in-flight slot", async () => {
    const model = new ControllableModel();
    const pipeline = new DecisionPipeline(model);

    pipeline.request(5, makeState(5));
    model.rejectLatest(new Error("boom"));
    await flush();

    expect(pipeline.current()).toBeNull();

    pipeline.request(6, makeState(6));
    expect(model.calls).toBe(2);
  });
});
