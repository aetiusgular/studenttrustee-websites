// Keyboard walkthrough of the Legislation section: skip link, tab order, choosing a state,
// following links with Enter, focus after navigation, Back, and "Show more". Dev aid only.
//   node tools/dev/keyboard.mjs http://127.0.0.1:8100
import { chromium } from "@playwright/test";
const base = process.argv[2] || "http://127.0.0.1:8100";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
const active = () => p.evaluate(() => { const a = document.activeElement; return a ? (a.tagName.toLowerCase() + (a.id ? "#" + a.id : "") + " " + (a.textContent || a.value || "").trim().replace(/\s+/g, " ").slice(0, 50)) : null; });
const settle = () => p.waitForSelector("#app:not([aria-busy])");
const log = (...a) => console.log(...a);

await p.goto(base + "/legislation/"); await settle();
await p.keyboard.press("Tab"); log("1st Tab:", await active());
await p.keyboard.press("Enter"); log("after skip link:", await active());
const order = [];
for (let i = 0; i < 16; i++) { await p.keyboard.press("Tab"); order.push(await active()); }
log("tab order:\n  " + order.join("\n  "));

// choose California with the keyboard and press Go
await p.focus("#state-pick");
await p.keyboard.type("Calif");
await p.keyboard.press("Tab"); log("after select, focus:", await active());
await p.keyboard.press("Enter"); await settle();
log("url:", p.url(), "| focus:", await active());

// follow the first county link with Enter
const county = await p.$("#counties ul.cols a");
await county.focus(); await p.keyboard.press("Enter"); await settle();
log("url:", p.url(), "| focus:", await active());

// Back returns to California
await p.goBack(); await settle();
log("after Back:", p.url(), "| h1:", await p.textContent("h1"));

// Show more on a long list moves focus to the first new item
await p.goto(base + "/legislation/votes/?level=federal"); await settle();
const btn = await p.$("button:has-text('Show more')");
await btn.focus(); await p.keyboard.press("Enter");
log("after Show more, focus:", await active(), "| count:", await p.textContent(".count"));

// position filter buttons on a vote page toggle aria-pressed
await p.goto(base + "/legislation/votes/?level=federal"); await settle();
await p.click("ul.votes h3 a"); await settle();
const pressed = await p.$$eval("fieldset button", (bs) => bs.map((x) => x.textContent + "=" + x.getAttribute("aria-pressed")));
log("vote page", p.url(), "| filters:", pressed.join(", "));
const second = (await p.$$("fieldset button"))[1];
await second.focus(); await p.keyboard.press("Space");
log("after Space:", await p.$$eval("fieldset button", (bs) => bs.map((x) => x.getAttribute("aria-pressed")).join(",")), "|", await p.textContent(".count"));
log("page errors:", errors.length ? errors : "none");
await b.close();
