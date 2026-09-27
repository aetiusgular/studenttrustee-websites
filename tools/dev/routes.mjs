// Loads each route, waits for the legislation app to settle, and prints console errors,
// page errors, failed requests, the h1 and a short text sample. Dev aid only.
//   node tools/dev/routes.mjs http://127.0.0.1:8100 /legislation/ /legislation/states/ ...
import { chromium } from "@playwright/test";
const [base, ...routes] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
p.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log("  [console]", m.type(), m.text().slice(0, 300)); });
p.on("pageerror", (e) => console.log("  [pageerror]", e.message.slice(0, 500)));
p.on("requestfailed", (r) => console.log("  [requestfailed]", r.url(), r.failure() && r.failure().errorText));
p.on("response", (r) => { if (r.status() >= 400) console.log("  [http]", r.status(), r.url()); });
for (const r of routes) {
  console.log("==", r);
  const t0 = Date.now();
  await p.goto(base + r, { waitUntil: "load" });
  try { await p.waitForSelector("#app:not([aria-busy])", { timeout: 20000 }); } catch { console.log("  [timeout] app still busy"); }
  await p.waitForTimeout(200);
  const info = await p.evaluate(() => ({ h1: document.querySelector("h1") && document.querySelector("h1").textContent, title: document.title, text: (document.getElementById("app") || document.body).innerText.replace(/\s+/g, " ").slice(0, 400), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
  console.log("  ms", Date.now() - t0, "| h1:", info.h1, "| overflow:", info.overflow);
  console.log("  text:", info.text);
}
await b.close();
