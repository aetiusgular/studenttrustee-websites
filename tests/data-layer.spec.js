// The Legislation section's data layer and its security headers, in a real browser against the
// dev server (which applies studenttrustee/_headers and serves the records from
// studenttrustee/data/legislation/):
//   - intent prefetch: a resting pointer fetches the next page's files, so the click needs none;
//   - Save-Data turns prefetch off;
//   - leaving a page aborts the requests only that page wanted;
//   - a 5xx is retried once, a 404 on a required file and a newer schema are reported;
//   - record links that are not http(s) render as text;
//   - Trusted Types is enforced and no route logs a CSP or Trusted Types violation.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "..", "studenttrustee", "data", "legislation");
const read = (rel) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, rel), "utf8")); } catch { return null; } };
const hasData = !!read("manifest.json");
// A state outside California whose bills and votes are published (Open States bulk data), if any.
const legs = read("legislatures.json");
const VST = legs && Object.keys(legs.states).filter((k) => k !== "CA" && legs.states[k].votes > 0).sort()[0];
const VSUM = VST && read(`us-${VST.toLowerCase()}/summary.json`);
const VSLUG = VST && ((read("geo/states.json") || { states: [] }).states.find((s) => s.code === VST) || {}).slug;

// Every records request the page makes from now on, in order. seen.pending() counts the ones that have
// not finished; a 404 counts as finished (the records on the data branch can trail the code by a night).
function dataRequests(page) {
  const seen = [];
  const done = new Set();
  const isData = (r) => r.url().includes("/data/legislation/");
  page.on("request", (r) => { if (isData(r)) seen.push(r.url().split("/data/legislation/")[1]); });
  page.on("requestfinished", (r) => { if (isData(r)) done.add(r); });
  page.on("requestfailed", (r) => { if (isData(r)) done.add(r); });
  // an error response is final once it arrives; its body is not needed
  page.on("response", (res) => { if (isData(res.request()) && res.status() >= 400) done.add(res.request()); });
  Object.defineProperty(seen, "pending", { enumerable: false, value: () => seen.length - done.size });
  return seen;
}
async function ready(page) {
  await page.waitForSelector("#app:not([aria-busy])", { timeout: 30_000 });
}
// Waits until every records request so far has finished and none has started for 400 ms. Prefetch
// runs two at a time at low priority, so on a busy machine the last files can take a moment. Response
// events are used, not Resource Timing: Chromium records no timing entry for a fetch that gets a 404.
async function settled(seen) {
  await expect.poll(async () => {
    if (seen.pending() > 0) return "waiting for " + seen.pending() + " request(s)";
    const n = seen.length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    return seen.length === n && seen.pending() <= 0 ? "settled" : "more requests started";
  }, { timeout: 15_000 }).toBe("settled");
}
// The pages under test prefetch on hover; the phone project has no hover, so these run on desktop.
function desktopOnly(testInfo) { test.skip(testInfo.project.name !== "desktop-1440", "pointer hover is a desktop behaviour"); }

test.describe("data layer", () => {
  test.skip(!hasData, "no records checked out in studenttrustee/data/legislation/");

  test("a resting pointer prefetches the next page, and the click fetches nothing new", async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await page.goto("/legislation/states/");
    await ready(page);
    await page.waitForTimeout(300);
    const seen = dataRequests(page);
    const target = page.locator("#app a", { hasText: /^Texas$/ }).first();
    await target.hover();
    await expect.poll(() => seen.length, { timeout: 5_000 }).toBeGreaterThan(0);
    await settled(seen);
    const before = seen.length;
    await target.click();
    await expect(page).toHaveURL(/\/legislation\/texas\/$/);
    await ready(page);
    await page.waitForTimeout(300);
    expect(seen.slice(before), "files fetched after the click").toEqual([]);
  });

  test("Save-Data turns prefetch off", async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await page.addInitScript(() => {
      Object.defineProperty(Object.getPrototypeOf(navigator), "connection", { configurable: true, get: () => ({ saveData: true, effectiveType: "4g" }) });
    });
    await page.goto("/legislation/states/");
    await ready(page);
    await page.waitForTimeout(300);
    const seen = dataRequests(page);
    await page.locator("#app a", { hasText: /^Texas$/ }).first().hover();
    await page.waitForTimeout(600);
    expect(seen).toEqual([]);
  });

  test("leaving a page aborts the requests only that page wanted", async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const us = read("us/members.json");
    const senator = us.members.find((m) => m.body === "us-senate" && !m.former && !m.provisional);
    const house = "senate";
    const records = `us/records/${house}-${us.congress}.json`;
    // Hold the legislator's record file so the page is still waiting for it when the visitor leaves.
    let release;
    const held = new Promise((r) => { release = r; });
    await page.route(`**/data/legislation/${records}`, async (route) => { await held; await route.continue().catch(() => {}); });
    const failed = [];
    page.on("requestfailed", (r) => { if (r.url().includes(records)) failed.push(r.failure() && r.failure().errorText); });
    await page.goto("/legislation/");
    await ready(page);
    await page.evaluate((id) => {
      const a = document.createElement("a");
      a.href = "/legislation/legislator/" + id + "/";
      a.textContent = "member";
      a.id = "go-member";
      document.getElementById("app").prepend(a);
    }, senator.id);
    await page.click("#go-member");
    await expect.poll(() => page.evaluate(() => document.getElementById("app").getAttribute("aria-busy"))).toBe("true");
    await page.waitForTimeout(300);
    await page.click(".leg-nav a[href='/legislation/sources/']");
    await ready(page);
    await expect.poll(() => failed.length, { timeout: 5_000 }).toBeGreaterThan(0);
    expect(failed[0]).toMatch(/ABORT|cancel/i);
    release();
    await expect(page.locator("h1")).toHaveText("Sources and freshness");
  });

  test("a server error is retried once", async ({ page }) => {
    let calls = 0;
    await page.route("**/data/legislation/us/upcoming.json", async (route) => {
      calls += 1;
      if (calls === 1) await route.fulfill({ status: 503, body: "busy" });
      else await route.continue();
    });
    await page.goto("/legislation/upcoming/");
    await ready(page);
    expect(calls).toBe(2);
    await expect(page.locator(".err")).toHaveCount(0);
    await expect(page.locator("h1")).toHaveText("Upcoming");
  });

  test("a missing required file and a newer schema are reported, with a way to retry", async ({ page }) => {
    await page.route("**/data/legislation/us/members.json", (route) => route.fulfill({ status: 404, body: "" }));
    await page.goto("/legislation/votes/?level=federal");
    await ready(page);
    await expect(page.locator(".err h2")).toHaveText("This page could not be loaded");
    await expect(page.locator(".err")).toContainText("has not been published (us/members.json)");
    await expect(page.locator(".err button")).toHaveText("Try again");

    await page.unroute("**/data/legislation/us/members.json");
    await page.route("**/data/legislation/us/upcoming.json", async (route) => {
      const res = await route.fetch();
      const json = await res.json();
      json.schema_version = 99;
      await route.fulfill({ response: res, json });
    });
    await page.goto("/legislation/upcoming/");
    await ready(page);
    await expect(page.locator(".err")).toContainText("newer format");
    await expect(page.locator(".err button")).toHaveText("Reload the page");
  });

  test("an address that points outside the records folder requests nothing from it", async ({ page }) => {
    const seen = dataRequests(page);
    await page.goto("/legislation/bill/tx-..%2F..%2Fx-SB1/");
    await ready(page);
    await expect(page.locator("h1")).toHaveText("Not found");
    expect(seen.filter((r) => /SB-00\.json$|\.\./.test(r))).toEqual([]);
  });

  test("a resting pointer on another state's vote fetches its month of votes, and the click fetches nothing new", async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    test.skip(!(VSUM && VSUM.latest && VSUM.latest.length && VSLUG), "no other state's votes published");
    await page.goto(`/legislation/${VSLUG}/`);
    await ready(page);
    await page.waitForTimeout(300);
    const seen = dataRequests(page);
    const target = page.locator(`#app a[href="/legislation/vote/${VSUM.latest[0].id}/"]`).first();
    await target.hover();
    await expect.poll(() => seen.some((r) => r.includes("/votes/")), { timeout: 5_000 }).toBe(true);
    await settled(seen);
    const before = seen.length;
    await target.click();
    await expect(page).toHaveURL(new RegExp(`/legislation/vote/${VSUM.latest[0].id}/$`));
    await ready(page);
    await page.waitForTimeout(300);
    expect(seen.slice(before), "files fetched after the click").toEqual([]);
  });

  test("record links that are not http(s) are shown as text", async ({ page }) => {
    const us = read("us/members.json");
    const m = us.members.find((x) => x.body === "us-senate" && !x.former && !x.provisional);
    await page.route("**/data/legislation/us/members.json", async (route) => {
      const res = await route.fetch();
      const json = await res.json();
      const row = json.members.find((x) => x.id === m.id);
      row.urls = Object.assign({}, row.urls, { official: "javascript:alert(document.domain)", contact: "data:text/html,hi" });
      await route.fulfill({ response: res, json });
    });
    await page.goto(`/legislation/legislator/${m.id}/`);
    await ready(page);
    await expect(page.locator("dl.facts")).toContainText("Official website");
    await expect(page.locator('a[href^="javascript:"], a[href^="data:"]')).toHaveCount(0);
  });
});

// What a first visit costs: the JSON a page fetches before it is drawn, measured as the gzip
// transfer GitHub Pages would send (the dev server does not compress).
test.describe("data budget", () => {
  test.skip(!hasData || !read("geo/us-tx/counties.json"), "no national records checked out");
  const budgets = [["/legislation/texas/", 100], ["/legislation/texas/travis/", 100], ["/legislation/states/", 30], ["/legislation/", 120]];
  if (VSUM && VSUM.latest && VSUM.latest.length) {
    budgets.push([`/legislation/votes/?level=state&state=${VST}`, 120]);
    budgets.push([`/legislation/vote/${VSUM.latest[0].id}/`, 120]);
  }
  for (const [url, kb] of budgets) {
    test(`${url} is drawn with under ${kb} KB of JSON`, async ({ page }, testInfo) => {
      desktopOnly(testInfo);
      // Note when the page is first drawn, then count the records requested before that moment.
      await page.addInitScript(() => {
        new window.MutationObserver(function (list, obs) {
          const app = document.getElementById("app");
          if (app && app.getAttribute("aria-busy") === null && window.__drawnAt === undefined && document.querySelector("#app > *:not(noscript)")) { window.__drawnAt = performance.now(); obs.disconnect(); }
        }).observe(document, { subtree: true, attributes: true, attributeFilter: ["aria-busy"] });
      });
      await page.goto(url);
      await ready(page);
      await page.waitForTimeout(300);
      const seen = await page.evaluate(() => performance.getEntriesByType("resource")
        .filter((e) => e.name.includes("/data/legislation/") && e.startTime < window.__drawnAt)
        .map((e) => e.name.split("/data/legislation/")[1]));
      const unique = [...new Set(seen)];
      const bytes = unique.reduce((a, rel) => a + zlib.gzipSync(fs.readFileSync(path.join(DATA, rel))).length, 0);
      testInfo.annotations.push({ type: "json-gzip-kb", description: (bytes / 1024).toFixed(1) + " KB in " + unique.length + " files" });
      expect(bytes / 1024, unique.join(", ")).toBeLessThan(kb);
    });
  }
});

test.describe("security headers", () => {
  test.skip(!hasData, "no records checked out in studenttrustee/data/legislation/");

  test("Trusted Types is enforced on the Legislation pages", async ({ page }) => {
    await page.goto("/legislation/");
    await ready(page);
    const outcome = await page.evaluate(() => { try { document.createElement("div").innerHTML = "<b>x</b>"; return "assigned"; } catch (e) { return e.name; } });
    expect(outcome).toBe("TypeError");
  });

  test("pages name the speculation rules, served as speculation rules JSON", async ({ request }) => {
    const home = await request.get("/");
    expect(home.headers()["speculation-rules"]).toBe('"/speculation-rules.json"');
    const rules = await request.get("/speculation-rules.json");
    expect(rules.headers()["content-type"]).toMatch(/^application\/speculationrules\+json/);
    const json = await rules.json();
    expect(json.prefetch.length).toBeGreaterThan(0);
    expect(JSON.stringify(json)).toContain('"/legislation/*"');
  });

  const routes = ["/legislation/", "/legislation/states/", "/legislation/california/", "/legislation/texas/", "/legislation/votes/?level=state",
    "/legislation/bills/?level=federal", "/legislation/upcoming/", "/legislation/search/?q=water", "/legislation/sources/", "/legislation/calendars/"];
  if (VSUM && VSUM.latest && VSUM.latest.length) {
    routes.push(`/legislation/votes/?level=state&state=${VST}`, `/legislation/bills/?level=state&state=${VST}`, `/legislation/vote/${VSUM.latest[0].id}/`);
    const withBill = VSUM.latest.find((v) => v.bill_id);
    if (withBill) routes.push(`/legislation/bill/${withBill.bill_id}/`);
  }
  for (const url of routes) {
    test(`no CSP or Trusted Types violation on ${url}`, async ({ page }) => {
      const problems = [];
      await page.addInitScript(() => {
        document.addEventListener("securitypolicyviolation", (e) => console.error("CSP violation: " + e.violatedDirective + " " + e.blockedURI));
      });
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        // A records file the published data does not have yet is a 404 here. The page treats an
        // optional file as absent and reports a required one itself (tested above), so these are not
        // security problems. Any other console error, and every CSP or Trusted Types report, counts.
        if (/^Failed to load resource: the server responded with a status of 404/.test(m.text()) && (m.location().url || "").includes("/data/legislation/")) return;
        problems.push(m.text());
      });
      page.on("pageerror", (e) => problems.push(e.message));
      await page.goto(url);
      if (!/calendars/.test(url)) await ready(page);
      await page.waitForTimeout(500);
      expect(problems).toEqual([]);
    });
  }
});
