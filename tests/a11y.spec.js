// Accessibility and layout checks for every page, at every viewport in playwright.config.js.
//
// Three layers per page:
//   1. axe-core with the full WCAG 2.x A/AA/AAA tag set and the AAA contrast rule enabled.
//   2. A custom scan of every visible text node against the AAA 7:1 ratio (4.5:1 for large text),
//      pointer targets under 44x44 CSS px (WCAG 2.5.5), and text under 12 px.
//   3. Layout: no horizontal overflow at the current viewport, and none at 320 px (WCAG 1.4.10 reflow).
//
// tests/a11y-baseline.json lists what is still allowed to fail, per page. It should shrink to nothing.
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const baseline = JSON.parse(fs.readFileSync(path.join(here, "a11y-baseline.json"), "utf8"));
const report = [];

// The Legislation section renders from the records in studenttrustee/data/legislation/ (the data
// branch, checked out by CI and by tools/pull-data.sh). Detail pages are picked from those records,
// so the suite keeps working as votes, members and sessions change. "ready" waits until the app
// has rendered (aria-busy cleared). With no records checked out, these pages are skipped.
function legislationPages() {
  const DATA = path.join(here, "..", "studenttrustee", "data", "legislation");
  const read = (rel) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, rel), "utf8")); } catch { return null; } };
  if (!read("manifest.json")) return [];
  const ready = (sel) => `#app:not([aria-busy]) ${sel}`;
  // Layout D: the map of states; a state's three doors, its bills and sources; a county's doors.
  // "open" names a control the test presses before the scan (the filter drawer); "abort" and
  // "missing" make the matching records requests fail or answer 404.
  const pages = [
    { name: "leg-map", url: "/legislation/", ready: ready(".map-wrap") },
    { name: "leg-california", url: "/legislation/california/", ready: ready("#results") },
    { name: "leg-california-drawer", url: "/legislation/california/?level=state", ready: ready("#results"), open: "#more-btn" },
    { name: "leg-california-representatives", url: "/legislation/california/representatives/", ready: ready(".rep-group") },
    { name: "leg-california-upcoming", url: "/legislation/california/upcoming/", ready: ready("#results") },
    { name: "leg-california-bills", url: "/legislation/california/bills/?type=SB", ready: ready("#results") },
    { name: "leg-votes-federal", url: "/legislation/votes/?level=federal", ready: ready("form.filters") },
    { name: "leg-bills-federal", url: "/legislation/bills/?level=federal", ready: ready("form.filters") },
    { name: "leg-upcoming", url: "/legislation/upcoming/", ready: ready("form.filters") },
    { name: "leg-search", url: "/legislation/search/?q=school", ready: ready(".sec") },
    { name: "leg-sources", url: "/legislation/sources/", ready: ready("table.tbl") },
    { name: "leg-not-found", url: "/legislation/nowhere/at-all/", ready: ready("p") },
    // The records site cannot be reached (production reads it from GitHub Pages), and a county
    // address in a state whose county file has not been published yet.
    { name: "leg-records-down", url: "/legislation/", ready: ready(".err-links"), abort: "**/data/legislation/**" },
    { name: "leg-county-pending", url: "/legislation/texas/travis/", ready: ready(".note"), missing: "**/data/legislation/geo/us-tx/counties.json" },
  ];
  // Every state outside California: its doors, its sources, a county with a board link and its
  // representatives, a county with no county government, a territory with no legislature.
  if (read("geo/us-tx/counties.json")) {
    pages.push({ name: "leg-other-state", url: "/legislation/texas/", ready: ready("#results") });
    pages.push({ name: "leg-other-state-representatives", url: "/legislation/texas/representatives/", ready: ready(".rep-group") });
    pages.push({ name: "leg-other-state-upcoming", url: "/legislation/texas/upcoming/", ready: ready("#results") });
    pages.push({ name: "leg-other-state-sources", url: "/legislation/texas/sources/", ready: ready("table.tbl") });
    pages.push({ name: "leg-county-national", url: "/legislation/texas/travis/", ready: ready("#results") });
    pages.push({ name: "leg-county-representatives", url: "/legislation/texas/travis/representatives/", ready: ready(".rep-group") });
    pages.push({ name: "leg-territory", url: "/legislation/guam/", ready: ready("#results") });
    pages.push({ name: "leg-search-place", url: "/legislation/search/?q=travis", ready: ready(".sec") });
  }
  if (read("geo/us-ct/counties.json")) pages.push({ name: "leg-county-no-government", url: "/legislation/connecticut/fairfield/", ready: ready("#results") });
  // A county board outside California that publishes on Legistar, its upcoming meetings, and one of its votes.
  const national = read("counties/index.json");
  const statesFile = read("geo/states.json");
  const board = national && national.counties.find((c) => c.coverage === "votes" && c.slug);
  const stateRow = board && statesFile && statesFile.states.find((s) => s.code === board.state);
  if (board && stateRow) {
    pages.push({ name: "leg-county-board-national", url: `/legislation/${stateRow.slug}/${board.slug}/?level=county`, ready: ready("#results") });
    pages.push({ name: "leg-county-board-upcoming", url: `/legislation/${stateRow.slug}/${board.slug}/upcoming/`, ready: ready("#results") });
  }
  const natLatest = read("counties/latest.json");
  if (natLatest && natLatest.rows.length) pages.push({ name: "leg-vote-county-national", url: `/legislation/vote/${natLatest.rows[0][0]}/`, ready: ready("dl.facts") });
  const tx = read("us-tx/members.json");
  if (tx && tx.members.length) pages.push({ name: "leg-legislator-other-state", url: `/legislation/legislator/${tx.members[0].id}/`, ready: ready("dl.facts") });
  // Other states' bills and votes (Open States bulk data), once the nightly job has published some:
  // that state's votes and bills, a vote, its bill, and a legislator with votes on record.
  const legs = read("legislatures.json");
  const vst = legs && Object.keys(legs.states).filter((k) => k !== "CA" && legs.states[k].votes > 0).sort()[0];
  const vsum = vst && read(`us-${vst.toLowerCase()}/summary.json`);
  const vslug = vst && statesFile && (statesFile.states.find((s) => s.code === vst) || {}).slug;
  if (vsum && vsum.latest && vsum.latest.length && vslug) {
    const st = vst.toLowerCase();
    const v = vsum.latest.find((x) => x.bill_id) || vsum.latest[0];
    pages.push({ name: "leg-votes-other-state", url: `/legislation/${vslug}/?level=state`, ready: ready("#results") });
    pages.push({ name: "leg-bills-other-state", url: `/legislation/${vslug}/bills/`, ready: ready("#results") });
    pages.push({ name: "leg-vote-other-state", url: `/legislation/vote/${v.id}/`, ready: ready("dl.facts") });
    if (v.bill_id) pages.push({ name: "leg-bill-other-state", url: `/legislation/bill/${v.bill_id}/`, ready: ready("dl.facts") });
    const vidx = read(`us-${st}/votes/index.json`);
    const newest = vidx && vidx.shards.slice().sort((a, b) => b.month.localeCompare(a.month) || a.body.localeCompare(b.body))[0];
    const month = newest && read(`us-${st}/votes/${newest.session}/${newest.file}`);
    const members = read(`us-${st}/members.json`);
    const voter = month && members && month.members.find((id) => members.members.some((m) => m.id === id));
    if (voter) pages.push({ name: "leg-legislator-record-other-state", url: `/legislation/legislator/${voter}/`, ready: ready("#record .sum") });
  }
  const col = (d, k) => d.columns.indexOf(k);
  const usLatest = read("us/latest.json");
  if (usLatest && usLatest.rows.length) {
    pages.push({ name: "leg-vote-federal", url: `/legislation/vote/${usLatest.rows[0][0]}/?state=TX`, ready: ready("dl.facts") });
    const withBill = usLatest.rows.find((r) => r[col(usLatest, "bill_id")]);
    if (withBill) pages.push({ name: "leg-bill-federal", url: `/legislation/bill/${withBill[col(usLatest, "bill_id")]}/`, ready: ready("dl.facts") });
  }
  const us = read("us/members.json");
  const senator = us && us.members.find((m) => m.body === "us-senate" && m.state === "CA" && !m.former && !m.provisional);
  if (senator) pages.push({ name: "leg-legislator-federal", url: `/legislation/legislator/${senator.id}/`, ready: ready("dl.facts") });
  const caLatest = read("us-ca/latest.json");
  if (caLatest && caLatest.rows.length) {
    pages.push({ name: "leg-vote-state", url: `/legislation/vote/${caLatest.rows[0][0]}/`, ready: ready("dl.facts") });
    pages.push({ name: "leg-bill-state", url: `/legislation/bill/${caLatest.rows[0][col(caLatest, "bill_id")]}/`, ready: ready("dl.facts") });
  }
  const ca = read("us-ca/members.json");
  const asm = ca && ca.members.find((m) => m.active);
  if (asm) pages.push({ name: "leg-legislator-state", url: `/legislation/legislator/${asm.id}/`, ready: ready("dl.facts") });
  const counties = read("us-ca/counties/index.json");
  if (counties) {
    const voting = counties.counties.find((c) => c.coverage === "votes");
    const linksOnly = counties.counties.find((c) => c.coverage === "links");
    if (voting) {
      pages.push({ name: "leg-county-votes", url: `/legislation/california/${voting.slug}/?level=county`, ready: ready("#results") });
      pages.push({ name: "leg-county-upcoming", url: `/legislation/california/${voting.slug}/upcoming/`, ready: ready("#results") });
      const cboard = read(`us-ca/counties/${voting.fips}/board.json`);
      const sup = cboard && cboard.members.find((m) => !m.provisional);
      if (sup) pages.push({ name: "leg-legislator-county", url: `/legislation/legislator/${sup.id}/`, ready: ready("dl.facts") });
    }
    if (linksOnly) pages.push({ name: "leg-county-links", url: `/legislation/california/${linksOnly.slug}/`, ready: ready("#results") });
    const coLatest = read("us-ca/counties/latest.json");
    if (coLatest && coLatest.rows.length) pages.push({ name: "leg-vote-county", url: `/legislation/vote/${coLatest.rows[0][0]}/`, ready: ready("dl.facts") });
  }
  return pages;
}

// The Elections section (assets/elections.js) renders from elections/* in the same records folder.
// Pages that depend on a file are added only when it is there, so a checkout without the election
// records still runs the rest.
function electionPages() {
  const DATA = path.join(here, "..", "studenttrustee", "data", "legislation");
  const read = (rel) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, rel), "utf8")); } catch { return null; } };
  if (!read("manifest.json")) return [];
  const ready = (sel) => `#app:not([aria-busy]) ${sel}`;
  const pages = [
    { name: "el-map", url: "/elections/", ready: ready(".map-wrap") },
    { name: "el-state", url: "/elections/california/", ready: ready("#results") },
    { name: "el-state-level-state", url: "/elections/california/?level=state", ready: ready("#results") },
    { name: "el-state-colleges", url: "/elections/california/?level=college", ready: ready("#results") },
    { name: "el-state-results", url: "/elections/california/results/", ready: ready("#results") },
    { name: "el-ballot", url: "/elections/ballot/", ready: ready("form.ballot-form") },
    { name: "el-state-ballot", url: "/elections/california/ballot/", ready: ready("form.ballot-form") },
    { name: "el-races", url: "/elections/races/", ready: ready("#results") },
    { name: "el-sources", url: "/elections/sources/", ready: ready("table.tbl") },
    { name: "el-not-found", url: "/elections/nowhere/", ready: ready("p") },
  ];
  const idx = read("elections/us/federal-index.json");
  if (idx && idx.rows.length) {
    pages.push({ name: "el-race", url: `/elections/race/${idx.rows[0][0]}/`, ready: ready(".cands") });
    const st = idx.rows[0][1].toLowerCase();
    if (st !== "ca") pages.push({ name: "el-other-state", url: `/elections/${{ tx: "texas" }[st] || st}/`, ready: ready("#results") });
  }
  return pages;
}

const PAGES = [
  { name: "home", url: "/" },
  { name: "map", url: "/map", settle: 4000 },
  { name: "districts", url: "/districts/" },
  { name: "district", url: "/districts/los-rios-ccd/" },
  { name: "district-vacant", url: "/districts/ohlone-ccd/" },
  { name: "calendars", url: "/legislation/calendars/" },
  { name: "about", url: "/about" },
  { name: "accessibility", url: "/accessibility" },
  ...legislationPages(),
  ...electionPages(),
  { name: "volunteer", url: "http://127.0.0.1:8101/", settle: 1500 },
];

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag2aaa", "wcag21a", "wcag21aa", "wcag21aaa", "wcag22aa", "wcag22aaa", "best-practice"];

// Runs in the page. Mirrors WCAG 1.4.6 (enhanced contrast), 2.5.5 (target size) and a 12 px floor.
function customScan() {
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const parse = (s) => { const m = s && s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(",").map(Number); return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 }; };
  const blend = (fg, bg, a) => fg.map((v, i) => Math.round(v * a + bg[i] * (1 - a)));
  const effBg = (el) => {
    let e = el; let acc = null;
    while (e && e !== document.documentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0) { if (c.a >= 0.99) return acc ? blend(acc.rgb, c.rgb, acc.a) : c.rgb; if (!acc) acc = c; }
      e = e.parentElement;
    }
    const root = parse(getComputedStyle(document.body).backgroundColor);
    const base = root && root.a > 0.99 ? root.rgb : [255, 255, 255];
    return acc ? blend(acc.rgb, base, acc.a) : base;
  };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const visible = (el) => { const cs = getComputedStyle(el); if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const contrast = [], small = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  while (walker.nextNode()) {
    const tn = walker.currentNode; if (!tn.textContent.trim()) continue;
    const el = tn.parentElement; if (!el || seen.has(el) || el.closest("script,style,noscript,[hidden],[aria-hidden='true']")) continue;
    seen.add(el); if (!visible(el)) continue;
    const cs = getComputedStyle(el); const fg = parse(cs.color); if (!fg) continue;
    const px = parseFloat(cs.fontSize); const bold = parseInt(cs.fontWeight, 10) >= 700;
    const large = px >= 24 || (px >= 18.66 && bold); const need = large ? 4.5 : 7;
    const bg = effBg(el); const fgc = fg.a < 1 ? blend(fg.rgb, bg, fg.a) : fg.rgb; const rr = ratio(fgc, bg);
    const tag = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : "");
    if (rr < need) contrast.push({ tag, text: tn.textContent.trim().slice(0, 40), fg: cs.color, bg: `rgb(${bg.join(",")})`, ratio: +rr.toFixed(2), need, px });
    if (px < 12) small.push({ tag, px, text: tn.textContent.trim().slice(0, 30) });
  }
  const targets = [];
  for (const el of document.querySelectorAll("a[href],button,input,select,textarea,summary,[role=button],[role=tab],[tabindex]:not([tabindex='-1'])")) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    // Inline text links inside a sentence are exempt from 2.5.5.
    if (el.tagName === "A" && cs.display === "inline" && el.parentElement && el.parentElement.textContent.trim().length > el.textContent.trim().length + 10) continue;
    // A checkbox or radio inside its <label> is hit anywhere on the label, so the label's box is the target.
    const hit = (el.type === "checkbox" || el.type === "radio") && el.closest("label") ? el.closest("label") : el;
    const r = hit.getBoundingClientRect();
    if (r.width < 44 || r.height < 44) targets.push({ tag: el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : ""), w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent || el.getAttribute("aria-label") || el.value || "").trim().slice(0, 30) });
  }
  return { contrast, small, targets, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, lang: document.documentElement.lang, title: document.title,
    skipLink: !!document.querySelector("a[href^='#'][class*='skip'], a[href='#main'], a[href='#content']"), main: document.querySelectorAll("main").length, h1: document.querySelectorAll("h1").length };
}

for (const p of PAGES) {
  test(`${p.name}: WCAG AAA scan and layout`, async ({ page }, testInfo) => {
    const key = p.name;
    const allowed = baseline[key] || {};
    if (p.abort) await page.route(p.abort, (route) => route.abort("connectionrefused"));
    if (p.missing) await page.route(p.missing, (route) => route.fulfill({ status: 404, body: "" }));
    await page.goto(p.url, { waitUntil: "load" });
    if (p.ready) await page.waitForSelector(p.ready, { timeout: 30_000 });
    if (p.open) await page.click(p.open);
    await page.waitForTimeout(p.settle || 500);

    const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS)
      .options({ rules: { "color-contrast-enhanced": { enabled: true } } }).analyze();
    const custom = await page.evaluate(customScan);

    const violations = axe.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) }));
    const entry = { page: key, viewport: testInfo.project.name, violations, contrastFails: custom.contrast.length, smallText: custom.small.length, smallTargets: custom.targets.length, overflow: custom.overflow, sampleContrast: custom.contrast.slice(0, 5), sampleTargets: custom.targets.slice(0, 5), sampleSmall: custom.small.slice(0, 5) };
    report.push(entry);
    await testInfo.attach("a11y.json", { body: JSON.stringify(entry, null, 2), contentType: "application/json" });

    const unexpected = violations.filter((v) => !(allowed.axe || []).includes(v.id));
    expect(unexpected, `unexpected axe violations: ${JSON.stringify(unexpected)}`).toEqual([]);
    expect(custom.contrast.length, `text below AAA contrast: ${JSON.stringify(custom.contrast.slice(0, 8))}`).toBeLessThanOrEqual(allowed.contrast ?? 0);
    expect(custom.targets.length, `pointer targets under 44px: ${JSON.stringify(custom.targets.slice(0, 8))}`).toBeLessThanOrEqual(allowed.targets ?? 0);
    expect(custom.small.length, `text under 12px: ${JSON.stringify(custom.small.slice(0, 8))}`).toBeLessThanOrEqual(allowed.small ?? 0);
    expect(custom.overflow, "horizontal overflow at this viewport").toBeLessThanOrEqual(0);
    expect(custom.lang).toBe("en");
    expect(custom.main, "exactly one <main>").toBe(1);
    expect(custom.h1, "exactly one <h1>").toBe(1);
    expect(custom.skipLink, "skip link present").toBe(allowed.skipLink === false ? false : true);
  });
}

test.describe("reflow at 320 px (WCAG 1.4.10)", () => {
  test.use({ viewport: { width: 320, height: 640 } });
  for (const p of PAGES) {
    test(`${p.name}: no horizontal scroll at 320 px`, async ({ page }) => {
      if (p.abort) await page.route(p.abort, (route) => route.abort("connectionrefused"));
      if (p.missing) await page.route(p.missing, (route) => route.fulfill({ status: 404, body: "" }));
      await page.goto(p.url, { waitUntil: "load" });
      if (p.ready) await page.waitForSelector(p.ready, { timeout: 30_000 });
      if (p.open) await page.click(p.open);
      await page.waitForTimeout(p.settle ? 1500 : 300);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const allowed = (baseline[p.name] || {}).reflow320 ?? 0;
      expect(overflow, "content wider than the 320 px viewport").toBeLessThanOrEqual(allowed);
    });
  }
});

test.afterAll(async () => {
  const out = path.join(here, "..", "test-results", "a11y-report.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(out, "utf8")); } catch { /* first writer */ }
  fs.writeFileSync(out, JSON.stringify(existing.concat(report), null, 2));
});
