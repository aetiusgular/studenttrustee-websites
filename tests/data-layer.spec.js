// The Legislation section's data layer and its security headers, in a real browser against the
// dev server (which applies studenttrustee/_headers and serves the records from
// studenttrustee/data/legislation/):
//   - intent prefetch: a resting pointer fetches the next page's files, so the click needs none;
//   - older addresses land on the new ones, and Back after one goes to the page before;
//   - filters: unknown values are ignored and fetch nothing; a level chip keeps focus and announces
//     the count; the drawer changes nothing until Apply; Show more loads older months in order;
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
// A California county board that publishes its votes.
const CA_BOARD = ((read("us-ca/counties/index.json") || { counties: [] }).counties.find((c) => c.coverage === "votes") || null);

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
    await page.goto("/legislation/");
    await ready(page);
    await page.waitForTimeout(300);
    const seen = dataRequests(page);
    const target = page.locator('.usmap a[href="/legislation/texas/"]');
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
    await page.goto("/legislation/");
    await ready(page);
    await page.waitForTimeout(300);
    const seen = dataRequests(page);
    await page.locator('.usmap a[href="/legislation/texas/"]').hover();
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
    await page.click("#app a[href='/legislation/sources/']");
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
    await expect(page.locator(".err-links")).toHaveCount(0);
  });

  // In production the records come from another site (GitHub Pages). If that site is down or has
  // never been published, the browser gets no usable answer at all, which is a network error.
  test("when the records site cannot be reached, the page says so and links the official sources", async ({ page }) => {
    await page.route("**/data/legislation/**", (route) => route.abort("connectionrefused"));
    await page.goto("/legislation/");
    await ready(page);
    await expect(page.locator(".err h2")).toHaveText("This page could not be loaded");
    await expect(page.locator(".err")).toContainText("that site is down or has not published the records yet");
    await expect(page.locator(".err button")).toHaveText("Try again");
    const links = page.locator(".err-links a");
    await expect(links).toHaveCount(4);
    for (const href of await links.evaluateAll((els) => els.map((a) => a.href))) expect(href).toMatch(/^https:\/\//);
    for (const h of await links.evaluateAll((els) => els.map((a) => a.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(44);
  });

  test("before a state's county file is published, its county addresses say when they will appear", async ({ page }) => {
    await page.route("**/data/legislation/geo/us-tx/counties.json", (route) => route.fulfill({ status: 404, body: "" }));
    for (const url of ["/legislation/texas/travis/", "/legislation/texas/travis/representatives/"]) {
      await page.goto(url);
      await ready(page);
      await expect(page.locator(".err")).toHaveCount(0);
      await expect(page.locator("h1")).toHaveText("Texas");
      await expect(page.locator("#app .note")).toContainText("County pages for Texas appear after the next nightly update of the records.");
      await expect(page.locator('#app .note a[href="/legislation/texas/"]')).toHaveCount(1);
    }
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
    await page.goto(`/legislation/${VSLUG}/?level=state`);
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

  // Every address the section used before layout D, and where it lands.
  const OLD = [
    ["/legislation/states/", "/legislation/", "Who voted for what, in every state."],
    ["/legislation/texas/legislators/", "/legislation/texas/representatives/", "Texas"],
    ["/legislation/votes/?level=state", "/legislation/california/?level=state", "California"],
    ["/legislation/votes/?level=state&state=TX&result=passed", "/legislation/texas/?level=state&result=passed", "Texas"],
    ["/legislation/votes/?level=county", "/legislation/california/?level=county", "California"],
    ["/legislation/bills/?level=state&state=TX", "/legislation/texas/bills/", "Texas"],
    ["/legislation/bills/?level=state&type=SB", "/legislation/california/bills/?type=SB", "California"],
  ];
  if (CA_BOARD) OLD.push([`/legislation/votes/?level=county&county=${CA_BOARD.fips}`, `/legislation/california/${CA_BOARD.slug}/?level=county`, CA_BOARD.county]);
  for (const [from, to, h1] of OLD) {
    test(`the old address ${from} lands on ${to}`, async ({ page }) => {
      await page.goto(from);
      await ready(page);
      expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(to);
      await expect(page.locator("h1")).toHaveText(h1);
    });
  }

  test("Back after an in-app link to an old address goes to the page before it", async ({ page }) => {
    await page.goto("/legislation/texas/");
    await ready(page);
    await page.evaluate(() => {
      const a = document.createElement("a");
      a.href = "/legislation/votes/?level=state&state=TX";
      a.id = "old-link";
      a.textContent = "old";
      document.getElementById("app").prepend(a);
    });
    await page.click("#old-link");
    await expect(page).toHaveURL(/\/legislation\/texas\/\?level=state$/);
    await ready(page);
    await page.goBack();
    await expect(page).toHaveURL(/\/legislation\/texas\/$/);
    await ready(page);
    await expect(page.locator("#results")).toHaveText("Latest votes in Texas, newest first");
  });

  test("filter values the page does not know are ignored, and nothing is requested for them", async ({ page }) => {
    const seen = dataRequests(page);
    await page.goto("/legislation/texas/?level=nowhere&body=..%2F..%2Fsecret&month=2026-13&result=maybe");
    await ready(page);
    await settled(seen);
    await expect(page.locator("#results")).toHaveText("Latest votes in Texas, newest first");
    await expect(page.locator('.chip[aria-current="true"]')).toHaveText("All levels");
    await expect(page.locator("#more-btn")).toHaveText("More filters");
    expect(seen.filter((r) => /nowhere|secret|2026-13|maybe|\.\./.test(r))).toEqual([]);
  });

  test("a level chip narrows the list, keeps focus on itself and announces the new count", async ({ page }) => {
    await page.goto("/legislation/california/");
    await ready(page);
    await page.locator('.chip[data-level="state"]').click();
    await expect(page).toHaveURL(/\/legislation\/california\/\?level=state$/);
    await ready(page);
    await expect.poll(() => page.evaluate(() => document.activeElement && document.activeElement.getAttribute("data-level"))).toBe("state");
    await expect(page.locator("#status")).toHaveText("Latest state votes in California, newest first");
    const levels = await page.locator(".vrow .vr-level").allTextContents();
    expect(levels.length).toBeGreaterThan(0);
    expect(levels.every((x) => /state/i.test(x))).toBe(true);
  });

  test("the filter drawer changes nothing until Apply, then says how many filters are on", async ({ page }) => {
    await page.goto("/legislation/california/");
    await ready(page);
    const heading = await page.locator("#results").textContent();
    await page.locator("#more-btn").click();
    await expect(page.locator("#filters")).toBeVisible();
    await page.selectOption("#f-result", "passed");
    await page.selectOption("#f-body", "ca-senate");
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(/\/legislation\/california\/$/);
    await expect(page.locator("#results")).toHaveText(heading);
    await page.locator("#filters button[type=submit]").click();
    await expect(page).toHaveURL(/\/legislation\/california\/\?level=state&body=ca-senate&result=passed$/);
    await ready(page);
    await expect.poll(() => page.evaluate(() => document.activeElement && document.activeElement.id)).toBe("results");
    await expect(page.locator("#results")).toHaveText("Latest votes of the California Senate that passed, newest first");
    await expect(page.locator("#more-btn")).toHaveText("More filters (2 on)");
    const metas = await page.locator(".vrow .vr-meta").allTextContents();
    expect(metas.every((m) => m.includes("California Senate"))).toBe(true);
    await page.locator("#filters button", { hasText: "Clear all" }).click();
    await expect(page).toHaveURL(/\/legislation\/california\/\?level=state$/);
  });

  test("Show more loads older months and keeps the list newest first", async ({ page }) => {
    await page.goto("/legislation/california/?level=state");
    await ready(page);
    const first = await page.locator(".vrow").count();
    await page.locator(".show-more button").click();
    await expect.poll(() => page.locator(".vrow").count(), { timeout: 30_000 }).toBeGreaterThan(first);
    const dates = await page.locator(".vrow time").evaluateAll((els) => els.map((t) => t.getAttribute("datetime").slice(0, 10)));
    expect(dates.every((d, i) => i === 0 || dates[i - 1] >= d)).toBe(true);
    // focus moves to the first row added
    await expect.poll(() => page.evaluate((n) => { const rows = document.querySelectorAll(".vrow"); return rows[n] && rows[n].contains(document.activeElement); }, first)).toBe(true);
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
  // The map, then every door of a state and a county, each under 100 KB (the plan's budget).
  const budgets = [["/legislation/", 30], ["/legislation/texas/", 100], ["/legislation/texas/representatives/", 100], ["/legislation/texas/upcoming/", 100],
    ["/legislation/texas/travis/", 100], ["/legislation/texas/travis/representatives/", 100], ["/legislation/california/", 100], ["/legislation/california/representatives/", 100],
    ["/legislation/california/upcoming/", 100]];
  if (CA_BOARD) budgets.push([`/legislation/california/${CA_BOARD.slug}/`, 100]);
  if (VSUM && VSUM.latest && VSUM.latest.length) {
    budgets.push([`/legislation/${VSLUG}/?level=state`, 100]);
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

  const routes = ["/legislation/", "/legislation/california/", "/legislation/california/?level=state&month=2026-08", "/legislation/texas/", "/legislation/texas/representatives/",
    "/legislation/texas/upcoming/", "/legislation/texas/travis/", "/legislation/california/bills/", "/legislation/texas/sources/", "/legislation/votes/?level=federal",
    "/legislation/bills/?level=federal", "/legislation/upcoming/", "/legislation/search/?q=water", "/legislation/sources/", "/legislation/calendars/"];
  if (VSUM && VSUM.latest && VSUM.latest.length) {
    routes.push(`/legislation/${VSLUG}/?level=state`, `/legislation/${VSLUG}/bills/`, `/legislation/vote/${VSUM.latest[0].id}/`);
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
