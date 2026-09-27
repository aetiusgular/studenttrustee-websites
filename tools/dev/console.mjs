import { chromium } from "@playwright/test";
const b = await chromium.launch(); const p = await b.newPage();
p.on("console", m => console.log("[console]", m.type(), m.text().slice(0, 300)));
p.on("pageerror", e => console.log("[pageerror]", e.message.slice(0, 500)));
await p.goto(process.argv[2], { waitUntil: "load" }); await p.waitForTimeout(3000);
console.log("dialog open?", await p.evaluate(() => { const d = document.getElementById("intro"); return d && d.open; }));
await b.close();
