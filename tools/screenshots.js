#!/usr/bin/env node
// Full-page screenshots of every route at desktop, tablet and phone widths.
// Used for visual review before and after a change.
//
//   node tools/screenshots.js http://127.0.0.1:8100 test-results/shots
//
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const [base = "http://127.0.0.1:8100", out = "test-results/shots"] = process.argv.slice(2);
const routes = process.env.ROUTES ? process.env.ROUTES.split(",") : ["/", "/map", "/districts/", "/districts/los-rios-ccd/", "/districts/ohlone-ccd/", "/legislation/", "/legislation/california/", "/legislation/calendars/", "/about"];
const sizes = [[1440, 900], [768, 1024], [390, 844]];

fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
for (const [w, h] of sizes) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  for (const r of routes) {
    await page.goto(base + r, { waitUntil: "load" });
    // the Legislation section renders from JSON; wait until it has finished
    if (await page.$("#app")) await page.waitForSelector("#app:not([aria-busy])", { timeout: 20000 });
    await page.waitForTimeout(r === "/map" ? 3500 : 400);
    const name = (r === "/" ? "home" : r.replace(/^\/|\/$/g, "").replace(/[/?&=]+/g, "_")) + `-${w}.png`;
    await page.screenshot({ path: path.join(out, name), fullPage: r !== "/map" });
    console.log("shot", name);
  }
  await ctx.close();
}
await browser.close();
