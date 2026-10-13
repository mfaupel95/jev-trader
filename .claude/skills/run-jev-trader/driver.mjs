// Drives the jev-trader dashboard (Next.js, assumed already running on
// DASHBOARD_URL) with Playwright: navigates, waits for the live feed to
// populate, screenshots, and reports any console errors.
//
// Usage:
//   bun run .claude/skills/run-jev-trader/driver.mjs [outPath]
//
// outPath must use forward slashes even on Windows (see Gotchas in
// SKILL.md) — backslash path strings get mangled by JS escape parsing
// (e.g. "C:\Users\..." loses the "\U" as an escape).

import { chromium } from "playwright";

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? "http://localhost:3001";
const outPath = process.argv[2] ?? "./jev-trader-dashboard.png";

if (outPath.includes("\\")) {
  console.error(`outPath must use forward slashes, got: ${outPath}`);
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});

await page.goto(DASHBOARD_URL, { waitUntil: "networkidle", timeout: 20000 });

// The header shows "block -" until the SSE snapshot lands; wait for a
// real block number before screenshotting, or the shot just shows the
// loading shell.
await page.waitForFunction(
  () => !document.querySelector(".Header-module__ldgnoG__block")?.textContent?.includes("-"),
  { timeout: 15000 },
).catch(() => {
  console.error("WARNING: block number never populated — dashboard may not be receiving SSE events");
});

await page.screenshot({ path: outPath, fullPage: true });

console.log(`screenshot saved: ${outPath}`);
console.log(`console errors: ${JSON.stringify(consoleErrors)}`);

await browser.close();
process.exit(consoleErrors.length > 0 ? 1 : 0);
