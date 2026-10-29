import { describe, expect, test } from "bun:test";
import { mitZeitlimit } from "./model";

describe("mitZeitlimit", () => {
  test("liefert das Ergebnis, wenn die Anfrage rechtzeitig antwortet", async () => {
    expect(await mitZeitlimit(Promise.resolve("ok"), 1000)).toBe("ok");
  });

  test("bricht eine haengende Anfrage nach dem Zeitlimit ab", async () => {
    const haengt = new Promise<string>(() => {});
    await expect(mitZeitlimit(haengt, 20)).rejects.toThrow("abgebrochen");
  });
});
