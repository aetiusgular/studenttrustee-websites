/* Legislation section: a small client-side router over the JSON records the nightly pipeline
   publishes. No framework. Every page is a route: a loader that names the files the page needs
   and a view that builds the page with el() and returns it. render() swaps the view into #app,
   sets the title and moves focus to the page's h1, or, after a level chip, a door or a filter, to
   the control or the list that changed.

   Addresses name places and doors (layout D of Nick's "Legislation tab options"):
     /legislation/                                   every state, on a tile map
     /legislation/{state}/                           How they voted: federal, state and county votes
     /legislation/{state}/representatives/           Who represents me
     /legislation/{state}/upcoming/                  What's coming up
     /legislation/{state}/bills/, /sources/          the legislature's bills; the state's sources
     /legislation/{state}/{county}/[representatives/|upcoming/]   the same doors for a county
     /legislation/vote|bill|legislator/{id}/         one record
     /legislation/votes/, /bills/, /upcoming/, /search/, /sources/   national lists and tools
   Filters are query parameters (level, body, result, month, ...) and never name a page. Older
   addresses (/legislation/states/, a state's /legislators/, the state and county vote lists) are
   rewritten to the new ones before routing, with history.replaceState.

   Loaders serve two callers: navigation, which waits for them before drawing the page, and
   prefetch, which runs the same loader at low priority when a visitor shows intent to open a link
   (pointer resting on it, keyboard focus, or a touch). So a prefetched page and a visited page
   always want the same files.

   Data layout (written by tools/legislation/*.py):
     manifest.json, legislatures.json    per-source status; one row per legislature
     geo/states.json, geo/counties.json  every state; every county (name, state, slug)
     geo/us-{st}/counties.json           each county's districts and board, per state
     us/members.json, us/votes/…, us/bills/119/…, us/records/…, us/upcoming.json, us/latest.json
     us-ca/members.json, us-ca/votes/…, us-ca/bills/20252026/…, us-ca/records/…, us-ca/upcoming.json
     us-ca/counties/index.json, us-ca/counties/upcoming.json, us-ca/counties/{fips}/board.json, votes-YYYY-MM.json
     counties/index.json, counties/latest.json, counties/upcoming.json   county boards outside California
     us-{st}/members.json, us-{st}/summary.json   every other state's legislators (Open States)
     us-{st}/votes/…, us-{st}/bills/…, us-{st}/records/…   their bills and votes, where collected
     search/us.json, search/us-ca.json, search/states.json */
(function () {
  "use strict";

  // The records are published nightly to GitHub Pages (the repository's data branch), so a data
  // refresh never triggers a Netlify deploy. Local development and the test suite serve the same
  // files from studenttrustee/data/legislation/ on the dev server.
  var META = document.querySelector('meta[name="st-legislation-data"]');
  var LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  var DATA = LOCAL || !META ? "/data/legislation/" : META.getAttribute("content");
  var BASE = "/legislation/";
  var PAGE = 50;
  var TZ = "America/Los_Angeles";
  var app = document.getElementById("app");
  var status = document.getElementById("status");

  // ---------- data API ----------
  // Every read of a record goes through api.get(). The rules:
  //   GET only, one origin, no query strings, default credentials (no cookies cross-origin; this
  //   also matches the <link rel=preload crossorigin> in the page head, so a preload is reused);
  //   one request per file, shared by every caller, kept in memory for 30 minutes;
  //   a 10 second timeout, and one retry after a second for a network error or a 5xx;
  //   a 404 is final and reported as missing; a failure is remembered for 3 seconds, so the
  //   loader and the view do not both wait out the same timeout;
  //   every file may carry schema_version, and a newer one than this code knows asks for a reload;
  //   each request has owners (a page, or prefetch). Leaving a page releases its requests, and any
  //   request no one else wants is aborted.
  var SCHEMA_MAX = 1;
  var TIMEOUT = 10000, RETRY_AFTER = 1000, KEEP = 30 * 60 * 1000, FAIL_MEMORY = 3000, PREFETCH_SLOTS = 2;
  var MISSING = { missing: true };
  var SAFE_REL = /^[A-Za-z0-9_-][A-Za-z0-9_./-]*\.json$/;

  function ApiError(kind, rel, httpStatus) {
    var msg = kind === "timeout" ? "The records service did not answer within " + (TIMEOUT / 1000) + " seconds."
      : kind === "network" ? "The records service could not be reached. Check the connection, then try again."
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
    var files = {};          // rel -> entry
    var queue = [];          // prefetch entries waiting for a slot
    var running = 0;         // prefetch requests in flight

    function attempt(rel, entry, retried) {
      var ctrl = new AbortController();
      var timedOut = false;
      var timer = setTimeout(function () { timedOut = true; ctrl.abort(); }, TIMEOUT);
      entry.controller = ctrl;
      var init = { signal: ctrl.signal };
      if (entry.low) init.priority = "low";
      return fetch(DATA + rel, init).then(function (r) {
        if (!r.ok) {
          // The body of an error is never read; cancel it so the connection is free for the next file.
          if (r.body) r.body.cancel().catch(function () {});
          if (r.status === 404) return MISSING;
          throw ApiError(r.status >= 500 ? "server" : "http", rel, r.status);
        }
        return r.json().catch(function (e) {
          if (ctrl.signal.aborted) throw e;
          throw ApiError("format", rel);
        });
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
      }).then(function () {
        if (entry.prefetch) { running--; next(); }
      });
    }

    function next() {
      while (running < PREFETCH_SLOTS && queue.length) {
        var entry = queue.shift();
        start(entry.rel, entry);
      }
    }

    function get(rel, opts) {
      opts = opts || {};
      // Paths are built from ids in the address; anything outside the data folder's own names is
      // treated as a file that does not exist, and never requested.
      if (!SAFE_REL.test(rel) || /(^|\/)\.\.?(\/|$)/.test(rel)) return opts.optional ? Promise.resolve(null) : Promise.reject(ApiError("missing", rel, 404));
      var e = files[rel];
      var now = Date.now();
      if (e && e.state === "done" && now - e.at > KEEP) e = null;
      if (e && e.state === "failed" && now - e.at > FAIL_MEMORY) e = null;
      if (!e) {
        e = files[rel] = { rel: rel, state: "pending", owners: {}, started: false, prefetch: !!opts.prefetch, low: !!opts.low };
        e.promise = new Promise(function (resolve, reject) { e.resolve = resolve; e.reject = reject; });
        e.promise.catch(function () {});
        if (opts.prefetch && running >= PREFETCH_SLOTS) queue.push(e);
        else start(rel, e);
      } else if (e.state === "pending" && !e.started && !opts.prefetch) {
        start(rel, e);   // a page now needs what was only queued for prefetch
      }
      if (e.state === "pending" && opts.owner) e.owners[opts.owner.id] = true;
      var p = e.state === "done" ? Promise.resolve(e.value) : e.state === "failed" ? Promise.reject(e.error) : e.promise;
      return p.then(function (v) {
        if (v === MISSING) {
          if (opts.optional) return null;
          throw ApiError("missing", rel, 404);
        }
        return v;
      });
    }

    // A page is done with its requests. Anything no one else wants is aborted on the next turn,
    // after the next page has had the chance to ask for the same files.
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
    // A new intent replaces the old: prefetches that have not started yet are dropped.
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
    function forgetFailures() {
      Object.keys(files).forEach(function (rel) { if (files[rel].state === "failed") delete files[rel]; });
    }
    function pending() {
      return Object.keys(files).filter(function (rel) { return files[rel].state === "pending"; });
    }
    return { get: get, release: release, dropQueued: dropQueued, forgetFailures: forgetFailures, pending: pending };
  })();

  // Requests made while a page renders belong to that page.
  var PREFETCH = { id: "prefetch" };
  var activeOwner = null;
  var ownerSeq = 0;
  function get(rel, optional) { return api.get(rel, { optional: optional, owner: activeOwner }); }

  // Loader contexts. Navigation fetches everything the page needs; prefetch fetches at low
  // priority through two slots, and on a mere hover leaves out the large files.
  function navContext() {
    return { get: function (rel) { return api.get(rel, { optional: true, owner: activeOwner }); }, light: false, nav: true };
  }
  function prefetchContext(light) {
    return { light: light, get: function (rel, o) {
      if (light && o && o.big) return Promise.resolve(null);
      return api.get(rel, { optional: true, owner: PREFETCH, prefetch: true, low: true });
    } };
  }
  function need(c, list) { return Promise.all(list.filter(Boolean).map(function (x) { return typeof x === "string" ? c.get(x) : c.get(x.rel, x); })); }

  // ---------- DOM ----------
  // Pages are built from elements and text nodes only. No HTML string is ever parsed: the
  // Legislation pages are served with Trusted Types enforced, so an HTML sink would throw.
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
    // append(node, child, child, ...): strings become text, arrays are flattened, null/false are skipped
    for (var i = 1; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined || child === false) continue;
      if (Array.isArray(child)) { child.forEach(function (c) { append(node, c); }); continue; }
      node.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
    }
  }
  function frag() { var f = document.createDocumentFragment(); for (var i = 0; i < arguments.length; i++) append(f, arguments[i]); return f; }
  function link(href, text, cls) { return el("a", { href: href, class: cls || null }, text); }
  // Links that come from the records (official pages, board websites) are only ever http(s).
  // Anything else (javascript:, data:, a relative path) is dropped and its text kept.
  function safeUrl(u) {
    if (typeof u !== "string" || !/^https?:\/\//i.test(u.trim())) return null;
    try { var p = new URL(u.trim()); return p.protocol === "https:" || p.protocol === "http:" ? p.href : null; } catch (e) { return null; }
  }
  function ext(href, text, hint) {
    var u = safeUrl(href);
    if (!u) return el("span", null, text);
    return el("a", { href: u, class: "ext", rel: "noopener" }, text, el("span", { class: "visually-hidden" }, hint || " (official source, opens the government site)"));
  }
  function mailLink(addr, text) {
    return typeof addr === "string" && /^[^\s@<>()"',;:]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(addr) ? el("a", { href: "mailto:" + addr }, text || addr) : null;
  }
  function telLink(phone) {
    var digits = (phone || "").replace(/[^\d+]/g, "");
    return digits.length >= 7 ? el("a", { href: "tel:" + digits }, phone) : el("span", null, phone || "");
  }

  // ---------- dates ----------
  var DATE_FMT = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "short", day: "numeric" });
  var TIME_FMT = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  var MONTH_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "long" });
  function isDateOnly(s) { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s); }
  function dateOnly(s) { var p = s.split("-"); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 12)); }
  function fmtDate(s) {
    if (!s) return "";
    if (isDateOnly(s)) return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" }).format(dateOnly(s));
    var d = new Date(s); if (isNaN(d)) return s;
    return DATE_FMT.format(d);
  }
  function fmtWhen(s) {
    if (!s) return "";
    if (isDateOnly(s)) return fmtDate(s);
    var d = new Date(s); if (isNaN(d)) return s;
    return TIME_FMT.format(d);
  }
  function fmtMonth(ym) { var p = ym.split("-"); return MONTH_FMT.format(new Date(Date.UTC(+p[0], +p[1] - 1, 15))); }
  // Zones the sources give times in: the abbreviation shown, and hours behind Eastern (for sorting;
  // Arizona, Hawaii and Puerto Rico skip daylight time, so their offsets are right half the year).
  var ZONES = { "America/New_York": ["ET", 0], "America/Detroit": ["ET", 0], "America/Indiana/Indianapolis": ["ET", 0], "America/Kentucky/Louisville": ["ET", 0],
    "America/Chicago": ["CT", 1], "America/Denver": ["MT", 2], "America/Boise": ["MT", 2], "America/Phoenix": ["MST", 3], "America/Los_Angeles": ["PT", 3],
    "America/Anchorage": ["AKT", 4], "Pacific/Honolulu": ["HST", 6], "America/Puerto_Rico": ["AST", 0] };
  function fmtClock(t, tz) {
    // "14:00" + "America/New_York" -> "2:00 PM ET". Times stay in the zone the source gives.
    var m = /^(\d{2}):(\d{2})$/.exec(t || "");
    if (!m) return t || "";
    var h = +m[1], ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return h + ":" + m[2] + " " + ap + " " + (ZONES[tz] || ZONES["America/Los_Angeles"])[0];
  }
  function whenKey(x) {
    // Sort key for scheduled items across time zones, in Eastern time. Items without a time sort last in their day.
    var m = /^(\d{2}):(\d{2})$/.exec(x.time || "");
    var mins = m ? (+m[1]) * 60 + (+m[2]) + 60 * (ZONES[x.tz] || ZONES["America/Los_Angeles"])[1] : 9999;
    return (x.date || "") + " " + String(mins).padStart(4, "0");
  }
  function clockPart(x) { return x.time ? " · " + fmtClock(x.time, x.tz) : x.time_note ? " · " + x.time_note : ""; }
  function time(s, withTime) { return s ? el("time", { datetime: s }, withTime ? fmtWhen(s) : fmtDate(s)) : el("span", { class: "unk" }, "not recorded"); }
  function todayISO() { var d = new Date(); return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d); }

  // ---------- vocabulary ----------
  var LEVEL_NAME = { federal: "Federal", state: "State", county: "County", geo: "Geography" };
  var BODY_NAME = { "us-house": "U.S. House", "us-senate": "U.S. Senate", "ca-assembly": "California Assembly", "ca-senate": "California Senate", "ca-legislature": "California Legislature" };
  var PARTY = { D: "Democrat", R: "Republican", I: "Independent", L: "Libertarian", G: "Green", NP: "Nonpartisan", P: "Progressive", F: "Forward",
    WF: "Working Families", PNP: "New Progressive", PPD: "Popular Democratic", PIP: "Puerto Rican Independence", MVC: "Citizens' Victory Movement", PD: "Project Dignity" };
  function badge(level) { return el("span", { class: "lvl lvl-" + level }, LEVEL_NAME[level] || level); }
  function bodyName(body, counties) {
    if (BODY_NAME[body]) return BODY_NAME[body];
    var sb = /^us-([a-z]{2})-(upper|lower|legislature)$/.exec(body || "");
    var si = sb && STATE_INFO[sb[1].toUpperCase()];
    if (si) {
      // "legislature" is a unicameral body, or in a two-chamber state the legislature as a whole
      var one = ((si.legislature && si.legislature.chambers) || []).length === 1;
      return sb[2] === "legislature" && !one ? stateLegName(si) : chamberTitle(si, sb[2]);
    }
    var m = /^[a-z]{2}-(\d{5})-bos$/.exec(body || "");
    if (m && counties) { var c = counties[m[1]]; if (c) return c.body_name; }
    return body || "";
  }
  function levelOf(body) { return body === "us-house" || body === "us-senate" ? "federal" : /-bos$/.test(body || "") ? "county" : "state"; }
  function resultWord(v) { return v.passed === true ? "Passed" : v.passed === false ? "Failed" : (v.result || "Recorded"); }
  function tally(v) {
    var t = v.tally || v;
    return el("span", { class: "tally" },
      el("span", { class: "t-yes" }, el("b", null, String(t.yes)), " yes"), " ",
      el("span", { class: "t-no" }, el("b", null, String(t.no)), " no"), " ",
      el("span", { class: "t-other" }, el("b", null, String((t.present || 0) + (t.not_voting || t.other || 0))), " other"));
  }
  function party(p) { return p ? (PARTY[p] || p) : ""; }
  function escapeRe(x) { return (x || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  function stripLabel(title, label) {
    // "AB 1: Residential property insurance" with label "AB 1" -> "Residential property insurance"
    if (!title || !label) return title || "";
    return title.replace(new RegExp("^" + escapeRe(label) + ":?\\s*"), "");
  }
  function cap(x) { return x ? x.charAt(0).toUpperCase() + x.slice(1) : x; }
  function ordinal(n) { var t = n % 100, u = n % 10; return n + (t >= 11 && t <= 13 ? "th" : u === 1 ? "st" : u === 2 ? "nd" : u === 3 ? "rd" : "th"); }
  function sessionLabel(sess) { return sess ? sess.slice(0, 4) + "–" + sess.slice(6, 8) : ""; }
  function congressYear(c, sess) { return 1787 + 2 * c + (sess - 1); }

  // ---------- routing ----------
  function safeDecode(x) { try { return decodeURIComponent(x); } catch (e) { return x; } }
  function parse(pathname) {
    var rest = pathname.indexOf(BASE) === 0 ? pathname.slice(BASE.length) : "";
    return rest.split("/").filter(Boolean).map(safeDecode);
  }
  // Filters are written in one fixed order, so one list has one address.
  var PARAM_ORDER = ["level", "body", "result", "month", "session", "type", "status", "year", "state", "q"];
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
  function billHref(id) { return href(["bill", id]); }
  function voteHref(id) { return href(["vote", id]); }
  function memberHref(id) { return href(["legislator", id]); }

  // ---------- rendering ----------
  // A view returns { title, crumbs, lede, body } for the standard page head, or { title, head, body }
  // when it draws its own head (the map, and the state and county pages). Either way the page has
  // one h1, #page-title. After an in-app navigation focus moves to it, or, for a level chip, a door
  // or a filter, to the control or list the visitor changed (opts.focusSel), keeping the scroll.
  var current = 0;
  var firstRender = true;
  var slowTimer = null;
  var pendingUi = {};          // a hint for the next view only: keep the filter drawer open after Apply
  function render(rt, parts, params, opts) {
    opts = opts || {};
    var run = ++current;
    var previous = activeOwner;
    activeOwner = { id: "page-" + (++ownerSeq) };
    api.release(previous);
    say("Loading…");
    clearTimeout(slowTimer);
    slowTimer = setTimeout(function () { if (run === current) say("Still loading. This page's records are large."); }, 2000);
    app.setAttribute("aria-busy", "true");
    var ui = pendingUi;
    pendingUi = {};
    var loaded = rt.load ? Promise.resolve().then(function () { return rt.load(parts, params, navContext()); }).catch(function () {}) : Promise.resolve();
    return loaded.then(function () {
      if (run !== current) return null;
      return Promise.all([Promise.resolve().then(function () { return rt.view(parts, params, ui); }), manifest().catch(function () { return null; })]);
    }).then(function (r) {
      if (!r || run !== current) return;
      var out = r[0];
      clearTimeout(slowTimer);
      app.replaceChildren();
      append(app, staleNotice(r[1]), out.head || pageHead(out), out.body);
      document.title = (out.docTitle || out.title) + " · Legislation · studenttrustee.net";
      setCanonical();
      app.removeAttribute("aria-busy");
      // The #fragment a link pointed at wins; then the element the link asked for; then the h1. On
      // the first load the browser has already put the reader at the top of the page.
      var hashTarget = location.hash ? document.getElementById(safeDecode(location.hash.slice(1))) : null;
      var target = hashTarget || (opts.focusSel ? app.querySelector(opts.focusSel) : null);
      if (target) {
        if (!target.hasAttribute("tabindex") && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) target.setAttribute("tabindex", "-1");
        if (hashTarget) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: "start" }); }
        else target.focus();
      } else {
        var h1 = document.getElementById("page-title");
        if (!firstRender && opts.focus !== false && h1) h1.focus({ preventScroll: true });
        if (!opts.keepScroll) window.scrollTo(0, 0);
      }
      firstRender = false;
      // A level chip keeps focus on itself, so the new count is announced instead.
      var res = opts.announce ? app.querySelector("#results") : null;
      say(res ? res.textContent : "");
      if (out.after) setTimeout(function () { if (run === current) out.after(); }, 0);   // after the page is drawn
      idlePrefetch(rt, parts, params);
    }).catch(function (e) {
      if (run !== current) return;
      clearTimeout(slowTimer);
      app.replaceChildren();
      append(app, pageHead({ title: "Legislation", crumbs: [["All states", BASE], "Page not loaded"] }), errorBox(e));
      document.title = "Page not loaded · Legislation · studenttrustee.net";
      app.removeAttribute("aria-busy");
      firstRender = false;
      say("");
    });
  }
  // The standard head: where the page sits, its title and a line about it.
  function pageHead(out) {
    return el("div", { class: "page-head" },
      out.crumbs ? crumbTrail(out.crumbs) : null,
      el("h1", { id: "page-title", tabindex: "-1" }, out.title),
      out.lede ? el("p", { class: "lede" }, out.lede) : null);
  }
  // [["All states", "/legislation/"], ["Texas", "/legislation/texas/"], "HB 2"]: links, then the page itself.
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
      el("p", { class: "row wrap" }, retry, " ", link(BASE, "Back to all states")));
  }
  // The job runs every night. If the newest records are more than a day and a half old it has
  // stopped (a failed check, a disabled schedule), and every page says so.
  var STALE_HOURS = 36;
  function staleNotice(man) {
    if (!man || !man.generated_at) return null;
    var hours = (Date.now() - Date.parse(man.generated_at)) / 36e5;
    if (!(hours > STALE_HOURS)) return null;
    return el("p", { class: "stale-all" }, el("strong", null, "Not refreshed since "), time(man.generated_at, true), el("strong", null, "."),
      " The nightly update has not run since then, so newer votes and schedule changes are missing. Each record links to its official source, which has the current version. ",
      link(href(["sources"]), "Source status"));
  }
  function say(t) { status.textContent = t; }
  // First path segments that are pages of their own; any other first segment is a state.
  var SECTIONS = ["states", "bill", "vote", "legislator", "votes", "bills", "upcoming", "search", "sources", "calendars"];
  // The last segment of a state's address picks a door; a county has the first two.
  var STATE_DOORS = { representatives: 1, upcoming: 1, bills: 1, sources: 1 };
  var COUNTY_DOORS = { representatives: 1, upcoming: 1 };
  function navigate(url, opts) {
    history.pushState(null, "", url);
    return route(opts);
  }
  // Links this router handles: same origin, under /legislation/, except the static calendars page.
  function inApp(u) { return u.origin === location.origin && u.pathname.indexOf(BASE) === 0 && !/^\/legislation\/calendars\//.test(u.pathname); }
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[href]");
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (a.target === "_blank" || a.hasAttribute("download")) return;
    var u = new URL(a.href, location.href);
    if (!inApp(u)) return;
    if (u.hash && u.pathname === location.pathname && u.search === location.search) return;   // same-page anchor, e.g. the skip link
    e.preventDefault();
    // Level chips and doors change the list below them: they name where focus goes next and keep
    // the scroll position. Every other link moves focus to the new page's heading.
    var opts = {};
    var f = a.getAttribute("data-focus");
    if (f) { opts.focusSel = f; opts.keepScroll = true; opts.announce = a.hasAttribute("data-announce"); }
    navigate(u.pathname + u.search + u.hash, opts);
  });
  window.addEventListener("popstate", function () { route(); });

  // Addresses from before the state pages had doors. Returns the new address (or a promise of it),
  // or null. The server sends the fixed-shape ones on with a 301 (_redirects); these run in the
  // page too, for in-app links and for the ones that need the records to translate.
  function legacy(parts, params) {
    if (parts.length === 1 && parts[0] === "states") return href([]);
    if (parts.length === 2 && parts[1] === "legislators" && SECTIONS.indexOf(parts[0]) < 0) return href([parts[0], "representatives"]);
    if (parts.length !== 1 || (parts[0] !== "votes" && parts[0] !== "bills")) return null;
    var level = params.get("level") || "federal";
    var result = /^(passed|failed)$/.test(params.get("result") || "") ? params.get("result") : "";
    var month = /^\d{4}-\d{2}$/.test(params.get("month") || "") ? params.get("month") : "";
    if (level === "state") {
      var code = (params.get("state") || "CA").toUpperCase();
      var slug = CODE_SLUG[code] || "california";
      if (parts[0] === "bills") return href([slug, "bills"], { session: params.get("session"), type: params.get("type"), status: params.get("status"), q: params.get("q") });
      return href([slug], { level: "state", body: params.get("body"), result: result, month: month });
    }
    if (level === "county" && parts[0] === "votes") {
      var fips = params.get("county") || "";
      if (!/^\d{5}$/.test(fips)) return href(["california"], { level: "county", result: result });
      return countyIndex().then(function (cidx) {
        var e = cidx[fips];
        var s = e && CODE_SLUG[e.state || "CA"];
        return e && s && e.slug ? href([s, e.slug], { level: "county", result: result, month: month }) : href(["california"], { level: "county", result: result });
      });
    }
    return null;
  }

  function resolve(pathname, search) {
    var parts = parse(pathname);
    var params = new URLSearchParams(search || "");
    for (var i = 0; i < ROUTES.length; i++) if (ROUTES[i].test(parts)) return { route: ROUTES[i], parts: parts, params: params };
    return { route: NOT_FOUND, parts: parts, params: params };
  }
  var routeSeq = 0;
  function route(opts) {
    var run = ++routeSeq;
    return Promise.resolve().then(function () { return legacy(parse(location.pathname), new URLSearchParams(location.search)); }).catch(function () { return null; }).then(function (to) {
      if (run !== routeSeq) return null;
      // replaceState, so Back goes to the page before the old address instead of bouncing on it.
      if (to && to !== location.pathname + location.search) history.replaceState(null, "", to + location.hash);
      var r = resolve(location.pathname, location.search);
      return render(r.route, r.parts, r.params, opts);
    });
  }
  function notFound() {
    return { title: "Not found", crumbs: [["All states", BASE], "Not found"], body: el("p", null, "There is no page at this address. ", link(BASE, "See all states"), ".") };
  }
  var NOT_FOUND = { name: "not-found", test: function () { return true; }, view: notFound };

  // ---------- prefetch on intent ----------
  // A pointer resting on a link for 80 ms, keyboard focus resting on it for 80 ms, or a touch
  // starts that page's loader at low priority, two requests at a time. A newer intent drops
  // prefetches that have not started. Nothing is prefetched when the visitor asks the browser to
  // save data, on a 2G connection, or for the link to the page already shown. Large files wait for
  // focus or touch, which signal intent more strongly than a passing pointer.
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
  document.addEventListener("touchstart", function (e) {
    var a = linkOf(e.target);
    if (a) prefetchLink(a, "touch");
  }, { passive: true });

  // After a page is drawn and the browser is idle, fetch what the likely next page needs.
  function idlePrefetch(r, parts, params) {
    if (!r.next || dataSaver()) return;
    var go = function () { var n = r.next(parts, params); if (!n) return; prefetchLink({ href: n }, "hover"); };
    if (window.requestIdleCallback) window.requestIdleCallback(go, { timeout: 4000 }); else setTimeout(go, 1500);
  }

  // ---------- shared loaders ----------
  function manifest() { return get("manifest.json"); }
  function states() { return get("geo/states.json").then(function (d) { noteStates(d.states); return d.states; }); }
  // Records published before the national files name no legislature, not even California's, whose
  // chambers are known; a page drawn from them still has California's two houses.
  var CA_LEGISLATURE = { name: "California Legislature", chambers: [{ id: "upper", name: "Senate", seats: 40 }, { id: "lower", name: "Assembly", seats: 80 }] };
  function noteStates(list) {
    (list || []).forEach(function (x) { if (x.code === "CA" && !x.legislature) x.legislature = CA_LEGISLATURE; STATE_INFO[x.code] = x; });
  }
  // County boards with a record here, California's and every other state's, by FIPS code.
  function indexCounties(ca, us) {
    var byFips = {};
    ((ca && ca.counties) || []).forEach(function (c) { byFips[c.fips] = Object.assign({ state: "CA" }, c); });
    ((us && us.counties) || []).forEach(function (c) { byFips[c.fips] = c; });
    return byFips;
  }
  function countyIndex() {
    return Promise.all([get("us-ca/counties/index.json", true), get("counties/index.json", true)]).then(function (r) { return indexCounties(r[0], r[1]); });
  }
  function usMembers() {
    return get("us/members.json").then(function (d) { var by = {}; d.members.forEach(function (m) { by[m.id] = m; }); return { list: d.members, by: by, congress: d.congress }; });
  }
  function caMembers() {
    return get("us-ca/members.json", true).then(function (d) {
      if (!d) return { list: [], by: {}, vacant: [], session: null };
      var by = {}; d.members.forEach(function (m) { by[m.id] = m; }); return { list: d.members, by: by, vacant: d.vacant || [], session: d.session };
    });
  }
  function caVoteIndex() { return get("us-ca/votes/index.json", true); }
  function sourceOf(man, id) { return (man && man.sources && man.sources[id]) || null; }
  function freshness(man, sourceId, updated, retrieved) {
    var s = sourceOf(man, sourceId);
    var parts = [];
    if (updated) parts.push(el("span", null, "Source updated ", time(updated, true)));
    else if (retrieved) parts.push(el("span", null, "Retrieved ", time(retrieved, true)));
    if (s && s.last_checked_at) parts.push(el("span", null, "Checked ", time(s.last_checked_at, true), s.status === "ok" ? "" : el("span", { class: "warn" }, " · " + statusWord(s))));
    return parts.length ? el("p", { class: "fresh" }, parts.map(function (p, i) { return i ? [" · ", p] : p; })) : null;
  }
  function statusWord(s) {
    return s.status === "ok" ? "OK" : s.status === "partial" ? "partly updated; earlier copies kept where a request failed" : s.status === "stale" ? "last check failed, showing the previous copy" : s.status === "error" ? "unavailable" : s.status === "not_configured" ? "not configured" : (s.status || "unknown");
  }
  function memberLabel(m) {
    if (!m) return "";
    var bits = [];
    if (m.party) bits.push(m.party);
    if (m.body === "us-house") bits.push(m.state + (m.district ? "-" + m.district : (m.delegate ? " delegate" : " at large")));
    else if (m.body === "us-senate") bits.push(m.state);
    else if (m.body === "ca-assembly") bits.push("AD " + m.district);
    else if (m.body === "ca-senate") bits.push("SD " + m.district);
    else if (/^us-[a-z]{2}-(upper|lower|legislature)$/.test(m.body || "")) return stateMemberLabel(m);
    else if (m.title) bits.push(m.title);
    if (m.former || m.provisional) bits.push(m.left_office ? "left office " + fmtDate(m.left_office) : "no longer serving");
    return bits.join(" · ");
  }
  function rows2objs(d) { if (!d) return []; var c = d.columns; return d.rows.map(function (r) { var o = {}; c.forEach(function (k, i) { o[k] = r[i]; }); return o; }); }
  function caBody(loc) { return /^(A|CX)/.test(loc || "") ? "ca-assembly" : /^CONF/.test(loc || "") ? "ca-legislature" : "ca-senate"; }
  // County records carry ids like ca-06073-bos-vote-... and tx-48201-bos-12345: the state, the county's FIPS code.
  function idOfCounty(id) { var m = /^([a-z]{2})-(\d{5})-bos/.exec(id || ""); return m ? m[2] : null; }
  function countyFolder(id) { var m = /^([a-z]{2})-(\d{5})-bos/.exec(id || ""); return m ? "us-" + m[1] + "/counties/" + m[2] : null; }
  function countyHref(entry) {
    var s = entry && STATE_INFO[entry.state || "CA"];
    return entry && entry.slug && s ? href([s.slug, entry.slug]) : href([]);
  }

  // ---------- states outside California: shared loaders and words ----------
  var STATE_INFO = {};          // code -> row of geo/states.json, filled whenever that file is read
  function lc(code) { return String(code || "").toLowerCase(); }
  function stateGeo(code) { return get("geo/us-" + lc(code) + "/counties.json"); }
  function stateMembers(code) {
    return get("us-" + lc(code) + "/members.json", true).then(function (d) {
      var list = (d && d.members) || [];
      var by = {}; list.forEach(function (m) { by[m.id] = m; });
      return { list: list, by: by, source_updated_at: d && d.source_updated_at, retrieved_at: d && d.retrieved_at };
    });
  }
  function stateSummary(code) { return get("us-" + lc(code) + "/summary.json", true); }
  function legislatures() { return get("legislatures.json", true).then(function (d) { return (d && d.states) || {}; }); }
  function chamberOf(s, id) {
    var cs = (s && s.legislature && s.legislature.chambers) || [];
    var want = id === "legislature" ? "upper" : id;
    return cs.filter(function (c) { return c.id === want || (want === "upper" && c.id === "legislature"); })[0] || null;
  }
  function chamberName(s, id) { var c = chamberOf(s, id); return c ? c.name : (id === "lower" ? "House" : "Senate"); }
  function shortChamber(name) { return String(name || "").replace(/ of Representatives$/, ""); }
  // "Texas Senate", "Nebraska Legislature", "Council of the District of Columbia"
  function chamberTitle(s, id) {
    var n = chamberName(s, id);
    if (s.code === "DC") return "Council of the District of Columbia";
    if (s.code === "NE") return "Nebraska Legislature";
    return s.name + " " + n;
  }
  function countyWord(s, n) {
    var w = (s && s.county_word) || "county";
    if (n === 1) return w;
    return w === "county" ? "counties" : w === "parish" ? "parishes" : w === "borough or census area" ? "boroughs and census areas" : w === "municipio" ? "municipios" : w + "s";
  }
  function plural(n, one, many) { return n.toLocaleString() + " " + (n === 1 ? one : many); }
  // Legislators outside California have ids like "tx-5f3c2a91": the state, then the start of the
  // Open States person id.
  function stateMemberCode(id) { var m = /^([a-z]{2})-[0-9a-f]{8}$/.exec(id || ""); return m && m[1] !== "ca" ? m[1].toUpperCase() : null; }
  function districtWords(m) {
    if (m.at_large) return "at large";
    var d = m.district || "";
    return /^\d+[A-Za-z]?$/.test(d) ? "District " + d : d;
  }
  function stateMemberLabel(m) {
    var s = STATE_INFO[(m.jurisdiction || "").slice(3).toUpperCase()];
    return [m.party, s ? shortChamber(chamberName(s, m.chamber)) : null, districtWords(m)].filter(Boolean).join(" · ");
  }
  // Which of a state's legislators represent part of a county: their district overlaps the county
  // (Census relationship files), their district is named after it (New Hampshire's floterial
  // districts), or they are elected at large.
  function countyLegislators(members, g, chamber) {
    var keys = chamber === "lower" ? g.sldl || [] : g.sldu || [];
    return members.filter(function (m) {
      var mc = m.chamber === "legislature" ? "upper" : m.chamber;
      if (mc !== chamber) return false;
      if (m.at_large) return true;
      if (m.district_key && keys.indexOf(m.district_key) >= 0) return true;
      return !!(m.county_fips && m.county_fips.indexOf(g.fips) >= 0);
    }).sort(function (a, b) { return naturalCompare(a.district, b.district) || a.name.localeCompare(b.name); });
  }
  function naturalCompare(a, b) {
    var x = String(a || "").split(/(\d+)/), y = String(b || "").split(/(\d+)/);
    for (var i = 0; i < Math.min(x.length, y.length); i++) {
      if (x[i] === y[i]) continue;
      var nx = /^\d+$/.test(x[i]), ny = /^\d+$/.test(y[i]);
      if (nx && ny) return (+x[i]) - (+y[i]);
      return x[i].localeCompare(y[i]);
    }
    return x.length - y.length;
  }
  function listWords(items) {
    if (items.length <= 2) return items.join(" and ");
    return items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
  }
  // The board's website as the nightly check last saw it.
  function boardLinkStatus(b) {
    if (!b.checked_at) return el("span", { class: "unk" }, "not checked yet");
    if (b.status === "ok") return frag("link checked ", time(b.checked_at, true));
    var why = b.status === "dead" ? "the page was not found" + (b.code ? " (HTTP " + b.code + ")" : "")
      : b.status === "blocked" ? "the site refused the automated check" + (b.code ? " (HTTP " + b.code + ")" : "") + "; it may still work in a browser"
      : "the site did not answer";
    return el("span", { class: "warn" }, "At the last check (", time(b.checked_at, true), ") " + why + ".", b.last_ok_at ? [" Last seen working ", time(b.last_ok_at, true), "."] : null);
  }

  function section(title, body, cls) { return el("section", { class: "sec " + (cls || "") }, el("h2", null, title), body); }
  function note(text) { return el("p", { class: "note" }, text); }
  // A list shown a page at a time: "Show more" appends the next page and moves focus to its first
  // link. opts: first (size of the first page), page (size of the next ones), what (names the list
  // on the button for screen readers, "of U.S. House"), empty (text when the list is empty).
  function more(list, renderItem, opts) {
    opts = opts || {};
    var box = el("div", { class: "more-list " + (opts.class || "") });
    var ul = el("ul", { class: "plain " + (opts.ulClass || "") });
    var count = el("p", { class: "count" });
    var shown = 0;
    var first = opts.first || opts.page || PAGE, size = opts.page || PAGE;
    function page(focusFirstNew) {
      var start = shown;
      var end = Math.min(list.length, shown + (shown ? size : first));
      for (; shown < end; shown++) ul.appendChild(renderItem(list[shown], shown));
      btn.hidden = shown >= list.length;
      count.textContent = "Showing " + shown.toLocaleString() + " of " + list.length.toLocaleString();
      if (focusFirstNew && ul.children[start]) {
        var f = ul.children[start].querySelector("a, button, [tabindex]");
        if (f) f.focus();
      }
    }
    var btn = el("button", { type: "button", class: "btn", on: { click: function () { page(true); } } }, "Show more", opts.what ? el("span", { class: "visually-hidden" }, " " + opts.what) : null);
    append(box, list.length ? [ul, list.length > first ? el("div", { class: "show-more" }, count, btn) : null] : note(opts.empty || "Nothing to show."));
    if (list.length) page(false);
    return box;
  }

  // ---------- vote row rendering (index rows from us/ or us-ca/ shards) ----------
  function voteItem(v, counties, locations) {
    // v: object with id, date, question, title, result, passed, yes, no, other, bill_id, bill_label, body, floor?, location?
    var lvl = levelOf(v.body);
    if (!v.bill_label && v.bill_id && v.title) { var lm = /^([A-Z]+ \d+):/.exec(v.title); if (lm) v.bill_label = lm[1]; }
    var loc = v.location && locations ? (locations[v.location] || v.location) : v.location;
    return el("li", { class: "vote" },
      el("div", { class: "vote-head" }, badge(lvl), el("span", { class: "body" }, bodyName(v.body, counties)), loc ? el("span", { class: "loc" }, loc) : null, el("span", { class: "when" }, time(v.date, !isDateOnly(v.date)))),
      el("h3", null, link(voteHref(v.id), v.question || "Vote")),
      v.title ? el("p", { class: "vt" }, v.bill_id ? link(billHref(v.bill_id), v.bill_label || v.title) : null, v.bill_id && v.bill_label && stripLabel(v.title, v.bill_label) ? ": " : null, v.bill_label ? stripLabel(v.title, v.bill_label) : v.title) : null,
      el("p", { class: "res" }, el("b", { class: v.passed ? "pass" : "fail" }, resultWord(v)), " · ", tally({ yes: v.yes, no: v.no, other: v.other || 0 })));
  }

  function ahead(u, today) {
    // an item for "the week of" a Monday stays listed through that week
    if (u.date_precision === "week") {
      var p = u.date.split("-"); var end = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + 6));
      return end.toISOString().slice(0, 10) >= today;
    }
    return u.date >= today;
  }

  function freshnessTable(man) {
    var srcs = man.sources || {};
    var ids = Object.keys(srcs).filter(function (k) { return !/^county-/.test(k); });
    var counties = Object.keys(srcs).filter(function (k) { return /^county-/.test(k); });
    var ok = counties.filter(function (k) { return srcs[k].status === "ok"; }).length;
    var rows = ids.sort(function (a, b) { return (srcs[a].level + srcs[a].name).localeCompare(srcs[b].level + srcs[b].name); }).map(function (k) {
      var s = srcs[k];
      return el("tr", null, el("th", { scope: "row" }, s.url ? ext(s.url, s.name) : s.name), el("td", null, badge(s.level)), el("td", null, el("span", { class: "st st-" + s.status }, statusWord(s))), el("td", null, s.last_checked_at ? time(s.last_checked_at, true) : "never"), el("td", null, s.source_updated_at ? time(s.source_updated_at, true) : el("span", { class: "unk" }, "not stated")));
    });
    return frag(
      el("p", null, "Generated ", time(man.generated_at, true), ". Each source is checked nightly by a scheduled job; a source that fails keeps its last good copy and is marked here."),
      el("table", { class: "tbl" }, el("caption", null, "Federal and state sources"), el("thead", null, el("tr", null, el("th", { scope: "col" }, "Source"), el("th", { scope: "col" }, "Level"), el("th", { scope: "col" }, "Status"), el("th", { scope: "col" }, "Last checked"), el("th", { scope: "col" }, "Source updated"))), el("tbody", null, rows)),
      counties.length ? el("p", null, ok + " of " + counties.length + " county sources reachable at the last check. ", link(href(["sources"]), "Every source, including each county")) : null);
  }

  // The latest session of the current Congress, read from the newest roll call's id (us-house-119-2-314).
  function currentSession(latest) {
    var ids = rows2objs(latest).map(function (v) { return v.id; });
    var m = ids.length ? /^us-(?:house|senate)-(\d+)-(\d+)-/.exec(ids[0]) : null;
    return m ? { congress: +m[1], session: +m[2] } : null;
  }

  // ---------- places: every state on a map; a state or a county behind three doors ----------
  // Layout D of Nick's "Legislation tab options": the map of states, then for a state (or one of
  // its counties) three doors, How they voted, Who represents me and What's coming up, each with
  // level chips and, for the votes, a "More filters" drawer. Filters are query parameters.

  // The tile map, row by row and west to east, as on page 1 of the PDF. Keyboard order follows
  // the rows. The territories without a legislature are listed under it.
  var TILE_ROWS = [
    { 0: "AK", 10: "ME" },
    { 5: "WI", 9: "VT", 10: "NH" },
    { 0: "WA", 1: "ID", 2: "MT", 3: "ND", 4: "MN", 5: "IL", 6: "MI", 8: "NY", 9: "MA", 10: "RI" },
    { 0: "OR", 1: "NV", 2: "WY", 3: "SD", 4: "IA", 5: "IN", 6: "OH", 7: "PA", 8: "NJ", 9: "CT" },
    { 0: "CA", 1: "UT", 2: "CO", 3: "NE", 4: "MO", 5: "KY", 6: "WV", 7: "VA", 8: "MD", 9: "DE" },
    { 1: "AZ", 2: "NM", 3: "KS", 4: "AR", 5: "TN", 6: "NC", 7: "SC", 8: "DC" },
    { 3: "OK", 4: "LA", 5: "MS", 6: "AL", 7: "GA" },
    { 0: "HI", 3: "TX", 8: "FL", 10: "PR" }];

  // Which levels a state has votes for: federal everywhere; the legislature where its votes are
  // collected (California's from the Legislature, the others' from Open States); and the number of
  // county boards whose votes are published through Legistar.
  function coverageOf(st, leg, cidx) {
    var boards = {};
    Object.keys(cidx).forEach(function (k) { var c = cidx[k]; if (c.coverage === "votes") boards[c.state || "CA"] = (boards[c.state || "CA"] || 0) + 1; });
    var out = {};
    st.forEach(function (s) { out[s.code] = { state: s.code === "CA" || ((leg[s.code] || {}).votes || 0) > 0, county: boards[s.code] || 0 }; });
    return out;
  }
  function levelCount(c) { return 1 + (c.state ? 1 : 0) + (c.county ? 1 : 0); }
  function coverageWords(c) { return listWords(["federal"].concat(c.state ? ["state"] : [], c.county ? ["county"] : [])) + " votes"; }
  // Bars under each code, left to right: federal, state, county. A filled bar has votes, so the
  // tile's shade is never the only cue.
  function barsEl(c) { return el("span", { class: "bars", "aria-hidden": "true" }, [true, c.state, c.county > 0].map(function (on) { return el("span", { class: on ? "on" : null }); })); }
  function tileEl(s, c) {
    // The link's name starts with the code it shows ("TX, Texas: federal and county votes").
    return el("a", { href: href([s.slug]), class: "tile lv" + levelCount(c) },
      el("span", { class: "code" }, s.code), el("span", { class: "visually-hidden" }, ", " + s.name + ": " + coverageWords(c)), barsEl(c));
  }
  function legendEl(st, cov) {
    function firstWith(n) { return st.filter(function (s) { return !NO_LEGISLATURE[s.code] && levelCount(cov[s.code]) === n; })[0]; }
    var rows = [[3, "Votes at all three levels"], [2, "Votes at two levels. The bars say which."], [1, "Federal votes only, so far"]].map(function (x) {
      var s = firstWith(x[0]);
      return s ? el("li", null, el("span", { class: "tile sample lv" + x[0], "aria-hidden": "true" }, el("span", { class: "code" }, s.code), barsEl(cov[s.code])), el("span", null, x[1])) : null;
    });
    return el("div", { class: "legend" },
      el("h2", null, "What each tile shows"),
      el("ul", { class: "plain" }, rows),
      el("p", { class: "key" }, barsEl({ state: true, county: 1 }), el("span", null, "Bars under each code, left to right: federal, state, county. A filled bar has votes.")));
  }
  // One search box, on the map and on every state and county page: a GET form to the search page.
  function searchForm(id, labelText, placeholder, value) {
    var input = el("input", { id: id, name: "q", type: "search", placeholder: placeholder, autocomplete: "off", spellcheck: "false", value: value || null });
    return el("form", { class: "leg-search", role: "search", action: href(["search"]), method: "get", on: { submit: function (e) {
      e.preventDefault();
      navigate(href(["search"], { q: input.value.trim() }));
    } } }, el("label", { for: id }, labelText), el("div", { class: "search-row" }, input, el("button", { type: "submit", class: "btn go" }, "Search")));
  }
  function footLine(bits) { return el("p", { class: "leg-foot" }, bits.filter(Boolean).map(function (b, i) { return [i ? el("span", { class: "sep", "aria-hidden": "true" }, " · ") : null, b]; })); }

  function viewMap() {
    return Promise.all([states(), legislatures(), countyIndex(), manifest()]).then(function (r) {
      var st = r[0], man = r[3];
      var cov = coverageOf(st, r[1], r[2]);
      var by = {};
      st.forEach(function (s) { by[s.code] = s; });
      var geo = el("nav", { class: "usmap", "aria-label": "States, west to east" }, TILE_ROWS.map(function (row) {
        var cells = [];
        for (var i = 0; i < 11; i++) cells.push(row[i] && by[row[i]] ? tileEl(by[row[i]], cov[row[i]]) : el("span", { class: "gap", "aria-hidden": "true" }));
        return cells;
      }));
      // Under 760 px the map's 11 columns would shrink the tiles below 44 px, so phones get the
      // states in alphabetical order instead. Only one of the two is ever displayed.
      var alpha = st.filter(function (s) { return !NO_LEGISLATURE[s.code]; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
      var grid = el("nav", { class: "usgrid", "aria-label": "States, A to Z" }, alpha.map(function (s) { return tileEl(s, cov[s.code]); }));
      var terr = st.filter(function (s) { return NO_LEGISLATURE[s.code]; });
      var head = el("div", { class: "map-page" },
        el("div", { class: "map-intro" },
          el("p", { class: "eyebrow" }, "Legislation"),
          el("h1", { id: "page-title", tabindex: "-1" }, "Who voted for what, in every state."),
          el("p", { class: "intro" }, "Pick a state. Each one has its people in Congress, its own legislature and, where the county publishes them, its county boards' votes. Records refresh every night from official sources."),
          searchForm("map-q", "Search a state, legislator, or bill", "Try “AB 2627” or “Padilla”"),
          legendEl(st, cov)),
        el("div", { class: "map-wrap" }, geo, grid,
          terr.length ? el("p", { class: "terr" }, "Also on this site, with their delegate in Congress: ", terr.map(function (s, i) { return [i ? " · " : null, link(href([s.slug]), s.name)]; }), ".") : null));
      var foot = footLine([el("span", null, "Last refresh ", time(man.generated_at, true)),
        link(href(["votes"], { level: "federal" }), "Every federal vote"), link(href(["bills"], { level: "federal" }), "Every federal bill"),
        link(href(["upcoming"]), "Everything scheduled"), link("/legislation/calendars/", "2026 calendars"), link(href(["sources"]), "Sources")]);
      return { title: "Who voted for what, in every state.", docTitle: "Every state", head: head, body: foot };
    });
  }

  // ---------- a place: the files every door reads ----------
  function placeFiles(code) {
    return ["manifest.json", "geo/states.json", "legislatures.json", "us-ca/counties/index.json", "counties/index.json"].concat(NO_LEGISLATURE[code] ? [] : ["geo/us-" + lc(code) + "/counties.json"]);
  }
  // [state] | [state, door] | [state, county] | [state, county, door]
  function placeParts(parts) {
    var code = STATE_CODES[parts[0]];
    if (!code || parts.length > 3) return null;
    var p = { slug: parts[0], code: code, county: null, door: "votes" };
    if (parts.length === 2) { if (STATE_DOORS[parts[1]]) p.door = parts[1]; else p.county = parts[1]; }
    if (parts.length === 3) { if (!COUNTY_DOORS[parts[2]]) return null; p.county = parts[1]; p.door = parts[2]; }
    if (p.county && NO_LEGISLATURE[code]) return null;
    return p;
  }
  // California's county file has its own shape; this gives every state's counties the same fields.
  function normCounties(code, geo) {
    var list = (geo && geo.counties) || [];
    if (code !== "CA") return list;
    return list.map(function (c) {
      var h = c.us_house || {};
      return { fips: c.fips, name: c.name, slug: c.slug, cd: h.current || [], cd2027: h.from_2027 || null, effective2027: h.effective_2027 || null,
        sldu: (c.ca_senate || []).map(String), sldl: (c.ca_assembly || []).map(String) };
    });
  }
  function buildScope(p, s, leg, cidx, geo, man) {
    var counties = normCounties(p.code, geo);
    var g = p.county ? counties.filter(function (c) { return c.slug === p.county; })[0] || null : null;
    if (p.county && !g) return null;
    var entry = g ? cidx[g.fips] || null : null;
    var legistar = function (e) { return e && e.platform === "Legistar" && (e.coverage === "votes" || e.coverage === "agendas"); };
    var boards = g ? (legistar(entry) ? [entry] : []) : Object.keys(cidx).map(function (k) { return cidx[k]; })
      .filter(function (e) { return (e.state || "CA") === p.code && legistar(e); }).sort(function (a, b) { return a.county.localeCompare(b.county); });
    var row = leg[p.code] || {};
    return { s: s, code: p.code, st: lc(p.code), slug: p.slug, door: p.door, county: g, entry: entry, board: legistar(entry) ? entry : null,
      counties: counties, boards: boards, leg: row, cidx: cidx, man: man, parts: g ? [p.slug, g.slug] : [p.slug], name: g ? g.name : s.name,
      stateVotes: !!s.legislature && (p.code === "CA" || (row.votes || 0) > 0), stateBills: !!s.legislature && (p.code === "CA" || (row.bills || 0) > 0),
      countyVotes: boards.some(function (b) { return b.counts ? (b.counts.votes || 0) > 0 : b.coverage === "votes"; }),
      noCountyGov: !!(g && g.board && g.board.none) };
  }
  function placeScope(parts) {
    var p = placeParts(parts);
    if (!p) return Promise.resolve(null);
    return Promise.all([states(), legislatures(), countyIndex(), manifest(), NO_LEGISLATURE[p.code] ? null : get("geo/us-" + lc(p.code) + "/counties.json", true)]).then(function (r) {
      var s = STATE_INFO[p.code];
      return s ? buildScope(p, s, r[1], r[2], r[4], r[3]) : null;
    });
  }
  function boardFolder(sc) { return "us-" + sc.st + "/counties/" + sc.county.fips; }
  function boardOfBody(sc, body) { return sc.boards.filter(function (b) { return b.body === body; })[0] || null; }

  // The page head: where the place sits, its name, and the search box.
  function placeHead(sc, last) {
    var trail = [["All states", BASE]];
    if (sc.county || last) trail.push([sc.s.name, href([sc.slug])]);
    if (sc.county) trail.push(last ? [sc.county.name, href(sc.parts)] : sc.county.name);
    if (last) trail.push(last);
    if (!sc.county && !last) trail.push(sc.s.name);
    return el("div", { class: "place-head" },
      el("div", { class: "ph-title" }, crumbTrail(trail), el("h1", { id: "page-title", tabindex: "-1" }, sc.name)),
      searchForm("place-q", "Search anything", "Bill, legislator, place or topic"));
  }
  // A county page says in one line who represents it and in another where its board publishes.
  function countyFacts(sc) {
    var g = sc.county, s = sc.s, e = sc.entry;
    var parts = [];
    var cd = (g.cd || []).filter(function (n) { return n > 0; });
    if (s.delegate_only) parts.push("its delegate in the U.S. House");
    else if (cd.length) parts.push(plural(cd.length, "U.S. House district", "U.S. House districts"));
    else parts.push("the state's at-large U.S. House seat");
    ((s.legislature && s.legislature.chambers) || []).forEach(function (c) {
      var keys = c.id === "lower" ? g.sldl : g.sldu;
      var nm = s.code === "NE" || s.code === "DC" ? chamberTitle(s, c.id) : s.name + " " + shortChamber(c.name);
      if (keys && keys.length) parts.push(plural(keys.length, nm + " district", nm + " districts"));
    });
    var lines = [el("p", null, "Represented by " + listWords(parts) + ".")];
    var urls = (e && e.urls) || {};
    if (e && e.platform === "Legistar") {
      lines.push(el("p", null, (e.body_name || "County board") + ": " + (e.coverage === "votes" ? "meetings, agenda actions and each member's vote, from the county's Legistar system. " : e.coverage === "agendas" ? "meetings and agenda actions from the county's Legistar system; it publishes no roll calls. " : "its Legistar site publishes no votes. "),
        urls.board_url ? ext(urls.board_url, "Legistar calendar", " (the county's meeting system)") : null, urls.website ? [" · ", ext(urls.website, "County website", " (the county's own site)")] : null));
    } else if (e && (urls.board_url || urls.agenda_url)) {
      lines.push(el("p", null, (e.body_name || "Board of Supervisors") + ": ", urls.board_url ? ext(urls.board_url, "board page", " (the county's page for its board)") : null,
        urls.agenda_url ? [urls.board_url ? " · " : null, ext(urls.agenda_url, "agendas and minutes", " (the county's agenda site)")] : null,
        e.url_status && /^unreachable/.test(e.url_status) ? el("span", { class: "warn" }, " (did not respond at the last nightly check)") : null,
        ". Its votes are only in minutes documents, so they are not collected here."));
    } else {
      var b = g.board || {};
      if (b.none) lines.push(el("p", null, b.none));
      else lines.push(el("p", null, (b.name || "County government") + ": ",
        b.url ? [ext(b.url, b.url.replace(/^https?:\/\//, "").replace(/\/$/, ""), " (the " + countyWord(s, 1) + "'s website)"), " (", boardLinkStatus(b), ")"] : el("span", { class: "unk" }, "no website is listed in Wikidata"),
        ". Its votes are not collected: this " + countyWord(s, 1) + " does not publish them through Legistar."));
    }
    return el("div", { class: "county-facts" }, lines);
  }
  var DOOR_TITLE = { votes: "How they voted", representatives: "Who represents me", upcoming: "What's coming up", bills: "Bills", sources: "Sources" };
  function doorsNav(sc) {
    var fed = sc.s.delegate_only ? "The delegate in Congress" : "Congress";
    var desc = {
      votes: "Every recorded vote, with each legislator's position",
      representatives: !sc.s.legislature ? fed + ", with contact info" : sc.county && !sc.noCountyGov ? fed + ", the legislature and the county board"
        : fed + " and the " + (sc.code === "DC" ? "Council" : sc.s.delegate_only ? "legislature" : "state legislature") + ", with contact info",
      upcoming: "Sessions, hearings and expected votes" };
    return el("nav", { class: "pdoors", "aria-label": "Sections for " + sc.name }, ["votes", "representatives", "upcoming"].map(function (d) {
      return el("a", { href: href(d === "votes" ? sc.parts : sc.parts.concat(d)), class: "pdoor", "aria-current": sc.door === d ? "page" : null, "data-focus": "#results" },
        el("span", { class: "dt" }, DOOR_TITLE[d]), el("span", { class: "dd" }, desc[d]));
    }));
  }
  // Level chips: links that narrow the list below. Focus stays on the chip and the new count is
  // announced. A level with nothing published in this place is dashed and says so.
  function chipBar(sc, level, hrefFor, muted, withCounty) {
    var items = [["", "All levels"], ["federal", "Federal"]];
    if (sc.s.legislature) items.push(["state", "State", muted.state]);
    if (withCounty && sc.counties.length) items.push(["county", "County", muted.county]);
    return el("div", { class: "chips", role: "group", "aria-label": "Level" }, items.map(function (it) {
      var key = it[0] || "all";
      return el("a", { href: hrefFor(it[0]), class: "chip" + (it[2] ? " muted" : ""), "aria-current": (level || "") === it[0] ? "true" : null,
        "data-level": key, "data-focus": '.chip[data-level="' + key + '"]', "data-announce": true }, it[1], it[2] ? " (" + it[2] + ")" : null);
    }));
  }
  function levelParam(v, allowed) { return allowed.indexOf(v) >= 0 ? v : ""; }
  // Before the first nightly run with the national files, a state has only its members of Congress.
  function pendingNote(sc) {
    return !sc.s.legislature && !NO_LEGISLATURE[sc.code] ? [note("The " + sc.s.name + " Legislature's members and votes, and the " + countyWord(sc.s, 2) + ", appear here after the next nightly update of the records.")] : [];
  }

  function viewPlace(parts, params, ui) {
    return placeScope(parts).then(function (sc) {
      if (!sc) return notFound();
      var door = sc.door;
      var content = door === "votes" ? votesDoor(sc, params, ui) : door === "representatives" ? repsDoor(sc, params) : door === "upcoming" ? upcomingDoor(sc, params)
        : door === "bills" ? billsDoor(sc, params) : sourcesDoor(sc);
      return Promise.resolve(content).then(function (c) {
        if (!c) return notFound();
        var last = door === "bills" ? "Bills" : door === "sources" ? "Sources" : null;
        return { title: sc.name, docTitle: DOOR_TITLE[door] + ": " + sc.name + (sc.county ? ", " + sc.s.name : ""), head: placeHead(sc, last),
          body: frag(sc.county ? countyFacts(sc) : null, doorsNav(sc), el("div", { class: "door-body door-" + door }, c.body), c.foot) };
      });
    });
  }

  // ---------- door: How they voted ----------
  // One list, newest first, merging three feeds: federal roll calls, the legislature's votes, and
  // the county boards'. Each feed lists its months (newest first) and loads one month at a time;
  // the federal and state feeds also have a small file of their latest votes for the first draw.
  // Show more loads the next month of whichever feed is furthest behind, so the list never has to
  // slot a vote in above one already shown.
  var DOOR_PAGE = 20;
  function stateBodies(sc) {
    if (!sc.s.legislature) return [];
    if (sc.code === "CA") return [["ca-senate", "California Senate"], ["ca-assembly", "California Assembly"]];
    return sc.s.legislature.chambers.map(function (c) { return ["us-" + sc.st + "-" + c.id, chamberTitle(sc.s, c.id)]; });
  }
  // A unicameral legislature's votes can be filed as "legislature" or "upper".
  function bodyMatch(a, b) { return a === b || (/-(legislature|upper)$/.test(a) && /-(legislature|upper)$/.test(b) && a.slice(0, 5) === b.slice(0, 5) && !/-lower$/.test(a)); }
  function voteBodies(sc) {
    var out = [["us-house", "U.S. House"]];
    if (!sc.s.delegate_only) out.push(["us-senate", "U.S. Senate"]);
    if (sc.stateVotes) out = out.concat(stateBodies(sc));
    return out.concat(sc.boards.map(function (b) { return [b.body, b.body_name || b.county]; }));
  }
  function voteFilters(params, sc) {
    var f = { level: levelParam(params.get("level"), sc.s.legislature ? ["federal", "state", "county"] : ["federal", "county"]),
      body: params.get("body") || "", result: levelParam(params.get("result"), ["passed", "failed"]),
      month: /^\d{4}-(0[1-9]|1[0-2])$/.test(params.get("month") || "") ? params.get("month") : "" };
    if (!voteBodies(sc).some(function (b) { return b[0] === f.body; })) f.body = "";
    if (f.body) f.level = levelOf(f.body);
    return f;
  }
  function wantsOf(sc, f) {
    return { fed: !f.level || f.level === "federal", state: !!sc.s.legislature && (!f.level || f.level === "state"), county: !f.level || f.level === "county" };
  }
  function monthsDesc(list) { var seen = {}; return list.filter(function (m) { if (seen[m]) return false; seen[m] = 1; return true; }).sort().reverse(); }
  // Every month from the newest roll call back to January of the Congress's first year.
  function fedMonths(latestDoc) {
    var cs = currentSession(latestDoc);
    var rows = rows2objs(latestDoc);
    if (!cs || !rows.length) return [];
    var newest = rows.reduce(function (a, v) { return (v.date || "") > a ? v.date : a; }, "").slice(0, 7);
    var start = (1787 + 2 * cs.congress) + "-01";
    var out = [], y = +newest.slice(0, 4), m = +newest.slice(5, 7);
    for (var i = 0; i < 48; i++) {
      var ym = y + "-" + (m < 10 ? "0" : "") + m;
      if (ym < start) break;
      out.push(ym);
      m -= 1; if (!m) { m = 12; y -= 1; }
    }
    return out;
  }
  function fedMonthFiles(latestDoc, month, body) {
    var cs = currentSession(latestDoc);
    if (!cs) return [];
    var session = +month.slice(0, 4) - (1787 + 2 * cs.congress) + 1;
    if (session < 1 || session > 2) return [];
    return (body ? [body] : ["us-house", "us-senate"]).map(function (b) { return "us/votes/" + cs.congress + "-" + session + "-" + (b === "us-house" ? "house" : "senate") + ".json"; });
  }
  function stateShards(sc, idx, body) {
    return ((idx && idx.shards) || []).filter(function (x) { return !body || bodyMatch(x.body, body); });
  }
  function stateMonthFiles(sc, idx, month, body) {
    return stateShards(sc, idx, body).filter(function (x) { return x.month === month; }).map(function (x) {
      return { rel: sc.code === "CA" ? "us-ca/votes/" + x.file : "us-" + sc.st + "/votes/" + x.session + "/" + x.file, body: x.body };
    });
  }
  function boardMonths(board) { return monthsDesc(((board && board.vote_months) || []).map(function (x) { return x.month; })); }
  function boardMonthRel(sc, board, month) {
    var m = ((board && board.vote_months) || []).filter(function (x) { return x.month === month; })[0];
    return m ? boardFolder(sc) + "/" + (m.file || "votes-" + month + ".json") : null;
  }
  // The files of the first draw. The view reads the same ones, so a prefetch covers the click.
  function votesFirstFiles(sc, f) {
    var w = wantsOf(sc, f), CA = sc.code === "CA";
    return { latest: "us/latest.json",
      stLatest: w.state && sc.stateVotes ? (CA ? "us-ca/latest.json" : "us-" + sc.st + "/summary.json") : null,
      stIdx: w.state && sc.stateVotes ? (CA ? "us-ca/votes/index.json" : "us-" + sc.st + "/votes/index.json") : null,
      coLatest: w.county && !sc.county && sc.boards.length ? (CA ? "us-ca/counties/latest.json" : "counties/latest.json") : null,
      board: w.county && sc.board ? boardFolder(sc) + "/board.json" : null };
  }
  function stLatestRows(sc, d) { return sc.code === "CA" ? rows2objs(d.stLatest) : ((d.stLatest && d.stLatest.latest) || []); }
  // The month files the first draw needs as well: a month asked for, a county board's newest
  // month, or a legislature's newest month when its latest-votes list is empty.
  function votesMonthFiles(sc, f, d) {
    var w = wantsOf(sc, f), out = [];
    var fb = f.body && levelOf(f.body) === "federal" ? f.body : "";
    var sb = f.body && levelOf(f.body) === "state" ? f.body : "";
    if (f.month) {
      if (w.fed) out = out.concat(fedMonthFiles(d.latest, f.month, fb));
      if (w.state && d.stIdx) out = out.concat(stateMonthFiles(sc, d.stIdx, f.month, sb).map(function (x) { return x.rel; }));
    } else if (w.state && d.stIdx && !stLatestRows(sc, d).length) {
      var sm = monthsDesc(stateShards(sc, d.stIdx, sb).map(function (x) { return x.month; }));
      if (sm.length) out = out.concat(stateMonthFiles(sc, d.stIdx, sm[0], sb).map(function (x) { return x.rel; }));
    }
    if (w.county && sc.board && d.board) {
      var bm = boardMonths(d.board);
      var rel = boardMonthRel(sc, d.board, f.month || bm[0]);
      if (rel) out.push(rel);
    }
    return out;
  }
  function namedFiles(getter, named) {
    var keys = Object.keys(named);
    return Promise.all(keys.map(function (k) { return named[k] ? getter(named[k]) : null; })).then(function (r) { var o = {}; keys.forEach(function (k, i) { o[k] = r[i]; }); return o; });
  }

  // Rows from each source, in one shape.
  function fedRow(v) {
    return { id: v.id, date: v.date, level: "federal", body: v.body, number: v.number, question: v.question, title: v.title, label: v.bill_label, bill_id: v.bill_id,
      result: v.result, passed: v.passed, yes: v.yes, no: v.no, other: v.other };
  }
  function caRow(v, locs, body) {
    var lm = /^([A-Z]+ \d+):\s*/.exec(v.title || "");
    return { id: v.id, date: v.date, level: "state", body: body || caBody(v.location), where: (locs && locs[v.location]) || v.location, floor: v.floor,
      title: lm ? v.title.slice(lm[0].length) : v.title, label: lm ? lm[1] : null, bill_id: v.bill_id, result: v.result, passed: v.passed, yes: v.yes, no: v.no, other: v.other };
  }
  function osRow(v, body) {
    return { id: v.id, date: v.date, level: "state", body: body || v.body, where: v.floor ? "floor" : "committee", floor: !!v.floor, question: v.question, title: v.title,
      label: v.bill_label, bill_id: v.bill_id, result: v.result, passed: v.passed, yes: v.yes, no: v.no, other: v.other };
  }
  function coRow(v, matters, body) {
    var m = v.matter_id && matters ? matters[v.matter_id] : null;
    return { id: v.id, date: v.date, level: "county", body: body || v.body, question: v.question, title: m ? m.title : (v.matter_title || ""), label: m ? m.label : v.matter_label,
      result: v.result, passed: v.passed, yes: v.yes, no: v.no, other: v.other,
      recorded: v.recorded !== undefined && v.recorded !== null ? !!v.recorded : /[^-]/.test(v.positions || "") };
  }
  function voteFeeds(sc, f, d) {
    var w = wantsOf(sc, f), feeds = [];
    var only = function (months) { return f.month ? (months.indexOf(f.month) >= 0 ? [f.month] : []) : months; };
    var fb = f.body && levelOf(f.body) === "federal" ? f.body : "";
    var sb = f.body && levelOf(f.body) === "state" ? f.body : "";
    if (w.fed && d.latest) {
      feeds.push({ key: "federal", months: only(fedMonths(d.latest)), first: f.month ? null : rows2objs(d.latest).map(fedRow), month: function (m) {
        return Promise.all(fedMonthFiles(d.latest, m, fb).map(function (rel) { return get(rel, true); })).then(function (docs) {
          var out = [];
          docs.forEach(function (doc) { rows2objs(doc).forEach(function (v) { if ((v.date || "").slice(0, 7) === m) out.push(fedRow(v)); }); });
          return out;
        });
      } });
    }
    if (w.state && sc.stateVotes && d.stIdx) {
      var CA = sc.code === "CA";
      var locs = (d.stIdx && d.stIdx.locations) || (d.stLatest && d.stLatest.locations) || {};
      feeds.push({ key: "state", months: only(monthsDesc(stateShards(sc, d.stIdx, sb).map(function (x) { return x.month; }))),
        first: f.month ? null : stLatestRows(sc, d).map(function (v) { return CA ? caRow(v, locs) : osRow(v, v.body); }), month: function (m) {
          var files = stateMonthFiles(sc, d.stIdx, m, sb);
          return Promise.all(files.map(function (x) { return get(x.rel, true); })).then(function (docs) {
            var out = [];
            docs.forEach(function (doc, i) { rows2objs(doc).forEach(function (v) { out.push(CA ? caRow(v, locs, files[i].body) : osRow(v, files[i].body)); }); });
            return out;
          });
        } });
    }
    if (w.county && sc.county && sc.board && d.board) {
      feeds.push({ key: "county", months: only(boardMonths(d.board)), first: null, month: function (m) {
        var rel = boardMonthRel(sc, d.board, m);
        return (rel ? get(rel, true) : Promise.resolve(null)).then(function (doc) { return rows2objs(doc).map(function (v) { return coRow(v, doc && doc.matters, d.board.body); }); });
      } });
    } else if (w.county && !sc.county && d.coLatest && !f.month) {
      // A state's county boards: the latest votes only. Each county's page has its last 90 days.
      feeds.push({ key: "county", months: [], first: rows2objs(d.coLatest).filter(function (v) { return (v.body || "").indexOf(sc.st + "-") === 0; }).map(function (v) { return coRow(v, null, v.body); }), month: null });
    }
    return feeds;
  }
  function newestFirst(a, b) {
    var da = (a.date || "").slice(0, 10), db = (b.date || "").slice(0, 10);
    if (da !== db) return da < db ? 1 : -1;
    if ((a.date || "") !== (b.date || "")) return (a.date || "") < (b.date || "") ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  }
  function merger(feeds, keep) {
    feeds.forEach(function (fd) { fd.rows = []; fd.ids = {}; fd.next = 0; fd.down = "9999-12-31"; fd.done = false; });
    function add(fd, rows) { (rows || []).forEach(function (v) { if (v && v.id && !fd.ids[v.id]) { fd.ids[v.id] = 1; fd.rows.push(v); } }); }
    function step(fd) {
      var m = fd.months[fd.next++];
      return fd.month(m).then(function (rows) {
        add(fd, rows);
        fd.down = m + "-01";
        if (fd.next >= fd.months.length) fd.done = true;
      });
    }
    function init() {
      return Promise.all(feeds.map(function (fd) {
        if (fd.first && fd.first.length) {
          add(fd, fd.first);
          // All of this feed's votes after its oldest listed day are in the latest file. That day
          // may be cut short; a vote missing from it slots in when its month is loaded.
          fd.down = fd.first.reduce(function (a, v) { var x = (v.date || "").slice(0, 10); return x < a ? x : a; }, "9999-12-31");
          if (!fd.months.length) fd.done = true;
          return null;
        }
        if (!fd.months.length) { fd.done = true; return null; }
        return step(fd);
      }));
    }
    function frontier() { var x = ""; feeds.forEach(function (fd) { if (!fd.done && fd.down > x) x = fd.down; }); return x; }
    function visible() {
      var x = frontier(), out = [];
      feeds.forEach(function (fd) { fd.rows.forEach(function (v) { if (keep(v) && (!x || (v.date || "").slice(0, 10) >= x)) out.push(v); }); });
      return out.sort(newestFirst);
    }
    function complete() { return feeds.every(function (fd) { return fd.done; }); }
    function fill(n) {
      var v = visible();
      if (v.length >= n || complete()) return Promise.resolve(v);
      var best = null;
      feeds.forEach(function (fd) { if (!fd.done && (!best || fd.down > best.down)) best = fd; });
      return step(best).then(function () { return fill(n); });
    }
    return { init: init, visible: visible, fill: fill, complete: complete };
  }

  // A plain title first: the record's own title with the boilerplate taken off ("A bill to",
  // "An ordinance", "Relating to"), cut at 90 characters on a word. The official number and
  // body follow on the next line, and the vote page has the full title.
  var TITLE_LEAD = /^(?:an?|the)\s+(?:bill|act|joint resolution|concurrent resolution|resolution|ordinance|measure|memorial)\b[\s,:]*(?:to\s+)?/i;
  function plainTitle(v) {
    var t = String(v.title || "").replace(/\s+/g, " ").trim();
    if (!t) t = v.question ? String(v.question) : "Vote";
    if (t.length > 12 && t === t.toUpperCase()) t = t.toLowerCase();
    t = t.replace(TITLE_LEAD, "").replace(/^relating to\s+/i, "").replace(/^to\s+(?=[a-z])/i, "").replace(/[\s.;:,]+$/, "");
    t = cap(t);
    if (t.length > 90) {
      var cut = t.slice(0, 90), sp = cut.lastIndexOf(" ");
      t = (sp > 50 ? cut.slice(0, sp) : cut).replace(/[\s,;:(]+$/, "") + "…";
    }
    return t || "Vote";
  }
  var YEAR_NOW = todayISO().slice(0, 4);
  function shortDate(s) {
    if (!s) return "";
    var d = isDateOnly(s.slice(0, 10)) ? dateOnly(s.slice(0, 10)) : new Date(s);
    if (isNaN(d)) return s;
    var withYear = s.slice(0, 4) !== YEAR_NOW;
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: withYear ? "numeric" : undefined }).format(d);
  }
  function resultText(v) {
    if (v.level !== "county") return resultWord(v);
    var r = String(v.result || "");
    if (/^pass(ed)?$/i.test(r)) return "Passed";
    if (/^fail(ed)?$/i.test(r)) return "Failed";
    if (r) return cap(r === r.toUpperCase() ? r.toLowerCase() : r);
    return v.passed === true ? "Passed" : v.passed === false ? "Failed" : "Recorded";
  }
  function feedItem(v, sc) {
    var bits = [];
    if (v.level === "federal") {
      if (v.label) bits.push(v.label);
      bits.push(bodyName(v.body));
      if (v.number) bits.push("roll call " + v.number);
      var q = String(v.question || "").replace(v.label || "\u0000", "").replace(/\s+/g, " ").trim();
      if (q) bits.push(q);
    } else if (v.level === "state") {
      if (v.label) bits.push(v.label);
      bits.push(bodyName(v.body));
      if (v.where) bits.push(v.where);
      if (v.question) bits.push(cap(String(v.question)));
    } else {
      bits.push(bodyName(v.body, sc.cidx));
      if (v.label) bits.push("agenda item " + v.label);
    }
    bits.push(v.recorded === false ? "no roll call recorded" : (v.yes || 0) + " to " + (v.no || 0));
    var title = plainTitle(v);
    var deleg = null;
    if (v.level === "federal" && !sc.s.delegate_only) {
      var who = v.body === "us-senate" ? sc.s.name + "'s senators" : "the " + sc.s.name + " delegation";
      deleg = el("a", { href: voteHref(v.id) + "?state=" + sc.code }, "see " + who, el("span", { class: "visually-hidden" }, " on " + title));
    }
    return el("li", { class: "vrow" },
      el("span", { class: "vr-level" }, LEVEL_NAME[v.level]),
      el("div", { class: "vr-main" },
        el("h3", null, link(voteHref(v.id), title)),
        el("p", { class: "vr-meta" }, bits.join(" · "), deleg ? [" · ", deleg] : null)),
      el("span", { class: "vr-result" + (v.passed === true ? " pass" : v.passed === false ? " fail" : "") }, resultText(v)),
      el("span", { class: "vr-date" }, v.date ? el("time", { datetime: v.date }, shortDate(v.date)) : null));
  }
  function monthsForDrawer(sc, f, d) {
    var w = wantsOf(sc, { level: f.level });
    var list = [];
    if (w.fed) list = list.concat(fedMonths(d.latest));
    if (w.state && d.stIdx) list = list.concat(stateShards(sc, d.stIdx, "").map(function (x) { return x.month; }));
    if (w.county && d.board) list = list.concat(boardMonths(d.board));
    return monthsDesc(list);
  }
  function votesDrawer(sc, f, months, open) {
    var on = (f.body ? 1 : 0) + (f.result ? 1 : 0) + (f.month ? 1 : 0);
    var btn = el("button", { type: "button", class: "more-btn", id: "more-btn", "aria-expanded": open ? "true" : "false", "aria-controls": "filters" },
      el("span", null, on ? "More filters (" + on + " on)" : "More filters"), el("span", { class: "chev", "aria-hidden": "true" }));
    var countySel = el("select", { id: "f-county" }, el("option", { value: "" }, "All of " + sc.s.name), sc.counties.map(function (c) { return el("option", { value: c.slug, selected: !!(sc.county && sc.county.slug === c.slug) }, c.name); }));
    var bodySel = el("select", { id: "f-body" }, el("option", { value: "" }, "Any body"), voteBodies(sc).map(function (b) { return el("option", { value: b[0], selected: b[0] === f.body }, b[1]); }));
    var resultSel = el("select", { id: "f-result" }, [["", "Any result"], ["passed", "Passed"], ["failed", "Failed"]].map(function (o) { return el("option", { value: o[0], selected: o[0] === f.result }, o[1]); }));
    var monthSel = el("select", { id: "f-month" }, el("option", { value: "" }, "Latest votes"), months.map(function (m) { return el("option", { value: m, selected: m === f.month }, fmtMonth(m)); }));
    var showBills = sc.s.legislature ? el("input", { type: "radio", name: "f-show", id: "f-show-bills", value: "bills" }) : null;
    function field(id, label, control, cls) { return el("div", { class: "field" + (cls ? " " + cls : "") }, el("label", { for: id }, label), control); }
    var form = el("form", { class: "drawer-form", "aria-label": "More filters", on: { submit: function (e) {
      e.preventDefault();
      if (showBills && showBills.checked) { navigate(href([sc.slug, "bills"]), { focusSel: "#results" }); return; }
      var cslug = countySel.value, parts = cslug ? [sc.slug, cslug] : [sc.slug];
      var body = bodySel.value;
      if (body && levelOf(body) === "county") {
        // a county's board narrows to that county's page
        var b = boardOfBody(sc, body);
        if (b && b.slug && !cslug) parts = [sc.slug, b.slug];
        else if (b && b.slug !== cslug) body = "";
      }
      pendingUi = { drawer: true };
      navigate(href(parts, { level: body ? levelOf(body) : f.level, body: body, result: resultSel.value, month: monthSel.value }), { focusSel: "#results", keepScroll: parts.join("/") === sc.parts.join("/") });
    } } },
      el("div", { class: "fields" },
        sc.counties.length ? field("f-county", cap(countyWord(sc.s, 1)), countySel) : null,
        field("f-body", "Body", bodySel), field("f-result", "Result", resultSel, "narrow"), field("f-month", "Month", monthSel, "mid"),
        showBills ? el("fieldset", { class: "field show" }, el("legend", null, "Show"), el("div", { class: "radios" },
          el("label", { class: "check" }, el("input", { type: "radio", name: "f-show", id: "f-show-votes", value: "votes", checked: true }), " Votes"),
          el("label", { class: "check" }, showBills, " Bills"))) : null),
      el("div", { class: "actions" },
        el("button", { type: "submit", class: "btn apply" }, "Apply"),
        el("button", { type: "button", class: "btn", on: { click: function () {
          pendingUi = { drawer: true };
          navigate(href(sc.parts, { level: f.level }), { focusSel: "#results", keepScroll: true });
        } } }, "Clear all"),
        el("p", { class: "hint" }, "Nothing changes until Apply."),
        el("p", { class: "src-link" }, link(href([sc.slug, "sources"]), sc.s.name + " sources and update times"))));
    var panel = el("div", { class: "drawer", id: "filters", hidden: !open }, form);
    btn.addEventListener("click", function () {
      var o = btn.getAttribute("aria-expanded") !== "true";
      btn.setAttribute("aria-expanded", o ? "true" : "false");
      panel.hidden = !o;
    });
    return { btn: btn, panel: panel };
  }
  function votesDoor(sc, params, ui) {
    var f = voteFilters(params, sc);
    var w = wantsOf(sc, f);
    return namedFiles(function (rel) { return get(rel, true); }, votesFirstFiles(sc, f)).then(function (d) {
      var months = monthsForDrawer(sc, f, d);
      if (f.month && months.indexOf(f.month) < 0) f.month = "";
      var keep = function (v) {
        if (f.body && !bodyMatch(v.body, f.body)) return false;
        if (f.result === "passed" && v.passed !== true) return false;
        if (f.result === "failed" && v.passed !== false) return false;
        return true;
      };
      var feeds = voteFeeds(sc, f, d);
      var eng = merger(feeds, keep);
      return eng.init().then(function () {
        var man = sc.man, counts = man.counts || {};
        var cs = currentSession(d.latest);
        var legName = stateLegName(sc.s);
        var rows = eng.visible();
        var place = sc.county ? sc.county.name : sc.s.name;
        var res = f.result === "passed" ? " that passed" : f.result === "failed" ? " that failed" : "";
        var subject = function (n) {
          var word = n === 1 ? "vote" : "votes";
          return f.body ? word + " of the " + bodyName(f.body, sc.cidx) : f.level === "federal" ? "federal " + word : (f.level ? f.level + " " : "") + word + " in " + place;
        };
        // "Latest votes in Texas, newest first"; with a month, the exact count: "41 state votes in Texas that passed in September 2026"
        var heading = f.month ? rows.length.toLocaleString() + " " + subject(rows.length) + res + " in " + fmtMonth(f.month) + ", newest first" : "Latest " + subject(2) + res + ", newest first";
        // What is on record, level by level, when no month is chosen.
        var onRecord = [];
        if (!f.month && !f.body) {
          if (w.fed && counts.us_votes && cs) onRecord.push(plural(counts.us_votes, "federal roll call", "federal roll calls") + " in the " + ordinal(cs.congress) + " Congress");
          if (w.state && sc.stateVotes) onRecord.push(sc.code === "CA" ? plural(counts.ca_votes || 0, "vote", "votes") + " of the California Legislature this session" : plural(sc.leg.votes || 0, "vote", "votes") + " of the " + legName + " (Open States, not the official record)");
          var boardVotes = ((d.board && d.board.vote_months) || []).reduce(function (a, x) { return a + (x.votes || 0); }, 0);
          if (w.county && sc.countyVotes) onRecord.push(sc.county ? plural(boardVotes, "board vote", "board votes") + " in the last 90 days" : "the latest county board votes (each county's page has its last 90 days)");
        }
        var notes = pendingNote(sc);
        if (w.state && sc.s.legislature && !sc.stateVotes) notes.push(note("Votes of the " + legName + " are not collected here yet. Its members are under Who represents me; the legislature's journals are the official record."));
        if (w.county && !sc.countyVotes && sc.counties.length && !sc.noCountyGov) notes.push(note(sc.county ? (sc.board ? sc.county.name + "'s board publishes its agendas through Legistar but no votes; its site is linked above." : sc.county.name + " does not publish its board's votes in a form this site can collect; its board's own site is linked above.")
          : "No " + countyWord(sc.s, 1) + " board in " + sc.s.name + " publishes its votes through Legistar, the system this site reads." + (sc.boards.length ? "" : " Each " + countyWord(sc.s, 1) + "'s page links its board's own site.")));
        if (w.county && !sc.county && sc.boards.length && (f.level === "county" || f.month)) {
          notes.push(el("p", { class: "note" }, (f.month ? "County board votes by month are on each " + countyWord(sc.s, 1) + "'s page: " : "Boards in " + sc.s.name + " that publish through Legistar: "),
            sc.boards.map(function (b, i) { return [i ? " · " : null, link(href([sc.slug, b.slug], f.month ? { level: "county", month: f.month } : { level: "county" }), b.county), b.coverage === "agendas" ? " (agenda actions, no roll calls)" : ""]; }), "."));
        }
        var drawer = votesDrawer(sc, f, months, !!ui.drawer);
        var hrefFor = function (lv) { return href(sc.parts, { level: lv, result: f.result, month: f.month }); };
        var chips = chipBar(sc, f.level, hrefFor, { state: sc.s.legislature && !sc.stateVotes ? "not collected yet" : "", county: sc.noCountyGov ? "no county government" : sc.countyVotes ? "" : "no published votes" }, true);
        var list = el("ul", { class: "plain vlist" });
        var countP = el("p", { class: "count" });
        var moreBtn = el("button", { type: "button", class: "btn" }, "Show more", el("span", { class: "visually-hidden" }, " votes"));
        var shown = 0;
        function paint(all, upto, focusFrom) {
          list.replaceChildren();
          for (var i = 0; i < upto; i++) list.appendChild(feedItem(all[i], sc));
          shown = upto;
          var known = eng.complete();
          countP.textContent = "Showing " + upto.toLocaleString() + (known ? " of " + all.length.toLocaleString() : "");
          moreBtn.hidden = known && upto >= all.length;
          if (focusFrom !== undefined && list.children[focusFrom]) { var a = list.children[focusFrom].querySelector("a"); if (a) a.focus(); }
        }
        moreBtn.addEventListener("click", function () {
          var from = shown;
          moreBtn.disabled = true;
          moreBtn.firstChild.textContent = "Loading…";
          eng.fill(shown + DOOR_PAGE).then(function (all) {
            moreBtn.disabled = false;
            moreBtn.firstChild.textContent = "Show more";
            paint(all, Math.min(all.length, from + DOOR_PAGE), from);
          }, function (e) {
            moreBtn.disabled = false;
            moreBtn.firstChild.textContent = "Show more";
            countP.textContent = "Older votes could not be loaded. " + (e && e.kind ? e.message : "");
          });
        });
        paint(rows, Math.min(rows.length, DOOR_PAGE));
        var body = frag(
          el("div", { class: "controls" }, chips, drawer.btn), drawer.panel,
          el("h2", { class: "results", id: "results", tabindex: "-1" }, heading),
          onRecord.length ? el("p", { class: "on-record" }, "On record: " + listWords(onRecord) + ".") : null,
          notes,
          rows.length || !eng.complete() ? list : note(f.body || f.result || f.month ? "No votes match these filters." : "No votes are published for this place yet."),
          rows.length || !eng.complete() ? el("div", { class: "show-more" }, countP, moreBtn) : null);
        var foot = footLine([el("span", null, "Updated ", time(man.generated_at, true)), "Federal roll calls from the Clerk of the House and the Senate",
          sc.code === "CA" ? "California votes from the Legislature's nightly database" : sc.stateVotes ? sc.s.name + " votes from Open States (not the official record)" : null,
          sc.boards.length ? (sc.county ? sc.county.name + " votes from its Legistar site" : "county votes from each board's Legistar site") : null,
          link(href([sc.slug, "sources"]), sc.s.name + " sources")]);
        return { body: body, foot: foot };
      });
    });
  }

  // ---------- door: Who represents me ----------
  function byLast(a, b) { return (a.last || a.name).localeCompare(b.last || b.name); }
  function repsDoor(sc, params) {
    var CA = sc.code === "CA", s = sc.s, g = sc.county;
    var level = levelParam(params.get("level"), g ? ["federal", "state", "county"] : ["federal", "state"]);
    return Promise.all([usMembers(), s.legislature ? (CA ? caMembers() : stateMembers(sc.code)) : null, s.legislature && !CA ? stateSummary(sc.code) : null,
      g && sc.board ? get(boardFolder(sc) + "/board.json", true) : null]).then(function (r) {
      var us = r[0], mem = r[1], summ = r[2] || {}, board = r[3];
      var serving = function (m) { return !m.former && !m.provisional; };
      var groups = [];
      function contactOf(m, kind) {
        var out = [];
        var urls = m.urls || {};
        if (m.phone) out.push(telLink(m.phone));
        if (m.email) { var ml = mailLink(m.email); if (ml) out.push(ml); }
        if (kind === "federal") {
          if (urls.contact) out.push(ext(urls.contact, "contact form", " for " + m.name + " (opens the member's site)"));
          else if (urls.official) out.push(ext(urls.official, "website", " of " + m.name + " (opens the member's site)"));
        } else if (kind === "ca") {
          if (urls.official) out.push(ext(urls.official, "member list", " (the Legislature's page of members)"));
        } else if (m.url) out.push(ext(m.url, "official page", " of " + m.name + " (the legislature's page)"));
        return out;
      }
      function row(m, party2, seat, contact) {
        return el("li", { class: "prow" },
          el("span", { class: "pr-name" }, link(memberHref(m.id), m.name)),
          el("span", { class: "pr-party" }, party2 || ""),
          el("span", { class: "pr-seat" }, seat || ""),
          el("span", { class: "pr-contact" }, contact.map(function (c, i) { return [i ? " · " : null, c]; })),
          el("span", { class: "pr-rec" }, el("a", { href: memberHref(m.id) + "#record" }, "Voting record", el("span", { class: "visually-hidden" }, " of " + m.name))));
      }
      if (!level || level === "federal") {
        var sen = us.list.filter(function (m) { return m.body === "us-senate" && m.state === sc.code && serving(m); }).sort(byLast);
        var reps = us.list.filter(function (m) { return m.body === "us-house" && m.state === sc.code && serving(m) && (!g || s.delegate_only || (g.cd || []).indexOf(m.district || 0) >= 0); })
          .sort(function (a, b) { return (a.district || 0) - (b.district || 0); });
        if (sen.length) groups.push({ title: "U.S. Senate", count: plural(sen.length, "senator", "senators"), list: sen, row: function (m) { return row(m, m.party_name || party(m.party), "Senator for " + s.name, contactOf(m, "federal")); } });
        groups.push({ title: "U.S. House", count: plural(reps.length, s.delegate_only ? "delegate" : "representative", s.delegate_only ? "delegates" : "representatives"), list: reps,
          empty: "No current representative is matched to this " + countyWord(s, 1) + "'s districts.",
          row: function (m) { return row(m, m.party_name || party(m.party), m.delegate || s.delegate_only ? "Delegate" : m.district ? "District " + m.district : "At large", contactOf(m, "federal")); } });
      }
      if ((!level || level === "state") && s.legislature && mem) {
        if (CA) {
          [["ca-senate", "California Senate", 40, g ? g.sldu : null], ["ca-assembly", "California Assembly", 80, g ? g.sldl : null]].forEach(function (x) {
            var list = mem.list.filter(function (m) { return m.body === x[0] && m.active && (!x[3] || x[3].indexOf(String(m.district)) >= 0); }).sort(function (a, b) { return a.district - b.district; });
            groups.push({ title: x[1], count: g ? plural(list.length, "member", "members") : x[2] + " seats, " + list.length + " filled", list: list,
              row: function (m) { return row(m, m.party_name || party(m.party), "District " + m.district, contactOf(m, "ca")); } });
          });
        } else {
          s.legislature.chambers.forEach(function (c) {
            var id = c.id === "legislature" ? "upper" : c.id;
            var list = g ? countyLegislators(mem.list, g, id) : mem.list.filter(function (m) { return (m.chamber === "legislature" ? "upper" : m.chamber) === id; })
              .sort(function (a, b) { return naturalCompare(a.district, b.district) || a.name.localeCompare(b.name); });
            var sum = ((summ.chambers || []).filter(function (x) { return x.id === c.id; })[0]) || null;
            groups.push({ title: chamberTitle(s, c.id), count: g ? plural(list.length, "member", "members") : (sum ? sum.seats + " seats, " + sum.members + " filled" : plural(list.length, "member", "members")), list: list,
              empty: "No current member is matched to this " + countyWord(s, 1) + "'s districts.",
              row: function (m) { return row(m, m.party_name || party(m.party), cap(districtWords(m)), contactOf(m, "state")); } });
          });
        }
      }
      if (g && !sc.noCountyGov && (!level || level === "county")) {
        var bm = ((board && board.members) || []).filter(function (m) { return !m.provisional; });
        groups.push({ title: (board && board.body_name) || (sc.entry && sc.entry.body_name) || (g.board && g.board.name) || "County board", count: bm.length ? plural(bm.length, "member", "members") : "",
          list: bm, empty: "This " + countyWord(s, 1) + "'s board members are not published in a form this site can read; its own site, linked above, lists them.",
          row: function (m) { return row(m, "", m.title || "Member", []); } });
      }
      var sel = el("select", { id: "rep-county" }, el("option", { value: "" }, "All of " + s.name), sc.counties.map(function (c) { return el("option", { value: c.slug, selected: !!(g && g.slug === c.slug) }, c.name); }));
      var picker = sc.counties.length ? el("form", { class: "county-pick", on: { submit: function (e) {
        e.preventDefault();
        var v = sel.value;
        navigate(href(v ? [sc.slug, v, "representatives"] : [sc.slug, "representatives"], { level: level === "county" && !v ? "" : level }), { focusSel: "#results", keepScroll: (v || "") === (g ? g.slug : "") });
      } } }, el("label", { for: "rep-county" }, "Narrow to your " + countyWord(s, 1)), el("div", { class: "row" }, sel, el("button", { type: "submit", class: "btn" }, "Show"))) : null;
      var chips = chipBar(sc, level, function (lv) { return href(sc.parts.concat("representatives"), { level: lv }); }, { county: sc.noCountyGov ? "no county government" : "" }, !!g);
      var lookups = el("p", { class: "note" }, "For the districts of one address: ", ext("https://www.house.gov/representatives/find-your-representative", "Find your U.S. Representative", " (the House's lookup)"),
        s.legislature ? [" · ", CA ? ext("https://findyourrep.legislature.ca.gov/", "Find your California legislators", " (the Legislature's lookup)") : ext("https://openstates.org/find_your_legislator/", "Find your state legislators", " (Open States, a nonprofit project)")] : null, ".");
      var body = frag(
        el("div", { class: "controls" }, chips, picker),
        el("h2", { class: "results", id: "results", tabindex: "-1" }, "Who represents " + sc.name + (level ? ": " + level + " level" : "")),
        pendingNote(sc), lookups,
        groups.map(function (gr) {
          return el("section", { class: "rep-group" },
            el("h3", { class: "group-head" }, gr.title, gr.count ? el("span", { class: "gcount" }, gr.count) : null),
            more(gr.list, gr.row, { first: 6, page: 500, ulClass: "prows", what: "of " + gr.title, empty: gr.empty || "No current members listed." }));
        }));
      var cl = sourceOf(sc.man, "congress-legislators") || {};
      var foot = footLine([el("span", null, "Members of Congress from the congress-legislators dataset, checked ", time(cl.last_checked_at, true)),
        s.legislature ? (CA ? el("span", null, "California legislators from the Legislature's nightly database") : el("span", null, s.name + " legislators from Open States, updated ", time(mem && mem.source_updated_at, true), " (not the official record)")) : null,
        link(href([sc.slug, "sources"]), s.name + " sources")]);
      return { body: body, foot: foot };
    });
  }

  // ---------- door: What's coming up ----------
  var DAY_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
  function upcomingRow(u, sc) {
    var lvl = u.level || levelOf(u.body);
    var isMeeting = u.kind === "meeting";
    var what = isMeeting ? (bodyName(u.body, sc.cidx) || u.title || "Board meeting") : (u.title || "Scheduled item");
    var paren = isMeeting && /\(([^)]*)\)$/.exec(u.title || "");
    var where = [isMeeting ? (paren ? paren[1] : "Meeting") : u.category || (u.kind === "floor" ? "Floor" : u.kind === "committee" ? "Committee" : null), u.location, u.file_item ? "file item " + u.file_item : null].filter(Boolean).join(" · ");
    var id = (u.source && u.source.id) || "";
    var url = u.agenda_url || u.official_url;
    var srcText = u.agenda_url ? "Agenda" : id === "docs-house-floor" ? "Floor schedule" : id === "senate-schedules" ? (u.kind === "floor" ? "Floor schedule" : "Hearing page")
      : id === "senate-daily-press" ? "Press Gallery notice" : id === "ca-leginfo-pubinfo" ? "Daily File" : isMeeting ? "Meeting page" : "Official notice";
    var when = u.date_precision === "week" ? "Week of " + shortDate(u.date) : u.time ? fmtClock(u.time, u.tz) : (u.time_note || "Time not set");
    return el("li", { class: "urow" },
      el("span", { class: "ur-time" }, when),
      el("span", { class: "ur-level" }, LEVEL_NAME[lvl] || lvl),
      el("div", { class: "ur-main" },
        el("p", { class: "ur-what" }, u.bill_id && /^(us-|\d{8})/.test(u.bill_id) ? link(billHref(u.bill_id), what) : what),
        where ? el("p", { class: "ur-where" }, where) : null,
        u.note ? el("p", { class: "ur-where" }, id === "senate-daily-press" ? el("strong", null, "Advisory, quoted from the Press Gallery's notice; floor times often change. ") : null, u.note) : null),
      el("span", { class: "ur-src" }, url ? ext(url, srcText, " for " + what + ", " + fmtDate(u.date) + " (opens the official site)") : null));
  }
  function upcomingDoor(sc, params) {
    var CA = sc.code === "CA", s = sc.s, g = sc.county;
    var level = levelParam(params.get("level"), s.legislature ? ["federal", "state", "county"] : ["federal", "county"]);
    return Promise.all([get("us/upcoming.json", true), CA ? get("us-ca/upcoming.json", true) : null, sc.boards.length ? get(CA ? "us-ca/counties/upcoming.json" : "counties/upcoming.json", true) : null,
      s.legislature && !CA ? stateSummary(sc.code) : null, g && sc.board ? get(boardFolder(sc) + "/board.json", true) : null]).then(function (r) {
      var today = todayISO();
      var boardBody = sc.board ? sc.board.body : null;
      var county = ((r[2] && r[2].items) || []).map(function (m) { return Object.assign({ level: "county" }, m); })
        .filter(function (u) { var b = u.body || ""; return g ? b === boardBody : b.indexOf(sc.st + "-") === 0; });
      var items = ((r[0] && r[0].items) || []).concat((r[1] && r[1].items) || [], county)
        .filter(function (u) { return ahead(u, today) && (!level || (u.level || levelOf(u.body)) === level); })
        .sort(function (a, b) { return whenKey(a).localeCompare(whenKey(b)) || (a.title || "").localeCompare(b.title || ""); });
      var days = [];
      items.forEach(function (u) { var d = days[days.length - 1]; if (!d || d.date !== u.date) { d = { date: u.date, items: [] }; days.push(d); } d.items.push(u); });
      var summ = r[3] || {};
      var notes = [];
      if (s.legislature && !CA && (!level || level === "state")) {
        var sites = (summ.chambers || []).filter(function (c) { return c.official_site; });
        notes.push(el("p", { class: "note" }, "Hearings and floor sessions of the " + stateLegName(s) + " are not collected yet.",
          sites.length ? [" Its chambers list them: ", sites.map(function (c, i) { return [i ? " · " : null, ext(c.official_site, chamberTitle(s, c.id), " (the chamber's own site)")]; }), "."] : null));
      }
      if (!sc.boards.length && sc.counties.length && !sc.noCountyGov && (!level || level === "county")) notes.push(note(g ? g.name + "'s meetings are not published in a form this site can collect; its board's own site is linked above." : "No " + countyWord(s, 1) + " board in " + s.name + " publishes its meetings through Legistar, the system this site reads."));
      var board = r[4];
      var held = board ? (board.meetings || []).filter(function (m) { return m.date < today; }).sort(function (a, b) { return b.date.localeCompare(a.date); }) : [];
      var chips = chipBar(sc, level, function (lv) { return href(sc.parts.concat("upcoming"), { level: lv }); },
        { state: s.legislature && !CA ? "not collected yet" : "", county: sc.noCountyGov ? "no county government" : sc.boards.length ? "" : "none published" }, true);
      var body = frag(
        el("div", { class: "controls" }, chips),
        el("h2", { class: "results", id: "results", tabindex: "-1" }, plural(items.length, "item", "items") + " scheduled" + (level ? " at the " + level + " level" : "") + ", soonest first"),
        el("p", { class: "on-record" }, "The House floor for the week, Senate hearings and floor sessions" + (CA ? ", California's Daily File and committee hearings within 45 days" : "") + (sc.boards.length ? ", and the meetings of " + (g ? "the " + countyWord(s, 1) + "'s board" : "county boards that publish through Legistar") : "") + ". Times are in the zone each source gives."),
        notes,
        days.length ? days.map(function (d) {
          return el("section", { class: "day" }, el("h3", { class: "day-head" }, el("time", { datetime: d.date }, DAY_FMT.format(dateOnly(d.date)))),
            el("ul", { class: "plain ulist" }, d.items.map(function (u) { return upcomingRow(u, sc); })));
        }) : note("Nothing is scheduled in the published feeds" + (level ? " at this level" : "") + "."),
        held.length && (!level || level === "county") ? el("section", { class: "held" }, el("h2", null, "Recent meetings of the " + (board.body_name || "board")),
          el("ul", { class: "plain meets" }, held.map(function (m) {
            return el("li", null, time(m.date), clockPart(m), " · " + plural(m.votes || 0, "action", "actions") + " on " + plural(m.items || 0, "agenda item", "agenda items"), " · ",
              m.minutes_url ? ext(m.minutes_url, "Minutes", " of the " + fmtDate(m.date) + " meeting") : null, m.minutes_url && m.agenda_url ? " · " : null,
              m.agenda_url ? ext(m.agenda_url, "Agenda", " of the " + fmtDate(m.date) + " meeting") : null, !m.minutes_url && !m.agenda_url ? ext(m.official_url, "Meeting page", " for " + fmtDate(m.date)) : null);
          }))) : null);
      var foot = footLine(["Federal from the House Majority Leader and the Senate", CA ? "California from the Daily File" : null, sc.boards.length ? "county meetings from Legistar" : null,
        "Times in the zone each source gives", link(href([sc.slug, "sources"]), s.name + " sources")]);
      return { body: body, foot: foot };
    });
  }

  // ---------- a state's bills ----------
  function billsDoor(sc, params) {
    // A territory has no legislature; a state whose legislature is not published yet says so.
    if (!sc.s.legislature) return Promise.resolve(NO_LEGISLATURE[sc.code] ? null : { body: frag(el("h2", { class: "results", id: "results", tabindex: "-1" }, sc.s.name + " bills"), pendingNote(sc)) });
    var CA = sc.code === "CA", s = sc.s;
    var text = (params.get("q") || "").toLowerCase();
    var form = el("form", { class: "filters", "aria-label": "Filter bills", on: { submit: function (e) {
      e.preventDefault();
      var fd = new FormData(form);
      navigate(href([sc.slug, "bills"], { session: fd.get("session"), type: fd.get("type"), status: fd.get("status"), q: String(fd.get("q") || "").trim() }), { focusSel: "#results", keepScroll: true });
    } } });
    var controls = [];
    var subtitle = "";
    var loads;
    if (CA) {
      loads = caMembers().then(function (ca) { return ca.session ? get("us-ca/bills/" + ca.session + "/index.json", true).then(function (idx) { return { idx: idx, session: ca.session }; }) : { idx: null }; }).then(function (x) {
        var idx = x.idx;
        if (!idx) return [];
        subtitle = "Every measure of the " + sessionLabel(x.session) + " session, from the Legislature's nightly database.";
        var types = Object.keys(idx.types);
        var type = params.get("type") && types.indexOf(params.get("type")) >= 0 ? params.get("type") : "AB";
        controls.push(selectEl("type", "Measure type", types.map(function (t) { return [t, t + " (" + idx.types[t].bills + ")"]; }), type));
        return get("us-ca/bills/" + x.session + "/" + idx.types[type].file, true).then(function (d) { return rows2objs(d).map(function (b) { return { id: b.id, label: b.label, title: b.title, date: b.latest_action_date, action: null, status: b.status, location: b.location, votes: b.votes }; }); });
      });
    } else if (sc.stateBills) {
      loads = stateVoteIndex(sc.code).then(function (vidx) {
        var sessions = ((vidx && vidx.sessions) || []).slice().sort(function (a, b) { return (a.start || "").localeCompare(b.start || ""); });
        var ids = sessions.map(function (x) { return x.id; });
        var regular = sessions.filter(function (x) { return x.classification === "primary"; });
        var session = params.get("session") && ids.indexOf(params.get("session")) >= 0 ? params.get("session") : (regular.length ? regular[regular.length - 1] : sessions[sessions.length - 1] || {}).id;
        if (!session) return [];
        if (sessions.length > 1) controls.push(selectEl("session", "Session", sessions.map(function (x) { return [x.id, x.name || x.id]; }), session));
        return get("us-" + sc.st + "/bills/" + session + "/index.json", true).then(function (idx) {
          if (!idx) return [];
          var types = Object.keys(idx.types).sort(function (a, b) { return idx.types[b].bills - idx.types[a].bills || a.localeCompare(b); });
          var type = params.get("type") && types.indexOf(params.get("type")) >= 0 ? params.get("type") : types[0];
          if (!type) return [];
          controls.push(selectEl("type", "Measure type", types.map(function (t) { return [t, t + " (" + idx.types[t].bills + ")"]; }), type));
          subtitle = "Every measure in the Open States data for the " + sessionTitle(s, sessionName(sessions, session)) + ". Open States collects them from the legislature's website; it is not the official record.";
          return get("us-" + sc.st + "/bills/" + session + "/" + idx.types[type].file, true).then(function (d) {
            return rows2objs(d).map(function (b) { return { id: b.id, label: b.label, title: b.title, date: b.latest_action_date, action: b.latest_action, status: null, votes: b.votes }; });
          });
        });
      });
    } else {
      loads = Promise.resolve(null);
    }
    return Promise.all([loads, CA ? null : stateSummary(sc.code)]).then(function (x) {
      var rows = x[0], summ = x[1] || {};
      var legName = stateLegName(s);
      if (rows === null) {
        var sites = (summ.chambers || []).filter(function (c) { return c.official_site; });
        return { body: frag(el("h2", { class: "results", id: "results", tabindex: "-1" }, legName + " bills"),
          el("p", { class: "note" }, "Bills of the " + legName + " are not collected here yet.", sites.length ? [" Its chambers list them: ", sites.map(function (c, i) { return [i ? " · " : null, ext(c.official_site, chamberTitle(s, c.id), " (the chamber's own site)")]; }), "."] : null)) };
      }
      var statuses = [];
      rows.forEach(function (b) { if (b.status && statuses.indexOf(b.status) < 0) statuses.push(b.status); });
      var status = params.get("status") || "";
      if (statuses.length) controls.push(selectEl("status", "Status", [["", "Any status"]].concat(statuses.sort().map(function (v) { return [v, v]; })), status));
      var filtered = rows.filter(function (b) {
        if (status && b.status !== status) return false;
        if (text && ((b.label || "") + " " + (b.title || "") + " " + (b.id || "")).toLowerCase().indexOf(text) < 0) return false;
        return true;
      });
      filtered.sort(function (a, b) { return (b.date || "").localeCompare(a.date || "") || a.label.localeCompare(b.label, undefined, { numeric: true }); });
      append(form, el("div", { class: "row wrap" }, controls),
        el("div", { class: "row" }, el("div", { class: "field grow" }, el("label", { for: "bills-q" }, "Filter by number or title"), el("input", { id: "bills-q", name: "q", type: "search", value: params.get("q") || "", autocomplete: "off" })), el("button", { type: "submit", class: "btn" }, "Apply")),
        el("p", { class: "hint" }, "Choose the filters, then press Apply."));
      var list = more(filtered, function (b) {
        return el("li", { class: "bill" },
          el("div", { class: "vote-head" }, b.date ? el("span", { class: "when" }, "latest action ", time(b.date)) : null),
          el("h3", null, link(billHref(b.id), b.label), b.title ? ": " + b.title : ""),
          el("p", { class: "vt" }, b.status ? b.status + (b.location ? " · " + b.location : "") : (b.action || ""), " · " + plural(b.votes || 0, "recorded vote", "recorded votes")));
      }, { ulClass: "bills", empty: "No bills match these filters.", what: "bills" });
      var body = frag(el("h2", { class: "results", id: "results", tabindex: "-1" }, filtered.length.toLocaleString() + " " + legName + (filtered.length === 1 ? " bill" : " bills")),
        subtitle ? el("p", { class: "on-record" }, subtitle) : null, form, list);
      return { body: body, foot: footLine([link(href([sc.slug]), "How " + s.name + " voted"), link(href([sc.slug, "sources"]), s.name + " sources")]) };
    });
  }

  // ---------- a state's sources ----------
  function sourceTr(s, name) {
    return el("tr", null, el("th", { scope: "row" }, name || (s.url ? ext(s.url, s.name) : s.name)), el("td", null, LEVEL_NAME[s.level] || s.level || ""),
      el("td", null, el("span", { class: "st st-" + s.status }, statusWord(s)), s.error ? el("span", { class: "unk" }, " · " + s.error) : null),
      el("td", null, s.last_checked_at ? time(s.last_checked_at, true) : "never"), el("td", null, s.source_updated_at ? time(s.source_updated_at, true) : el("span", { class: "unk" }, "not stated")));
  }
  function sourcesDoor(sc) {
    var srcs = sc.man.sources || {}, s = sc.s;
    var ids = ["us-house-clerk", "us-senate-lis", "govinfo-billstatus", "docs-house-floor", "senate-schedules", "senate-daily-press", "congress-legislators"];
    if (sc.code === "CA") ids.push("ca-leginfo-pubinfo", "ab604-map");
    else if (s.legislature) ids.push("openstates-people", "openstates-bulk");
    if (sc.counties.length) ids.push("census-geo");
    if (sc.code !== "CA" && sc.counties.length) ids.push("wikidata-county-sites", "legistar-probe");
    var head = el("thead", null, el("tr", null, ["Source", "Level", "Status", "Last checked", "Source updated"].map(function (h) { return el("th", { scope: "col" }, h); })));
    var main = el("table", { class: "tbl" }, el("caption", null, "Sources for " + s.name), head, el("tbody", null, ids.filter(function (k) { return srcs[k]; }).map(function (k) { return sourceTr(srcs[k]); })));
    var cks = Object.keys(srcs).filter(function (k) { return /^county-\d{5}$/.test(k) && k.slice(7, 9) === s.fips; }).sort(function (a, b) { return srcs[a].name.localeCompare(srcs[b].name); });
    var ctable = cks.length ? el("table", { class: "tbl" }, el("caption", null, cap(countyWord(s, 1)) + " boards"),
      el("thead", null, el("tr", null, ["County", "Level", "Status", "Last checked", "Source updated"].map(function (h) { return el("th", { scope: "col" }, h); }))),
      el("tbody", null, cks.map(function (k) {
        var e = sc.cidx[k.slice(7)] || {};
        return sourceTr(srcs[k], e.slug ? frag(link(href([sc.slug, e.slug]), e.county || srcs[k].name), srcs[k].url ? [" · ", ext(srcs[k].url, "official page", " of " + (e.county || srcs[k].name))] : null) : null);
      }))) : null;
    var body = frag(el("h2", { class: "results", id: "results", tabindex: "-1" }, "Where " + s.name + "'s records come from"),
      el("p", { class: "on-record" }, "Each source is checked every night. A source that fails keeps its last good copy and is marked here; a feed that returns far fewer records than the night before is held back rather than published."),
      main, ctable, el("p", { class: "links" }, link(href(["sources"]), "Every source, nationwide, with method notes")));
    return Promise.resolve({ body: body, foot: null });
  }

  // ---------- a state legislator outside California ----------
  function viewStateMember(id, code, params) {
    // The vote index is read only for a legislature whose votes are published (legislatures.json
    // says so), so a state without them costs no failed request.
    var idxP = legislatures().then(function (leg) { return leg[code] && leg[code].votes ? stateVoteIndex(code) : null; });
    return Promise.all([states(), stateMembers(code), stateGeo(code), idxP, manifest()]).then(function (r) {
      var s = STATE_INFO[code], mem = r[1], geo = r[2], idx = r[3], man = r[4];
      var m = mem.by[id];
      if (!s || !m) return notFound();
      var chamber = m.chamber === "legislature" ? "upper" : m.chamber;
      var col = chamber === "lower" ? "sldl" : "sldu";
      var counties = (geo.counties || []).filter(function (g) {
        if (m.at_large) return true;
        if (m.district_key && (g[col] || []).indexOf(m.district_key) >= 0) return true;
        return !!(m.county_fips && m.county_fips.indexOf(g.fips) >= 0);
      });
      var whole = function (g) { return (g[col] || []).length <= 1; };
      var countyLinks = counties.length > 40 && m.at_large ? [el("span", null, "All " + plural(counties.length, countyWord(s, 1), countyWord(s, 2)) + " (elected at large)")]
        : counties.map(function (g, i) { return [i ? " · " : null, link(href([s.slug, g.slug]), g.name), whole(g) ? null : el("span", { class: "meta" }, " (part)")]; });
      var contact = [m.phone ? telLink(m.phone) : null, m.email ? mailLink(m.email) : null].filter(Boolean);
      var facts = el("dl", { class: "facts" },
        el("div", null, el("dt", null, "Level"), el("dd", null, badge("state"), " " + chamberTitle(s, chamber) + ", " + districtWords(m))),
        el("div", null, el("dt", null, "Represents"), el("dd", null, counties.length ? countyLinks : el("span", { class: "unk" }, "the district could not be matched to Census geography")),
          m.county_fips && !m.district_key ? el("p", { class: "meta" }, "A district that overlaps others, matched to the " + countyWord(s, 1) + " it is named after.") : null),
        m.party_name || m.party ? el("div", null, el("dt", null, "Party"), el("dd", null, m.party_name || party(m.party))) : null,
        contact.length ? el("div", null, el("dt", null, "Contact"), el("dd", null, contact.map(function (c, i) { return [i ? " · " : null, c]; }))) : null,
        el("div", null, el("dt", null, "Official page"), el("dd", null, m.url ? ext(m.url, m.url.replace(/^https?:\/\//, "").replace(/\/.*$/, "") + " member page", " (the legislature's page for this member)") : el("span", { class: "unk" }, "none published"))),
        el("div", null, el("dt", null, "Record"), el("dd", null, "Open States, updated ", time(mem.source_updated_at, true), ". Not the official record.")));
      var crumbs = [["All states", BASE], [s.name, href([s.slug, "representatives"])], m.name];
      var lede = "Member of the " + chamberTitle(s, chamber) + (m.party_name ? " (" + m.party_name + ")" : "") + ".";
      var legName = stateLegName(s);
      var vbody = idx ? bodyWithVotes(idx, m) : null;
      function done(rec) {
        rec.id = "record";
        return { title: m.name, lede: lede, crumbs: crumbs, body: frag(facts, rec) };
      }
      if (!idx) return done(section("Voting record", note("Votes in the " + legName + " are not collected yet. The legislature's journals, linked from its website, are the official record."), "record"));
      if (!vbody) return done(section("Voting record", note("No votes of the " + chamberTitle(s, chamber) + " are in the Open States data for the sessions kept here."), "record"));
      var pick = statePick(idx, vbody, params);
      var ch = vbody.split("-")[2];
      return Promise.all([get("us-" + lc(code) + "/records/" + ch + "-" + pick.session + ".json", true), pick.shard ? get("us-" + lc(code) + "/votes/" + pick.session + "/" + pick.shard.file, true) : null]).then(function (d) {
        var rec = d[0], vf = d[1];
        var codes = (rec && rec.members && rec.members[id]) || "";
        var counts = {}, total = 0, floorTotal = 0;
        for (var i = 0; i < codes.length; i++) {
          var c = codes.charAt(i);
          if (c === "-") continue;
          total++; counts[c] = (counts[c] || 0) + 1;
          if (rec.floor && rec.floor[i]) floorTotal++;
        }
        var at = vf ? vf.members.indexOf(id) : -1;
        var entries = at < 0 ? [] : rows2objs(vf).map(function (v) {
          var c2 = (v.positions || "").charAt(at);
          return c2 && c2 !== "-" ? { v: stateRow(v, vbody), code: c2 } : null;
        }).filter(Boolean);
        entries.sort(function (a, b) { return (b.v.date || "").localeCompare(a.v.date || "") || b.v.id.localeCompare(a.v.id); });
        var sessName = sessionName(pick.sessions, pick.session);
        var ssel = pick.sessions.length > 1 ? el("select", { id: "session-pick", name: "session" }, pick.sessions.map(function (x) { return el("option", { value: x.id, selected: x.id === pick.session }, x.name || x.id); })) : null;
        var msel = el("select", { id: "month-pick", name: "month" }, pick.months.slice().reverse().map(function (mo) { return el("option", { value: mo, selected: mo === pick.month }, fmtMonth(mo)); }));
        var form = el("form", { class: "filters", on: { submit: function (e) {
          e.preventDefault();
          var sess = ssel ? ssel.value : pick.session;
          navigate(href(["legislator", id], { session: ssel ? sess : "", month: sess === pick.session ? msel.value : "" }) + "#record", { keepScroll: true });
        } } }, el("div", { class: "row wrap" }, ssel ? [el("label", { for: "session-pick" }, "Session"), ssel] : null, el("label", { for: "month-pick" }, "Month"), msel, el("button", { type: "submit", class: "btn" }, "Show")),
          ssel ? el("p", { class: "hint" }, "A different session shows its latest month.") : null);
        var state = { code: "", text: "", floor: false };
        var box = el("div");
        function redraw() { box.replaceChildren(); box.appendChild(recordList(entries, state, null)); }
        redraw();
        var other = (counts.X || 0), abst = (counts.A || 0) + (counts.O || 0);
        return done(section("Voting record", frag(
          el("p", { class: "sum" }, el("b", null, String(total)), " votes recorded in the " + sessName + " (", el("b", null, String(floorTotal)), " on the floor, the rest in committee): ",
            el("span", { class: "pos pos-Y" }, counts.Y || 0), " yes, ", el("span", { class: "pos pos-N" }, counts.N || 0), " no, ", el("span", { class: "pos pos-X" }, other), " absent or not voting",
            abst ? [", ", el("span", { class: "pos pos-A" }, abst), " abstained or other"] : null, "."),
          form,
          el("h3", null, (pick.month ? fmtMonth(pick.month) : sessName) + " · " + plural(entries.length, "vote", "votes")),
          recordFilters(state, redraw, { floor: true }), box,
          note(OPEN_STATES_NOTE),
          freshness(man, "openstates-bulk", vf && vf.source_updated_at)), "record"));
      });
    });
  }

  // ---------- id resolution ----------
  function parseCaBill(id) { var m = /^(\d{8})(\d)([A-Z]+)(\d+)$/.exec(id); return m ? { session: m[1], type: m[3], num: +m[4], shard: m[3] + "-" + (Math.floor(m[4] / 100) < 10 ? "0" : "") + Math.floor(m[4] / 100) } : null; }
  // Where a bill or a vote lives, from its id alone. The loaders and the views both use these.
  // Bills and votes of the other states (Open States bulk data): tx-89-SB12, tx-89-upper-20250304-aaaaaaaa.
  function stateBillFile(id) {
    var m = /^([a-z]{2})-([A-Za-z0-9_-]+)-([A-Z]+)(\d+)(-[0-9a-z]+)?$/.exec(id || "");
    if (!m || m[1] === "us" || m[1] === "ca") return null;
    var nn = Math.floor(+m[4] / 100);
    return { st: m[1], session: m[2], rel: "us-" + m[1] + "/bills/" + m[2] + "/" + m[3] + "-" + (nn < 10 ? "0" : "") + nn + ".json", national: true };
  }
  function stateVoteFile(id) {
    var m = /^([a-z]{2})-([A-Za-z0-9_-]+)-(upper|lower|legislature)-(\d{4})(\d{2})\d{2}-([0-9a-f]{8})$/.exec(id || "");
    if (!m || m[1] === "us" || m[1] === "ca") return null;
    return { st: m[1], session: m[2], chamber: m[3], rel: "us-" + m[1] + "/votes/" + m[2] + "/" + m[3] + "-" + m[4] + "-" + m[5] + ".json", members: "us-" + m[1] + "/members.json", level: "state", national: true };
  }
  function billFile(id) {
    if (/^us-\d+-/.test(id)) return { rel: "us/bills/" + id.split("-")[1] + "/" + id + ".json" };
    var nb = stateBillFile(id);
    if (nb) return nb;
    var ca = parseCaBill(id);
    return ca ? { rel: "us-ca/bills/" + ca.session + "/" + ca.shard + ".json", ca: true, session: ca.session } : null;
  }
  function voteFile(id) {
    if (/^us-(house|senate)-/.test(id)) return { rel: "us/votes/" + id + ".json", members: "us/members.json", level: "federal" };
    var nv = stateVoteFile(id);
    if (nv) return nv;
    var ca = /^ca-(\d{8}\d[A-Z]+\d+)-/.exec(id);
    var bill = ca && parseCaBill(ca[1]);
    if (bill) return { rel: "us-ca/votes/" + bill.session + "/" + ca[1] + ".json", members: "us-ca/members.json", level: "state" };
    var co = /^([a-z]{2})-(\d{5})-bos-vote-(\d{4})(\d{2})\d{2}-/.exec(id);
    if (co) return { rel: "us-" + co[1] + "/counties/" + co[2] + "/votes-" + co[3] + "-" + co[4] + ".json", members: "us-" + co[1] + "/counties/" + co[2] + "/board.json", level: "county", fips: co[2], st: co[1] };
    return null;
  }
  function loadBill(id) {
    var f = billFile(id);
    if (!f) return Promise.resolve(null);
    if (f.national) return get(f.rel, true).then(function (d) { return d && d.bills[id] || null; });
    if (!f.ca) return get(f.rel, true);
    return get(f.rel, true).then(function (d) { return d && d.bills[id] || null; });
  }
  // One vote of another state's legislature, rebuilt from its month file: positions are a string
  // in the order of the file's member list.
  function stateVote(d, id, f) {
    if (!d) return null;
    var row = rows2objs(d).filter(function (v) { return v.id === id; })[0];
    if (!row) return null;
    var positions = [];
    (d.members || []).forEach(function (mid, i) { var c = (row.positions || "").charAt(i); if (c && c !== "-") positions.push([mid, c]); });
    return { id: id, level: "state", body: "us-" + f.st + "-" + f.chamber, date: row.date, question: row.question, title: row.title, bill_id: row.bill_id, bill_label: row.bill_label,
      result: row.result === "pass" ? "Passed" : row.result === "fail" ? "Failed" : row.result, passed: row.passed, floor: !!row.floor, recorded: positions.length > 0,
      tally: { yes: row.yes, no: row.no, not_voting: row.other, present: 0 }, positions: positions, names: d.names || {},
      labels: d.codes || { Y: "yes", N: "no", X: "absent or not voting", A: "abstain", O: "other" }, official_url: row.official_url,
      source: { id: "openstates-bulk" }, source_updated_at: d.source_updated_at, session: f.session };
  }
  function loadVote(id) {
    var f = voteFile(id);
    if (!f) return Promise.resolve(null);
    if (f.national) return get(f.rel, true).then(function (d) { return stateVote(d, id, f); });
    if (f.level === "federal") return get(f.rel, true);
    if (f.level === "state") return get(f.rel, true).then(function (d) { return d && d.votes.filter(function (v) { return v.id === id; })[0] || null; });
    return get(f.rel, true).then(function (d) {
      if (!d) return null;
      var row = rows2objs(d).filter(function (v) { return v.id === id; })[0];
      if (!row) return null;
      var m = row.matter_id ? d.matters[row.matter_id] : null;
      return { id: id, level: "county", body: f.st + "-" + f.fips + "-bos", county: f.fips, date: row.date, question: row.question, title: m ? (m.label ? m.label + ": " : "") + m.title : "", matter: m,
        result: row.result, passed: row.passed, tally: { yes: row.yes, no: row.no, not_voting: row.other, present: 0 },
        positions: d.members.map(function (mid, i) { return [mid, row.positions.charAt(i) || "-"]; }).filter(function (p) { return p[1] !== "-"; }),
        labels: d.codes, mover: row.mover, seconder: row.seconder, agenda_number: row.agenda_number, meeting_id: row.meeting_id,
        source_updated_at: row.source_updated_at, source: { id: "county-" + f.fips } };
    });
  }
  // The year and month of a California legislator's record to show (the latest, or the one asked for).
  function memberMonth(idx, body, params) {
    var shards = ((idx && idx.shards) || []).filter(function (s) { return s.body === body; });
    var years = []; shards.forEach(function (s) { var y = s.month.slice(0, 4); if (years.indexOf(y) < 0) years.push(y); });
    var year = params.get("year") && years.indexOf(params.get("year")) >= 0 ? params.get("year") : years[years.length - 1];
    var months = shards.filter(function (s) { return s.month.slice(0, 4) === year; }).map(function (s) { return s.month; });
    var month = params.get("month") && months.indexOf(params.get("month")) >= 0 ? params.get("month") : months[months.length - 1];
    return { years: years, year: year, months: months, month: month };
  }
  function membersFor(level, countyId) {
    if (level === "federal") return usMembers();
    var sm = /^us-([a-z]{2})-(upper|lower|legislature)$/.exec(countyId || "");
    if (level === "state" && sm && sm[1] !== "ca") return stateMembers(sm[1].toUpperCase());
    if (level === "state") return caMembers();
    return get(countyFolder(countyId) + "/board.json", true).then(function (b) { var by = {}; ((b && b.members) || []).forEach(function (m) { by[m.id] = m; }); return { list: (b && b.members) || [], by: by, board: b }; });
  }

  // ---------- other states' bills and votes (Open States bulk data) ----------
  // us-{st}/votes/index.json lists the sessions kept and, for each chamber, the months with votes.
  function stateVoteIndex(code) { return get("us-" + lc(code) + "/votes/index.json", true); }
  function stateLegName(s) { return (s && s.legislature && s.legislature.name) || ((s && s.name) || "State") + " Legislature"; }
  // A row of a month file in the shape the vote lists draw.
  function stateRow(v, body) {
    return { id: v.id, date: v.date, body: body || v.body, question: cap(v.question || "Vote"), title: v.title || "", bill_id: v.bill_id, bill_label: v.bill_label,
      result: v.result, passed: v.passed, yes: v.yes, no: v.no, other: v.other || 0, floor: !!v.floor, location: v.floor ? "Floor" : "Committee" };
  }
  // The chamber a legislator's votes are filed under. Unicameral bodies can be filed as
  // "legislature" or "upper", so both are tried.
  function bodyWithVotes(idx, m) {
    var st = (m.jurisdiction || "").slice(3);
    var alt = m.chamber === "legislature" ? "upper" : m.chamber === "upper" ? "legislature" : null;
    var bodies = [m.body || "us-" + st + "-" + m.chamber].concat(alt ? ["us-" + st + "-" + alt] : []);
    var shards = (idx && idx.shards) || [];
    return bodies.filter(function (b) { return shards.some(function (x) { return x.body === b; }); })[0] || null;
  }
  // Which session and month of a chamber's votes to show: those asked for, or the latest.
  function statePick(idx, body, params) {
    var shards = ((idx && idx.shards) || []).filter(function (x) { return x.body === body; });
    var sessions = ((idx && idx.sessions) || []).filter(function (s) { return shards.some(function (x) { return x.session === s.id; }); })
      .sort(function (a, b) { return (a.start || "").localeCompare(b.start || ""); });
    var ids = sessions.map(function (s) { return s.id; });
    var session = params.get("session") && ids.indexOf(params.get("session")) >= 0 ? params.get("session") : ids[ids.length - 1];
    var inSession = shards.filter(function (x) { return x.session === session; }).sort(function (a, b) { return a.month.localeCompare(b.month); });
    var months = inSession.map(function (x) { return x.month; });
    var month = params.get("month") && months.indexOf(params.get("month")) >= 0 ? params.get("month") : months[months.length - 1];
    return { sessions: sessions, session: session, shards: inSession, months: months, month: month,
      shard: inSession.filter(function (x) { return x.month === month; })[0] || null };
  }
  function sessionName(sessions, id) { var s = (sessions || []).filter(function (x) { return x.id === id; })[0]; return (s && s.name) || "session " + id; }
  // "Texas 89th Legislature", "Georgia General Assembly, 2025-2026 Regular Session"
  function sessionTitle(s, name) {
    return /legislature|assembly|council|congress/i.test(name || "") ? s.name + " " + name : stateLegName(s) + ", " + (name || "current session");
  }
  // The votes of a bill, read from the month files that hold them (one request per file).
  function stateVotes(ids) {
    var byFile = {};
    (ids || []).forEach(function (vid) { var f = stateVoteFile(vid); if (f) (byFile[f.rel] = byFile[f.rel] || []).push(vid); });
    return Promise.all(Object.keys(byFile).map(function (rel) {
      return get(rel, true).then(function (d) { return byFile[rel].map(function (vid) { return stateVote(d, vid, stateVoteFile(vid)); }); });
    })).then(function (lists) { return [].concat.apply([], lists).filter(Boolean); });
  }
  // Which chamber acted, when it was one chamber (not the legislature as a whole or the governor).
  function actionChamber(s, ch) {
    if (!s || !ch || ch === "legislature") return "";
    var c = chamberOf(s, ch);
    return c && s.legislature.chambers.length > 1 ? " (" + shortChamber(c.name) + ")" : "";
  }
  var OPEN_STATES_NOTE = "From Open States, which collects the legislature's records from its website. Not the official record.";

  // ---------- bill ----------
  // A bill of another state's legislature. Its record keeps the latest 25 actions and up to 12
  // sponsors, primary sponsors first.
  function viewStateBill(b, man) {
    var s = STATE_INFO[b.state] || null;
    var legName = stateLegName(s || { name: b.state });
    return stateVotes(b.vote_ids).then(function (votes) {
      votes.sort(function (a, c) { return (c.date || "").localeCompare(a.date || "") || c.id.localeCompare(a.id); });
      var sponsors = b.sponsors || [];
      var primary = sponsors.filter(function (x) { return x.primary; }), others = sponsors.filter(function (x) { return !x.primary; });
      if (!primary.length) { primary = others; others = []; }
      var extra = Math.max(0, (b.sponsors_total || sponsors.length) - sponsors.length);
      function names(list, last) {
        return [list.map(function (x, i) { var nm = x.name || "Unnamed sponsor"; return [i ? ", " : null, x.id ? link(memberHref(x.id), nm) : nm]; }), last && extra ? " and " + plural(extra, "other", "others") : null];
      }
      var facts = el("dl", { class: "facts" },
        el("div", null, el("dt", null, "Level"), el("dd", null, badge("state"), " " + sessionTitle(s || { name: b.state }, b.session_name || "session " + b.session))),
        b.classification && b.classification.length ? el("div", null, el("dt", null, "Kind"), el("dd", null, cap(b.classification.join(", ")))) : null,
        b.latest_action ? el("div", null, el("dt", null, "Latest action"), el("dd", null, b.latest_action.date ? [time(b.latest_action.date), " · "] : null, b.latest_action.text || "")) : null,
        b.introduced ? el("div", null, el("dt", null, "First action"), el("dd", null, time(b.introduced))) : null,
        primary.length ? el("div", null, el("dt", null, primary.length > 1 ? "Sponsors" : "Sponsor"), el("dd", null, names(primary, !others.length))) : null,
        others.length ? el("div", null, el("dt", null, "Cosponsors"), el("dd", null, names(others, true))) : null,
        b.subjects && b.subjects.length ? el("div", null, el("dt", null, b.subjects.length > 1 ? "Subjects" : "Subject"), el("dd", null, b.subjects.join(", "))) : null,
        el("div", null, el("dt", null, "Record"), el("dd", null, b.official_url ? ext(b.official_url, "The legislature's page for this bill") : el("span", { class: "unk" }, "not linked"),
          el("p", { class: "meta" }, OPEN_STATES_NOTE))));
      var vl = votes.length ? el("ul", { class: "plain votes" }, votes.map(function (v) {
        return voteItem({ id: v.id, date: v.date, body: v.body, question: cap(v.question || "Vote"), title: null, result: v.result, passed: v.passed, yes: v.tally.yes, no: v.tally.no, other: v.tally.not_voting || 0, location: v.floor ? "Floor" : "Committee", bill_id: null });
      })) : note("No recorded votes on this bill in the Open States data.");
      var acts = (b.actions || []).slice().reverse();      // newest first, as on the other bill pages
      var slug = CODE_SLUG[b.state] || "";
      var crumbs = slug ? [["All states", BASE], [(s && s.name) || b.state, href([slug])], ["Bills", href([slug, "bills"])], b.label] : [["All states", BASE], b.label];
      var body = frag(
        facts,
        section("Votes on this bill", vl, "votes"),
        acts.length ? section("Actions", frag(
          el("ul", { class: "plain acts" }, acts.map(function (a) { return el("li", null, time(a.date), el("span", null, " · " + a.text + actionChamber(s, a.chamber))); })),
          b.actions_total > acts.length ? (b.official_url ? el("p", { class: "links" }, ext(b.official_url, "All " + b.actions_total + " actions on the legislature's site")) : note("The latest " + acts.length + " of " + b.actions_total + " actions.")) : null), "actions") : null,
        freshness(man, "openstates-bulk", b.source_updated_at));
      return { title: b.label + (b.title ? ": " + b.title : ""), lede: null, crumbs: crumbs, body: body, docTitle: b.label + ", " + legName };
    });
  }

  function viewBill(id) {
    return Promise.all([loadBill(id), manifest(), countyIndex(), states()]).then(function (r) {
      var b = r[0], man = r[1];
      if (!b) return notFound();
      if (stateBillFile(id)) return viewStateBill(b, man);
      var lvl = b.level || (/^us-/.test(id) ? "federal" : "state");
      var isCa = lvl === "state";
      var votesP = isCa ? get("us-ca/votes/" + b.session + "/" + id + ".json", true).then(function (d) { return (d && d.votes) || []; })
        : Promise.all((b.vote_ids || []).map(function (vid) { return get("us/votes/" + vid + ".json", true); })).then(function (vs) { return vs.filter(Boolean); });
      return votesP.then(function (votes) {
        votes.sort(function (a, c) { return (c.date || "").localeCompare(a.date || ""); });
        var facts = el("dl", { class: "facts" },
          el("div", null, el("dt", null, "Level"), el("dd", null, badge(lvl), isCa ? " California Legislature, " + sessionLabel(b.session) + " session" : " " + ordinal(b.congress) + " Congress")),
          b.status ? el("div", null, el("dt", null, "Status"), el("dd", null, b.status, b.location ? " · " + b.location : "")) : null,
          b.chapter ? el("div", null, el("dt", null, "Enacted"), el("dd", null, b.chapter)) : null,
          b.latest_action ? el("div", null, el("dt", null, "Latest action"), el("dd", null, b.latest_action.date ? [time(b.latest_action.date), " · "] : null, b.latest_action.text || "")) : null,
          b.introduced ? el("div", null, el("dt", null, "Introduced"), el("dd", null, time(b.introduced))) : null,
          b.sponsors && b.sponsors.length ? el("div", null, el("dt", null, isCa ? (b.sponsors.length > 1 ? "Authors" : "Author") : (b.sponsors.length > 1 ? "Sponsors" : "Sponsor")), el("dd", null, b.sponsors.map(function (s, i) { return [i ? ", " : null, s.id ? link(memberHref(s.id), s.name.replace(/^(Sen|Rep|Del|Res\. Comm)\.\s+/, "").replace(/\s*\[[^\]]*\]$/, "").replace(/^([^,]+),\s*(.+)$/, "$2 $1")) : s.name, s.house ? " (" + (s.house === "ASSEMBLY" ? "Assembly" : s.house === "SENATE" ? "Senate" : s.house) + ")" : (s.party || s.state ? " (" + [s.party, s.state].filter(Boolean).join("-") + ")" : "")]; }))) : null,
          b.cosponsors ? el("div", null, el("dt", null, "Cosponsors"), el("dd", null, String(b.cosponsors) + (b.cosponsors_original ? " (" + b.cosponsors_original + " original)" : ""))) : null,
          b.committees && b.committees.length ? el("div", null, el("dt", null, b.committees.length > 1 ? "Committees" : "Committee"), el("dd", null, b.committees.join(", "))) : null,
          b.policy_area ? el("div", null, el("dt", null, "Policy area"), el("dd", null, b.policy_area)) : null,
          b.laws && b.laws.length ? el("div", null, el("dt", null, "Became law"), el("dd", null, b.laws.join(", "))) : null,
          b.urgency ? el("div", null, el("dt", null, "Urgency"), el("dd", null, "Yes")) : null,
          b.vote_required ? el("div", null, el("dt", null, "Vote required"), el("dd", null, b.vote_required)) : null,
          el("div", null, el("dt", null, "Official record"), el("dd", null, ext(b.official_url, isCa ? "LegInfo" : "Congress.gov"), b.votes_url ? [" · ", ext(b.votes_url, "Vote history")] : null)));
        var vl = votes.length ? el("ul", { class: "plain votes" }, votes.map(function (v) {
          return voteItem({ id: v.id, date: v.date, body: v.body, question: v.question, title: null, result: v.result, passed: v.passed, yes: v.tally.yes, no: v.tally.no, other: (v.tally.present || 0) + (v.tally.not_voting || 0), location: v.location, bill_id: null });
        })) : note(isCa ? "No floor or committee votes recorded on this bill yet." : "No roll-call votes recorded on this bill in this Congress.");
        var crumbs = isCa ? [["All states", BASE], ["California", href(["california"])], ["Bills", href(["california", "bills"])], b.label]
          : [["All states", BASE], ["Federal bills", href(["bills"], { level: "federal" })], b.label];
        var body = frag(
          b.summary ? el("p", { class: "lede2" }, b.summary, b.summary_version ? el("span", { class: "unk" }, " (Congressional Research Service summary: " + b.summary_version + ")") : null) : null,
          facts,
          section("Votes on this bill", vl, "votes"),
          b.actions && b.actions.length ? section("Actions", frag(
            el("ul", { class: "plain acts" }, b.actions.map(function (a) { return el("li", null, time(a.date), el("span", null, " · " + a.text)); })),
            b.actions_total > b.actions.length ? el("p", { class: "links" }, ext(b.official_url, "All " + b.actions_total + " actions on Congress.gov")) : null), "actions") : null,
          freshness(man, b.source && b.source.id === "vote-records" ? (b.chamber_of_origin === "us-senate" ? "us-senate-lis" : "us-house-clerk") : (b.source && b.source.id), b.source_updated_at));
        return { title: b.label + (b.title ? ": " + b.title : ""), lede: null, crumbs: crumbs, body: body, docTitle: b.label };
      });
    });
  }

  // ---------- vote ----------
  function viewVote(id, params) {
    return Promise.all([loadVote(id), manifest(), countyIndex(), states()]).then(function (r) {
      var v = r[0], man = r[1], cidx = r[2];
      if (!v) return notFound();
      var lvl = v.level || levelOf(v.body);
      // ?state=TX (from a state's vote list): a federal roll call shows that state's members first.
      var want = String((params && params.get("state")) || "").toUpperCase();
      want = lvl === "federal" && CODE_SLUG[want] && STATE_INFO[want] ? want : "";
      return membersFor(lvl, v.body).then(function (mem) {
        var positions = v.positions || [];
        var labels = v.labels || {};
        var codeName = function (c) { return cap(labels[c] || ({ Y: "Yes", N: "No", X: "Not voting", P: "Present", A: "Abstain", R: "Recused", O: "Other" })[c] || c); };
        var counts = {};
        positions.forEach(function (p) { counts[p[1]] = (counts[p[1]] || 0) + 1; });
        var codes = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
        var state = { code: "", text: "", st: want };
        var tbody = el("tbody");
        var summary = el("p", { class: "count" });
        function partyOf(m) { return m && m.party ? m.party : ""; }
        var stateList = [];
        positions.forEach(function (p) { var m = mem.by[p[0]]; if (m && m.state && stateList.indexOf(m.state) < 0) stateList.push(m.state); });
        stateList.sort(function (a, b) { return ((STATE_INFO[a] || {}).name || a).localeCompare((STATE_INFO[b] || {}).name || b); });
        function draw() {
          tbody.replaceChildren();
          var t = state.text.toLowerCase();
          var shown = 0;
          positions.forEach(function (p) {
            var m = mem.by[p[0]];
            var name = m ? m.name : (/^lis-/.test(p[0]) ? "Senator (LIS " + p[0].slice(4) + ")" : (v.names && v.names[p[0]]) || (/^[a-z]{2}-[0-9a-f]{8}$/.test(p[0]) ? "A former member (" + p[0] + ")" : p[0]));
            if (state.code && p[1] !== state.code) return;
            if (state.st && (!m || m.state !== state.st)) return;
            if (t && (name + " " + memberLabel(m)).toLowerCase().indexOf(t) < 0) return;
            shown++;
            tbody.appendChild(el("tr", null,
              el("th", { scope: "row" }, m ? link(memberHref(m.id), name) : name),
              el("td", null, party(partyOf(m))),
              el("td", null, m ? (m.body === "us-house" ? m.state + (m.district ? "-" + m.district : "") : m.body === "us-senate" ? m.state : /^us-[a-z]{2}-/.test(m.body || "") ? districtWords(m) : m.district ? (m.body === "ca-assembly" ? "AD " : "SD ") + m.district : (m.title || "")) : ""),
              el("td", null, el("span", { class: "pos pos-" + p[1] }, codeName(p[1])))));
          });
          summary.textContent = shown + " of " + positions.length + " positions shown" + (state.st && STATE_INFO[state.st] ? ": " + STATE_INFO[state.st].name + "'s members" : "");
        }
        var filters = el("form", { class: "filters", on: { submit: function (e) { e.preventDefault(); } } },
          el("fieldset", null, el("legend", null, "Show"),
            el("div", { class: "row wrap" },
              el("button", { type: "button", class: "btn", "aria-pressed": "true", on: { click: function (e) { setCode("", e.currentTarget); } } }, "All (" + positions.length + ")"),
              codes.map(function (c) { return el("button", { type: "button", class: "btn", "aria-pressed": "false", dataset: { code: c }, on: { click: function (e) { setCode(c, e.currentTarget); } } }, codeName(c) + " (" + counts[c] + ")"); }))),
          lvl === "federal" ? el("div", { class: "field" }, el("label", { for: "pos-state" }, "State"),
            el("select", { id: "pos-state", on: { change: function (e) { state.st = e.target.value; draw(); } } }, el("option", { value: "" }, "All states"),
              stateList.map(function (c) { return el("option", { value: c, selected: c === want }, STATE_INFO[c] ? STATE_INFO[c].name : c); }))) : null,
          el("label", { for: "pos-q" }, "Filter by name, party or district"),
          el("input", { id: "pos-q", type: "search", autocomplete: "off", on: { input: function (e) { state.text = e.target.value.trim(); draw(); } } }));
        function setCode(c, btn) {
          state.code = c;
          filters.querySelectorAll("button[aria-pressed]").forEach(function (b) { b.setAttribute("aria-pressed", b === btn ? "true" : "false"); });
          draw();
        }
        draw();
        var national = v.source && v.source.id === "openstates-bulk";
        var bill = v.bill_id && (/^(us-|\d{8})/.test(v.bill_id) || stateBillFile(v.bill_id)) ? link(billHref(v.bill_id), v.bill_label || v.bill_id) : (v.matter && v.matter.official_url ? ext(v.matter.official_url, v.matter.label || "Agenda item") : null);
        var facts = el("dl", { class: "facts" },
          el("div", null, el("dt", null, "Level"), el("dd", null, badge(lvl), " " + bodyName(v.body, cidx), v.location && !v.floor ? " · " + v.location : "")),
          el("div", null, el("dt", null, "When"), el("dd", null, time(v.date, !isDateOnly(v.date)), isDateOnly(v.date) ? clockPart(v) : "", isDateOnly(v.date) && lvl === "state" ? el("span", { class: "unk" }, " (the record gives the day, not the time)") : null)),
          el("div", null, el("dt", null, "Result"), el("dd", null, el("b", { class: v.passed ? "pass" : "fail" }, resultWord(v)), v.result && v.result !== resultWord(v) ? " · " + v.result : "", v.vote_type ? " · " + v.vote_type : "")),
          el("div", null, el("dt", null, "Tally"), el("dd", null, tally(v))),
          bill ? el("div", null, el("dt", null, lvl === "county" ? "Agenda item" : "Bill"), el("dd", null, bill, lvl !== "county" && stripLabel(v.title, v.bill_label) ? ": " + stripLabel(v.title, v.bill_label) : lvl === "county" && v.matter && v.matter.title ? ": " + v.matter.title : "")) : (v.title ? el("div", null, el("dt", null, "Subject"), el("dd", null, v.title)) : null),
          v.number ? el("div", null, el("dt", null, "Roll call"), el("dd", null, "No. " + v.number + ", session " + v.session + " of the " + ordinal(v.congress) + " Congress")) : null,
          v.mover ? el("div", null, el("dt", null, "Motion"), el("dd", null, "Moved by " + v.mover + (v.seconder ? ", seconded by " + v.seconder : ""))) : null,
          national ? el("div", null, el("dt", null, "Kind"), el("dd", null, v.floor ? "Floor vote" : "Committee vote")) : null,
          el("div", null, el("dt", null, national ? "Record" : "Official record"), el("dd", null, v.official_url ? ext(v.official_url, lvl === "federal" ? (v.body === "us-house" ? "Clerk of the House" : "Senate.gov") : national ? "The legislature's record of this vote" : lvl === "state" ? "LegInfo vote history" : "County minutes", national ? " (the legislature's site)" : null) : (mem.board && mem.board.urls && mem.board.urls.agenda_url ? ext(mem.board.urls.agenda_url, "County agendas and minutes") : el("span", { class: "unk" }, "not linked")),
            national ? el("p", { class: "meta" }, "From Open States, which collects votes from the legislature's website. Not the official record.") : null)));
        var parties = {};
        positions.forEach(function (p2) { var m2 = mem.by[p2[0]]; var pa = (m2 && m2.party) || "?"; parties[pa] = parties[pa] || {}; parties[pa][p2[1]] = (parties[pa][p2[1]] || 0) + 1; });
        var partyKeys = Object.keys(parties).sort(function (a, b) { return a === "?" ? 1 : b === "?" ? -1 : a.localeCompare(b); });
        var byParty = lvl !== "county" && partyKeys.length > 1 ? el("table", { class: "tbl byparty" }, el("caption", null, "By party"),
          el("thead", null, el("tr", null, el("th", { scope: "col" }, "Party"), codes.map(function (c) { return el("th", { scope: "col" }, codeName(c)); }))),
          el("tbody", null, partyKeys.map(function (pk) { return el("tr", null, el("th", { scope: "row" }, pk === "?" ? "Unknown" : party(pk)), codes.map(function (c) { return el("td", null, String(parties[pk][c] || 0)); })); }))) : null;
        var table = el("table", { class: "tbl positions" }, el("caption", null, "How each member voted"),
          el("thead", null, el("tr", null, el("th", { scope: "col" }, "Member"), el("th", { scope: "col" }, "Party"), el("th", { scope: "col" }, lvl === "county" ? "Seat" : "State / district"), el("th", { scope: "col" }, "Position"))), tbody);
        // Where the vote sits: the state (and county) it belongs to, or the national list.
        var last = lvl === "federal" ? "Roll call " + v.number : v.bill_label || (v.matter && v.matter.label) || "Vote";
        var crumbs = [["All states", BASE]];
        if (lvl === "federal") crumbs.push(want ? [STATE_INFO[want].name, href([CODE_SLUG[want]])] : ["Federal votes", href(["votes"], { level: "federal", body: v.body })]);
        else if (lvl === "state") {
          var sc2 = /^ca-/.test(v.body) ? "CA" : String(v.body || "").slice(3, 5).toUpperCase();
          if (CODE_SLUG[sc2] && STATE_INFO[sc2]) crumbs.push([STATE_INFO[sc2].name, href([CODE_SLUG[sc2]], { level: "state" })]);
        } else {
          var ce = cidx[v.county] || {};
          var cs2 = ce.state || String(v.body || "").slice(0, 2).toUpperCase();
          if (CODE_SLUG[cs2] && STATE_INFO[cs2]) crumbs.push([STATE_INFO[cs2].name, href([CODE_SLUG[cs2]])]);
          if (ce.slug && CODE_SLUG[cs2]) crumbs.push([ce.county, href([CODE_SLUG[cs2], ce.slug], { level: "county" })]);
        }
        crumbs.push(last);
        var body = frag(
          facts,
          v.source && v.source.id === "voteview" ? el("p", { class: "note" }, "These positions come from Voteview (UCLA), an academic roll-call database built from the same official records, because the nightly job could not reach senate.gov. The official record is linked above; the next successful check replaces this copy with the Senate's own.") : null,
          section("Positions", positions.length ? frag(byParty, filters, summary, table) : note("No individual positions were recorded for this vote (a voice vote or an unrecorded action)."), "positions"),
          freshness(man, v.source && v.source.id, v.source_updated_at, v.retrieved_at));
        var q = cap(v.question || "Vote");
        return { title: q + (v.bill_label && q.indexOf(v.bill_label) < 0 ? " · " + v.bill_label : lvl === "county" && v.matter && v.matter.label ? " · " + v.matter.label : ""), lede: null, crumbs: crumbs, body: body };
      });
    });
  }

  // ---------- legislator ----------
  function memberFacts(m, lvl, man, cidx) {
    var urls = m.urls || {};
    return el("dl", { class: "facts" },
      el("div", null, el("dt", null, "Level"), el("dd", null, badge(lvl), " " + bodyName(m.body, cidx))),
      el("div", null, el("dt", null, lvl === "county" ? "Seat" : "Represents"), el("dd", null, m.body === "us-house" ? (m.state + (m.district ? ", district " + m.district : m.delegate ? " (delegate)" : " at large")) : m.body === "us-senate" ? m.state : m.body === "ca-assembly" ? "Assembly District " + m.district : m.body === "ca-senate" ? "Senate District " + m.district : (m.title || "Supervisor") + (m.county ? ", " + m.county : ""), m.active === false ? el("span", { class: "unk" }, " · no longer serving") : null)),
      m.party ? el("div", null, el("dt", null, "Party"), el("dd", null, party(m.party))) : null,
      m.term_start || m.term_end ? el("div", null, el("dt", null, m.former ? "Last term" : "Term"), el("dd", null, m.term_start ? time(m.term_start) : "", m.term_end ? [" to ", time(m.term_end)] : "", m.former ? " (left office early)" : "")) : null,
      m.phone ? el("div", null, el("dt", null, "Office phone"), el("dd", null, telLink(m.phone))) : null,
      el("div", null, el("dt", null, "Official pages"), el("dd", null, [["official", "Official website"], ["contact", "Contact form"], ["congress_gov", "Congress.gov"], ["bioguide", "Biographical Directory"]].filter(function (k) { return urls[k[0]]; }).map(function (k, i) { return [i ? " · " : null, ext(urls[k[0]], k[1])]; }), !Object.keys(urls).length ? el("span", { class: "unk" }, "none published") : null)),
      freshness(man, lvl === "federal" ? "congress-legislators" : lvl === "state" ? "ca-leginfo-pubinfo" : "county-" + (idOfCounty(m.body) || ""), m.source_updated_at) ? el("div", null, el("dt", null, "Record"), el("dd", null, freshness(man, lvl === "federal" ? "congress-legislators" : lvl === "state" ? "ca-leginfo-pubinfo" : "county-" + (idOfCounty(m.body) || ""), m.source_updated_at))) : null);
  }
  function recordFilters(state, redraw, opts) {
    var posBtns = ["", "Y", "N", "X"].map(function (c) {
      return el("button", { type: "button", class: "btn", "aria-pressed": state.code === c ? "true" : "false", on: { click: function (e) { state.code = c; e.currentTarget.parentNode.querySelectorAll("button").forEach(function (b) { b.setAttribute("aria-pressed", b === e.currentTarget ? "true" : "false"); }); redraw(); } } },
        c === "" ? "All" : c === "Y" ? "Voted yes" : c === "N" ? "Voted no" : "Did not vote");
    });
    return el("form", { class: "filters", on: { submit: function (e) { e.preventDefault(); } } },
      el("fieldset", null, el("legend", null, "Position"), el("div", { class: "row wrap" }, posBtns)),
      opts && opts.floor ? el("label", { class: "check" }, el("input", { type: "checkbox", checked: state.floor, on: { change: function (e) { state.floor = e.target.checked; redraw(); } } }), " Floor votes only") : null,
      el("label", { for: "rec-q" }, "Filter by question or bill"),
      el("input", { id: "rec-q", type: "search", autocomplete: "off", on: { input: function (e) { state.text = e.target.value.trim().toLowerCase(); redraw(); } } }));
  }
  var POSITION_WORD = { Y: "Yes", N: "No", X: "Did not vote", P: "Present", A: "Abstained", O: "Other" };
  function recordList(entries, state, cidx, locations) {
    // entries: [{v: index row object, code}], newest first
    var list = entries.filter(function (e) {
      if (state.code && e.code !== state.code) return false;
      if (state.floor && !e.v.floor) return false;
      if (state.text && ((e.v.question || "") + " " + (e.v.title || "") + " " + (e.v.bill_label || "")).toLowerCase().indexOf(state.text) < 0) return false;
      return true;
    });
    return more(list, function (e) {
      var li = voteItem(e.v, cidx, locations);
      li.insertBefore(el("p", { class: "mypos" }, "Position: ", el("span", { class: "pos pos-" + e.code }, POSITION_WORD[e.code] || e.code)), li.querySelector(".res"));
      return li;
    }, { ulClass: "votes", empty: "No votes match these filters." });
  }
  function summaryLine(counts, total) {
    return el("p", { class: "sum" }, el("b", null, String(total)), " votes recorded: ", el("span", { class: "pos pos-Y" }, counts.Y || 0), " yes, ", el("span", { class: "pos pos-N" }, counts.N || 0), " no, ", el("span", { class: "pos pos-X" }, (counts.X || 0) + (counts.P || 0) + (counts.A || 0) + (counts.O || 0)), " other or not voting.");
  }

  function viewMember(id, params) {
    var stCode = stateMemberCode(id);
    if (stCode) return viewStateMember(id, stCode, params);
    var lvl = /^ca-(asm|sen)-/.test(id) ? "state" : /^[a-z]{2}-\d{5}-bos-/.test(id) ? "county" : "federal";
    return Promise.all([manifest(), countyIndex(), membersFor(lvl, id), states()]).then(function (r) {
      var man = r[0], cidx = r[1], mem = r[2];
      var m = mem.by[id];
      if (!m) return notFound();
      var state = { code: "", text: "", floor: false };
      var facts = memberFacts(m, lvl, man, cidx);
      // All states / the member's state (its representatives) / [the county] / the member
      var crumbs = [["All states", BASE]];
      var ce = lvl === "county" ? cidx[idOfCounty(id)] || {} : null;
      var code = lvl === "federal" ? m.state : lvl === "state" ? "CA" : (ce.state || String(id).slice(0, 2).toUpperCase());
      var slug = CODE_SLUG[code];
      if (slug && STATE_INFO[code]) crumbs.push([STATE_INFO[code].name, href(lvl === "county" ? [slug] : [slug, "representatives"])]);
      if (ce && ce.slug && slug) crumbs.push([ce.county, href([slug, ce.slug, "representatives"])]);
      crumbs.push(m.name);

      if (lvl === "federal") {
        var house = m.body === "us-house" ? "house" : "senate";
        return Promise.all([get("us/records/" + house + "-" + mem.congress + ".json", true), get("us/votes/" + mem.congress + "-1-" + house + ".json", true), get("us/votes/" + mem.congress + "-2-" + house + ".json", true)]).then(function (d) {
          var rec = d[0]; var rows = rows2objs(d[1]).concat(rows2objs(d[2])); var byId = {}; rows.forEach(function (v) { byId[v.id] = v; });
          var codes = (rec && rec.members[id]) || "";
          var entries = [], counts = {};
          (rec ? rec.votes : []).forEach(function (vid, i) { var c = codes.charAt(i); if (c && c !== "-" && byId[vid]) { entries.push({ v: byId[vid], code: c }); counts[c] = (counts[c] || 0) + 1; } });
          entries.sort(function (a, b) { return (b.v.date || "").localeCompare(a.v.date || ""); });
          var box = el("div");
          function redraw() { box.replaceChildren(); box.appendChild(recordList(entries, state, cidx)); }
          redraw();
          var rsec = section("Voting record · " + ordinal(mem.congress) + " Congress", frag(summaryLine(counts, entries.length), recordFilters(state, redraw), box), "record");
          rsec.id = "record";
          return { title: m.name, lede: null, crumbs: crumbs, body: frag(facts, rsec) };
        });
      }
      if (lvl === "state") {
        var h = m.body === "ca-assembly" ? "assembly" : "senate";
        return caVoteIndex().then(function (idx) {
          var pick = memberMonth(idx, m.body, params);
          var years = pick.years, year = pick.year, months = pick.months, month = pick.month;
          if (!year) return { title: m.name, lede: null, crumbs: crumbs, body: frag(facts, note("No votes published for this house yet.")) };
          return Promise.all([get("us-ca/records/" + h + "-" + mem.session + "-" + year + ".json", true), get("us-ca/votes/" + mem.session + "-" + h + "-" + month + ".json", true)]).then(function (d) {
            var rec = d[0], shard = d[1];
            var codes = (rec && rec.members[id]) || "";
            var counts = {}, floorCounts = {}, total = 0, floorTotal = 0;
            var byId = {}; rows2objs(shard).forEach(function (v) { v.body = m.body; byId[v.id] = v; });
            var entries = [];
            (rec ? rec.votes : []).forEach(function (vid, i) {
              var c = codes.charAt(i); if (!c || c === "-") return;
              total++; counts[c] = (counts[c] || 0) + 1;
              if (rec.floor[i]) { floorTotal++; floorCounts[c] = (floorCounts[c] || 0) + 1; }
              if (byId[vid]) entries.push({ v: byId[vid], code: c });
            });
            entries.sort(function (a, b) { return (b.v.date || "").localeCompare(a.v.date || "") || b.v.id.localeCompare(a.v.id); });
            var ysel = el("select", { id: "year-pick", name: "year" }, years.map(function (y) { return el("option", { value: y, selected: y === year }, y); }));
            var msel = el("select", { id: "month-pick", name: "month" }, months.map(function (mo) { return el("option", { value: mo, selected: mo === month }, fmtMonth(mo)); }));
            var pick = el("form", { class: "filters", on: { submit: function (e) { e.preventDefault(); navigate(href(["legislator", id], { year: ysel.value, month: ysel.value === year ? msel.value : "" }) + "#record", { keepScroll: true }); } } },
              el("div", { class: "row wrap" }, el("label", { for: "year-pick" }, "Year"), ysel, el("label", { for: "month-pick" }, "Month"), msel, el("button", { type: "submit", class: "btn" }, "Show")));
            var box = el("div");
            function redraw() { box.replaceChildren(); box.appendChild(recordList(entries, state, cidx, shard && shard.locations)); }
            redraw();
            var sec = section("Voting record", frag(
              el("p", { class: "sum" }, el("b", null, String(total)), " votes recorded in " + year + " (", el("b", null, String(floorTotal)), " on the floor, the rest in committee): ", el("span", { class: "pos pos-Y" }, counts.Y || 0), " yes, ", el("span", { class: "pos pos-N" }, counts.N || 0), " no, ", el("span", { class: "pos pos-X" }, counts.X || 0), " no vote recorded."),
              pick,
              el("h3", null, fmtMonth(month) + " · " + entries.length + " votes"),
              recordFilters(state, redraw, { floor: true }), box), "record");
            sec.id = "record";
            return { title: m.name, lede: null, crumbs: crumbs, body: frag(facts, sec) };
          });
        });
      }
      // county supervisor
      var board = mem.board || {};
      var months = (board.vote_months || []).map(function (x) { return x.month; });
      var month = params.get("month") && months.indexOf(params.get("month")) >= 0 ? params.get("month") : months[months.length - 1];
      if (!month) return { title: m.name, lede: null, crumbs: crumbs, body: frag(facts, note("No recorded votes for this board in the last 90 days.")) };
      return get(countyFolder(id) + "/votes-" + month + ".json", true).then(function (vf) {
        var i = vf ? vf.members.indexOf(id) : -1;
        var counts = {};
        var entries = rows2objs(vf).map(function (v) {
          var c = i >= 0 ? v.positions.charAt(i) : "-";
          if (!c || c === "-") return null;
          counts[c] = (counts[c] || 0) + 1;
          var mt = v.matter_id ? vf.matters[v.matter_id] : null;
          return { code: c, v: { id: v.id, date: v.date, body: m.body, question: (v.question ? v.question.charAt(0).toUpperCase() + v.question.slice(1) : "Vote") + (mt && mt.label ? " · " + mt.label : ""), title: mt ? mt.title : "", result: v.result, passed: v.passed, yes: v.yes, no: v.no, other: v.other, bill_id: null } };
        }).filter(Boolean);
        var msel = el("select", { id: "month-pick", name: "month" }, months.slice().reverse().map(function (mo) { return el("option", { value: mo, selected: mo === month }, fmtMonth(mo)); }));
        var pick = el("form", { class: "filters", on: { submit: function (e) { e.preventDefault(); navigate(href(["legislator", id], { month: msel.value }) + "#record", { keepScroll: true }); } } },
          el("div", { class: "row wrap" }, el("label", { for: "month-pick" }, "Month"), msel, el("button", { type: "submit", class: "btn" }, "Show")));
        var box = el("div");
        function redraw() { box.replaceChildren(); box.appendChild(recordList(entries, state, cidx)); }
        redraw();
        var sec = section("Voting record · " + fmtMonth(month), frag(summaryLine(counts, entries.length), pick, recordFilters(state, redraw), box), "record");
        sec.id = "record";
        return { title: m.name, lede: null, crumbs: crumbs, body: frag(facts, sec) };
      });
    });
  }

  // ---------- the national lists: every federal roll call and bill ----------
  // Filter forms change nothing until they are applied (WCAG 3.2.2): a select only records the
  // choice, and the Apply button loads the new list and moves focus to its heading. A state's own
  // votes and bills are on the state's page (the old state and county lists redirect there).
  function selectEl(id, label, options, value) {
    var s = el("select", { id: id, name: id }, options.map(function (o) { return el("option", { value: o[0], selected: o[0] === value }, o[1]); }));
    return el("div", { class: "field" }, el("label", { for: id }, label), s);
  }
  function viewVotes(p) {
    return Promise.all([countyIndex(), usMembers(), states()]).then(function (r) {
      var cidx = r[0], congress = r[1].congress;
      var body = p.get("body") === "us-senate" ? "us-senate" : "us-house";
      var sess = /^[12]$/.test(p.get("session") || "") ? p.get("session") : "";
      var text = (p.get("q") || "").toLowerCase(), result = levelParam(p.get("result"), ["passed", "failed"]);
      var form = el("form", { class: "filters", "aria-label": "Filter federal votes", on: { submit: function (e) {
        e.preventDefault();
        var fd = new FormData(form);
        navigate(href(["votes"], { level: "federal", body: fd.get("body"), result: fd.get("result"), session: fd.get("session"), q: String(fd.get("q") || "").trim() }), { focusSel: "#results", keepScroll: true });
      } } });
      var files = (sess ? [sess] : ["1", "2"]).map(function (x) { return get("us/votes/" + congress + "-" + x + "-" + (body === "us-house" ? "house" : "senate") + ".json", true); });
      return Promise.all(files).then(function (ds) {
        var rows = ds.reduce(function (a, d) { return a.concat(rows2objs(d)); }, []);
        var filtered = rows.filter(function (v) {
          if (result === "passed" && !v.passed) return false;
          if (result === "failed" && v.passed !== false) return false;
          if (text && ((v.question || "") + " " + (v.title || "") + " " + (v.bill_label || "") + " " + (v.bill_id || "")).toLowerCase().indexOf(text) < 0) return false;
          return true;
        }).sort(function (a, b) { return (b.date || "").localeCompare(a.date || "") || b.id.localeCompare(a.id); });
        append(form, el("div", { class: "row wrap" },
            selectEl("body", "Chamber", [["us-house", "U.S. House"], ["us-senate", "U.S. Senate"]], body),
            selectEl("session", "Session", [["", "Both sessions"], ["1", "First session (" + congressYear(congress, 1) + ")"], ["2", "Second session (" + congressYear(congress, 2) + ")"]], sess),
            selectEl("result", "Result", [["", "Any result"], ["passed", "Passed"], ["failed", "Failed"]], result)),
          el("div", { class: "row" }, el("div", { class: "field grow" }, el("label", { for: "votes-q" }, "Filter by question, bill or subject"), el("input", { id: "votes-q", name: "q", type: "search", value: p.get("q") || "", autocomplete: "off" })), el("button", { type: "submit", class: "btn" }, "Apply")),
          el("p", { class: "hint" }, "Choose the filters, then press Apply. Each state's page lists these roll calls together with its legislature's and county boards' votes."));
        // The same rows as a state's votes: a plain title first, then the number, chamber and tally.
        var nat = { s: { delegate_only: true }, cidx: cidx };
        var list = more(filtered.map(fedRow), function (v) { return feedItem(v, nat); }, { ulClass: "vlist", empty: "No votes match these filters.", what: "votes" });
        return { title: "Federal votes", crumbs: [["All states", BASE], "Federal votes"], lede: "Every roll call of the " + ordinal(congress) + " Congress, with each member's position. Newest first.",
          body: frag(form, el("h2", { class: "results", id: "results", tabindex: "-1" }, plural(filtered.length, "roll call", "roll calls") + " of the " + BODY_NAME[body] + (sess ? ", " + congressYear(congress, +sess) : "")), list) };
      });
    });
  }
  function viewBills(p) {
    var text = (p.get("q") || "").toLowerCase();
    return usMembers().then(function (us) {
      return get("us/bills/" + us.congress + "/index.json", true).then(function (d) {
        var rows = rows2objs(d).map(function (b) { return { id: b.id, label: b.label, title: b.title, date: b.latest_action_date, action: b.latest_action, votes: b.votes }; });
        var filtered = rows.filter(function (b) { return !text || ((b.label || "") + " " + (b.title || "") + " " + (b.id || "")).toLowerCase().indexOf(text) >= 0; })
          .sort(function (a, b) { return (b.date || "").localeCompare(a.date || "") || a.label.localeCompare(b.label, undefined, { numeric: true }); });
        var form = el("form", { class: "filters", "aria-label": "Filter federal bills", on: { submit: function (e) {
          e.preventDefault();
          navigate(href(["bills"], { level: "federal", q: String(new FormData(form).get("q") || "").trim() }), { focusSel: "#results", keepScroll: true });
        } } }, el("div", { class: "row" }, el("div", { class: "field grow" }, el("label", { for: "bills-q" }, "Filter by number or title"), el("input", { id: "bills-q", name: "q", type: "search", value: p.get("q") || "", autocomplete: "off" })), el("button", { type: "submit", class: "btn" }, "Apply")));
        var list = more(filtered, function (b) {
          return el("li", { class: "bill" },
            el("div", { class: "vote-head" }, badge("federal"), b.date ? el("span", { class: "when" }, "latest action ", time(b.date)) : null),
            el("h3", null, link(billHref(b.id), b.label), b.title ? ": " + b.title : ""),
            el("p", { class: "vt" }, b.action || "", " · " + plural(b.votes || 0, "recorded vote", "recorded votes")));
        }, { ulClass: "bills", empty: "No bills match this filter.", what: "bills" });
        return { title: "Federal bills", crumbs: [["All states", BASE], "Federal bills"], lede: "Bills with at least one roll-call vote in the " + ordinal(us.congress) + " Congress. Bills without a recorded vote are on Congress.gov. Each state's page lists its legislature's bills.",
          body: frag(form, el("h2", { class: "results", id: "results", tabindex: "-1" }, plural(filtered.length, "bill", "bills")), list) };
      });
    });
  }

  // ---------- upcoming (every level, everywhere) ----------
  function viewUpcoming(p) {
    var level = levelParam(p.get("level"), ["federal", "state", "county"]);
    return Promise.all([get("us/upcoming.json", true), get("us-ca/upcoming.json", true), get("us-ca/counties/upcoming.json", true), countyIndex(), manifest(), get("counties/upcoming.json", true)]).then(function (r) {
      var cidx = r[3], man = r[4];
      var today = todayISO();
      var items = ((r[0] && r[0].items) || []).concat((r[1] && r[1].items) || [], ((r[2] && r[2].items) || []).concat((r[5] && r[5].items) || []).map(function (m) { return Object.assign({ level: "county" }, m); }))
        .filter(function (u) { return ahead(u, today) && (!level || (u.level || levelOf(u.body)) === level); })
        .sort(function (a, b) { return whenKey(a).localeCompare(whenKey(b)) || (a.title || "").localeCompare(b.title || ""); });
      var form = el("form", { class: "filters", "aria-label": "Filter the schedule", on: { submit: function (e) {
        e.preventDefault();
        navigate(href(["upcoming"], { level: new FormData(form).get("level") }), { focusSel: "#results", keepScroll: true });
      } } }, el("div", { class: "row wrap" }, selectEl("level", "Level", [["", "All levels"], ["federal", "Federal"], ["state", "State"], ["county", "County"]], level), el("button", { type: "submit", class: "btn" }, "Apply")));
      var days = [];
      items.forEach(function (u) { var d = days[days.length - 1]; if (!d || d.date !== u.date) { d = { date: u.date, items: [] }; days.push(d); } d.items.push(u); });
      var sc = { cidx: cidx };
      var body = frag(
        form,
        el("h2", { class: "results", id: "results", tabindex: "-1" }, plural(items.length, "item", "items") + " scheduled" + (level ? " at the " + level + " level" : "") + ", soonest first"),
        el("p", { class: "on-record" }, "What the official feeds list as scheduled: the House floor for the week, Senate hearings and floor items, California's Daily File and committee hearings within 45 days, and the meetings of county boards that publish through Legistar. Each time is shown in the zone its source gives, marked ET, CT, MT or PT."),
        days.length ? days.map(function (d) {
          return el("section", { class: "day" }, el("h3", { class: "day-head" }, el("time", { datetime: d.date }, DAY_FMT.format(dateOnly(d.date)))),
            el("ul", { class: "plain ulist" }, d.items.map(function (u) { return upcomingRow(u, sc); })));
        }) : note("Nothing is scheduled in the published feeds."),
        el("p", { class: "fresh" }, ["docs-house-floor", "senate-schedules", "senate-daily-press", "ca-leginfo-pubinfo"].map(function (sid) { var s = sourceOf(man, sid); return s ? el("span", null, s.name + ": checked ", time(s.last_checked_at, true), s.status !== "ok" ? " (" + statusWord(s) + ")" : "", ". ") : null; })));
      return { title: "Upcoming", crumbs: [["All states", BASE], "Everything scheduled"], lede: "Votes, hearings and meetings scheduled at the federal, state and county levels, everywhere this site collects them. Each state's page has its own.", body: body };
    });
  }

  // ---------- search ----------
  function viewSearch(query) {
    var terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    var box = searchForm("search-q", "Search bills, legislators and places", "AB 1, wildfire, Padilla, Travis County", query);
    if (!terms.length) return { title: "Search", crumbs: [["All states", BASE], "Search"], lede: "Type a bill number, a subject, a legislator's name or a place.", body: frag(box, note("Try “AB 1”, “wildfire”, “Padilla”, “S. 2403”, “Travis County” or “Ohio”.")) };
    return Promise.all([get("search/us.json", true), get("search/us-ca.json", true), get("search/states.json", true), states(), get("geo/counties.json", true)]).then(function (r) {
      var rows = rows2objs(r[0]).concat(rows2objs(r[1]), rows2objs(r[2]));
      var st = r[3], byCode = {};
      st.forEach(function (s) { byCode[s.code] = s; });
      function hit(text) { var t = text.toLowerCase(); return terms.every(function (w) { return t.indexOf(w) >= 0; }); }
      var members = [], bills = [];
      rows.forEach(function (x) {
        var where = /^us-[a-z]{2}-(upper|lower|legislature)$/.test(x.body || "") ? bodyName(x.body) : "";
        if (!hit(x.label + " " + x.meta + " " + x.id + " " + where)) return;
        x.where = where;
        (x.type === "member" ? members : bills).push(x);
      });
      var places = st.filter(function (s) { return hit(s.name); }).map(function (s) { return el("li", null, link(href([s.slug]), s.name), el("span", { class: "meta" }, s.legislature ? " state" : " territory")); })
        .concat(rows2objs(r[4]).filter(function (c) { var s = byCode[c.state]; return s && hit(c.name + " " + s.name); }).slice(0, 60).map(function (c) {
          var s = byCode[c.state];
          return el("li", null, link(href([s.slug, c.slug]), c.name), el("span", { class: "meta" }, " " + countyWord(s, 1) + ", " + s.name));
        }));
      var body = frag(
        box,
        places.length ? section("Places", el("ul", { class: "plain people" }, places), "places") : null,
        section("Legislators", members.length ? el("ul", { class: "plain people" }, members.slice(0, 100).map(function (m) {
          return el("li", null, badge(levelOf(m.body)), " ", link(memberHref(m.id), m.label), el("span", { class: "meta" }, " " + m.meta + " · " + (m.where || bodyName(m.body))));
        })) : note("No legislators match."), "people"),
        section("Bills", bills.length ? el("ul", { class: "plain bills" }, bills.slice(0, 100).map(function (b) { return el("li", null, badge(levelOf(b.body)), " ", link(billHref(b.id), b.label), b.meta ? el("span", { class: "meta" }, " · " + b.meta) : null); })) : note("No bills match."), "bills"),
        members.length > 100 || bills.length > 100 ? note("Showing the first 100 in each group; add a word to narrow the search.") : null,
        note("Bills are searched for Congress and California; other states' bills are listed on each state's bills page. County supervisors and agenda items are searched on each county's page."));
      return { title: "Search: " + query, crumbs: [["All states", BASE], "Search"], lede: (members.length + bills.length + places.length) + " results for “" + query + "”", body: body };
    });
  }

  // ---------- sources ----------
  function viewSources() {
    return Promise.all([manifest(), countyIndex(), states()]).then(function (r) {
      var man = r[0], cidx = r[1];
      var srcs = man.sources || {};
      var counties = Object.keys(srcs).filter(function (k) { return /^county-/.test(k); }).sort(function (a, b) {
        var x = cidx[a.slice(7)] || {}, y = cidx[b.slice(7)] || {};
        return ((x.state || "CA") === "CA" ? "" : x.state || "").localeCompare((y.state || "CA") === "CA" ? "" : y.state || "") || srcs[a].name.localeCompare(srcs[b].name);
      });
      var ctable = el("table", { class: "tbl" }, el("caption", null, "County boards"),
        el("thead", null, el("tr", null, el("th", { scope: "col" }, "County"), el("th", { scope: "col" }, "What is collected"), el("th", { scope: "col" }, "Status"), el("th", { scope: "col" }, "Last checked"), el("th", { scope: "col" }, "Source updated"))),
        el("tbody", null, counties.map(function (k) {
          var s = srcs[k]; var c = cidx[k.slice(7)] || {};
          var st = STATE_INFO[c.state || "CA"];
          return el("tr", null, el("th", { scope: "row" }, c.slug ? link(countyHref(c), (c.county || s.name) + (st && st.code !== "CA" ? ", " + st.name : "")) : s.name, " ", s.url ? ext(s.url, "official page") : null), el("td", null, c.coverage === "votes" ? "meetings, agenda items and each supervisor's vote (Legistar)" : c.coverage === "agendas" ? "meetings and agenda items (Legistar), no per-member votes" : "links only (" + (c.platform || "county site") + ")"), el("td", null, el("span", { class: "st st-" + s.status }, statusWord(s)), s.error ? el("span", { class: "unk" }, " · " + s.error) : null), el("td", null, s.last_checked_at ? time(s.last_checked_at, true) : "never"), el("td", null, s.source_updated_at ? time(s.source_updated_at, true) : el("span", { class: "unk" }, "not stated")));
        })));
      var body = frag(
        el("p", null, "Votes, bills and schedules come from official government publications. Two sources are not official and are named wherever they are used: Open States for legislators, bills and votes outside California, and Wikidata for county websites outside California. Everything is collected once a night by a scheduled job and published as static files; nothing is edited by hand. When a source is down the job keeps the last good copy and marks it stale here; a feed that returns far fewer records than the night before is rejected rather than published."),
        freshnessTable(man),
        ctable,
        section("Method notes", el("ul", null,
          el("li", null, "Federal roll calls come from the Clerk of the House (evs XML) and the Senate Legislative Information System (vote XML). Members are matched by Bioguide ID through the public-domain congress-legislators dataset and the Senate's own member file. If senate.gov refuses the nightly job, votes already published stay, and new Senate votes are filled in from Voteview (UCLA) and labelled as such until the Senate's copy can be fetched."),
          el("li", null, "Federal bill details (sponsor, cosponsors, committees, summary, actions) come from GovInfo's Bill Status files, published by the Government Publishing Office and the Library of Congress. GovInfo can trail Congress.gov by a day or two for Senate actions; vote results always come from the roll calls."),
          el("li", null, "Upcoming Senate floor votes come from the Senate Daily Press Gallery's floor log, the only published source that names them; it is text, shown as written and linked. The House's come from the Majority Leader's weekly floor schedule on docs.house.gov."),
          el("li", null, "California bills, floor and committee votes, legislators and the Daily File come from the Legislature's nightly database export (LegInfo “pubinfo”). The export records the day of a vote but not the time of day. “No vote recorded” covers absent, abstaining and not-voting members alike, as the Legislature records it."),
          el("li", null, "Counties in California: 17 boards publish through Granicus Legistar, whose public API gives meetings, agenda items and, for most, each supervisor's vote; those are collected for the last 90 days. The other counties are linked to their official board and agenda pages, which are checked nightly. Their votes are only in minutes documents or on platforms that ask automated tools not to collect them."),
          el("li", null, "Counties elsewhere: each night the job tries a thirtieth of the country's counties on Legistar under names built from the county's name and website, so every county is tried once a month. A name that answers is used only when the county's Legistar site links the county's own website, or when the name is the website's own name or spells out the county and its state. The boards found this way are collected the same way as California's."),
          el("li", null, "Which state and federal districts overlap a county comes from the Census Bureau's 2024 relationship files and, for California's congressional map that applies from January 2027, the Senate Elections Committee's AB 604 block equivalency file. Every state's counties come from the Census Bureau's 2020 county list, so Connecticut appears as its eight former counties."),
          el("li", null, "Legislators in the other 49 states, the District of Columbia and Puerto Rico come from Open States (Plural), a nonprofit project that collects them from each legislature's website and publishes them in the public domain. It is not an official record, and each legislator's page says so and links the legislature's own page. Their districts are matched to the Census districts by name; the few that cannot be matched are listed without counties."),
          el("li", null, "Bills and votes of those legislatures come from Open States' bulk data: one file per legislative session, built from each legislature's website and published in the public domain. The nightly job keeps each state's current regular session and any special session since it, and downloads a session's file only when Open States has published a new copy. The files are listed only through Open States' free API, so this part runs once the site's key is configured; until then the table above marks it “not configured”. A vote Open States could not match to a legislator keeps the name as the legislature wrote it. If the published records approach the free hosting limit, committee votes are left out, largest state first, and the state's page says so; floor votes are always kept."),
          el("li", null, "County websites outside California come from Wikidata's official-website entries, which volunteers edit. The nightly job checks a seventh of them each night, so every link is checked once a week, and each county page says when its link was last checked and whether it answered. A link that answers can still point to the wrong page; report one with the corrections link at the foot of the page."),
          el("li", null, "Times are shown in Pacific Time with the zone marked. Each record shows when its source last changed and when this site last checked it."))),
        el("p", { class: "links" }, ext("https://github.com/aetiusgular/studenttrustee-websites", "The pipeline's source code")));
      return { title: "Sources and freshness", crumbs: [["All states", BASE], "Sources"], lede: "Where every record comes from, and when each source was last checked. Each state's page has its own list.", body: body };
    });
  }

  // ---------- loaders ----------
  // Each returns once the files its page needs are in memory. They read the same indexes the
  // views read, so the dependent files (a county's board, a month of votes) are found the same way.
  var STATE_CODES = { alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
    florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
    maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE",
    nevada: "NV", "new-hampshire": "NH", "new-jersey": "NJ", "new-mexico": "NM", "new-york": "NY", "north-carolina": "NC", "north-dakota": "ND", ohio: "OH",
    oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode-island": "RI", "south-carolina": "SC", "south-dakota": "SD", tennessee: "TN", texas: "TX",
    utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west-virginia": "WV", wisconsin: "WI", wyoming: "WY", "district-of-columbia": "DC",
    "puerto-rico": "PR", guam: "GU", "u-s-virgin-islands": "VI", "american-samoa": "AS", "northern-mariana-islands": "MP" };
  var NO_LEGISLATURE = { GU: 1, VI: 1, AS: 1, MP: 1 };
  var CODE_SLUG = {};           // "TX" -> "texas"
  Object.keys(STATE_CODES).forEach(function (k) { CODE_SLUG[STATE_CODES[k]] = k; });
  // Records files (a chamber's positions for a year or a Congress, 30 to 70 KB compressed) and the
  // search indexes (over 100 KB) wait for focus or touch; a passing pointer does not fetch them.
  function big(rel) { return { rel: rel, big: true }; }

  function loadMap(parts, params, c) { return need(c, ["manifest.json", "geo/states.json", "legislatures.json", "us-ca/counties/index.json", "counties/index.json"]); }
  // A state or county door: the place's files, then what the door draws first.
  function loadPlace(parts, params, c) {
    var p = placeParts(parts);
    if (!p) return need(c, ["manifest.json"]);
    return need(c, placeFiles(p.code)).then(function (r) {
      noteStates(r[1] && r[1].states);
      var s = STATE_INFO[p.code];
      var sc = s ? buildScope(p, s, (r[2] && r[2].states) || {}, indexCounties(r[3], r[4]), r[5], r[0]) : null;
      return sc ? doorFiles(sc, params, c) : null;
    });
  }
  function doorFiles(sc, params, c) {
    var CA = sc.code === "CA", s = sc.s;
    var board = sc.board ? boardFolder(sc) + "/board.json" : null;
    if (sc.door === "votes") {
      var f = voteFilters(params, sc);
      return namedFiles(function (rel) { return c.get(rel); }, votesFirstFiles(sc, f)).then(function (d) { return need(c, votesMonthFiles(sc, f, d)); });
    }
    if (sc.door === "representatives") {
      return need(c, ["us/members.json", s.legislature ? (CA ? "us-ca/members.json" : "us-" + sc.st + "/members.json") : null,
        s.legislature && !CA ? "us-" + sc.st + "/summary.json" : null, sc.county ? board : null]);
    }
    if (sc.door === "upcoming") {
      return need(c, ["us/upcoming.json", CA ? "us-ca/upcoming.json" : null, sc.boards.length ? (CA ? "us-ca/counties/upcoming.json" : "counties/upcoming.json") : null,
        s.legislature && !CA ? "us-" + sc.st + "/summary.json" : null, sc.county ? board : null]);
    }
    if (sc.door === "bills" && s.legislature) {
      if (CA) {
        return need(c, ["us-ca/members.json"]).then(function (r) {
          var session = r[0] && r[0].session;
          return session ? c.get("us-ca/bills/" + session + "/index.json").then(function (idx) {
            var types = idx ? Object.keys(idx.types) : [];
            var type = params.get("type") && types.indexOf(params.get("type")) >= 0 ? params.get("type") : "AB";
            return idx && idx.types[type] ? c.get("us-ca/bills/" + session + "/" + idx.types[type].file) : null;
          }) : null;
        });
      }
      var st = "us-" + sc.st;
      if (!sc.stateBills) return need(c, [st + "/summary.json"]);
      return need(c, [st + "/summary.json", st + "/votes/index.json"]).then(function (r) {
        var vidx = r[1];
        var sessions = ((vidx && vidx.sessions) || []).slice().sort(function (a, b) { return (a.start || "").localeCompare(b.start || ""); });
        var ids = sessions.map(function (x) { return x.id; });
        var regular = sessions.filter(function (x) { return x.classification === "primary"; });
        var session = params.get("session") && ids.indexOf(params.get("session")) >= 0 ? params.get("session") : (regular.length ? regular[regular.length - 1] : sessions[sessions.length - 1] || {}).id;
        return session ? c.get(st + "/bills/" + session + "/index.json").then(function (idx) {
          var types = idx ? Object.keys(idx.types).sort(function (a, b) { return idx.types[b].bills - idx.types[a].bills || a.localeCompare(b); }) : [];
          var type = params.get("type") && types.indexOf(params.get("type")) >= 0 ? params.get("type") : types[0];
          return type ? c.get(st + "/bills/" + session + "/" + idx.types[type].file) : null;
        }) : null;
      });
    }
    return null;
  }
  function loadMember(parts, params, c) {
    var id = parts[1];
    var stCode = stateMemberCode(id);
    if (stCode) {
      var st = "us-" + lc(stCode);
      return need(c, ["manifest.json", "geo/states.json", st + "/members.json", "geo/" + st + "/counties.json", "legislatures.json"]).then(function (r) {
        var row = ((r[4] && r[4].states) || {})[stCode];
        var m = r[2] && r[2].members.filter(function (x) { return x.id === id; })[0];
        if (!m || !row || !row.votes) return null;
        return c.get(st + "/votes/index.json").then(function (idx) {
          var body = idx ? bodyWithVotes(idx, m) : null;
          if (!body) return null;
          var pick = statePick(idx, body, params);
          return need(c, [big(st + "/records/" + body.split("-")[2] + "-" + pick.session + ".json"), pick.shard && st + "/votes/" + pick.session + "/" + pick.shard.file]);
        });
      });
    }
    var base = ["manifest.json", "us-ca/counties/index.json", "counties/index.json", "geo/states.json"];
    if (/^ca-(asm|sen)-/.test(id)) {
      return need(c, base.concat(["us-ca/members.json", "us-ca/votes/index.json"])).then(function (r) {
        var ca = r[4], idx = r[5];
        var m = ca && ca.members.filter(function (x) { return x.id === id; })[0];
        if (!m || !idx) return null;
        var pick = memberMonth(idx, m.body, params);
        if (!pick.year) return null;
        var h = m.body === "ca-assembly" ? "assembly" : "senate";
        return need(c, [big("us-ca/records/" + h + "-" + ca.session + "-" + pick.year + ".json"), "us-ca/votes/" + ca.session + "-" + h + "-" + pick.month + ".json"]);
      });
    }
    var folder = countyFolder(id);
    if (folder) {
      return need(c, base.concat([folder + "/board.json"])).then(function (r) {
        var months = ((r[4] && r[4].vote_months) || []).map(function (x) { return x.month; });
        var month = params.get("month") && months.indexOf(params.get("month")) >= 0 ? params.get("month") : months[months.length - 1];
        return month ? c.get(folder + "/votes-" + month + ".json") : null;
      });
    }
    return need(c, base.concat(["us/members.json"])).then(function (r) {
      var us = r[4];
      var m = us && us.members.filter(function (x) { return x.id === id; })[0];
      if (!m) return null;
      var house = m.body === "us-house" ? "house" : "senate";
      return need(c, [big("us/records/" + house + "-" + us.congress + ".json"), "us/votes/" + us.congress + "-1-" + house + ".json", "us/votes/" + us.congress + "-2-" + house + ".json"]);
    });
  }
  function loadVoteRoute(parts, params, c) {
    var f = voteFile(parts[1]);
    return need(c, ["manifest.json", "us-ca/counties/index.json", "counties/index.json", "geo/states.json", f && f.rel, f && f.members]);
  }
  function loadBillRoute(parts, params, c) {
    var id = parts[1];
    var f = billFile(id);
    return need(c, ["manifest.json", "us-ca/counties/index.json", "counties/index.json", "geo/states.json", f && f.rel]).then(function (r) {
      if (!f) return null;
      if (f.ca) return c.get("us-ca/votes/" + f.session + "/" + id + ".json");
      var b = f.national ? r[4] && r[4].bills && r[4].bills[id] : r[4];
      var ids = (b && b.vote_ids) || [];
      if (f.national) {
        // one month file holds every vote of a chamber in that month
        var files = [];
        ids.forEach(function (vid) { var vf = stateVoteFile(vid); if (vf && files.indexOf(vf.rel) < 0) files.push(vf.rel); });
        return need(c, files);
      }
      return need(c, ids.map(function (vid) { return "us/votes/" + vid + ".json"; }));
    });
  }
  // The national lists: every roll call and every bill of the current Congress.
  function loadVotes(parts, params, c) {
    return need(c, ["manifest.json", "us-ca/counties/index.json", "counties/index.json", "us/members.json", "geo/states.json"]).then(function (r) {
      var us = r[3];
      if (!us) return null;
      var body = params.get("body") === "us-senate" ? "senate" : "house";
      var sess = /^[12]$/.test(params.get("session") || "") ? params.get("session") : "";
      return need(c, (sess ? [sess] : ["1", "2"]).map(function (s) { return "us/votes/" + us.congress + "-" + s + "-" + body + ".json"; }));
    });
  }
  function loadBills(parts, params, c) {
    return need(c, ["manifest.json", "us/members.json"]).then(function (r) { return r[1] ? c.get("us/bills/" + r[1].congress + "/index.json") : null; });
  }
  function loadUpcoming(parts, params, c) { return need(c, ["manifest.json", "us/upcoming.json", "us-ca/upcoming.json", "us-ca/counties/upcoming.json", "counties/upcoming.json", "us-ca/counties/index.json", "counties/index.json"]); }
  function loadSearch(parts, params, c) {
    if (!(params.get("q") || "").trim()) return need(c, ["manifest.json"]);
    return need(c, ["manifest.json", "search/us.json", big("search/us-ca.json"), big("search/states.json"), "geo/states.json", "geo/counties.json"]);
  }
  function loadSources(parts, params, c) { return need(c, ["manifest.json", "us-ca/counties/index.json", "counties/index.json", "geo/states.json"]); }

  // ---------- routes ----------
  function one(name) { return function (p) { return p[0] === name && p.length === 1; }; }
  function withId(name) { return function (p) { return p[0] === name && p.length === 2 && !!p[1]; }; }
  var ROUTES = [
    { name: "map", test: function (p) { return p.length === 0; }, load: loadMap, view: function () { return viewMap(); } },
    { name: "bill", test: withId("bill"), load: loadBillRoute, view: function (p) { return viewBill(p[1]); } },
    { name: "vote", test: withId("vote"), load: loadVoteRoute, view: function (p, q) { return viewVote(p[1], q); } },
    { name: "legislator", test: withId("legislator"), load: loadMember, view: function (p, q) { return viewMember(p[1], q); } },
    { name: "votes", test: one("votes"), load: loadVotes, view: function (p, q) { return viewVotes(q); } },
    { name: "bills", test: one("bills"), load: loadBills, view: function (p, q) { return viewBills(q); } },
    { name: "upcoming", test: one("upcoming"), load: loadUpcoming, view: function (p, q) { return viewUpcoming(q); } },
    { name: "search", test: one("search"), load: loadSearch, view: function (p, q) { return viewSearch(q.get("q") || ""); } },
    { name: "sources", test: one("sources"), load: loadSources, view: function () { return viewSources(); } },
    { name: "place", test: function (p) { return !!placeParts(p); }, load: loadPlace, view: function (p, q, ui) { return viewPlace(p, q, ui); } },
  ];

  route();
})();
