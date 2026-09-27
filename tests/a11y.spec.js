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

const PAGES = [
  { name: "home", url: "/" },
  { name: "map", url: "/map", settle: 4000 },
  { name: "districts", url: "/districts/" },
  { name: "district", url: "/districts/los-rios-ccd/" },
  { name: "district-vacant", url: "/districts/ohlone-ccd/" },
  { name: "legislature", url: "/legislature" },
  { name: "about", url: "/about" },
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
    const r = el.getBoundingClientRect();
    if (r.width < 44 || r.height < 44) targets.push({ tag: el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : ""), w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent || el.getAttribute("aria-label") || el.value || "").trim().slice(0, 30) });
  }
  return { contrast, small, targets, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, lang: document.documentElement.lang, title: document.title,
    skipLink: !!document.querySelector("a[href^='#'][class*='skip'], a[href='#main'], a[href='#content']"), main: document.querySelectorAll("main").length, h1: document.querySelectorAll("h1").length };
}

for (const p of PAGES) {
  test(`${p.name}: WCAG AAA scan and layout`, async ({ page }, testInfo) => {
    const key = p.name;
    const allowed = baseline[key] || {};
    await page.goto(p.url, { waitUntil: "load" });
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
      await page.goto(p.url, { waitUntil: "load" });
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
