import { describe, expect, test } from "bun:test";
import { shouldPost, type PostPolicy } from "./postpolicy";

/**
 * TTL-Refresh (03.11.2026): auf Hyperliquid kommt der Kurs ueber Zeit, nicht
 * ueber Kettenbloecke. `refreshMs` ist die Frist in Millisekunden; fehlt sie
 * oder ist sie 0, gilt unveraendert der Blockzaehler (Kuru-Betrieb).
 */
const basis: PostPolicy = { moveBps: 50, refreshBlocks: 20 };

describe("shouldPost - Blockzaehler (unveraendert)", () => {
  test("erster Block postet", () => {
    expect(shouldPost({ block: 0, mid: 0 }, 7, 1.0, basis)).toBe(true);
  });
  test("ohne Bewegung und ohne Frist bleibt die Order liegen", () => {
    expect(shouldPost({ block: 100, mid: 1.0, ts: 1_000 }, 101, 1.0, basis, 2_000)).toBe(false);
  });
  test("Blockfrist erreicht postet", () => {
    expect(shouldPost({ block: 100, mid: 1.0, ts: 1_000 }, 120, 1.0, basis, 2_000)).toBe(true);
  });
  test("Bewegung ueber der Schwelle postet", () => {
    // 0,6 % = 60 bp > 50 bp
    expect(shouldPost({ block: 100, mid: 1.0, ts: 1_000 }, 101, 1.006, basis, 2_000)).toBe(true);
  });
});

describe("shouldPost - Zeit-TTL", () => {
  const ttl: PostPolicy = { ...basis, refreshMs: 30_000 };

  test("Frist nicht abgelaufen: kein Post trotz bewegungslosem Markt", () => {
    expect(shouldPost({ block: 100, mid: 1.0, ts: 1_000 }, 101, 1.0, ttl, 20_000)).toBe(false);
  });
  test("aktive Zeitfrist ersetzt die Blockfrist bis zur TTL-Grenze", () => {
    const last = { block: 100, mid: 1.0, ts: 1_000 };
    expect(shouldPost(last, 120, 1.0, ttl, 30_999)).toBe(false);
    expect(shouldPost(last, 120, 1.0, ttl, 31_000)).toBe(true);
  });
  test("Bewegung postet auch vor Ablauf der Zeitfrist", () => {
    expect(shouldPost({ block: 100, mid: 1.0, ts: 1_000 }, 120, 1.006, ttl, 2_000)).toBe(true);
  });
  test("ohne bekannten Zeitstempel bleibt die Blockfrist als Rueckfall", () => {
    for (const ts of [undefined, 0]) {
      expect(shouldPost({ block: 100, mid: 1.0, ts }, 120, 1.0, ttl, 2_000)).toBe(true);
    }
  });
  test("deaktivierte Zeitfrist behaelt die Blockfrist", () => {
    expect(shouldPost({ block: 100, mid: 1.0, ts: 1_000 }, 120, 1.0, { ...basis, refreshMs: 0 }, 2_000)).toBe(true);
  });
  test("Frist abgelaufen: Post ohne jede Bewegung", () => {
    expect(shouldPost({ block: 100, mid: 1.0, ts: 1_000 }, 101, 1.0, ttl, 31_000)).toBe(true);
  });
  test("Frist abgelaufen schlaegt den Blockzaehler, auch bei grossem Abstand", () => {
    expect(shouldPost({ block: 1, mid: 1.0, ts: 5_000 }, 2, 1.0, ttl, 40_000)).toBe(true);
  });
  test("ohne Zeitstempel greift die Frist nicht", () => {
    expect(shouldPost({ block: 100, mid: 1.0 }, 101, 1.0, ttl, 10_000_000)).toBe(false);
  });
  test("refreshMs 0 schaltet die Frist ab", () => {
    expect(shouldPost({ block: 100, mid: 1.0, ts: 1 }, 101, 1.0, { ...basis, refreshMs: 0 }, 10_000_000)).toBe(false);
  });
});
