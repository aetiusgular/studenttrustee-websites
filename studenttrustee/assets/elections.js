/* Elections section: a small client-side router over the records tools/legislation/elections.py
   publishes next to the legislation records. Same shape as legislation.js (loaders, views, el(),
   Trusted Types), kept as its own script so each section stays small.

   Addresses (page 05 of the wireframes):
     /elections/                         every state on the tile map, each with its next election
     /elections/{state}/                 Who's running: the state's races and candidates
     /elections/{state}/ballot/          Your ballot: an address, then the contests at it
     /elections/{state}/results/         certified results on file for the state
     /elections/ballot/                  the address box from the map page
     /elections/race/{id}/               one race
     /elections/sources/                 where the records come from
   Filters are query parameters (level) and never name a page.

   Data (written by tools/legislation/elections.py, inside data/legislation/):
     elections/calendar.json        every known election, soonest first
     elections/states.json          one row per state: office, site, deadlines, next election
     elections/us-{st}/federal.json the state's federal races and candidates (FEC)
     elections/us-{st}/colleges.json California's community college board seats (hand entered)
     elections/us-{st}/results.json certified results, when on file
   Your ballot calls the Google Civic Information API from the browser, once, with the address the
   visitor typed. The address is never stored, never written to the URL and never sent anywhere else. */
(function () {
  "use strict";

  var META = document.querySelector('meta[name="st-legislation-data"]');
  var CIVIC_META = document.querySelector('meta[name="st-civic-key"]');
  var LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  var DATA = LOCAL || !META ? "/data/legislation/" : META.getAttribute("content");
  var CIVIC_KEY = CIVIC_META ? CIVIC_META.getAttribute("content") : "";
  var CIVIC_URL = "https://www.googleapis.com/civicinfo/v2/voterinfo";
  var BASE = "/elections/";
  var TZ = "America/Los_Angeles";
  var SOON_DAYS = 14;
  var app = document.getElementById("app");
  var status = document.getElementById("status");

  // ---------- data API (the rules are legislation.js's: one origin, GET, timeout, one retry) ----------
  var SCHEMA_MAX = 1;
  var TIMEOUT = 10000, RETRY_AFTER = 1000, KEEP = 30 * 60 * 1000, FAIL_MEMORY = 3000, PREFETCH_SLOTS = 2;
  var MISSING = { missing: true };
  var SAFE_REL = /^[A-Za-z0-9_-][A-Za-z0-9_./-]*\.json$/;

  function ApiError(kind, rel, httpStatus) {
    var msg = kind === "timeout" ? "The records service did not answer within " + (TIMEOUT / 1000) + " seconds."
      : kind === "network" ? "The site that holds the records did not answer. It may be down, or not published yet."
      : kind === "server" ? "The records service had an error (HTTP " + httpStatus + "). Try again in a minute."
      : kind === "http" ? "The records service refused the request (HTTP " + httpStatus + ")."
      : kind === "missing" ? "A file this page needs has not been published (" + rel + ")."
      : kind === "format" ? "A records file could not be read (" + rel + ")."
      : kind === "schema" ? "The records use a newer format than this copy of the page. Reload the page to get the latest version."
      : "The request was cancelled.";
    var e = new Error(msg);
    e.kind = kind; e.rel = rel; e.status = httpStatus;
    return e;
  }

  var api = (function () {
    var files = {}, queue = [], running = 0;
    function attempt(rel, entry, retried) {
      var ctrl = new AbortController();
      var timedOut = false;
      var timer = setTimeout(function () { timedOut = true; ctrl.abort(); }, TIMEOUT);
      entry.controller = ctrl;
      var init = { signal: ctrl.signal };
      if (entry.low) init.priority = "low";
      return fetch(DATA + rel, init).then(function (r) {
        if (!r.ok) {
          if (r.body) r.body.cancel().catch(function () {});
          if (r.status === 404) return MISSING;
          throw ApiError(r.status >= 500 ? "server" : "http", rel, r.status);
        }
        return r.json().catch(function (e) { if (ctrl.signal.aborted) throw e; throw ApiError("format", rel); });
      }).then(function (json) {
        clearTimeout(timer);
        if (json && json !== MISSING && typeof json.schema_version === "number" && json.schema_version > SCHEMA_MAX) throw ApiError("schema", rel);
        return json;
      }, function (e) {
        clearTimeout(timer);
        if (e && e.kind) throw e;
        if (timedOut) throw ApiError("timeout", rel);
        if (ctrl.signal.aborted) throw ApiError("aborted", rel);
        throw ApiError("network", rel);
      }).catch(function (e) {
        if (retried || entry.aborted || (e.kind !== "network" && e.kind !== "server")) throw e;
        return new Promise(function (resolve) { setTimeout(resolve, RETRY_AFTER); }).then(function () {
          if (entry.aborted) throw ApiError("aborted", rel);
          return attempt(rel, entry, true);
        });
      });
    }
    function start(rel, entry) {
      if (entry.started) return;
      entry.started = true;
      var qi = queue.indexOf(entry);
      if (qi >= 0) queue.splice(qi, 1);
      if (entry.prefetch) running++;
      attempt(rel, entry, false).then(function (value) {
        if (files[rel] !== entry) return;
        entry.state = "done"; entry.value = value; entry.at = Date.now();
        entry.resolve(value);
      }, function (e) {
        if (files[rel] === entry) {
          if (e.kind === "aborted") delete files[rel];
          else { entry.state = "failed"; entry.error = e; entry.at = Date.now(); }
        }
        entry.reject(e);
      }).then(function () { if (entry.prefetch) { running--; next(); } });
    }
    function next() { while (running < PREFETCH_SLOTS && queue.length) { var e = queue.shift(); start(e.rel, e); } }
    function get(rel, opts) {
      opts = opts || {};
      if (!SAFE_REL.test(rel) || /(^|\/)\.\.?(\/|$)/.test(rel)) return opts.optional ? Promise.resolve(null) : Promise.reject(ApiError("missing", rel, 404));
      var e = files[rel];
      var now = Date.now();
      if (e && e.state === "done" && now - e.at > KEEP) e = null;
      if (e && e.state === "failed" && now - e.at > FAIL_MEMORY) e = null;
      if (!e) {
        e = files[rel] = { rel: rel, state: "pending", owners: {}, started: false, prefetch: !!opts.prefetch, low: !!opts.low };
        e.promise = new Promise(function (resolve, reject) { e.resolve = resolve; e.reject = reject; });
        e.promise.catch(function () {});
        if (opts.prefetch && running >= PREFETCH_SLOTS) queue.push(e); else start(rel, e);
      } else if (e.state === "pending" && !e.started && !opts.prefetch) start(rel, e);
      if (e.state === "pending" && opts.owner) e.owners[opts.owner.id] = true;
      var p = e.state === "done" ? Promise.resolve(e.value) : e.state === "failed" ? Promise.reject(e.error) : e.promise;
      return p.then(function (v) {
        if (v === MISSING) { if (opts.optional) return null; throw ApiError("missing", rel, 404); }
        return v;
      });
    }
    function release(owner) {
      if (!owner) return;
      Object.keys(files).forEach(function (rel) { var e = files[rel]; if (e.state === "pending") delete e.owners[owner.id]; });
      setTimeout(sweep, 0);
    }
    function sweep() {
      Object.keys(files).forEach(function (rel) {
        var e = files[rel];
        if (e.state !== "pending" || Object.keys(e.owners).length) return;
        e.aborted = true;
        delete files[rel];
        var qi = queue.indexOf(e);
        if (qi >= 0) queue.splice(qi, 1);
        if (e.controller) e.controller.abort();
        if (!e.started) e.reject(ApiError("aborted", rel));
      });
    }
    function dropQueued() {
      queue.slice().forEach(function (e) {
        delete e.owners[PREFETCH.id];
        if (!Object.keys(e.owners).length) {
          queue.splice(queue.indexOf(e), 1);
          if (files[e.rel] === e) delete files[e.rel];
          e.aborted = true;
          e.reject(ApiError("aborted", e.rel));
        }
      });
    }
    function forgetFailures() { Object.keys(files).forEach(function (rel) { if (files[rel].state === "failed") delete files[rel]; }); }
    return { get: get, release: release, dropQueued: dropQueued, forgetFailures: forgetFailures };
  })();

  var PREFETCH = { id: "prefetch" };
  var activeOwner = null;
  var ownerSeq = 0;
  function get(rel, optional) { return api.get(rel, { optional: optional, owner: activeOwner }); }
  function navContext() { return { get: function (rel) { return api.get(rel, { optional: true, owner: activeOwner }); }, light: false, nav: true }; }
  function prefetchContext(light) {
    return { light: light, get: function (rel, o) {
      if (light && o && o.big) return Promise.resolve(null);
      return api.get(rel, { optional: true, owner: PREFETCH, prefetch: true, low: true });
    } };
  }
  function need(c, list) { return Promise.all(list.filter(Boolean).map(function (x) { return typeof x === "string" ? c.get(x) : c.get(x.rel, x); })); }

  // ---------- DOM ----------
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = v;
        else if (k === "on") Object.keys(v).forEach(function (ev) { node.addEventListener(ev, v[ev]); });
        else if (k === "dataset") Object.keys(v).forEach(function (d) { node.dataset[d] = v[d]; });
        else node.setAttribute(k, v === true ? "" : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }
  function append(node) {
    for (var i = 1; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined || child === false) continue;
      if (Array.isArray(child)) { child.forEach(function (c) { append(node, c); }); continue; }
      node.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
    }
  }
  function frag() { var f = document.createDocumentFragment(); for (var i = 0; i < arguments.length; i++) append(f, arguments[i]); return f; }
  function link(href, text, cls) { return el("a", { href: href, class: cls || null }, text); }
  function safeUrl(u) {
    if (typeof u !== "string" || !/^https?:\/\//i.test(u.trim())) return null;
    try { var p = new URL(u.trim()); return p.protocol === "https:" || p.protocol === "http:" ? p.href : null; } catch (e) { return null; }
  }
  function ext(href, text, hint) {
    var u = safeUrl(href);
    if (!u) return el("span", null, text);
    return el("a", { href: u, class: "ext", rel: "noopener" }, text, el("span", { class: "visually-hidden" }, hint || " (official source, opens the government site)"));
  }
  function section(title, body, cls) { return el("section", { class: "sec " + (cls || "") }, el("h2", null, title), body); }
  function note(text) { return el("p", { class: "note" }, text); }
  function plural(n, one, many) { return n.toLocaleString() + " " + (n === 1 ? one : many); }
  function listWords(items) { return items.length <= 2 ? items.join(" and ") : items.slice(0, -1).join(", ") + " and " + items[items.length - 1]; }

  // ---------- dates ----------
  var DAY_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
  var LONG_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });
  var SHORT_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
  var TIME_FMT = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  function isDateOnly(s) { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s); }
  function dateOnly(s) { var p = s.split("-"); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 12)); }
  function fmtShort(s) { return isDateOnly(s) ? SHORT_FMT.format(dateOnly(s)) : ""; }
  function fmtLong(s) { return isDateOnly(s) ? LONG_FMT.format(dateOnly(s)) : ""; }
  function fmtShortY(s) { return isDateOnly(s) ? new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(dateOnly(s)) : ""; }
  function fmtDay(s) { return isDateOnly(s) ? DAY_FMT.format(dateOnly(s)) : ""; }
  function fmtMD(s) { return isDateOnly(s) ? new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric" }).format(dateOnly(s)) : ""; }
  function fmtWhen(s) { var d = new Date(s); return isNaN(d) ? s : TIME_FMT.format(d); }
  function time(s, withTime) { return s ? el("time", { datetime: s }, withTime ? fmtWhen(s) : fmtLong(s)) : el("span", { class: "unk" }, "not recorded"); }
  function todayISO() { return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
  function daysUntil(s) { return Math.round((dateOnly(s) - dateOnly(todayISO())) / 864e5); }
  function daysWords(n) { return n === 0 ? "today" : n === 1 ? "tomorrow" : n < 0 ? plural(-n, "day", "days") + " ago" : "in " + plural(n, "day", "days"); }

  // ---------- vocabulary ----------
  var LEVEL_NAME = { federal: "Federal", state: "State", county: "County", local: "Local", college: "College", measure: "Measure" };
  var PARTY = { D: "Democratic", R: "Republican", I: "Independent", L: "Libertarian", G: "Green", NP: "Nonpartisan", C: "Constitution", W: "Write-in", WF: "Working Families", F: "Forward" };
  function party(p, full) { return full || (p ? (PARTY[p] || p) : ""); }
  function badge(level) { return el("span", { class: "lvl lvl-" + level }, LEVEL_NAME[level] || level); }
  // "GRANGER, KAY" (the FEC's form) -> "Kay Granger"; a name the FEC already wrote naturally is kept.
  function personName(n) {
    n = String(n || "").trim();
    var m = /^([^,]+),\s*(.+)$/.exec(n);
    if (!m || n !== n.toUpperCase()) return n;
    var titleCase = function (s) { return s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, function (x, a, b) { return a + b.toUpperCase(); }).replace(/\bMc([a-z])/g, function (x, a) { return "Mc" + a.toUpperCase(); }); };
    return titleCase(m[2]) + " " + titleCase(m[1]);
  }

  // ---------- routing ----------
  function safeDecode(x) { try { return decodeURIComponent(x); } catch (e) { return x; } }
  function parse(pathname) {
    var rest = pathname.indexOf(BASE) === 0 ? pathname.slice(BASE.length) : "";
    return rest.split("/").filter(Boolean).map(safeDecode);
  }
  var PARAM_ORDER = ["level", "election", "q"];
  function rank(k) { var i = PARAM_ORDER.indexOf(k); return i < 0 ? 99 : i; }
  function href(parts, params) {
    var p = BASE + parts.map(encodeURIComponent).join("/") + (parts.length ? "/" : "");
    if (params) {
      var sp = new URLSearchParams();
      Object.keys(params).sort(function (a, b) { return rank(a) - rank(b); }).forEach(function (k) {
        var v = params[k];
        if (v !== "" && v !== null && v !== undefined && v !== false) sp.set(k, v);
      });
      var s = sp.toString(); if (s) p += "?" + s;
    }
    return p;
  }
  var STATE_CODES = { alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
    florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
    maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE",
    nevada: "NV", "new-hampshire": "NH", "new-jersey": "NJ", "new-mexico": "NM", "new-york": "NY", "north-carolina": "NC", "north-dakota": "ND", ohio: "OH",
    oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode-island": "RI", "south-carolina": "SC", "south-dakota": "SD", tennessee: "TN", texas: "TX",
    utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west-virginia": "WV", wisconsin: "WI", wyoming: "WY", "district-of-columbia": "DC", "puerto-rico": "PR" };
  var CODE_SLUG = {};
  Object.keys(STATE_CODES).forEach(function (k) { CODE_SLUG[STATE_CODES[k]] = k; });
  var STATE_NAME = {};
  function lc(code) { return String(code || "").toLowerCase(); }
  var DOORS = { ballot: 1, results: 1 };

  // ---------- rendering ----------
  var current = 0;
  var firstRender = true;
  var slowTimer = null;
  function render(rt, parts, params, opts) {
    opts = opts || {};
    var run = ++current;
    var previous = activeOwner;
    activeOwner = { id: "page-" + (++ownerSeq) };
    api.release(previous);
    say("Loading…");
    clearTimeout(slowTimer);
    slowTimer = setTimeout(function () { if (run === current) say("Still loading."); }, 2000);
    app.setAttribute("aria-busy", "true");
    var loaded = rt.load ? Promise.resolve().then(function () { return rt.load(parts, params, navContext()); }).catch(function () {}) : Promise.resolve();
    return loaded.then(function () {
      if (run !== current) return null;
      return Promise.all([Promise.resolve().then(function () { return rt.view(parts, params); }), manifest().catch(function () { return null; })]);
    }).then(function (r) {
      if (!r || run !== current) return;
      var out = r[0];
      clearTimeout(slowTimer);
      app.replaceChildren();
      append(app, staleNotice(r[1]), out.head || pageHead(out), out.body);
      document.title = (out.docTitle || out.title) + " · Elections · studenttrustee.net";
      setCanonical();
      app.removeAttribute("aria-busy");
      var hashTarget = location.hash ? document.getElementById(safeDecode(location.hash.slice(1))) : null;
      var target = hashTarget || (opts.focusSel ? app.querySelector(opts.focusSel) : null);
      if (target) {
        if (!target.hasAttribute("tabindex") && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) target.setAttribute("tabindex", "-1");
        if (hashTarget) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: "start" }); } else target.focus();
      } else {
        var h1 = document.getElementById("page-title");
        if (!firstRender && opts.focus !== false && h1) h1.focus({ preventScroll: true });
        if (!opts.keepScroll) window.scrollTo(0, 0);
      }
      firstRender = false;
      var res = opts.announce ? app.querySelector("#results") : null;
      say(res ? res.textContent : "");
      if (out.after) setTimeout(function () { if (run === current) out.after(); }, 0);
      idlePrefetch(rt, parts, params);
    }).catch(function (e) {
      if (run !== current) return;
      clearTimeout(slowTimer);
      app.replaceChildren();
      append(app, pageHead({ title: "Elections", crumbs: [["All states", BASE], "Page not loaded"] }), errorBox(e));
      document.title = "Page not loaded · Elections · studenttrustee.net";
      app.removeAttribute("aria-busy");
      firstRender = false;
      say("");
    });
  }
  function pageHead(out) {
    return el("div", { class: "page-head" },
      out.crumbs ? crumbTrail(out.crumbs) : null,
      el("h1", { id: "page-title", tabindex: "-1" }, out.title),
      out.lede ? el("p", { class: "lede" }, out.lede) : null);
  }
  function crumbTrail(list) {
    return el("nav", { class: "crumbs", "aria-label": "Breadcrumb" }, el("ol", null, list.map(function (c, i) {
      var last = i === list.length - 1;
      if (Array.isArray(c) && !last) return el("li", null, link(c[1], c[0]));
      return el("li", null, el("span", { "aria-current": last ? "page" : null }, Array.isArray(c) ? c[0] : c));
    })));
  }
  function setCanonical() {
    var canon = document.querySelector('link[rel="canonical"]');
    if (!canon) return;
    var keep = {};
    new URLSearchParams(location.search).forEach(function (v, k) { if (PARAM_ORDER.indexOf(k) >= 0) keep[k] = v; });
    canon.setAttribute("href", location.origin + href(parse(location.pathname), keep));
  }
  function errorBox(e) {
    var kind = e && e.kind;
    var retry = el("button", { type: "button", class: "btn", on: { click: function () {
      if (kind === "schema") { location.reload(); return; }
      api.forgetFailures();
      route({ focus: false, keepScroll: true });
    } } }, kind === "schema" ? "Reload the page" : "Try again");
    return el("div", { class: "err", role: "alert" },
      el("h2", null, "This page could not be loaded"),
      el("p", null, kind ? e.message : "Something went wrong while building this page."),
      el("p", null, "The official sources have the same information: ",
        ext("https://www.usa.gov/election-office", "your state's election office (USA.gov)", " (opens USA.gov)"), " · ",
        ext("https://www.fec.gov/data/candidates/", "federal candidates (FEC)", " (opens the FEC's site)"), "."),
      el("p", { class: "row wrap" }, retry, " ", link(BASE, "Back to all states")));
  }
  var STALE_HOURS = 36;
  // The election records' own age: the newest success among the election sources, since the
  // manifest's generated_at also covers the legislation records, which refresh on their own.
  function electionsAge(man) {
    var newest = null;
    Object.keys(man.sources || {}).forEach(function (k) {
      var s = man.sources[k];
      if ((s.level || "") !== "election" || !s.last_success_at) return;
      if (!newest || Date.parse(s.last_success_at) > Date.parse(newest)) newest = s.last_success_at;
    });
    return newest || man.generated_at;
  }
  function staleNotice(man) {
    var at = man && electionsAge(man);
    if (!at) return null;
    var hours = (Date.now() - Date.parse(at)) / 36e5;
    if (!(hours > STALE_HOURS)) return null;
    return el("p", { class: "stale-all" }, el("strong", null, "Not refreshed since "), time(at, true), el("strong", null, "."),
      " The nightly update has not run since then, so newer filings and dates are missing. Each state's page links its election office, which has the current version. ",
      link(href(["sources"]), "Source status"));
  }
  function say(t) { status.textContent = t; }
  function navigate(url, opts) { history.pushState(null, "", url); return route(opts); }
  function inApp(u) { return u.origin === location.origin && u.pathname.indexOf(BASE) === 0; }
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[href]");
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (a.target === "_blank" || a.hasAttribute("download")) return;
    var u = new URL(a.href, location.href);
    if (!inApp(u)) return;
    if (u.hash && u.pathname === location.pathname && u.search === location.search) return;
    e.preventDefault();
    var opts = {};
    var f = a.getAttribute("data-focus");
    if (f) { opts.focusSel = f; opts.keepScroll = true; opts.announce = a.hasAttribute("data-announce"); }
    navigate(u.pathname + u.search + u.hash, opts);
  });
  window.addEventListener("popstate", function () { route(); });
  function resolve(pathname, search) {
    var parts = parse(pathname);
    var params = new URLSearchParams(search || "");
    for (var i = 0; i < ROUTES.length; i++) if (ROUTES[i].test(parts)) return { route: ROUTES[i], parts: parts, params: params };
    return { route: NOT_FOUND, parts: parts, params: params };
  }
  var routeSeq = 0;
  function route(opts) {
    var run = ++routeSeq;
    return Promise.resolve().then(function () {
      if (run !== routeSeq) return null;
      var r = resolve(location.pathname, location.search);
      return render(r.route, r.parts, r.params, opts);
    });
  }
  function notFound() {
    return { title: "Not found", crumbs: [["All states", BASE], "Not found"], body: el("p", null, "There is no page at this address. ", link(BASE, "See all states"), ".") };
  }
  var NOT_FOUND = { name: "not-found", test: function () { return true; }, view: notFound };

  // ---------- prefetch on intent (as in legislation.js) ----------
  var DWELL = 80;
  function dataSaver() {
    var c = navigator.connection;
    if (c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || ""))) return true;
    try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-data: reduce)").matches); } catch (e) { return false; }
  }
  function prefetchLink(a, trigger) {
    if (dataSaver() || !a.href) return;
    var u = new URL(a.href, location.href);
    if (!inApp(u) || (u.pathname === location.pathname && u.search === location.search)) return;
    var r = resolve(u.pathname, u.search);
    if (!r.route.load) return;
    api.dropQueued();
    Promise.resolve().then(function () { return r.route.load(r.parts, r.params, prefetchContext(trigger === "hover")); }).catch(function () {});
  }
  var hoverTimer = null, hoverLink = null, focusTimer = null;
  function linkOf(t) { return t && t.closest ? t.closest("a[href]") : null; }
  document.addEventListener("pointerover", function (e) {
    if (e.pointerType === "touch") return;
    var a = linkOf(e.target);
    if (!a || a === hoverLink) return;
    clearTimeout(hoverTimer);
    hoverLink = a;
    hoverTimer = setTimeout(function () { prefetchLink(a, "hover"); }, DWELL);
  });
  document.addEventListener("pointerout", function (e) {
    var a = linkOf(e.target);
    if (a && a === hoverLink && !a.contains(e.relatedTarget)) { clearTimeout(hoverTimer); hoverLink = null; }
  });
  document.addEventListener("focusin", function (e) {
    var a = linkOf(e.target);
    clearTimeout(focusTimer);
    if (a) focusTimer = setTimeout(function () { if (document.activeElement === a) prefetchLink(a, "focus"); }, DWELL);
  });
  document.addEventListener("touchstart", function (e) { var a = linkOf(e.target); if (a) prefetchLink(a, "touch"); }, { passive: true });
  function idlePrefetch(r, parts, params) {
    if (!r.next || dataSaver()) return;
    var go = function () { var n = r.next(parts, params); if (!n) return; prefetchLink({ href: n }, "hover"); };
    if (window.requestIdleCallback) window.requestIdleCallback(go, { timeout: 4000 }); else setTimeout(go, 1500);
  }

  // ---------- shared loaders ----------
  function manifest() { return get("manifest.json"); }
  function states() { return get("geo/states.json").then(function (d) { (d.states || []).forEach(function (s) { STATE_NAME[s.code] = s.name; }); return d.states; }); }
  function calendar() { return get("elections/calendar.json", true); }
  function electionStates() { return get("elections/states.json", true).then(function (d) { var by = {}; ((d && d.states) || []).forEach(function (s) { by[s.code] = s; }); return { by: by, data: d }; }); }
  function federal(code) { return get("elections/us-" + lc(code) + "/federal.json", true); }
  function colleges(code) { return code === "CA" ? get("elections/us-ca/colleges.json", true) : Promise.resolve(null); }
  function results(code) { return get("elections/us-" + lc(code) + "/results.json", true); }
  function statusWord(s) {
    return s.status === "ok" ? "OK" : s.status === "partial" ? "partly updated; earlier copies kept where a request failed" : s.status === "stale" ? "last check failed, showing the previous copy" : s.status === "error" ? "unavailable" : s.status === "not_configured" ? "not configured" : (s.status || "unknown");
  }
  function footLine(bits) { return el("p", { class: "leg-foot" }, bits.filter(Boolean).map(function (b, i) { return [i ? el("span", { class: "sep", "aria-hidden": "true" }, " · ") : null, b]; })); }
  // The state's next election: the soonest calendar row for it or the country on or after today.
  function nextElection(cal, code) {
    var today = todayISO();
    var rows = ((cal && cal.elections) || []).filter(function (r) { return r.date >= today && (r.state === code || r.state === "US"); });
    rows.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.state === code ? -1 : 1; });
    return rows[0] || null;
  }

  // ---------- the map ----------
  var TILE_ROWS = [
    { 0: "AK", 10: "ME" },
    { 5: "WI", 9: "VT", 10: "NH" },
    { 0: "WA", 1: "ID", 2: "MT", 3: "ND", 4: "MN", 5: "IL", 6: "MI", 8: "NY", 9: "MA", 10: "RI" },
    { 0: "OR", 1: "NV", 2: "WY", 3: "SD", 4: "IA", 5: "IN", 6: "OH", 7: "PA", 8: "NJ", 9: "CT" },
    { 0: "CA", 1: "UT", 2: "CO", 3: "NE", 4: "MO", 5: "KY", 6: "WV", 7: "VA", 8: "MD", 9: "DE" },
    { 1: "AZ", 2: "NM", 3: "KS", 4: "AR", 5: "TN", 6: "NC", 7: "SC", 8: "DC" },
    { 3: "OK", 4: "LA", 5: "MS", 6: "AL", 7: "GA" },
    { 0: "HI", 3: "TX", 8: "FL", 10: "PR" }];
  function tileEl(s, nxt) {
    var soon = nxt && daysUntil(nxt.date) <= SOON_DAYS;
    var when = nxt ? fmtShort(nxt.date) : "none set";
    var say = nxt ? ": next election " + fmtLong(nxt.date) + (soon ? ", " + daysWords(daysUntil(nxt.date)) : "") : ": no election on the calendar";
    return el("a", { href: href([CODE_SLUG[s.code]]), class: "tile etile" + (soon ? " soon" : "") },
      el("span", { class: "code" }, s.code), el("span", { class: "visually-hidden" }, ", " + s.name + say), el("span", { class: "when", "aria-hidden": "true" }, when));
  }
  function legendEl(st, cal) {
    var soonOne = st.filter(function (s) { var n = nextElection(cal, s.code); return n && daysUntil(n.date) <= SOON_DAYS; })[0];
    var plain = st.filter(function (s) { var n = nextElection(cal, s.code); return n && daysUntil(n.date) > SOON_DAYS; })[0] || st[0];
    var sample = function (s, cls) { var n = nextElection(cal, s.code); return el("span", { class: "tile etile sample " + cls, "aria-hidden": "true" }, el("span", { class: "code" }, s.code), el("span", { class: "when" }, n ? fmtShort(n.date) : "")); };
    return el("div", { class: "legend" },
      el("h2", null, "What each tile shows"),
      el("ul", { class: "plain" },
        el("li", null, sample(plain, ""), el("span", null, "Next election day in that state")),
        soonOne ? el("li", null, sample(soonOne, "soon"), el("span", null, "An election within the next " + SOON_DAYS + " days")) : null));
  }
  // The address box: a GET form in markup, but the address never reaches the URL. Submitting keeps
  // it in memory and opens the ballot page, which sends it to the lookup service once.
  var pendingAddress = "";
  function addressForm(id, code) {
    var input = el("input", { id: id, name: "address", type: "text", autocomplete: "street-address", spellcheck: "false", placeholder: "Street address, city, state" });
    return el("form", { class: "leg-search addr", action: href(code ? [CODE_SLUG[code], "ballot"] : ["ballot"]), method: "get", on: { submit: function (e) {
      e.preventDefault();
      pendingAddress = input.value.trim();
      navigate(href(code ? [CODE_SLUG[code], "ballot"] : ["ballot"]));
    } } },
      el("label", { for: id }, "See your own ballot"),
      el("div", { class: "search-row" }, input, el("button", { type: "submit", class: "btn go" }, "Find")),
      el("p", { class: "privacy" }, "Your address goes to Google's Civic Information service to find your districts and nothing else. It is never stored and never put in the address bar."));
  }
  function loadMap(parts, params, c) { return need(c, ["manifest.json", "geo/states.json", "elections/calendar.json", "elections/states.json"]); }
  function viewMap() {
    return Promise.all([states(), calendar(), electionStates(), manifest()]).then(function (r) {
      var st = r[0].filter(function (s) { return CODE_SLUG[s.code]; }), cal = r[1], man = r[3];
      var by = {};
      st.forEach(function (s) { by[s.code] = s; });
      var geo = el("nav", { class: "usmap", "aria-label": "States, west to east" }, TILE_ROWS.map(function (row) {
        var cells = [];
        for (var i = 0; i < 11; i++) cells.push(row[i] && by[row[i]] ? tileEl(by[row[i]], nextElection(cal, row[i])) : el("span", { class: "gap", "aria-hidden": "true" }));
        return cells;
      }));
      var alpha = st.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
      var grid = el("nav", { class: "usgrid", "aria-label": "States, A to Z" }, alpha.map(function (s) { return tileEl(s, nextElection(cal, s.code)); }));
      var head = el("div", { class: "map-page" },
        el("div", { class: "map-intro" },
          el("p", { class: "eyebrow" }, "Elections"),
          el("h1", { id: "page-title", tabindex: "-1" }, "Who is on the ballot, and when."),
          el("p", { class: "intro" }, "Pick a state. Each one lists its next election and deadlines and every race for Congress with the people running. California also has every statewide and legislative race, the Board of Supervisors contests and the community college board seats. Records refresh every night from official sources."),
          CIVIC_KEY ? addressForm("map-addr", null) : null,
          legendEl(st, cal)),
        el("div", { class: "map-wrap" }, geo, grid,
          el("p", { class: "terr" }, cal ? "Dates come from the Google Civic Information election list and each state's election office. Every state page links its official office for deadlines and the certified list of candidates." : "The election calendar has not been published yet; each state page links its election office.")));
      var foot = footLine([el("span", null, "Last refresh ", time(electionsAge(man), true)), link(href(["races"]), "Every federal race"),
        link(href(["california"], { level: "college" }), "California college boards"), link(href(["sources"]), "Sources")]);
      return { title: "Who is on the ballot, and when.", docTitle: "Every state", head: head, body: foot };
    });
  }

  // ---------- a state ----------
  function placeParts(parts) {
    var code = STATE_CODES[parts[0]];
    if (!code || parts.length > 2) return null;
    if (parts.length === 2 && !DOORS[parts[1]]) return null;
    return { slug: parts[0], code: code, door: parts.length === 2 ? parts[1] : "running" };
  }
  function loadPlace(parts, params, c) {
    var p = placeParts(parts);
    if (!p) return need(c, ["manifest.json"]);
    var files = ["manifest.json", "geo/states.json", "elections/calendar.json", "elections/states.json"];
    if (p.door === "running") files.push("elections/us-" + lc(p.code) + "/federal.json");
    if (p.door === "running" && p.code === "CA") files.push("elections/us-ca/colleges.json");
    if (p.door === "results") files.push("elections/us-" + lc(p.code) + "/results.json");
    return need(c, files);
  }
  function placeScope(p) {
    return Promise.all([states(), calendar(), electionStates(), manifest()]).then(function (r) {
      var name = STATE_NAME[p.code];
      if (!name) return null;
      var row = r[2].by[p.code] || {};
      return { code: p.code, slug: p.slug, door: p.door, name: name, cal: r[1], row: row, man: r[3], nxt: nextElection(r[1], p.code), checked: r[2].data && r[2].data.deadlines_checked };
    });
  }
  function placeHead(sc) {
    var n = sc.nxt;
    var right = n ? el("div", { class: "next-el" },
      el("span", { class: "k" }, "Next election"),
      el("span", { class: "d" }, fmtDay(n.date)),
      el("span", { class: "m" }, n.name + " · " + daysWords(daysUntil(n.date))))
      : el("div", { class: "next-el" }, el("span", { class: "k" }, "Next election"), el("span", { class: "m" }, "None on the calendar yet"));
    return el("div", { class: "place-head" },
      el("div", { class: "ph-title" }, crumbTrail([["All states", BASE], sc.name]), el("h1", { id: "page-title", tabindex: "-1" }, sc.name)),
      right);
  }
  // Four plain cells, date first. A passed deadline says so in words; a date not entered yet sends
  // the reader to the official site instead of guessing.
  function deadlineCell(label, value, sub, passed) {
    return el("div", { class: "dl-cell" }, el("span", { class: "k" }, label),
      el("span", { class: "d" }, value),
      sub ? el("span", { class: passed ? "m passed" : "m" }, sub) : null);
  }
  function deadlines(sc) {
    var d = sc.row.deadlines || {};
    var today = todayISO();
    var site = sc.row.site;
    var official = site ? ext(site, sc.row.office || (sc.name + " election office"), " (the state's official election site)") : el("span", null, "the state's election office");
    var passed = function (x) { return isDateOnly(x) && x < today; };
    var reg = d.registration ? deadlineCell("Register to vote by", fmtMD(d.registration), passed(d.registration) ? "Passed. " + (d.registration_note || "") : d.registration_note, passed(d.registration))
      : deadlineCell("Register to vote by", el("span", { class: "see" }, "See the official site"), d.registration_note || null);
    var mail = d.mail_request ? deadlineCell("Ask for a mail ballot by", fmtMD(d.mail_request), (passed(d.mail_request) ? "Passed. " : "") + (d.mail_return ? "Return it by " + fmtMD(d.mail_return) + (d.postmark ? " (postmark)" : "") : (d.mail_request_note || "")), passed(d.mail_request))
      : deadlineCell("Mail ballot", d.mail_request_note ? el("span", { class: "see" }, "No request needed") : el("span", { class: "see" }, "See the official site"),
        d.mail_return ? "Return by " + fmtMD(d.mail_return) + (d.postmark ? " (postmark)" : "") + (d.mail_return_note ? ". " + d.mail_return_note : "") : d.mail_request_note || null);
    var early = d.early_start ? deadlineCell("Early voting", fmtMD(d.early_start) + (d.early_end ? " to " + fmtMD(d.early_end) : ""), "In person; places vary by county")
      : deadlineCell("Early voting", el("span", { class: "see" }, "See the official site"), null);
    var off = el("div", { class: "dl-cell" }, el("span", { class: "k" }, "The official word"), el("span", { class: "d link" }, official),
      el("span", { class: "m" }, sc.checked ? "Dates checked " + fmtLong(sc.checked) : "Dates not yet checked", sc.row.site_reachable === false ? el("span", { class: "warn" }, " · the site did not answer at the last check") : null));
    return el("div", { class: "deadlines", role: "group", "aria-label": "Deadlines" }, reg, mail, early, off);
  }
  var DOOR_TITLE = { running: "Who's running", ballot: "Your ballot", results: "Results" };
  var DOOR_DESC = { running: "Every race on the ballot, with the candidates", ballot: "Enter an address, see only the races you vote in", results: "Certified counts after each election, never a live tally" };
  function doorsNav(sc) {
    var ds = ["running"].concat(CIVIC_KEY ? ["ballot"] : [], ["results"]);
    return el("nav", { class: "pdoors" + (ds.length === 2 ? " two" : ""), "aria-label": "Sections for " + sc.name }, ds.map(function (d) {
      return el("a", { href: href(d === "running" ? [sc.slug] : [sc.slug, d]), class: "pdoor", "aria-current": sc.door === d ? "page" : null, "data-focus": "#results" },
        el("span", { class: "dt" }, DOOR_TITLE[d]), el("span", { class: "dd" }, DOOR_DESC[d].replace("the ballot", sc.name + " ballots")));
    }));
  }
  function chipBar(sc, level, items) {
    return el("div", { class: "chips", role: "group", "aria-label": "Level" }, items.map(function (it) {
      var key = it[0] || "all";
      return el("a", { href: href([sc.slug], { level: it[0] }), class: "chip" + (it[2] ? " muted" : ""), "aria-current": (level || "") === it[0] ? "true" : null,
        "data-level": key, "data-focus": '.chip[data-level="' + key + '"]', "data-announce": true }, it[1], it[2] ? " (" + it[2] + ")" : null,
        it[3] != null ? el("span", { class: "n" }, " " + it[3].toLocaleString()) : null);
    }));
  }
  function candidateLine(c) {
    // "Nonpartisan" says nothing on a nonpartisan office, so it is left out there.
    var p = c.party === "NP" ? null : party(c.party, c.party_full && c.party_full !== c.party_full.toUpperCase() ? c.party_full : null);
    var bits = [p];
    if (c.incumbent) bits.push("incumbent");
    if (c.designation && !(c.incumbent && /^incumbent$/i.test(c.designation.trim()))) bits.push(c.designation);
    if (c.website && safeUrl(c.website)) bits.push(ext(c.website, "website", " (the candidate's own site)"));
    return el("li", { class: "cand" }, el("span", { class: "nm" }, personName(c.name)),
      el("span", { class: "meta" }, bits.filter(Boolean).map(function (b, i) { return [i ? " · " : null, b]; })));
  }
  // Where a race's list comes from: the state's certified ballot, a county registrar, or the FEC.
  function raceSource(r, fed) {
    var lv = r.level || "federal";
    if (lv === "county") return r.official_url ? ext(r.official_url, "Registrar's list", " (the county registrar's candidate list)") : null;
    var ballot = fed && fed.ballot && fed.ballot.official_list_url;
    if (ballot && (lv === "state" || r.candidates.some(function (c) { return c.designation; })))
      return ext(ballot, "Certified list", " (the state's certified list of candidates)");
    var u = r.official_url || (fed && fed.official_list_url);
    return u ? ext(u, "FEC filings", " (the race's filings at the FEC)") : null;
  }
  // The part of a label that is not already said by the group heading above it.
  function rowTitle(r) {
    var t = r.label.replace(/^[^:]+:\s*/, "");
    if (r.level === "county") t = t.replace(/^.+? County\s+/, "");
    if (r.level === "state" && r.office === "SEN") t = "District " + (+r.district || r.district);
    if (r.level === "state" && r.office === "ASM") t = "District " + (+r.district || r.district);
    if (r.level === "state" && r.office === "BOE") t = "District " + (+r.district || r.district);
    if (r.office === "RET") t = t.replace(/\s*\(retention\)$/, "");
    return t;
  }
  function raceRow(r, sc, extra, fed, hTag) {
    var n = r.candidates.length;
    return el("li", { class: "vrow race" },
      el("span", { class: "vr-level" }, badge(r.level || "federal")),
      el("div", { class: "vr-main" },
        el(hTag || "h3", { class: "rt" }, link(href(["race", r.id]), rowTitle(r))),
        r.area && r.level === "state" ? el("p", { class: "note" }, r.area) : null,
        el("ul", { class: "plain cands" }, r.candidates.map(candidateLine)),
        n === 0 ? el("p", { class: "note" }, "No candidate on file yet; see the state's certified list.") : null),
      el("span", { class: "vr-result" }, extra || (r.office === "RET" ? plural(n, "justice", "justices") + ", yes or no" : plural(n, "candidate", "candidates"))),
      el("span", { class: "vr-date" }, raceSource(r, fed)));
  }
  // State races in the order the ballot prints them; county races by county.
  var STATE_GROUPS = [
    ["Statewide offices", function (r) { return ["SEN", "ASM", "BOE", "RET"].indexOf(r.office) < 0; }],
    ["State Senate", function (r) { return r.office === "SEN"; }],
    ["State Assembly", function (r) { return r.office === "ASM"; }],
    ["Board of Equalization", function (r) { return r.office === "BOE"; }],
    ["Courts: retention questions", function (r) { return r.office === "RET"; }]];
  var STATE_ORDER = ["GOVERNOR", "LIEUTENANT-GOVERNOR", "SECRETARY-OF-STATE", "CONTROLLER", "TREASURER", "ATTORNEY-GENERAL", "INSURANCE-COMMISSIONER", "SUPERINTENDENT-OF-PUBLIC-INSTRUCTION"];
  function countyOf(r) { var m = /^[^:]+:\s*(.+? County)\b/.exec(r.label); return m ? m[1] : "Other"; }
  function groupedRaces(races, level, sc, fed) {
    var groups;
    if (level === "state") {
      groups = STATE_GROUPS.map(function (g) {
        var rs = races.filter(g[1]);
        if (g[0] === "Statewide offices") rs.sort(function (a, b) { var i = STATE_ORDER.indexOf(a.office), j = STATE_ORDER.indexOf(b.office); return (i < 0 ? 99 : i) - (j < 0 ? 99 : j); });
        else rs.sort(function (a, b) { return (+a.district || 0) - (+b.district || 0) || (a.label < b.label ? -1 : 1); });
        return [g[0], rs];
      });
    } else {
      var by = {};
      races.forEach(function (r) { var c = countyOf(r); (by[c] = by[c] || []).push(r); });
      groups = Object.keys(by).sort().map(function (c) { return [c, by[c].sort(function (a, b) { return (+a.district || 0) - (+b.district || 0); })]; });
    }
    return groups.filter(function (g) { return g[1].length; }).map(function (g) {
      return el("section", { class: "race-group" },
        el("div", { class: "grp-h" }, el("h3", null, g[0]), el("span", { class: "n" }, plural(g[1].length, "race", "races"))),
        el("ul", { class: "plain vlist" }, g[1].map(function (r) { return raceRow(r, sc, null, fed, "h4"); })));
    });
  }
  function officialListNote(sc, what) {
    return note(frag(what + " are not collected for " + sc.name + " yet. ", sc.row.site ? ext(sc.row.site, "The " + (sc.row.office || "state election office") + " lists them", " (the state's official election site)") : "The state's election office lists them", "."));
  }
  function collegeRow(d, sc) {
    var seats = d.seats || [];
    var nSeats = seats.reduce(function (n, s) { return n + (s.count || 1); }, 0);
    var contested = seats.filter(function (s) { return (s.candidates || []).length > (s.count || 1); }).reduce(function (n, s) { return n + (s.count || 1); }, 0);
    return el("li", { class: "vrow race" },
      el("span", { class: "vr-level" }, badge("college")),
      el("div", { class: "vr-main" },
        el("h3", null, d.site_path ? link(d.site_path, d.name) : d.name),
        el("p", { class: "note" }, [d.county ? d.county + " County" : null, seats.length ? listWords(seats.map(function (s) { return s.name; })) + " on the ballot" : null].filter(Boolean).join(" · ")),
        seats.length ? el("ul", { class: "plain cands" }, seats.map(function (s) {
          var cs = s.candidates || [];
          return el("li", { class: "cand" }, el("span", { class: "nm seat" }, s.name),
            cs.length === 0 ? el("span", { class: "meta" }, "Not yet entered; the registrar publishes this list, see the link")
              : el("span", { class: "meta" }, cs.map(function (c, i) { return [i ? " · " : null, el("span", { class: "cn" }, personName(c.name)), c.incumbent ? " (incumbent)" : null]; }),
                cs.length === 1 && s.unopposed ? ", unopposed; seat filled without an election" : null));
        })) : el("p", { class: "note" }, "No seats entered for this district yet.")),
      el("span", { class: "vr-result" }, seats.length ? plural(nSeats, "seat", "seats") + ", " + (contested ? contested + " contested" : "none contested") : "—"),
      el("span", { class: "vr-date" }, d.registrar_url ? ext(d.registrar_url, "Registrar's list", " (the county registrar's candidate list)") : null));
  }
  function viewPlace(parts, params) {
    var p = placeParts(parts);
    if (!p) return notFound();
    return placeScope(p).then(function (sc) {
      if (!sc) return notFound();
      if (sc.door === "ballot") return viewBallot(sc);
      if (sc.door === "results") return viewResults(sc, params);
      return Promise.all([federal(sc.code), colleges(sc.code)]).then(function (r) {
        var fed = r[0], col = r[1];
        var level = ["federal", "state", "county", "college"].indexOf(params.get("level")) >= 0 ? params.get("level") : "";
        var all = ((fed && fed.races) || []).map(function (x) { return Object.assign({ level: "federal" }, x); });
        var byLevel = function (lv) { return all.filter(function (x) { return x.level === lv; }); };
        var fedR = byLevel("federal"), stR = byLevel("state"), ctyR = byLevel("county");
        var ccds = (col && col.districts) || [];
        var notes = (fed && fed.ballot && fed.ballot.level_notes) || {};
        var certified = fed && fed.ballot && fed.ballot.certified_at;
        var items = [["", "All levels"], ["federal", "Federal", null, fedR.length || null],
          ["state", "State", stR.length ? null : "not collected", stR.length || null],
          ["county", "County", ctyR.length ? null : "not collected", ctyR.length || null]];
        if (sc.code === "CA") items.push(["college", "College boards", ccds.length ? null : "not entered", ccds.length || null]);
        var count, list;
        var fromBallot = certified ? "the Secretary of State's certified list of candidates (" + fmtLong(certified) + ")" : "the state's certified list";
        if (level === "college") {
          count = ccds.length ? plural(ccds.length, "community college district has", "community college districts have") + " trustee seats on the ballot. Student trustees are elected by students on campus and are not on this ballot."
            : "College board seats for this cycle have not been entered yet. Student trustees are elected by students on campus and are not on this ballot.";
          list = el("ul", { class: "plain vlist" }, ccds.map(function (d) { return collegeRow(d, sc); }));
        } else if ((level === "state" && !stR.length) || (level === "county" && !ctyR.length)) {
          count = (level === "state" ? "State" : "County") + " races are not collected for " + sc.name + " yet.";
          list = officialListNote(sc, level === "state" ? "Statewide and legislative races" : "County races");
        } else if (level === "state") {
          count = plural(stR.length, "state race", "state races") + " on " + sc.name + " ballots, from " + fromBallot + "." +
            (stR.some(function (x) { return x.office === "RET"; }) ? " Includes the Supreme Court and Court of Appeal retention questions." : "");
          list = groupedRaces(stR, "state", sc, fed);
        } else if (level === "county") {
          count = plural(ctyR.length, "county race", "county races") + " on " + sc.name + " ballots, from county registrars' candidate lists. " +
            (notes.county ? "Seats decided outright in the primary are not listed." : "") + (sc.code === "CA" ? " Glenn and Mendocino are not entered yet." : "");
          list = groupedRaces(ctyR, "county", sc, fed);
        } else {
          var senate = fedR.filter(function (x) { return x.office === "S"; }).length, house = fedR.filter(function (x) { return x.office === "H"; }).length;
          var seats = [senate ? plural(senate, "U.S. Senate seat", "U.S. Senate seats") : null, house ? plural(house, "U.S. House seat", "U.S. House seats") : null].filter(Boolean).join(" and ");
          var who = certified ? "Candidates are from " + fromBallot + "." : "Candidates are those registered with the FEC; the state's certified list says who is on the ballot.";
          if (level === "federal") {
            count = fedR.length ? plural(fedR.length, "federal race", "federal races") + " in " + sc.name + (sc.nxt ? " on " + fmtLong(sc.nxt.date) : "") + ": " + seats + ". " + who
              : fed ? "No federal races on file for " + sc.name + " this cycle." : "Federal candidates have not been published yet.";
          } else if (!stR.length && !ctyR.length) {
            count = fedR.length ? plural(fedR.length, "federal race", "federal races") + " in " + sc.name + (sc.nxt ? " on " + fmtLong(sc.nxt.date) : "") + ": " + seats + ". " + who +
                " State and county races are not collected yet; the state's certified list has them."
              : fed ? "No federal races on file for " + sc.name + " this cycle." : "Federal candidates have not been published yet.";
          } else {
            var parts2 = [fedR.length ? fedR.length + " federal" : null, stR.length ? stR.length + " state" : null, ctyR.length ? ctyR.length + " county" : null].filter(Boolean);
            count = plural(all.length, "race", "races") + " in " + sc.name + (sc.nxt ? " on " + fmtLong(sc.nxt.date) : "") + ": " + listWords(parts2) + ". " +
              (certified ? "Federal and state candidates are from " + fromBallot + (ctyR.length ? "; county candidates from the county registrars' lists." : ".") : who);
          }
          var shown = level === "federal" ? fedR : all;
          list = shown.length ? el("ul", { class: "plain vlist" }, shown.map(function (x) { return raceRow(x, sc, null, fed); })) : null;
        }
        var freshBits = level === "college" ? null
          : (level === "state" || level === "county") && certified ? [level === "state" ? "Certified list " : "State certified list ", time(certified), " · "]
          : fed && fed.source_updated_at ? ["Newest FEC filing ", time(fed.source_updated_at), " · "] : null;
        var body = frag(deadlines(sc), doorsNav(sc),
          el("div", { class: "door-body" },
            el("div", { class: "controls" }, chipBar(sc, level, items)),
            el("p", { class: "results", id: "results", tabindex: "-1" }, count),
            el("h2", { class: "visually-hidden" }, level === "college" ? "College board seats" : "Races"),
            list,
            el("p", { class: "fresh" }, freshBits, "Retrieved ", time(fed ? fed.retrieved_at : sc.row.site_checked_at, true))));
        return { title: sc.name, docTitle: sc.name + ": who's running", head: placeHead(sc), body: body };
      });
    });
  }

  // ---------- your ballot ----------
  function levelOfContest(c) {
    var lv = (c.level || [])[0] || "";
    if (c.type === "Referendum") return "measure";
    if (lv === "country") return "federal";
    if (lv === "administrativeArea1") return "state";
    if (lv === "administrativeArea2") return "county";
    if (/College|School|Community College/i.test(c.office || "")) return "college";
    return "local";
  }
  function contestRow(c) {
    var lv = levelOfContest(c);
    var cands = c.candidates || [];
    var ref = c.type === "Referendum";
    return el("li", { class: "vrow race" },
      el("span", { class: "vr-level" }, badge(lv)),
      el("div", { class: "vr-main" },
        el("h3", null, ref ? (c.referendumTitle || "Measure") : (c.office || "Contest")),
        ref ? el("p", { class: "note" }, c.referendumSubtitle || c.referendumBrief || null, c.referendumUrl && safeUrl(c.referendumUrl) ? [" ", ext(c.referendumUrl, "Full text and arguments", " (the official measure page)")] : null) : null,
        cands.length ? el("ul", { class: "plain cands" }, cands.map(function (x) {
          return el("li", { class: "cand" }, el("span", { class: "nm" }, x.name || ""), el("span", { class: "meta" }, [x.party || null, x.candidateUrl && safeUrl(x.candidateUrl) ? ext(x.candidateUrl, "website", " (the candidate's own site)") : null].filter(Boolean).map(function (b, i) { return [i ? " · " : null, b]; })));
        })) : null),
      el("span", { class: "vr-result" }, ref ? "For or against" : c.numberElected ? "Vote for " + c.numberElected : null),
      el("span", { class: "vr-date" }, (c.sources || []).some(function (s) { return s.official; }) ? "Official" : "Not official"));
  }
  function lookupBallot(address, electionId) {
    var u = new URL(CIVIC_URL);
    u.searchParams.set("address", address);
    u.searchParams.set("key", CIVIC_KEY);
    if (electionId) u.searchParams.set("electionId", electionId);
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT);
    return fetch(u.href, { signal: ctrl.signal, referrerPolicy: "strict-origin-when-cross-origin" }).then(function (r) {
      clearTimeout(timer);
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.ok) return j;
        var msg = (j.error && j.error.message) || ("HTTP " + r.status);
        var e = new Error(msg); e.status = r.status; e.code = j.error && j.error.status; throw e;
      });
    }, function () { clearTimeout(timer); var e = new Error("network"); e.status = 0; throw e; });
  }
  function viewBallot(sc) {
    var code = sc ? sc.code : null;
    var input = el("input", { id: "addr", name: "address", type: "text", autocomplete: "street-address", spellcheck: "false", placeholder: "Street address, city, state", value: pendingAddress || null });
    var out = el("div", { class: "ballot-out" });
    var found = el("p", { class: "results", id: "results", tabindex: "-1" });
    var clearBtn = el("button", { type: "button", class: "btn", on: { click: function () { input.value = ""; pendingAddress = ""; out.replaceChildren(); found.textContent = ""; input.focus(); } } }, "Clear");
    var form = el("form", { class: "leg-search ballot-form", action: href(code ? [CODE_SLUG[code], "ballot"] : ["ballot"]), method: "get", on: { submit: function (e) { e.preventDefault(); run(); } } },
      el("label", { for: "addr" }, "Your registered address"),
      el("div", { class: "search-row" }, input, el("button", { type: "submit", class: "btn go" }, "Find my ballot"), clearBtn),
      el("p", { class: "privacy" }, "Sent once to Google's Civic Information service to find your districts. Not stored, not written to the address bar, not sent anywhere else. Clear removes it from the page."));
    function fail(text) {
      found.textContent = "";
      out.replaceChildren(el("div", { class: "err", role: "alert" }, el("h2", null, "No ballot found"), el("p", null, text),
        el("p", null, sc && sc.row.site ? [ext(sc.row.site, "The " + (sc.row.office || "state election office"), " (the state's official election site)"), " has the official list. "] : null,
          code ? link(href([sc.slug]), "See who's running in " + sc.name) : link(BASE, "Pick a state"), ".")));
    }
    function run() {
      var addr = input.value.trim();
      pendingAddress = addr;
      if (!addr) { input.focus(); return; }
      if (!CIVIC_KEY) { fail("The ballot lookup is not configured on this site."); return; }
      found.textContent = "Looking up the ballot…";
      out.replaceChildren();
      lookupBallot(addr).then(function (j) {
        var contests = j.contests || [];
        var elec = j.election || {};
        if (!contests.length) { fail("No contests were returned for that address. Outside an election window the lookup service has nothing to show; it may also not know the address."); return; }
        var byLevel = {};
        contests.forEach(function (c) { var l = levelOfContest(c); byLevel[l] = (byLevel[l] || 0) + 1; });
        var counts = ["federal", "state", "county", "local", "college", "measure"].filter(function (l) { return byLevel[l]; }).map(function (l) { return byLevel[l] + " " + LEVEL_NAME[l].toLowerCase(); });
        var admin = (j.state && j.state[0] && j.state[0].electionAdministrationBody) || {};
        var local = (j.state && j.state[0] && j.state[0].local_jurisdiction && j.state[0].local_jurisdiction.electionAdministrationBody) || {};
        found.textContent = plural(contests.length, "contest", "contests") + " at that address: " + listWords(counts) + ". " + (local.name ? local.name + " runs this election. " : "") + "Rows marked Official come from the state's own feed.";
        var order = { federal: 0, state: 1, county: 2, local: 3, college: 3, measure: 4 };
        contests.sort(function (a, b) { return order[levelOfContest(a)] - order[levelOfContest(b)]; });
        var places = (j.pollingLocations || []).concat(j.earlyVoteSites || []).slice(0, 4);
        out.replaceChildren(
          el("h2", { class: "ballot-h" }, "Your ballot for " + (elec.electionDay ? fmtLong(elec.electionDay) : elec.name || "the next election")),
          el("ul", { class: "plain vlist" }, contests.map(contestRow)),
          section("Where to vote", frag(
            places.length ? el("ul", { class: "plain" }, places.map(function (pl) { var a = pl.address || {}; return el("li", null, (a.locationName ? a.locationName + ": " : "") + [a.line1, a.city, a.state, a.zip].filter(Boolean).join(", "), pl.pollingHours ? " · " + pl.pollingHours : ""); })) : null,
            el("p", null, local.name && local.electionInfoUrl && safeUrl(local.electionInfoUrl) ? ext(local.electionInfoUrl, local.name, " (the county election office)") : admin.electionInfoUrl && safeUrl(admin.electionInfoUrl) ? ext(admin.electionInfoUrl, admin.name || "The state election office", " (the state's official election site)") : "Your county election office has the polling place list.",
              admin.votingLocationFinderUrl && safeUrl(admin.votingLocationFinderUrl) ? [" · ", ext(admin.votingLocationFinderUrl, "Polling place finder", " (official lookup)")] : null))));
        document.getElementById("results").focus({ preventScroll: true });
      }).catch(function (e) {
        if (e.status === 0) fail("The lookup service did not answer. Check the connection and try again.");
        else if (e.status === 400 || e.code === "INVALID_ARGUMENT") fail("The lookup service could not use that address. Try a full street address with city and state.");
        else if (e.status === 404 || e.code === "NOT_FOUND") fail("No election information is available for that address right now. Outside an election window the lookup service has nothing to show.");
        else fail("The lookup service returned an error (" + (e.message || "unknown") + ").");
      });
    }
    var body = frag(sc ? deadlines(sc) : null, sc ? doorsNav(sc) : null, el("div", { class: "door-body" }, form, found, out));
    var head = sc ? placeHead(sc) : pageHead({ title: "Your ballot", crumbs: [["All states", BASE], "Your ballot"] });
    return { title: sc ? sc.name : "Your ballot", docTitle: (sc ? sc.name + ": " : "") + "your ballot", head: head, body: body, after: function () { if (pendingAddress) run(); } };
  }
  function loadBallot(parts, params, c) { return need(c, ["manifest.json", "geo/states.json", "elections/calendar.json", "elections/states.json"]); }
  function viewBallotAlone() { return Promise.all([states(), calendar(), electionStates(), manifest()]).then(function () { return viewBallot(null); }); }

  // ---------- results ----------
  function resultRow(r) {
    var cs = (r.candidates || []).slice().sort(function (a, b) { return (b.votes || 0) - (a.votes || 0); });
    var total = cs.reduce(function (s, c) { return s + (c.votes || 0); }, 0);
    var win = cs.filter(function (c) { return c.elected; });
    var pct = function (c) { return total ? (100 * (c.votes || 0) / total).toFixed(1) + "%" : ""; };
    var winner = win[0];
    return el("li", { class: "vrow race" },
      el("span", { class: "vr-level" }, badge(r.level || "federal")),
      el("div", { class: "vr-main" },
        el("h3", null, r.label),
        el("ul", { class: "plain cands" }, cs.map(function (c) {
          return el("li", { class: "cand" }, el("span", { class: c.elected ? "nm won" : "nm" }, (c.elected ? (r.measure ? "Passed: " : "Elected: ") : "") + personName(c.name)),
            el("span", { class: "meta" }, [party(c.party, c.party_full), c.incumbent ? "incumbent" : null, !c.elected && c.votes != null ? c.votes.toLocaleString() + " · " + pct(c) : null].filter(Boolean).join(" · ")));
        }))),
      el("span", { class: "vr-result num" }, winner && winner.votes != null ? winner.votes.toLocaleString() + " · " + pct(winner) : "—"),
      el("span", { class: "vr-date" }, r.certified_at ? ["Certified ", el("time", { datetime: r.certified_at }, fmtShortY(r.certified_at)), r.certified_by ? ", " + r.certified_by : null] : "Not certified yet"));
  }
  function viewResults(sc, params) {
    return results(sc.code).then(function (res) {
      var elections = (res && res.elections) || [];
      var want = params ? params.get("election") : null;
      var pick = /^\d{4}-\d{2}-\d{2}$/.test(want || "") ? want : (elections[0] && elections[0].date);
      var e = elections.filter(function (x) { return x.date === pick; })[0] || null;
      var count = e ? plural((e.races || []).length, "certified result", "certified results") + " for " + fmtLong(e.date) + ". Counts are the certifying office's final canvass; nothing here updates on election night."
        : "No certified results on file for " + sc.name + " yet." + (sc.nxt ? " The " + fmtLong(sc.nxt.date) + " election is certified by the state weeks after election day; until then the official live count is at the state's election office." : "");
      var body = frag(deadlines(sc), doorsNav(sc),
        el("div", { class: "door-body" },
          e && elections.length > 1 ? el("div", { class: "controls" }, el("div", { class: "chips", role: "group", "aria-label": "Election" }, elections.map(function (x) {
            return el("a", { href: href([sc.slug, "results"], { election: x.date }), class: "chip", "aria-current": x.date === pick ? "true" : null, "data-focus": "#results", "data-announce": true }, fmtLong(x.date));
          }))) : null,
          el("p", { class: "results", id: "results", tabindex: "-1" }, count),
          e ? el("h2", { class: "visually-hidden" }, "Results by race") : null,
          e ? el("ul", { class: "plain vlist" }, (e.races || []).map(resultRow)) : officialListNote(sc, "Results"),
          e ? el("p", { class: "fresh" }, "Source: ", e.source_name || "official canvass", e.source_url ? [" · ", ext(e.source_url, "statement of vote", " (the official results page)")] : null) : null));
      return { title: sc.name, docTitle: sc.name + ": results", head: placeHead(sc), body: body };
    });
  }

  // ---------- one race ----------
  function loadRace(parts, params, c) {
    var m = /^\d{4}-([a-z]{2})-/.exec(parts[1] || "");
    return need(c, ["manifest.json", "geo/states.json", "elections/calendar.json", "elections/states.json"].concat(m ? ["elections/us-" + m[1] + "/federal.json"] : []));
  }
  function viewRace(parts) {
    var id = parts[1];
    var m = /^\d{4}-([a-z]{2})-/.exec(id || "");
    if (!m) return notFound();
    var code = m[1].toUpperCase();
    return Promise.all([states(), calendar(), electionStates(), federal(code)]).then(function (r) {
      var fed = r[3];
      var race = ((fed && fed.races) || []).filter(function (x) { return x.id === id; })[0];
      if (!race || !STATE_NAME[code]) return notFound();
      var row = r[2].by[code] || {};
      var nxt = nextElection(r[1], code);
      var lv = race.level || "federal";
      var ballot = fed.ballot || null;
      var onBallot = ballot && (lv !== "federal" || race.candidates.some(function (c) { return c.designation; }));
      var ret = race.office === "RET";
      var srcLink = lv === "county" ? (race.official_url ? ext(race.official_url, "The county registrar's candidate list", " (the county registrar's list)") : null)
        : onBallot && ballot.official_list_url ? ext(ballot.official_list_url, "The certified list", " (the state's certified list of candidates)")
        : row.site ? ext(row.site, "The " + (row.office || "state election office") + "'s certified list", " (the state's official election site)") : null;
      var lede = el("p", { class: "lede" }, nxt ? "On the ballot " + fmtLong(nxt.date) + ". " : null,
        lv === "county" ? "These are the candidates on the county registrar's list, with the ballot designation each one chose. "
          : onBallot ? (ret ? "Voters answer yes or no on each justice; a justice stays in office with a majority of yes votes. "
            : "These are the candidates on the Secretary of State's certified list, with the ballot designation each one chose. ")
          : "Candidates are those registered with the Federal Election Commission for the " + fed.cycle + " cycle; registering is not the same as qualifying for the ballot. ",
        srcLink ? [srcLink, " is the official word."] : null);
      var topTwo = code === "CA" && !ret && lv !== "county" && race.candidates.length === 2
        ? el("p", { class: "note" }, "California sends the top two from the June 2 primary to November, whatever their party. Ballot designations are the candidate's own words, as approved by the Secretary of State.") : null;
      var body = frag(lede,
        section(ret ? plural(race.candidates.length, "justice", "justices") : plural(race.candidates.length, "candidate", "candidates"), el("ul", { class: "plain cands big" }, race.candidates.map(function (c) {
          var p = c.party === "NP" ? null : party(c.party, c.party_full && c.party_full !== c.party_full.toUpperCase() ? c.party_full : null);
          var meta = lv === "federal" && !onBallot
            ? [p, c.incumbent ? "incumbent" : null, c.raised ? "has raised money" : "no money raised yet", c.first_filed ? "first filed " + fmtLong(c.first_filed) : null]
            : [p, c.incumbent ? "incumbent" : null, c.designation && !(c.incumbent && /^incumbent$/i.test(c.designation.trim())) ? "Ballot designation: " + c.designation : null];
          return el("li", { class: "cand" }, el("span", { class: "nm" }, personName(c.name)),
            el("span", { class: "meta" }, meta.filter(Boolean).join(" · "),
              c.fec_url ? [" · ", ext(c.fec_url, "FEC filings", " (the candidate's page at the FEC)")] : null));
        }))), topTwo,
        el("p", { class: "fresh" }, onBallot && ballot.certified_at ? ["Certified list ", time(ballot.certified_at), " · "] : fed.source_updated_at ? ["Newest filing ", time(fed.source_updated_at), " · "] : null, "Retrieved ", time(fed.retrieved_at, true)));
      var crumbs = [["All states", BASE], [STATE_NAME[code], href([CODE_SLUG[code]])]];
      if (lv !== "federal") crumbs.push([LEVEL_NAME[lv], href([CODE_SLUG[code]], { level: lv })]);
      crumbs.push(rowTitle(race));
      return { title: race.label, docTitle: race.label, crumbs: crumbs, body: body };
    });
  }

  // ---------- every federal race ----------
  function loadRaces(parts, params, c) { return need(c, ["manifest.json", "geo/states.json", "elections/us/federal-index.json"]); }
  function viewRaces(parts, params) {
    return Promise.all([states(), get("elections/us/federal-index.json", true)]).then(function (r) {
      var idx = r[1];
      var rows = ((idx && idx.rows) || []).map(function (x) { return { id: x[0], state: x[1], office: x[2], district: x[3], label: x[4], n: x[5], incumbent: x[6] }; });
      var q = (params.get("q") || "").trim().toLowerCase();
      if (q) rows = rows.filter(function (x) { return (x.label + " " + (x.incumbent || "") + " " + STATE_NAME[x.state]).toLowerCase().indexOf(q) >= 0; });
      var input = el("input", { id: "q", name: "q", type: "search", value: q || null, placeholder: "State, district or incumbent" });
      var form = el("form", { class: "leg-search", role: "search", action: href(["races"]), method: "get", on: { submit: function (e) { e.preventDefault(); navigate(href(["races"], { q: input.value.trim() }), { focusSel: "#results", keepScroll: true, announce: true }); } } },
        el("label", { for: "q" }, "Filter the list"), el("div", { class: "search-row" }, input, el("button", { type: "submit", class: "btn go" }, "Filter")));
      var body = frag(form,
        el("h2", { class: "visually-hidden" }, "Races"),
        el("p", { class: "results", id: "results", tabindex: "-1" }, idx ? plural(rows.length, "federal race", "federal races") + (q ? " matching “" + q + "”" : "") + " in the " + idx.cycle + " cycle, from the FEC's candidate registrations." : "Federal races have not been published yet."),
        el("ul", { class: "plain vlist" }, rows.map(function (x) {
          return el("li", { class: "vrow race" }, el("span", { class: "vr-level" }, badge("federal")),
            el("div", { class: "vr-main" }, el("h3", null, link(href(["race", x.id]), x.label)), x.incumbent ? el("p", { class: "note" }, "Incumbent: " + personName(x.incumbent)) : null),
            el("span", { class: "vr-result" }, plural(x.n, "candidate", "candidates")), el("span", { class: "vr-date" }, link(href([CODE_SLUG[x.state]]), STATE_NAME[x.state] || x.state)));
        })));
      return { title: "Every federal race", crumbs: [["All states", BASE], "Every federal race"], lede: "Every U.S. Senate and U.S. House seat on the ballot this cycle, in every state, with the people registered to run for it.", body: body };
    });
  }

  // ---------- sources ----------
  function loadSources(parts, params, c) { return need(c, ["manifest.json", "elections/states.json"]); }
  function viewSources() {
    return Promise.all([manifest(), electionStates()]).then(function (r) {
      var man = r[0];
      var ids = Object.keys(man.sources || {}).filter(function (k) { return (man.sources[k].level || "") === "election"; });
      var rows = ids.map(function (k) {
        var s = man.sources[k];
        return el("tr", null, el("th", { scope: "row" }, s.url && safeUrl(s.url) ? ext(s.url, s.name || k, " (the source's own site)") : (s.name || k)),
          el("td", null, s.official ? "Official" : "Not official"), el("td", { class: "st-" + s.status }, statusWord(s)), el("td", null, s.last_checked_at ? time(s.last_checked_at, true) : "—"), el("td", null, s.note || s.error || ""));
      });
      var st = ((r[1].data && r[1].data.states) || []);
      var dead = st.filter(function (x) { return x.site_reachable === false; });
      var body = frag(
        el("p", null, "Generated ", time(man.generated_at, true), ". Each source is checked nightly; one that fails keeps its last good copy and is marked here."),
        el("table", { class: "tbl" }, el("caption", null, "Election sources"), el("thead", null, el("tr", null, el("th", { scope: "col" }, "Source"), el("th", { scope: "col" }, "Kind"), el("th", { scope: "col" }, "Status"), el("th", { scope: "col" }, "Last checked"), el("th", { scope: "col" }, "Note"))), el("tbody", null, rows)),
        section("State election offices", frag(
          el("p", null, st.length + " state election sites on file; a seventh of them are checked each night. " + (dead.length ? "Not answering at the last check: " + listWords(dead.map(function (x) { return x.name; })) + "." : "All of those checked so far answered.")),
          el("ul", { class: "plain cols" }, st.map(function (x) { return el("li", null, x.site ? ext(x.site, x.name + ": " + (x.office || "election office"), " (the state's official election site)") : x.name); })))),
        section("Your ballot", el("p", null, CIVIC_KEY ? "The ballot lookup calls Google's Civic Information API from your browser with the address you type, once, and nothing is stored. Google marks each contest as coming from an official state feed or not, and the page prints that word." : "The ballot lookup is not configured on this site.")));
      return { title: "Sources", crumbs: [["All states", BASE], "Sources"], body: body };
    });
  }

  // ---------- routes ----------
  var ROUTES = [
    { name: "map", test: function (p) { return p.length === 0; }, load: loadMap, view: function () { return viewMap(); } },
    { name: "ballot", test: function (p) { return p.length === 1 && p[0] === "ballot"; }, load: loadBallot, view: function () { return viewBallotAlone(); } },
    { name: "races", test: function (p) { return p.length === 1 && p[0] === "races"; }, load: loadRaces, view: viewRaces },
    { name: "sources", test: function (p) { return p.length === 1 && p[0] === "sources"; }, load: loadSources, view: function () { return viewSources(); } },
    { name: "race", test: function (p) { return p.length === 2 && p[0] === "race"; }, load: loadRace, view: viewRace },
    { name: "place", test: function (p) { return !!placeParts(p); }, load: loadPlace, view: viewPlace,
      next: function (p) { var s = placeParts(p); return s && s.door === "running" && CIVIC_KEY ? href([s.slug, "ballot"]) : null; } }
  ];

  route();
})();
