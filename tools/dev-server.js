#!/usr/bin/env node
// Minimal static server that mimics how Netlify serves these folders:
// pretty URLs (/map -> map.html), directory indexes (/districts/ -> districts/index.html),
// the _redirects rules (SPA rewrite for /legislation/*, 301 for /legislature), and the _headers
// rules (CSP, Trusted Types, Speculation-Rules), so the test suite runs under the real policies.
// Like Netlify (and its CLI), every rule whose path matches applies, and a header set by a later
// rule replaces the same header from an earlier one. Cache-Control is always no-store here.
// The Legislation page reads its records from the data host named in data/site.json; this server
// points it at the local copy in data/legislation/ instead, so development and tests never reach
// the live records. Used by the Playwright suite and for local development. No dependencies.
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

export function readHeaders(dir) {
  const file = path.join(dir, "_headers");
  if (!fs.existsSync(file)) return [];
  const rules = [];
  let cur = null;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      const pattern = line.trim();
      const re = new RegExp("^" + pattern.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
      cur = { pattern, re, headers: {} };
      rules.push(cur);
      continue;
    }
    const i = line.indexOf(":");
    if (!cur || i < 0) continue;
    const name = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    cur.headers[name] = cur.headers[name] ? cur.headers[name] + ", " + value : value;
  }
  return rules;
}

export function headersFor(rules, pathname) {
  return Object.assign({}, ...rules.filter((r) => r.re.test(pathname)).map((r) => r.headers));
}

function dataHost(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, "data", "site.json"), "utf8")).legislation_data_url || null; } catch { return null; }
}

function localiseData(html, url) {
  if (!url) return html;
  const origin = new URL(url).origin;
  return html.split(url).join("/data/legislation/")
    .split("\n").filter((l) => !(l.includes('rel="preconnect"') && l.includes(origin))).join("\n");
}

// Like Netlify: rules are tried in order and the first match wins; a trailing slash does not
// matter; "/*" ends a rule with a splat and ":name" matches one path segment, and both can be used
// in the target (":splat", ":name").
function matchRedirect(rules, pathname) {
  const trim = (x) => (x.length > 1 ? x.replace(/\/+$/, "") : x);
  for (const r of rules) {
    if (r.from.endsWith("/*")) {
      const base = r.from.slice(0, -1);
      if (pathname.startsWith(base)) return { ...r, to: r.to.replace(":splat", pathname.slice(base.length)) };
      continue;
    }
    const names = [];
    const re = new RegExp("^" + trim(r.from).split("/").map((seg) => {
      if (seg.startsWith(":")) { names.push(seg.slice(1)); return "([^/]+)"; }
      return seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }).join("/") + "$");
    const m = re.exec(trim(pathname));
    if (!m) continue;
    let to = r.to;
    names.forEach((n, i) => { to = to.split(":" + n).join(m[i + 1]); });
    return { ...r, to };
  }
  return null;
}

export function serve(folder, port) {
  const dir = path.join(ROOT, folder);
  const rules = readRedirects(dir);
  const headerRules = readHeaders(dir);
  const data = dataHost(dir);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    let pathname = decodeURIComponent(url.pathname);
    const extra = headersFor(headerRules, pathname);
    const rule = matchRedirect(rules, pathname);
    if (rule && rule.status !== 200) {
      res.writeHead(rule.status, { ...extra, Location: rule.to + url.search }); res.end(); return;
    }
    // Like Netlify, a 200 rewrite without "!" only applies when no file exists at the path.
    const candidates = [pathname, pathname + ".html", path.join(pathname, "index.html")];
    if (rule && rule.status === 200) candidates.push(rule.to);
    for (const c of candidates) {
      const file = path.join(dir, c);
      if (!file.startsWith(dir)) break;
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        const ext = path.extname(file).toLowerCase();
        const head = { "Content-Type": TYPES[ext] || "application/octet-stream", ...extra, "Cache-Control": "no-store" };
        if (ext === ".html") {
          res.writeHead(200, head);
          res.end(localiseData(fs.readFileSync(file, "utf8"), data));
          return;
        }
        res.writeHead(200, head);
        fs.createReadStream(file).pipe(res); return;
      }
    }
    const notFound = path.join(dir, "404.html");
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", ...extra, "Cache-Control": "no-store" });
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
