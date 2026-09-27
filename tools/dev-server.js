#!/usr/bin/env node
// Minimal static server that mimics how Netlify serves these folders:
// pretty URLs (/map -> map.html), directory indexes (/districts/ -> districts/index.html),
// and a few _redirects rules (SPA rewrite for /legislation/*, 301 for /legislature).
// Used by the Playwright suite and for local development. No dependencies.
//
//   node tools/dev-server.js                 # studenttrustee on 8100, volunteer on 8101
//   node tools/dev-server.js studenttrustee 8100

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".geojson": "application/geo+json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json", ".xml": "application/xml", ".txt": "text/plain; charset=utf-8", ".pdf": "application/pdf",
  ".woff2": "font/woff2", ".map": "application/json",
};

function readRedirects(dir) {
  const file = path.join(dir, "_redirects");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n")
    .map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    .map((l) => { const [from, to, status] = l.split(/\s+/); return { from, to, status: Number(status || 301) }; });
}

function matchRedirect(rules, pathname) {
  for (const r of rules) {
    if (r.from.endsWith("/*")) {
      const base = r.from.slice(0, -1);
      if (pathname.startsWith(base)) return { ...r, to: r.to.replace(":splat", pathname.slice(base.length)) };
    } else if (r.from === pathname) return r;
  }
  return null;
}

export function serve(folder, port) {
  const dir = path.join(ROOT, folder);
  const rules = readRedirects(dir);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    let pathname = decodeURIComponent(url.pathname);
    const rule = matchRedirect(rules, pathname);
    if (rule && rule.status !== 200) {
      res.writeHead(rule.status, { Location: rule.to }); res.end(); return;
    }
    if (rule && rule.status === 200) pathname = rule.to;
    const candidates = [pathname, pathname + ".html", path.join(pathname, "index.html")];
    for (const c of candidates) {
      const file = path.join(dir, c);
      if (!file.startsWith(dir)) break;
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, { "Content-Type": TYPES[ext] || "application/octet-stream", "Cache-Control": "no-store" });
        fs.createReadStream(file).pipe(res); return;
      }
    }
    const notFound = path.join(dir, "404.html");
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.existsSync(notFound) ? fs.readFileSync(notFound) : "<!doctype html><title>Not found</title><h1>Not found</h1>");
  });
  server.listen(port, "127.0.0.1", () => console.log(`${folder} -> http://127.0.0.1:${port}`));
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [folder, port] = process.argv.slice(2);
  if (folder) serve(folder, Number(port || 8100));
  else { serve("studenttrustee", 8100); serve("volunteer", 8101); }
}
