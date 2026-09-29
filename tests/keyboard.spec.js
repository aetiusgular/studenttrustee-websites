// Keyboard walkthrough of the Legislation section in layout D: the map of states, a state's doors,
// the county picker, the level chips and the filter drawer, with the keyboard alone. Checks that
// every step is reachable with Tab, that Enter follows links, that focus lands where the page
// says it will (the heading after a new place, the result count after a door or Apply, the chip
// itself after a chip), that the drawer changes nothing until Apply, and that focus is always visible.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const hasNational = fs.existsSync(path.join(here, "..", "studenttrustee", "data", "legislation", "geo", "us-tx", "counties.json"));

async function ready(page) { await page.waitForSelector("#app:not([aria-busy])", { timeout: 30_000 }); }

// Press Tab until the focused element matches, failing after `limit` presses.
async function tabTo(page, matches, limit = 120) {
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press("Tab");
    const hit = await page.evaluate(matches);
    if (hit) return;
  }
  throw new Error("never reached with Tab: " + matches.toString());
}
async function focusVisible(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return false;
    const cs = getComputedStyle(el);
    return (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== "none");
  });
}
const activeId = (page) => page.evaluate(() => document.activeElement && document.activeElement.id);

test.describe("keyboard walkthrough", () => {
  test.skip(!hasNational, "no national records checked out");

  test("map, Texas, its doors, Travis County, a level chip and the filter drawer", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "phone-390", "the phone layout is walked through in the next test");
    await page.goto("/legislation/");
    await ready(page);

    // The skip link is the first stop and moves focus to the main content.
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).toHaveText("Skip to content");
    await page.keyboard.press("Enter");
    await expect.poll(() => activeId(page)).toBe("main");

    // The tiles run west to east, row by row; Texas is on the last row.
    await tabTo(page, () => document.activeElement && document.activeElement.matches('.usmap a[href="/legislation/texas/"]'));
    expect(await focusVisible(page)).toBe(true);
    await expect(page.locator(":focus")).toContainText("Texas");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/legislation\/texas\/$/);
    await ready(page);
    await expect.poll(() => activeId(page)).toBe("page-title");
    await expect(page.locator("h1")).toHaveText("Texas");

    // A door: focus moves to the new list's count, and the door is marked as the current one.
    await tabTo(page, () => document.activeElement && document.activeElement.matches(".pdoor") && /Who represents me/.test(document.activeElement.textContent));
    expect(await focusVisible(page)).toBe(true);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/legislation\/texas\/representatives\/$/);
    await ready(page);
    await expect.poll(() => activeId(page)).toBe("results");
    await expect(page.locator('.pdoor[aria-current="page"]')).toContainText("Who represents me");

    // The county picker changes nothing until Show.
    await tabTo(page, () => document.activeElement && document.activeElement.id === "rep-county");
    const before = page.url();
    await page.keyboard.type("Travis");
    expect(page.url()).toBe(before);
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).toHaveText("Show");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/legislation\/texas\/travis\/representatives\/$/);
    await ready(page);
    await expect(page.locator("h1")).toHaveText("Travis County");
    await expect.poll(() => activeId(page)).toBe("results");

    // Back to the votes door, then a level chip: focus stays on the chip and the count is announced.
    await tabTo(page, () => document.activeElement && document.activeElement.matches(".pdoor") && /How they voted/.test(document.activeElement.textContent));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/legislation\/texas\/travis\/$/);
    await ready(page);
    await tabTo(page, () => document.activeElement && document.activeElement.matches('.chip[data-level="federal"]'));
    expect(await focusVisible(page)).toBe(true);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/legislation\/texas\/travis\/\?level=federal$/);
    await ready(page);
    await expect.poll(() => page.evaluate(() => document.activeElement && document.activeElement.getAttribute("data-level"))).toBe("federal");
    await expect(page.locator('.chip[data-level="federal"]')).toHaveAttribute("aria-current", "true");
    await expect(page.locator("#status")).toContainText("federal votes");

    // The drawer: a disclosure button; its fields change nothing until Apply, which moves focus
    // to the count and keeps the drawer open.
    await tabTo(page, () => document.activeElement && document.activeElement.id === "more-btn");
    await expect(page.locator("#more-btn")).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Enter");
    await expect(page.locator("#more-btn")).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#filters")).toBeVisible();
    await tabTo(page, () => document.activeElement && document.activeElement.id === "f-result", 10);
    const url = page.url();
    const heading = await page.locator("#results").textContent();
    await page.keyboard.press("ArrowDown");
    expect(await page.inputValue("#f-result")).toBe("passed");
    expect(page.url()).toBe(url);
    await expect(page.locator("#results")).toHaveText(heading);
    await tabTo(page, () => document.activeElement && document.activeElement.textContent === "Apply", 10);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/legislation\/texas\/travis\/\?level=federal&result=passed$/);
    await ready(page);
    await expect.poll(() => activeId(page)).toBe("results");
    await expect(page.locator("#results")).toContainText("that passed");
    await expect(page.locator("#more-btn")).toHaveText("More filters (1 on)");
    await expect(page.locator("#more-btn")).toHaveAttribute("aria-expanded", "true");
  });

  test("on a phone the doors stack and the filters open from a button that says how many are on", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "phone-390", "phone layout only");
    await page.goto("/legislation/california/");
    await ready(page);
    // the three doors are one column, each a full-width target
    const boxes = await page.locator(".pdoor").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) })));
    expect(new Set(boxes.map((b) => b.x)).size).toBe(1);
    for (const b of boxes) expect(b.h).toBeGreaterThanOrEqual(44);
    const toggle = page.locator("#more-btn");
    await expect(page.locator("#filters")).toBeHidden();
    await toggle.focus();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#filters")).toBeVisible();
    await page.keyboard.press("Tab");
    expect(await activeId(page)).toBe("f-county");
    await page.focus("#f-month");
    await page.keyboard.press("ArrowDown");
    await page.locator("#filters button[type=submit]").focus();
    await page.keyboard.press("Enter");
    await ready(page);
    await expect(page).toHaveURL(/\/legislation\/california\/\?month=\d{4}-\d{2}$/);
    await expect(toggle).toHaveText("More filters (1 on)");
  });
});
