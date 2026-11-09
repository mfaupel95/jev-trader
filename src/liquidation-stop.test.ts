import { describe, expect, test } from "bun:test";
import { liquidationStopPrice } from "./liquidation-stop";

describe("liquidation stop price (offline, no market imports)", () => {
  test("long exits before liquidation as price falls", () => {
    expect(liquidationStopPrice(2, 100, 100)).toBe(101);
  });
  test("short exits before liquidation as price rises", () => {
    expect(liquidationStopPrice(-2, 100, 100)).toBe(99);
  });
  test("buffer is in basis points, independent of position size", () => {
    expect(liquidationStopPrice(0.001, 40_000, 250)).toBe(41_000);
    expect(liquidationStopPrice(-50, 40_000, 250)).toBe(39_000);
  });
  test("never returns a stop on or beyond liquidation across prices and buffers", () => {
    for (const px of [0.0001, 1, 100, 40_000]) {
      for (const bps of [1, 100, 250, 9999]) {
        expect(liquidationStopPrice(1, px, bps)!).toBeGreaterThan(px);
        expect(liquidationStopPrice(-1, px, bps)!).toBeLessThan(px);
        expect(liquidationStopPrice(-1, px, bps)!).toBeGreaterThan(0);
      }
    }
  });
  test("missing or invalid position data does not produce an order price", () => {
    for (const size of [0, NaN, Infinity, -Infinity]) {
      expect(liquidationStopPrice(size, 100, 100)).toBeNull();
    }
    for (const px of [null, 0, -1, NaN, Infinity, -Infinity]) {
      expect(liquidationStopPrice(1, px, 100)).toBeNull();
    }
  });
  test("invalid buffers do not produce an order price", () => {
    for (const bps of [0, -1, 10_000, 20_000, NaN, Infinity]) {
      expect(liquidationStopPrice(1, 100, bps)).toBeNull();
      expect(liquidationStopPrice(-1, 100, bps)).toBeNull();
    }
  });
  test("overflow and indistinguishable prices are rejected", () => {
    expect(liquidationStopPrice(1, Number.MAX_VALUE, 9999)).toBeNull();
    expect(liquidationStopPrice(1, 100, Number.MIN_VALUE)).toBeNull();
    expect(liquidationStopPrice(-1, 100, Number.MIN_VALUE)).toBeNull();
  });
});
