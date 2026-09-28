// Keyboard walkthrough of the national pages: the states table, a state, a county, with the
// keyboard alone. Checks that every step is reachable with Tab, that Enter follows links, that
// focus lands on the new page's heading after each navigation, that filters change the list in
// place without moving focus or changing the address, and that focus is always visible.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const hasNational = fs.existsSync(path.join(here, "..", "studenttrustee", "data", "legislation", "geo", "us-tx", "counties.json"));

async function ready(page) { await page.waitForSelector("#app:not([aria-busy])", { timeout: 30_000 }); }

// Press Tab until the focused element matches, failing after `limit` presses.
async function tabTo(page, matches, limit = 80) {
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

test.describe("keyboard walkthrough", () => {
  test.skip(!hasNational, "no national records checked out");

  test("states table, Texas, Travis County, and the county's vote filters", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "phone-390", "the phone layout is walked through in the next test");
    await page.goto("/legislation/states/");
    await ready(page);

    // The skip link is the first stop and moves focus to the main content.
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).toHaveText("Skip to content");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => document.activeElement && document.activeElement.id)).toBe("main");

    await tabTo(page, () => document.activeElement && document.activeElement.id === "place-q");
    expect(await focusVisible(page)).toBe(true);
    await page.keyboard.type("tex");
    await expect(page.locator("#place-q + .hint + .count, .finder .count").first()).toContainText("1 of 56");
    await expect(page).toHaveURL(/\/legislation\/states\/(#main)?$/);

    await tabTo(page, () => document.activeElement && document.activeElement.textContent === "Texas");
    expect(await focusVisible(page)).toBe(true);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/legislation\/texas\/$/);
    await ready(page);
    await expect.poll(() => page.evaluate(() => document.activeElement && document.activeElement.id)).toBe("page-title");
    await expect(page.locator("h1")).toHaveText("Texas");

    await tabTo(page, () => document.activeElement && document.activeElement.id === "county-q", 400);
    await page.keyboard.type("travis");
    await expect(page.locator("#counties .count")).toHaveText(/^1 of 254 counties shown$/);
    await tabTo(page, () => document.activeElement && document.activeElement.textContent === "Travis County");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/legislation\/texas\/travis\/$/);
    await ready(page);
    await expect.poll(() => page.evaluate(() => document.activeElement && document.activeElement.id)).toBe("page-title");

    // Filters change the list in place: focus stays on the control and the address does not change.
    await tabTo(page, () => document.activeElement && document.activeElement.id === "cv-body", 200);
    const before = page.url();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("#congress-votes p.count[role=status]")).toContainText("match the filters");
    expect(await page.evaluate(() => document.activeElement.id)).toBe("cv-body");
    expect(page.url()).toBe(before);
  });

  test("on a phone the vote filters open from a button that says how many are on", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "phone-390", "phone layout only");
    await page.goto("/legislation/texas/travis/");
    await ready(page);
    const toggle = page.locator("button.filter-toggle");
    await expect(page.locator("#cv-filters")).toBeHidden();
    await toggle.focus();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#cv-filters")).toBeVisible();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement.id)).toBe("cv-body");
    await page.keyboard.press("ArrowDown");
    await expect(toggle).toHaveText("Filter votes (1 on)");
  });
});
