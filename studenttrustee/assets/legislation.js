/* Legislation section: a small client-side router over the JSON the nightly pipeline writes
   to /data/legislation/. No framework. Every view is a function that builds DOM with el()
   and returns it; render() swaps it into #app, updates the title and moves focus to the h1.

   Data layout (written by tools/legislation/*.py):
     manifest.json                       per-source status and when it was last checked
     geo/states.json, geo/us-ca/counties.json
     us/members.json, us/votes/…, us/bills/119/…, us/records/…, us/upcoming.json, us/latest.json
     us-ca/members.json, us-ca/votes/…, us-ca/bills/20252026/…, us-ca/records/…, us-ca/upcoming.json
     us-ca/counties/index.json, us-ca/counties/upcoming.json, us-ca/counties/{fips}/board.json, votes-YYYY-MM.json
     search/us.json, search/us-ca.json */
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
  var titleEl = document.getElementById("page-title");
  var ledeEl = document.getElementById("page-lede");
  var cache = {};
  var inflight = {};

  // ---------- fetch with a per-page cache ----------
  function get(rel, optional) {
    if (cache[rel] !== undefined) return Promise.resolve(cache[rel]);
    if (inflight[rel]) return inflight[rel];
    inflight[rel] = fetch(DATA + rel, { credentials: "omit" }).then(function (r) {
      if (r.status === 404 && optional) return null;
      if (!r.ok) throw new Error("Could not load " + rel + " (HTTP " + r.status + ")");
      return r.json();
    }).then(function (j) { cache[rel] = j; delete inflight[rel]; return j; }, function (e) { delete inflight[rel]; throw e; });
    return inflight[rel];
  }

  // ---------- DOM ----------
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = v;
        else if (k === "html") node.innerHTML = v;   // only ever static markup from this file
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
  function ext(href, text) { return el("a", { href: href, class: "ext", rel: "noopener" }, text, el("span", { class: "visually-hidden" }, " (official source, opens the government site)")); }

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
  function fmtClock(t, tz) {
    // "14:00" + "America/New_York" -> "2:00 PM ET". Times stay in the zone the source gives.
    var m = /^(\d{2}):(\d{2})$/.exec(t || "");
    if (!m) return t || "";
    var h = +m[1], ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return h + ":" + m[2] + " " + ap + " " + (tz === "America/New_York" ? "ET" : tz === "America/Chicago" ? "CT" : "PT");
  }
  function whenKey(x) {
    // Sort key for scheduled items across time zones. Eastern and Pacific switch to daylight time on
    // the same dates, so Eastern is always Pacific + 3 h. Items without a time sort last in their day.
    var m = /^(\d{2}):(\d{2})$/.exec(x.time || "");
    var mins = m ? (+m[1]) * 60 + (+m[2]) + (x.tz === "America/New_York" ? 0 : 180) : 9999;
    return (x.date || "") + " " + String(mins).padStart(4, "0");
  }
  function clockPart(x) { return x.time ? " · " + fmtClock(x.time, x.tz) : x.time_note ? " · " + x.time_note : ""; }
  function time(s, withTime) { return s ? el("time", { datetime: s }, withTime ? fmtWhen(s) : fmtDate(s)) : el("span", { class: "unk" }, "not recorded"); }
  function todayISO() { var d = new Date(); return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d); }

  // ---------- vocabulary ----------
  var LEVEL_NAME = { federal: "Federal", state: "State", county: "County", geo: "Geography" };
  var BODY_NAME = { "us-house": "U.S. House", "us-senate": "U.S. Senate", "ca-assembly": "California Assembly", "ca-senate": "California Senate", "ca-legislature": "California Legislature" };
  var PARTY = { D: "Democrat", R: "Republican", I: "Independent", L: "Libertarian" };
  function badge(level) { return el("span", { class: "lvl lvl-" + level }, LEVEL_NAME[level] || level); }
  function bodyName(body, counties) {
    if (BODY_NAME[body]) return BODY_NAME[body];
    var m = /^ca-(\d{5})-bos$/.exec(body || "");
    if (m && counties) { var c = counties[m[1]]; if (c) return c.body_name; }
    return body || "";
  }
  function levelOf(body) { return /^us-/.test(body) ? "federal" : /-bos$/.test(body) ? "county" : "state"; }
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
  function parse(pathname) {
    var rest = pathname.indexOf(BASE) === 0 ? pathname.slice(BASE.length) : "";
    var parts = rest.split("/").filter(Boolean).map(decodeURIComponent);
    return parts;
  }
  function q() { return new URLSearchParams(location.search); }
  function href(parts, params) {
    var p = BASE + parts.map(encodeURIComponent).join("/") + (parts.length ? "/" : "");
    if (params) {
      var sp = new URLSearchParams();
      Object.keys(params).forEach(function (k) { if (params[k] !== "" && params[k] !== null && params[k] !== undefined && params[k] !== false) sp.set(k, params[k]); });
      var s = sp.toString(); if (s) p += "?" + s;
    }
    return p;
  }
  function billHref(id) { return href(["bill", id]); }
  function voteHref(id) { return href(["vote", id]); }
  function memberHref(id) { return href(["legislator", id]); }

  var current = 0;
  var firstRender = true;
  function render(build, opts) {
    var run = ++current;
    say("Loading…");
    app.setAttribute("aria-busy", "true");
    return Promise.all([Promise.resolve().then(build), manifest().catch(function () { return null; })]).then(function (r) {
      var out = r[0];
      if (run !== current) return;
      app.innerHTML = "";
      append(app, staleNotice(r[1]), out.body);
      titleEl.textContent = out.title;
      ledeEl.textContent = out.lede || "";
      ledeEl.hidden = !out.lede;
      document.title = out.title + " · Legislation · studenttrustee.net";
      app.removeAttribute("aria-busy");
      markNav();
      // After an in-app navigation, move focus to the new heading (or to the #fragment the link
      // pointed at) so screen readers announce where they are. On the first load the browser has
      // already put the reader at the top of the page.
      var target = location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
      if (target) {
        if (!target.hasAttribute("tabindex") && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) target.setAttribute("tabindex", "-1");
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: "start" });
      } else {
        if (!firstRender && (!opts || opts.focus !== false)) titleEl.focus({ preventScroll: true });
        if (!(opts && opts.keepScroll)) window.scrollTo(0, 0);
      }
      firstRender = false;
      say("");
    }).catch(function (e) {
      if (run !== current) return;
      app.innerHTML = "";
      append(app, el("div", { class: "err", role: "alert" },
        el("h2", null, "This page could not be loaded"),
        el("p", null, String(e && e.message || e)),
        el("p", null, "The nightly data files may not have been published yet. ", link(BASE, "Back to the overview"), ".")));
      titleEl.textContent = "Legislation";
      app.removeAttribute("aria-busy");
      say("");
    });
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
  function markNav() {
    var parts = parse(location.pathname);
    var section = parts[0] || "";
    document.querySelectorAll(".leg-nav a").forEach(function (a) {
      var ap = parse(new URL(a.href).pathname)[0] || "";
      var on = ap === section || (ap === "states" && parts.length && ["states", "bill", "vote", "legislator", "votes", "bills", "upcoming", "search", "sources", "calendars"].indexOf(section) < 0);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
  }
  function navigate(url, opts) {
    history.pushState(null, "", url);
    route(opts);
  }
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[href]");
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (a.target === "_blank" || a.hasAttribute("download")) return;
    var u = new URL(a.href, location.href);
    if (u.origin !== location.origin || u.pathname.indexOf(BASE) !== 0 || /^\/legislation\/calendars\//.test(u.pathname)) return;
    if (u.hash && u.pathname === location.pathname && u.search === location.search) return;   // same-page anchor, e.g. the skip link
    e.preventDefault();
    navigate(u.pathname + u.search + u.hash);
  });
  window.addEventListener("popstate", function () { route(); });
  document.getElementById("search-form").addEventListener("submit", function (e) {
    e.preventDefault();
    navigate(href(["search"], { q: document.getElementById("q").value.trim() }));
  });

  function route(opts) {
    var parts = parse(location.pathname);
    var p = q();
    var head = parts[0];
    if (!head) return render(viewOverview);
    if (head === "states") return render(viewStates);
    if (head === "bill" && parts[1]) return render(function () { return viewBill(parts[1]); });
    if (head === "vote" && parts[1]) return render(function () { return viewVote(parts[1]); });
    if (head === "legislator" && parts[1]) return render(function () { return viewMember(parts[1], p); }, opts);
    if (head === "votes") return render(function () { return viewVotes(p); }, opts);
    if (head === "bills") return render(function () { return viewBills(p); }, opts);
    if (head === "upcoming") return render(function () { return viewUpcoming(p); }, opts);
    if (head === "search") return render(function () { return viewSearch(p.get("q") || ""); });
    if (head === "sources") return render(viewSources);
    if (parts.length === 1) return render(function () { return viewState(parts[0]); });
    if (parts.length === 2) return render(function () { return viewCounty(parts[0], parts[1], p); }, opts);
    return render(function () { return notFound(); });
  }
  function notFound() {
    return { title: "Not found", body: el("p", null, "There is no page at this address. ", link(BASE, "Back to the overview"), ".") };
  }

  // ---------- shared loaders ----------
  function manifest() { return get("manifest.json"); }
  function states() { return get("geo/states.json").then(function (d) { return d.states; }); }
  function caCounties() { return get("geo/us-ca/counties.json").then(function (d) { return d.counties; }); }
  function countyIndex() {
    return get("us-ca/counties/index.json", true).then(function (d) {
      var byFips = {}; (d && d.counties || []).forEach(function (c) { byFips[c.fips] = c; }); return byFips;
    });
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
    else if (m.title) bits.push(m.title);
    if (m.former || m.provisional) bits.push(m.left_office ? "left office " + fmtDate(m.left_office) : "no longer serving");
    return bits.join(" · ");
  }
  function memberLink(m, id) {
    if (!m) return el("span", null, id);
    return frag(link(memberHref(m.id), m.name), m.provisional ? el("span", { class: "unk" }, " (name pending)") : null);
  }
  function rows2objs(d) { if (!d) return []; var c = d.columns; return d.rows.map(function (r) { var o = {}; c.forEach(function (k, i) { o[k] = r[i]; }); return o; }); }
  function caBody(loc) { return /^(A|CX)/.test(loc || "") ? "ca-assembly" : /^CONF/.test(loc || "") ? "ca-legislature" : "ca-senate"; }
  function countyRowToVote(v) {
    return { id: v.id, date: v.date, body: v.body, question: cap(v.question || "Vote") + (v.matter_label ? " · " + v.matter_label : ""), title: v.matter_title || "",
      result: v.result, passed: v.passed, yes: v.yes, no: v.no, other: v.other, bill_id: null };
  }
  function idOfCounty(id) { var m = /^ca-(\d{5})-bos/.exec(id || ""); return m ? m[1] : null; }

  function section(title, body, cls) { return el("section", { class: "sec " + (cls || "") }, el("h2", null, title), body); }
  function note(text) { return el("p", { class: "note" }, text); }
  function more(list, renderItem, opts) {
    // paginated list: renders PAGE items; "Show more" appends the next page and moves focus to it
    var box = el("div", { class: (opts && opts.class) || "" });
    var ul = el("ul", { class: "plain " + ((opts && opts.ulClass) || "") });
    var count = el("p", { class: "count" });
    var shown = 0;
    function page(focusFirstNew) {
      var first = shown;
      var end = Math.min(list.length, shown + PAGE);
      for (; shown < end; shown++) ul.appendChild(renderItem(list[shown], shown));
      btn.hidden = shown >= list.length;
      count.textContent = list.length ? "Showing " + shown + " of " + list.length : "";
      if (focusFirstNew && ul.children[first]) {
        var f = ul.children[first].querySelector("a, button, [tabindex]");
        if (f) f.focus();
      }
    }
    var btn = el("button", { type: "button", class: "btn", on: { click: function () { page(true); } } }, "Show more");
    append(box, list.length ? ul : note((opts && opts.empty) || "Nothing to show."), count, btn);
    page(false);
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
  function upcomingItem(u, counties) {
    var lvl = u.level || levelOf(u.body);
    return el("li", { class: "up" },
      el("div", { class: "vote-head" }, badge(lvl), el("span", { class: "body" }, bodyName(u.body, counties)), el("span", { class: "when" }, u.date_precision === "week" ? "week of " : "", time(u.date), clockPart(u))),
      el("h3", null, u.bill_id && /^(us-|\d{8})/.test(u.bill_id) ? link(billHref(u.bill_id), u.title) : u.kind === "meeting" ? "Board meeting" + (/\(([^)]*)\)$/.test(u.title) ? " (" + /\(([^)]*)\)$/.exec(u.title)[1] + ")" : "") : u.title),
      el("p", { class: "vt" }, u.category || (u.kind === "floor" ? "Floor" : u.kind === "committee" ? "Committee" : "Meeting"), u.location ? " · " + u.location : "", u.file_item ? " · file item " + u.file_item : ""),
      u.note ? el("p", { class: "vt" }, u.source && u.source.id === "senate-daily-press" ? el("strong", null, "Advisory, quoted from the Press Gallery's notice; floor times often change. ") : null, u.note) : null,
      el("p", { class: "src" }, u.official_url ? ext(u.official_url, u.source && u.source.name ? u.source.name : "Official source") : null, u.source_updated_at ? [" · updated ", time(u.source_updated_at, true)] : null));
  }

  // ---------- overview ----------
  function viewOverview() {
    return Promise.all([manifest(), states(), get("us/latest.json", true), get("us-ca/latest.json", true), get("us/upcoming.json", true), get("us-ca/upcoming.json", true), get("us-ca/counties/upcoming.json", true), countyIndex(), get("us-ca/counties/latest.json", true), caVoteIndex(), usMembers()])
      .then(function (r) {
        var man = r[0], st = r[1], usLatest = rows2objs(r[2]), caLatest = rows2objs(r[3]), counties = r[7];
        var caSession = r[9] && r[9].session, congress = r[10].congress;
        caLatest.forEach(function (v) { v.body = v.body || caBody(v.location); });
        var coLatest = rows2objs(r[8]).map(countyRowToVote);
        var today = todayISO();
        var up = ((r[4] && r[4].items) || []).concat((r[5] && r[5].items) || [], ((r[6] && r[6].items) || []).map(function (m) { return Object.assign({ level: "county" }, m); }))
          .filter(function (u) { return ahead(u, today); }).sort(function (a, b) { return whenKey(a).localeCompare(whenKey(b)); }).slice(0, 10);
        var counts = man.counts || {};
        var ca = st.filter(function (s) { return s.code === "CA"; })[0];

        var sel = el("select", { id: "state-pick", name: "state" }, el("option", { value: "" }, "Choose a state"),
          st.map(function (s) { return el("option", { value: s.slug }, s.name + (s.coverage === "full" ? " (federal, state and county)" : " (federal only)")); }));
        var finder = el("form", { class: "finder", on: { submit: function (e) { e.preventDefault(); var v = sel.value; if (v) navigate(href([v])); } } },
          el("label", { for: "state-pick" }, "Start with a state"),
          el("div", { class: "row" }, sel, el("button", { type: "submit", class: "btn" }, "Go")));

        var levels = el("ul", { class: "levels plain" },
          el("li", null, badge("federal"), el("h3", null, "Congress"), el("p", null, (counts.us_votes || 0).toLocaleString() + " roll-call votes, " + (counts.us_bills || 0).toLocaleString() + " bills with votes, " + (counts.us_members || 0) + " members of the " + ordinal(congress) + " Congress, including those who have left."),
            el("p", { class: "links" }, link(href(["votes"], { level: "federal" }), "Federal votes"), " · ", link(href(["bills"], { level: "federal" }), "Federal bills"))),
          el("li", null, badge("state"), el("h3", null, "California Legislature"), el("p", null, counts.ca_votes ? (counts.ca_votes.toLocaleString() + " floor and committee votes on " + (counts.ca_bills || 0).toLocaleString() + " bills of the " + sessionLabel(caSession) + " session, " + (counts.ca_members || 0) + " legislators.") : "California records have not been published yet."),
            el("p", { class: "links" }, link(href(["california"]), "California"), " · ", link(href(["votes"], { level: "state" }), "State votes"), " · ", link(href(["bills"], { level: "state" }), "State bills"))),
          el("li", null, badge("county"), el("h3", null, "County boards of supervisors"), el("p", null, counts.ca_counties_with_votes ? (counts.ca_counties_with_votes + " of California's 58 counties publish machine-readable board votes (" + (counts.ca_county_votes || 0).toLocaleString() + " votes in the last 90 days). The rest are linked to their official agenda pages.") : "County records have not been published yet."),
            el("p", { class: "links" }, link(href(["california"]) + "#counties", "Counties"), " · ", link(href(["votes"], { level: "county" }), "County votes"))));

        var body = frag(
          finder,
          section("Coverage", levels),
          section("Latest votes", frag(
            el("h3", { class: "lvlhead" }, badge("federal"), " Congress"),
            usLatest.length ? el("ul", { class: "plain votes" }, usLatest.slice(0, 4).map(function (v) { return voteItem(v, counties); })) : note("No federal votes published yet."),
            el("p", { class: "links" }, link(href(["votes"], { level: "federal" }), "All federal votes")),
            el("h3", { class: "lvlhead" }, badge("state"), " California Legislature"),
            caLatest.length ? el("ul", { class: "plain votes" }, caLatest.slice(0, 4).map(function (v) { return voteItem(v, counties, r[3] && r[3].locations); })) : note("No state votes published yet."),
            el("p", { class: "links" }, link(href(["votes"], { level: "state" }), "All state votes")),
            el("h3", { class: "lvlhead" }, badge("county"), " County boards"),
            coLatest.length ? el("ul", { class: "plain votes" }, coLatest.slice(0, 4).map(function (v) { return voteItem(v, counties); })) : note("No county votes published yet."),
            el("p", { class: "links" }, link(href(["votes"], { level: "county" }), "All county votes"))), "latest"),
          section("Coming up", up.length ? el("ul", { class: "plain ups" }, up.map(function (u) { return upcomingItem(u, counties); })) : note("Nothing scheduled in the published feeds."), "upcoming"),
          el("p", { class: "links" }, link(href(["upcoming"]), "Everything scheduled")),
          section("Freshness", freshnessTable(man), "fresh"));
        return { title: "Legislative votes and records", lede: ledeText(ca), body: body };
      });
  }
  function ledeText() {
    return "Bills, roll-call votes, each legislator's record, and what is scheduled next, at the federal, state and county levels. Every record links to its official source and says when that source last changed.";
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

  // ---------- states ----------
  function viewStates() {
    return Promise.all([states(), countyIndex()]).then(function (r) {
      var st = r[0];
      var items = st.map(function (s) {
        return el("li", null, link(href([s.slug]), s.name), " ", el("span", { class: "cov" }, s.coverage === "full" ? "federal, state and county" : "federal only"));
      });
      var body = frag(
        note("California has full coverage: Congress, the Legislature and county boards. Every other state has its congressional delegation and federal votes; state legislature records for those states are not collected yet."),
        el("ul", { class: "plain cols" }, items));
      return { title: "States and counties", lede: "Pick a state, then a county, to see who represents it and how they voted.", body: body };
    });
  }

  function viewState(slug) {
    return Promise.all([states(), usMembers(), manifest(), get("us/latest.json", true)]).then(function (r) {
      var st = r[0], us = r[1], man = r[2];
      var s = st.filter(function (x) { return x.slug === slug; })[0];
      if (!s) return notFound();
      var serving = function (m) { return !m.former && !m.provisional; };
      var sen = us.list.filter(function (m) { return m.body === "us-senate" && m.state === s.code && serving(m); }).sort(function (a, b) { return (a.last || a.name).localeCompare(b.last || b.name); });
      var reps = us.list.filter(function (m) { return m.body === "us-house" && m.state === s.code && serving(m); }).sort(function (a, b) { return (a.district || 0) - (b.district || 0); });
      var former = us.list.filter(function (m) { return m.state === s.code && !serving(m); }).sort(function (a, b) { return (a.left_office || "").localeCompare(b.left_office || ""); });
      var usLatest = rows2objs(r[3]).slice(0, 8);
      var delegation = section("Congressional delegation", frag(
        el("h3", null, "U.S. Senate"),
        el("ul", { class: "plain people" }, sen.map(function (m) { return el("li", null, memberLink(m), el("span", { class: "meta" }, " " + memberLabel(m))); })),
        el("h3", null, "U.S. House"),
        reps.length ? el("ul", { class: "plain people cols" }, reps.map(function (m) { return el("li", null, memberLink(m), el("span", { class: "meta" }, " " + memberLabel(m))); })) : note("No representatives listed."),
        former.length ? frag(el("h3", null, "Left office during the " + ordinal(us.congress) + " Congress"),
          el("ul", { class: "plain people cols" }, former.map(function (m) { return el("li", null, memberLink(m), el("span", { class: "meta" }, " " + memberLabel(m))); }))) : null,
        freshness(man, "congress-legislators", (sourceOf(man, "congress-legislators") || {}).source_updated_at)), "federal");
      if (s.code !== "CA") {
        var body = frag(el("p", { class: "covline" }, badge("federal"), " Coverage for " + s.name + ": congressional delegation and federal roll-call votes. State legislature and county records are collected for California only so far."),
          delegation,
          section("Latest federal votes", el("ul", { class: "plain votes" }, usLatest.map(function (v) { return voteItem(v); })), "latest"),
          el("p", { class: "links" }, link(href(["votes"], { level: "federal" }), "All federal votes"), " · ", link(href(["upcoming"], { level: "federal" }), "Upcoming in Congress")));
        return { title: s.name, lede: "Who represents " + s.name + " in Congress and how the House and Senate have voted.", body: body };
      }
      return Promise.all([caMembers(), countyIndex(), caCounties(), get("us-ca/latest.json", true), get("us-ca/upcoming.json", true), get("us-ca/counties/upcoming.json", true)]).then(function (c) {
        var caSession = c[0].session;
        var ca = c[0], cidx = c[1], geo = c[2], caLatest = rows2objs(c[3]);
        var today = todayISO();
        var up = ((c[4] && c[4].items) || []).filter(function (u) { return ahead(u, today); }).slice(0, 8);
        var vacant = ca.vacant || [];
        function house(body, label) {
          var ms = ca.list.filter(function (m) { return m.body === body && m.active; }).sort(function (a, b) { return a.district - b.district; });
          var seats = {}; ms.forEach(function (m) { seats[m.district] = m; });
          var n = body === "ca-assembly" ? 80 : 40;
          var items = [];
          for (var d = 1; d <= n; d++) {
            var m = seats[d];
            var id = "ca-" + (body === "ca-assembly" ? "asm" : "sen") + "-" + (d < 10 ? "0" + d : d);
            items.push(el("li", null, el("span", { class: "dist" }, (body === "ca-assembly" ? "AD " : "SD ") + d), " ", m ? frag(memberLink(m), el("span", { class: "meta" }, " " + party(m.party))) : el("span", { class: "unk" }, vacant.indexOf(id) >= 0 ? "vacant" : "not listed")));
          }
          return frag(el("h3", null, label), el("ul", { class: "plain people cols" }, items));
        }
        var counties = section("Counties", frag(
          note("Each county page shows who represents it at every level, its board of supervisors, and the board's recent votes where the county publishes them in a machine-readable form."),
          el("ul", { class: "plain cols" }, geo.map(function (g) {
            var e = cidx[g.fips] || {};
            return el("li", null, link(href([slug, g.slug]), g.name), " ", el("span", { class: "cov" }, e.coverage === "votes" ? "board votes" : e.coverage === "agendas" ? "board agendas" : "links"));
          }))), "counties");
        counties.id = "counties";
        var body = frag(
          el("p", { class: "covline" }, badge("federal"), " ", badge("state"), " ", badge("county"), " Full coverage: Congress, the Legislature (" + sessionLabel(caSession) + " session) and county boards."),
          delegation,
          section("California Legislature", frag(house("ca-senate", "State Senate"), house("ca-assembly", "State Assembly"), freshness(man, "ca-leginfo-pubinfo", (sourceOf(man, "ca-leginfo-pubinfo") || {}).source_updated_at),
            el("p", { class: "links" }, link(href(["votes"], { level: "state" }), "All state votes"), " · ", link(href(["bills"], { level: "state" }), "All state bills"))), "state"),
          counties,
          section("Latest votes", el("ul", { class: "plain votes" }, caLatest.slice(0, 6).map(function (v) { v.body = v.body || caBody(v.location); return voteItem(v, cidx, c[3] && c[3].locations); }).concat(usLatest.slice(0, 4).map(function (v) { return voteItem(v); }))), "latest"),
          section("Coming up in Sacramento", up.length ? el("ul", { class: "plain ups" }, up.map(function (u) { return upcomingItem(u, cidx); })) : note("Nothing on the Daily File or committee agendas within the next 45 days."), "upcoming"),
          el("p", { class: "links" }, link(href(["upcoming"]), "Everything scheduled")));
        return { title: "California", lede: "Congress, the Legislature and the 58 county boards: who represents California and how they vote.", body: body };
      });
    });
  }

  // ---------- county ----------
  function viewCounty(stateSlug, countySlug, params) {
    if (stateSlug !== "california") return notFound();
    return Promise.all([caCounties(), countyIndex(), usMembers(), caMembers(), manifest()]).then(function (r) {
      var geo = r[0], cidx = r[1], us = r[2], ca = r[3], man = r[4];
      var g = geo.filter(function (x) { return x.slug === countySlug; })[0];
      if (!g) return notFound();
      return get("us-ca/counties/" + g.fips + "/board.json", true).then(function (board) {
        board = board || {};
        var months = board.vote_months || [];
        var month = params.get("month") || (months.length ? months[months.length - 1].month : null);
        var votesP = month && months.some(function (m) { return m.month === month; }) ? get("us-ca/counties/" + g.fips + "/votes-" + month + ".json", true) : Promise.resolve(null);
        return votesP.then(function (vf) {
          function reps(list, label, keyFn, districts, note2027) {
            var ms = list.filter(function (m) { return districts.indexOf(keyFn(m)) >= 0; }).sort(function (a, b) { return keyFn(a) - keyFn(b); });
            return frag(el("h3", null, label), ms.length ? el("ul", { class: "plain people" }, ms.map(function (m) { return el("li", null, memberLink(m), el("span", { class: "meta" }, " " + memberLabel(m))); })) : note("No current members matched these districts."), note2027 || null);
          }
          var usHouse = us.list.filter(function (m) { return m.body === "us-house" && m.state === "CA" && !m.former && !m.provisional; });
          var caSen = ca.list.filter(function (m) { return m.body === "ca-senate" && m.active; });
          var caAsm = ca.list.filter(function (m) { return m.body === "ca-assembly" && m.active; });
          var cd = g.us_house || {};
          var n27 = cd.from_2027 && cd.from_2027.length && JSON.stringify(cd.from_2027) !== JSON.stringify(cd.current) ? note("From " + fmtDate(cd.effective_2027) + " the county is in congressional district" + (cd.from_2027.length > 1 ? "s " : " ") + cd.from_2027.join(", ") + " under the 2025 map (AB 604).") : null;
          var senators = us.list.filter(function (m) { return m.body === "us-senate" && m.state === "CA" && !m.former && !m.provisional; });
          var represent = section("Who represents " + g.name, frag(
            note("A county can span several districts. For the exact districts of one address, use the Legislature's Find Your Representative tool or the House's Find Your Representative page, both linked at the end of this section."),
            el("div", { class: "lvlblock" }, badge("federal"),
              el("h3", null, "U.S. Senate"), el("ul", { class: "plain people" }, senators.map(function (m) { return el("li", null, memberLink(m), el("span", { class: "meta" }, " " + memberLabel(m))); })),
              reps(usHouse, "U.S. House (district" + (cd.current && cd.current.length > 1 ? "s " : " ") + (cd.current || []).join(", ") + ")", function (m) { return m.district; }, cd.current || [], n27)),
            el("div", { class: "lvlblock" }, badge("state"),
              reps(caSen, "State Senate (district" + (g.ca_senate.length > 1 ? "s " : " ") + g.ca_senate.join(", ") + ")", function (m) { return m.district; }, g.ca_senate),
              reps(caAsm, "State Assembly (district" + (g.ca_assembly.length > 1 ? "s " : " ") + g.ca_assembly.join(", ") + ")", function (m) { return m.district; }, g.ca_assembly)),
            el("div", { class: "lvlblock" }, badge("county"),
              el("h3", null, board.body_name || (g.name + " Board of Supervisors")),
              board.members && board.members.length ? el("ul", { class: "plain people" }, board.members.filter(function (m) { return !m.provisional; }).map(function (m) { return el("li", null, memberLink(m), el("span", { class: "meta" }, " " + (m.title || "Supervisor"))); })) : note("Supervisor names are not published in a machine-readable form by this county; the board page below lists them."),
              el("p", { class: "links" }, board.urls && board.urls.board_url ? ext(board.urls.board_url, "Board of Supervisors") : null, board.urls && board.urls.agenda_url ? [" · ", ext(board.urls.agenda_url, "Agendas and minutes")] : null, board.urls && board.urls.website ? [" · ", ext(board.urls.website, "County website")] : null),
              board.note ? note(board.note) : null,
              board.url_status && /^unreachable/.test(board.url_status) ? el("p", { class: "warn" }, "The county's board page did not respond at the last nightly check (" + board.url_status + ").") : null,
              freshness(man, "county-" + g.fips, (sourceOf(man, "county-" + g.fips) || {}).source_updated_at)),
            el("p", { class: "links" }, ext("https://findyourrep.legislature.ca.gov/", "Find Your Representative (California Legislature)"), " · ", ext("https://www.house.gov/representatives/find-your-representative", "Find Your Representative (U.S. House)"))), "represent");

          var meetings = (board.meetings || []);
          var today = todayISO();
          var upcoming = meetings.filter(function (m) { return m.date >= today; }).sort(function (a, b) { return whenKey(a).localeCompare(whenKey(b)); });
          var held = meetings.filter(function (m) { return m.date < today; });
          var meetSec = section("Board meetings", board.platform === "Legistar" ? frag(
            el("h3", null, "Scheduled"),
            upcoming.length ? el("ul", { class: "plain ups" }, upcoming.map(function (m) { return upcomingItem(Object.assign({ level: "county" }, m), cidx); })) : note("No meetings scheduled in the published calendar."),
            el("h3", null, "Held in the last 90 days"),
            held.length ? el("ul", { class: "plain meets" }, held.map(function (m) { return el("li", null, time(m.date), clockPart(m), m.title && / \(/.test(m.title) ? " · " + m.title.replace(/^.*\((.*)\)$/, "$1") : "", " · " + m.votes + " actions on " + m.items + " agenda items · ", m.minutes_url ? ext(m.minutes_url, "Minutes") : null, m.minutes_url && m.agenda_url ? " · " : null, m.agenda_url ? ext(m.agenda_url, "Agenda") : null, !m.minutes_url && !m.agenda_url ? ext(m.official_url, "Meeting page") : null); })) : note("No meetings in the last 90 days.")) :
            note("Meeting schedules for this county are on its official agenda page linked above; they are not published in a machine-readable form."), "meetings");

          var votesSec;
          if (board.platform === "Legistar") {
            var msel = el("select", { id: "month-pick", name: "month" }, months.slice().reverse().map(function (m) { return el("option", { value: m.month, selected: m.month === month }, fmtMonth(m.month) + " (" + m.votes + ")"); }));
            var picker = months.length ? el("form", { class: "filters", on: { submit: function (ev) { ev.preventDefault(); navigate(href([stateSlug, countySlug], { month: msel.value }) + "#votes", { keepScroll: true }); } } },
              el("label", { for: "month-pick" }, "Month"),
              el("div", { class: "row" }, msel, el("button", { type: "submit", class: "btn" }, "Show"))) : null;
            var vrows = rows2objs(vf);
            var matters = (vf && vf.matters) || {};
            var list = more(vrows, function (v) {
              var m = v.matter_id ? matters[v.matter_id] : null;
              return el("li", { class: "vote" },
                el("div", { class: "vote-head" }, badge("county"), el("span", { class: "when" }, time(v.date)), v.agenda_number ? el("span", { class: "loc" }, "Item " + v.agenda_number) : null),
                el("h3", null, link(voteHref(v.id), (v.question ? v.question.charAt(0).toUpperCase() + v.question.slice(1) : "Vote") + (m && m.label ? " · " + m.label : ""))),
                m && m.title ? el("p", { class: "vt" }, m.title) : null,
                el("p", { class: "res" }, el("b", { class: v.passed ? "pass" : "fail" }, v.passed ? "Passed" : v.passed === false ? "Failed" : v.result), /[^-]/.test(v.positions || "") ? [" · ", tally({ yes: v.yes, no: v.no, other: v.other })] : el("span", { class: "unk" }, " · no roll call recorded")));
            }, { ulClass: "votes", empty: "No recorded votes for this month." });
            votesSec = section("Board votes" + (month ? " · " + fmtMonth(month) : ""), frag(
              note(board.coverage === "votes" ? "Every agenda item the board acted on, with each supervisor's position, from the county's Legistar system. Consent-calendar items are usually approved in one vote." : "This county publishes agendas through Legistar but no per-supervisor vote records."),
              picker, list), "votes");
            votesSec.id = "votes";
          } else {
            votesSec = section("Board votes", note("This county does not publish votes in a machine-readable form. Minutes and agendas are on its official pages linked above."), "votes");
            votesSec.id = "votes";
          }
          var body = frag(
            el("p", { class: "crumb" }, link(href(["states"]), "States"), " › ", link(href([stateSlug]), "California"), " › ", g.name),
            represent, votesSec, meetSec);
          return { title: g.name, lede: "Who represents " + g.name + " in Congress, in Sacramento and on the county board, and how they have voted.", body: body };
        });
      });
    });
  }

  // ---------- id resolution ----------
  function parseCaBill(id) { var m = /^(\d{8})(\d)([A-Z]+)(\d+)$/.exec(id); return m ? { session: m[1], type: m[3], num: +m[4], shard: m[3] + "-" + (Math.floor(m[4] / 100) < 10 ? "0" : "") + Math.floor(m[4] / 100) } : null; }
  function loadBill(id) {
    if (/^us-\d+-/.test(id)) {
      var congress = id.split("-")[1];
      return get("us/bills/" + congress + "/" + id + ".json", true);
    }
    var ca = parseCaBill(id);
    if (ca) return get("us-ca/bills/" + ca.session + "/" + ca.shard + ".json", true).then(function (d) { return d && d.bills[id] || null; });
    return Promise.resolve(null);
  }
  function loadVote(id) {
    if (/^us-(house|senate)-/.test(id)) return get("us/votes/" + id + ".json", true);
    var ca = /^ca-(\d{8}\d[A-Z]+\d+)-/.exec(id);
    if (ca) {
      var bill = parseCaBill(ca[1]);
      return get("us-ca/votes/" + bill.session + "/" + ca[1] + ".json", true).then(function (d) { return d && d.votes.filter(function (v) { return v.id === id; })[0] || null; });
    }
    var co = /^ca-(\d{5})-bos-vote-(\d{4})(\d{2})\d{2}-/.exec(id);
    if (co) {
      return get("us-ca/counties/" + co[1] + "/votes-" + co[2] + "-" + co[3] + ".json", true).then(function (d) {
        if (!d) return null;
        var row = rows2objs(d).filter(function (v) { return v.id === id; })[0];
        if (!row) return null;
        var m = row.matter_id ? d.matters[row.matter_id] : null;
        return { id: id, level: "county", body: "ca-" + co[1] + "-bos", county: co[1], date: row.date, question: row.question, title: m ? (m.label ? m.label + ": " : "") + m.title : "", matter: m,
          result: row.result, passed: row.passed, tally: { yes: row.yes, no: row.no, not_voting: row.other, present: 0 },
          positions: d.members.map(function (mid, i) { return [mid, row.positions.charAt(i) || "-"]; }).filter(function (p) { return p[1] !== "-"; }),
          labels: d.codes, mover: row.mover, seconder: row.seconder, agenda_number: row.agenda_number, meeting_id: row.meeting_id,
          source_updated_at: row.source_updated_at, source: { id: "county-" + co[1] } };
      });
    }
    return Promise.resolve(null);
  }
  function membersFor(level, countyFips) {
    if (level === "federal") return usMembers();
    if (level === "state") return caMembers();
    return get("us-ca/counties/" + countyFips + "/board.json", true).then(function (b) { var by = {}; ((b && b.members) || []).forEach(function (m) { by[m.id] = m; }); return { list: (b && b.members) || [], by: by, board: b }; });
  }

  // ---------- bill ----------
  function viewBill(id) {
    return Promise.all([loadBill(id), manifest(), countyIndex()]).then(function (r) {
      var b = r[0], man = r[1];
      if (!b) return notFound();
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
        var body = frag(
          el("p", { class: "crumb" }, link(href(["bills"], { level: lvl }), lvl === "federal" ? "Federal bills" : "State bills"), " › ", b.label),
          b.summary ? el("p", { class: "lede2" }, b.summary, b.summary_version ? el("span", { class: "unk" }, " (Congressional Research Service summary: " + b.summary_version + ")") : null) : null,
          facts,
          section("Votes on this bill", vl, "votes"),
          b.actions && b.actions.length ? section("Actions", frag(
            el("ul", { class: "plain acts" }, b.actions.map(function (a) { return el("li", null, time(a.date), el("span", null, " · " + a.text)); })),
            b.actions_total > b.actions.length ? el("p", { class: "links" }, ext(b.official_url, "All " + b.actions_total + " actions on Congress.gov")) : null), "actions") : null,
          freshness(man, b.source && b.source.id === "vote-records" ? (b.chamber_of_origin === "us-senate" ? "us-senate-lis" : "us-house-clerk") : (b.source && b.source.id), b.source_updated_at));
        return { title: b.label + (b.title ? ": " + b.title : ""), lede: null, body: body };
      });
    });
  }

  // ---------- vote ----------
  function viewVote(id) {
    return Promise.all([loadVote(id), manifest(), countyIndex()]).then(function (r) {
      var v = r[0], man = r[1], cidx = r[2];
      if (!v) return notFound();
      var lvl = v.level || levelOf(v.body);
      var fips = idOfCounty(v.body);
      return membersFor(lvl, fips).then(function (mem) {
        var positions = v.positions || [];
        var labels = v.labels || {};
        var codeName = function (c) { return cap(labels[c] || ({ Y: "Yes", N: "No", X: "Not voting", P: "Present", A: "Abstain", R: "Recused", O: "Other" })[c] || c); };
        var counts = {};
        positions.forEach(function (p) { counts[p[1]] = (counts[p[1]] || 0) + 1; });
        var codes = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
        var state = { code: "", text: "" };
        var tbody = el("tbody");
        var summary = el("p", { class: "count" });
        function partyOf(m) { return m && m.party ? m.party : ""; }
        function draw() {
          tbody.innerHTML = "";
          var t = state.text.toLowerCase();
          var shown = 0;
          positions.forEach(function (p) {
            var m = mem.by[p[0]];
            var name = m ? m.name : (/^lis-/.test(p[0]) ? "Senator (LIS " + p[0].slice(4) + ")" : p[0]);
            if (state.code && p[1] !== state.code) return;
            if (t && (name + " " + memberLabel(m)).toLowerCase().indexOf(t) < 0) return;
            shown++;
            tbody.appendChild(el("tr", null,
              el("th", { scope: "row" }, m ? link(memberHref(m.id), name) : name),
              el("td", null, party(partyOf(m))),
              el("td", null, m ? (m.body === "us-house" ? m.state + (m.district ? "-" + m.district : "") : m.body === "us-senate" ? m.state : m.district ? (m.body === "ca-assembly" ? "AD " : "SD ") + m.district : (m.title || "")) : ""),
              el("td", null, el("span", { class: "pos pos-" + p[1] }, codeName(p[1])))));
          });
          summary.textContent = shown + " of " + positions.length + " positions shown";
        }
        var filters = el("form", { class: "filters", on: { submit: function (e) { e.preventDefault(); } } },
          el("fieldset", null, el("legend", null, "Show"),
            el("div", { class: "row wrap" },
              el("button", { type: "button", class: "btn", "aria-pressed": "true", on: { click: function (e) { setCode("", e.currentTarget); } } }, "All (" + positions.length + ")"),
              codes.map(function (c) { return el("button", { type: "button", class: "btn", "aria-pressed": "false", dataset: { code: c }, on: { click: function (e) { setCode(c, e.currentTarget); } } }, codeName(c) + " (" + counts[c] + ")"); }))),
          el("label", { for: "pos-q" }, "Filter by name, party or district"),
          el("input", { id: "pos-q", type: "search", autocomplete: "off", on: { input: function (e) { state.text = e.target.value.trim(); draw(); } } }));
        function setCode(c, btn) {
          state.code = c;
          filters.querySelectorAll("button[aria-pressed]").forEach(function (b) { b.setAttribute("aria-pressed", b === btn ? "true" : "false"); });
          draw();
        }
        draw();
        var bill = v.bill_id && /^(us-|\d{8})/.test(v.bill_id) ? link(billHref(v.bill_id), v.bill_label || v.bill_id) : (v.matter && v.matter.official_url ? ext(v.matter.official_url, v.matter.label || "Agenda item") : null);
        var facts = el("dl", { class: "facts" },
          el("div", null, el("dt", null, "Level"), el("dd", null, badge(lvl), " " + bodyName(v.body, cidx), v.location && !v.floor ? " · " + v.location : "")),
          el("div", null, el("dt", null, "When"), el("dd", null, time(v.date, !isDateOnly(v.date)), isDateOnly(v.date) ? clockPart(v) : "", isDateOnly(v.date) && lvl === "state" ? el("span", { class: "unk" }, " (the Legislature records the day, not the time)") : null)),
          el("div", null, el("dt", null, "Result"), el("dd", null, el("b", { class: v.passed ? "pass" : "fail" }, resultWord(v)), v.result && v.result !== resultWord(v) ? " · " + v.result : "", v.vote_type ? " · " + v.vote_type : "")),
          el("div", null, el("dt", null, "Tally"), el("dd", null, tally(v))),
          bill ? el("div", null, el("dt", null, lvl === "county" ? "Agenda item" : "Bill"), el("dd", null, bill, lvl !== "county" && stripLabel(v.title, v.bill_label) ? ": " + stripLabel(v.title, v.bill_label) : lvl === "county" && v.matter && v.matter.title ? ": " + v.matter.title : "")) : (v.title ? el("div", null, el("dt", null, "Subject"), el("dd", null, v.title)) : null),
          v.number ? el("div", null, el("dt", null, "Roll call"), el("dd", null, "No. " + v.number + ", session " + v.session + " of the " + ordinal(v.congress) + " Congress")) : null,
          v.mover ? el("div", null, el("dt", null, "Motion"), el("dd", null, "Moved by " + v.mover + (v.seconder ? ", seconded by " + v.seconder : ""))) : null,
          el("div", null, el("dt", null, "Official record"), el("dd", null, v.official_url ? ext(v.official_url, lvl === "federal" ? (v.body === "us-house" ? "Clerk of the House" : "Senate.gov") : lvl === "state" ? "LegInfo vote history" : "County minutes") : (mem.board && mem.board.urls && mem.board.urls.agenda_url ? ext(mem.board.urls.agenda_url, "County agendas and minutes") : el("span", { class: "unk" }, "not linked")))));
        var parties = {};
        positions.forEach(function (p2) { var m2 = mem.by[p2[0]]; var pa = (m2 && m2.party) || "?"; parties[pa] = parties[pa] || {}; parties[pa][p2[1]] = (parties[pa][p2[1]] || 0) + 1; });
        var partyKeys = Object.keys(parties).sort(function (a, b) { return a === "?" ? 1 : b === "?" ? -1 : a.localeCompare(b); });
        var byParty = lvl !== "county" && partyKeys.length > 1 ? el("table", { class: "tbl byparty" }, el("caption", null, "By party"),
          el("thead", null, el("tr", null, el("th", { scope: "col" }, "Party"), codes.map(function (c) { return el("th", { scope: "col" }, codeName(c)); }))),
          el("tbody", null, partyKeys.map(function (pk) { return el("tr", null, el("th", { scope: "row" }, pk === "?" ? "Unknown" : party(pk)), codes.map(function (c) { return el("td", null, String(parties[pk][c] || 0)); })); }))) : null;
        var table = el("table", { class: "tbl positions" }, el("caption", null, "How each member voted"),
          el("thead", null, el("tr", null, el("th", { scope: "col" }, "Member"), el("th", { scope: "col" }, "Party"), el("th", { scope: "col" }, lvl === "county" ? "Seat" : "State / district"), el("th", { scope: "col" }, "Position"))), tbody);
        var body = frag(
          el("p", { class: "crumb" }, link(href(["votes"], { level: lvl }), LEVEL_NAME[lvl] + " votes"), " › ", v.question || "Vote"),
          facts,
          v.source && v.source.id === "voteview" ? el("p", { class: "note" }, "These positions come from Voteview (UCLA), an academic roll-call database built from the same official records, because the nightly job could not reach senate.gov. The official record is linked above; the next successful check replaces this copy with the Senate's own.") : null,
          section("Positions", positions.length ? frag(byParty, filters, summary, table) : note("No individual positions were recorded for this vote (a voice vote or an unrecorded action)."), "positions"),
          freshness(man, v.source && v.source.id, v.source_updated_at, v.retrieved_at));
        var q = cap(v.question || "Vote");
        return { title: q + (v.bill_label && q.indexOf(v.bill_label) < 0 ? " · " + v.bill_label : lvl === "county" && v.matter && v.matter.label ? " · " + v.matter.label : ""), lede: null, body: body };
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
      m.phone ? el("div", null, el("dt", null, "Office phone"), el("dd", null, el("a", { href: "tel:" + m.phone.replace(/[^\d+]/g, "") }, m.phone))) : null,
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
      li.insertBefore(el("p", { class: "mypos" }, "Position: ", el("span", { class: "pos pos-" + e.code }, e.code === "Y" ? "Yes" : e.code === "N" ? "No" : e.code === "X" ? "Did not vote" : e.code === "P" ? "Present" : e.code)), li.querySelector(".res"));
      return li;
    }, { ulClass: "votes", empty: "No votes match these filters." });
  }
  function summaryLine(counts, total) {
    return el("p", { class: "sum" }, el("b", null, String(total)), " votes recorded: ", el("span", { class: "pos pos-Y" }, counts.Y || 0), " yes, ", el("span", { class: "pos pos-N" }, counts.N || 0), " no, ", el("span", { class: "pos pos-X" }, (counts.X || 0) + (counts.P || 0) + (counts.A || 0) + (counts.O || 0)), " other or not voting.");
  }

  function viewMember(id, params) {
    var lvl = /^ca-(asm|sen)-/.test(id) ? "state" : /^ca-\d{5}-bos-/.test(id) ? "county" : "federal";
    return Promise.all([manifest(), countyIndex(), membersFor(lvl, idOfCounty(id))]).then(function (r) {
      var man = r[0], cidx = r[1], mem = r[2];
      var m = mem.by[id];
      if (!m) return notFound();
      var state = { code: "", text: "", floor: false };
      var facts = memberFacts(m, lvl, man, cidx);
      var head = el("p", { class: "crumb" }, lvl === "federal" ? link(href([m.state === "CA" ? "california" : "states"]), m.state === "CA" ? "California" : "States") : lvl === "state" ? link(href(["california"]), "California") : link(href(["california", (cidx[idOfCounty(id)] || {}).slug || ""]), m.county || "County"), " › ", m.name);

      if (lvl === "federal") {
        var house = m.body === "us-house" ? "house" : "senate";
        return Promise.all([get("us/records/" + house + "-" + mem.congress + ".json", true), get("us/votes/" + mem.congress + "-1-" + house + ".json", true), get("us/votes/" + mem.congress + "-2-" + house + ".json", true)]).then(function (d) {
          var rec = d[0]; var rows = rows2objs(d[1]).concat(rows2objs(d[2])); var byId = {}; rows.forEach(function (v) { byId[v.id] = v; });
          var codes = (rec && rec.members[id]) || "";
          var entries = [], counts = {};
          (rec ? rec.votes : []).forEach(function (vid, i) { var c = codes.charAt(i); if (c && c !== "-" && byId[vid]) { entries.push({ v: byId[vid], code: c }); counts[c] = (counts[c] || 0) + 1; } });
          entries.sort(function (a, b) { return (b.v.date || "").localeCompare(a.v.date || ""); });
          var box = el("div");
          function redraw() { box.innerHTML = ""; box.appendChild(recordList(entries, state, cidx)); }
          redraw();
          var body = frag(head, facts, section("Voting record · " + ordinal(mem.congress) + " Congress", frag(summaryLine(counts, entries.length), recordFilters(state, redraw), box), "record"));
          return { title: m.name, lede: null, body: body };
        });
      }
      if (lvl === "state") {
        var h = m.body === "ca-assembly" ? "assembly" : "senate";
        return caVoteIndex().then(function (idx) {
          var shards = ((idx && idx.shards) || []).filter(function (s) { return s.body === m.body; });
          var years = []; shards.forEach(function (s) { var y = s.month.slice(0, 4); if (years.indexOf(y) < 0) years.push(y); });
          var year = params.get("year") && years.indexOf(params.get("year")) >= 0 ? params.get("year") : years[years.length - 1];
          var months = shards.filter(function (s) { return s.month.slice(0, 4) === year; }).map(function (s) { return s.month; });
          var month = params.get("month") && months.indexOf(params.get("month")) >= 0 ? params.get("month") : months[months.length - 1];
          if (!year) return { title: m.name, lede: null, body: frag(head, facts, note("No votes published for this house yet.")) };
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
            function redraw() { box.innerHTML = ""; box.appendChild(recordList(entries, state, cidx, shard && shard.locations)); }
            redraw();
            var sec = section("Voting record", frag(
              el("p", { class: "sum" }, el("b", null, String(total)), " votes recorded in " + year + " (", el("b", null, String(floorTotal)), " on the floor, the rest in committee): ", el("span", { class: "pos pos-Y" }, counts.Y || 0), " yes, ", el("span", { class: "pos pos-N" }, counts.N || 0), " no, ", el("span", { class: "pos pos-X" }, counts.X || 0), " no vote recorded."),
              pick,
              el("h3", null, fmtMonth(month) + " · " + entries.length + " votes"),
              recordFilters(state, redraw, { floor: true }), box), "record");
            sec.id = "record";
            return { title: m.name, lede: null, body: frag(head, facts, sec) };
          });
        });
      }
      // county supervisor
      var board = mem.board || {};
      var months = (board.vote_months || []).map(function (x) { return x.month; });
      var month = params.get("month") && months.indexOf(params.get("month")) >= 0 ? params.get("month") : months[months.length - 1];
      if (!month) return { title: m.name, lede: null, body: frag(head, facts, note("No recorded votes for this board in the last 90 days.")) };
      return get("us-ca/counties/" + idOfCounty(id) + "/votes-" + month + ".json", true).then(function (vf) {
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
        function redraw() { box.innerHTML = ""; box.appendChild(recordList(entries, state, cidx)); }
        redraw();
        var sec = section("Voting record · " + fmtMonth(month), frag(summaryLine(counts, entries.length), pick, recordFilters(state, redraw), box), "record");
        sec.id = "record";
        return { title: m.name, lede: null, body: frag(head, facts, sec) };
      });
    });
  }

  // ---------- votes browse ----------
  function selectEl(id, label, options, value, onChange) {
    var s = el("select", { id: id, name: id, on: { change: onChange } }, options.map(function (o) { return el("option", { value: o[0], selected: o[0] === value }, o[1]); }));
    return el("div", { class: "field" }, el("label", { for: id }, label), s);
  }
  function viewVotes(p) {
    var level = p.get("level") || "federal";
    return Promise.all([countyIndex(), caVoteIndex(), usMembers()]).then(function (r) {
      var cidx = r[0], caIdx = r[1], us = r[2];
      var congress = us.congress;
      var body = p.get("body"), month = p.get("month"), fips = p.get("county"), text = (p.get("q") || "").toLowerCase(), floorOnly = p.get("floor") === "1", result = p.get("result") || "";
      var loads, locations = null, subtitle = "";
      var form = el("form", { class: "filters", on: { submit: function (e) { e.preventDefault(); apply(); } } });
      function apply() {
        var f = new FormData(form);
        navigate(href(["votes"], { level: f.get("level"), body: f.get("body"), month: f.get("month"), county: f.get("county"), floor: f.get("floor") ? "1" : "", result: f.get("result"), q: f.get("q") }), { keepScroll: true });
      }
      var levelSel = selectEl("level", "Level", [["federal", "Federal (Congress)"], ["state", "State (California Legislature)"], ["county", "County (boards of supervisors)"]], level, function () { form.querySelector("[name=body]") && (form.querySelector("[name=body]").value = ""); apply(); });
      var controls = [levelSel];
      if (level === "federal") {
        body = body || "us-house";
        controls.push(selectEl("body", "Chamber", [["us-house", "U.S. House"], ["us-senate", "U.S. Senate"]], body, apply));
        var sess = p.get("session") || "";
        controls.push(selectEl("session", "Session", [["", "Both sessions"], ["1", "First session (" + congressYear(congress, 1) + ")"], ["2", "Second session (" + congressYear(congress, 2) + ")"]], sess, apply));
        var files = (sess ? [sess] : ["1", "2"]).map(function (s) { return get("us/votes/" + congress + "-" + s + "-" + (body === "us-house" ? "house" : "senate") + ".json", true); });
        loads = Promise.all(files).then(function (ds) { return ds.reduce(function (a, d) { return a.concat(rows2objs(d)); }, []); });
        subtitle = BODY_NAME[body] + ", " + ordinal(congress) + " Congress";
      } else if (level === "state") {
        body = body || "ca-assembly";
        var shards = ((caIdx && caIdx.shards) || []).filter(function (s) { return s.body === body; });
        var months = shards.map(function (s) { return s.month; });
        month = month && months.indexOf(month) >= 0 ? month : months[months.length - 1];
        controls.push(selectEl("body", "House", [["ca-assembly", "California Assembly"], ["ca-senate", "California Senate"]], body, apply));
        controls.push(selectEl("month", "Month", months.slice().reverse().map(function (mo) { var sh = shards.filter(function (s) { return s.month === mo; })[0]; return [mo, fmtMonth(mo) + " (" + sh.votes + ")"]; }), month, apply));
        locations = caIdx && caIdx.locations;
        loads = month ? get("us-ca/votes/" + caIdx.session + "-" + body.split("-")[1] + "-" + month + ".json", true).then(function (d) { return rows2objs(d).map(function (v) { v.body = body; return v; }); }) : Promise.resolve([]);
        subtitle = BODY_NAME[body] + (month ? ", " + fmtMonth(month) : "");
      } else {
        var withVotes = Object.keys(cidx).map(function (k) { return cidx[k]; }).filter(function (c) { return c.coverage === "votes" || c.coverage === "agendas"; }).sort(function (a, b) { return a.county.localeCompare(b.county); });
        fips = fips && cidx[fips] ? fips : (withVotes[0] || {}).fips;
        controls.push(selectEl("county", "County", withVotes.map(function (c) { return [c.fips, c.county + (c.coverage === "votes" ? "" : " (agenda actions, no roll calls)")]; }), fips, function () { form.querySelector("[name=month]") && (form.querySelector("[name=month]").value = ""); apply(); }));
        loads = fips ? get("us-ca/counties/" + fips + "/board.json", true).then(function (b) {
          var months = ((b && b.vote_months) || []).map(function (x) { return x.month; });
          month = month && months.indexOf(month) >= 0 ? month : months[months.length - 1];
          controls.push(selectEl("month", "Month", months.slice().reverse().map(function (mo) { return [mo, fmtMonth(mo)]; }), month, apply));
          subtitle = (b && b.body_name || "") + (month ? ", " + fmtMonth(month) : "");
          if (!month) return [];
          return get("us-ca/counties/" + fips + "/votes-" + month + ".json", true).then(function (vf) {
            return rows2objs(vf).map(function (v) { var mt = v.matter_id ? vf.matters[v.matter_id] : null; return { id: v.id, date: v.date, body: "ca-" + fips + "-bos", question: (v.question ? v.question.charAt(0).toUpperCase() + v.question.slice(1) : "Vote") + (mt && mt.label ? " · " + mt.label : ""), title: mt ? mt.title : "", result: v.result, passed: v.passed, yes: v.yes, no: v.no, other: v.other, bill_id: null, floor: true }; });
          });
        }) : Promise.resolve([]);
      }
      return loads.then(function (rows) {
        var filtered = rows.filter(function (v) {
          if (floorOnly && level === "state" && !v.floor) return false;
          if (result === "passed" && !v.passed) return false;
          if (result === "failed" && v.passed !== false) return false;
          if (text && ((v.question || "") + " " + (v.title || "") + " " + (v.bill_label || "") + " " + (v.bill_id || "")).toLowerCase().indexOf(text) < 0) return false;
          return true;
        });
        filtered.sort(function (a, b) { return (b.date || "").localeCompare(a.date || ""); });
        append(form, el("div", { class: "row wrap" }, controls,
          selectEl("result", "Result", [["", "Any result"], ["passed", "Passed"], ["failed", "Failed"]], result, apply),
          level === "state" ? el("label", { class: "check" }, el("input", { type: "checkbox", name: "floor", checked: floorOnly, on: { change: apply } }), " Floor votes only") : null),
          el("div", { class: "row" }, el("div", { class: "field grow" }, el("label", { for: "votes-q" }, "Filter by question, bill or subject"), el("input", { id: "votes-q", name: "q", type: "search", value: p.get("q") || "", autocomplete: "off" })), el("button", { type: "submit", class: "btn" }, "Apply")));
        var list = more(filtered, function (v) { return voteItem(v, cidx, locations); }, { ulClass: "votes", empty: "No votes match these filters." });
        list.insertBefore(el("h2", { class: "results-h" }, filtered.length.toLocaleString() + (filtered.length === 1 ? " vote" : " votes")), list.firstChild);
        return { title: "Votes", lede: subtitle ? subtitle + ". Use the filters to change level, body, month or result." : "Roll-call and committee votes at every level.", body: frag(form, list) };
      });
    });
  }

  // ---------- bills browse ----------
  function viewBills(p) {
    var level = p.get("level") || "federal";
    var text = (p.get("q") || "").toLowerCase();
    var form = el("form", { class: "filters", on: { submit: function (e) { e.preventDefault(); apply(); } } });
    function apply() {
      var f = new FormData(form);
      navigate(href(["bills"], { level: f.get("level"), type: f.get("type"), status: f.get("status"), q: f.get("q") }), { keepScroll: true });
    }
    var controls = [selectEl("level", "Level", [["federal", "Federal (Congress)"], ["state", "State (California Legislature)"]], level, function () { form.querySelector("[name=type]") && (form.querySelector("[name=type]").value = ""); apply(); })];
    var loads, subtitle;
    if (level === "federal") {
      loads = usMembers().then(function (us) { return get("us/bills/" + us.congress + "/index.json", true).then(function (d) { return rows2objs(d).map(function (b) { return { id: b.id, label: b.label, title: b.title, date: b.latest_action_date, action: b.latest_action, status: null, votes: b.votes, level: "federal" }; }); }); });
      subtitle = "Federal bills with at least one roll-call vote in this Congress. Bills without a recorded vote are on Congress.gov.";
    } else {
      loads = caMembers().then(function (ca) { return ca.session ? get("us-ca/bills/" + ca.session + "/index.json", true).then(function (idx) { return { idx: idx, session: ca.session }; }) : { idx: null }; }).then(function (x) {
        var idx = x.idx;
        if (!idx) return [];
        subtitle = "Every measure of the " + sessionLabel(x.session) + " session, from the Legislature's nightly database.";
        var types = Object.keys(idx.types);
        var type = p.get("type") && types.indexOf(p.get("type")) >= 0 ? p.get("type") : "AB";
        controls.push(selectEl("type", "Measure type", types.map(function (t) { return [t, t + " (" + idx.types[t].bills + ")"]; }), type, apply));
        return get("us-ca/bills/" + x.session + "/" + idx.types[type].file, true).then(function (d) { return rows2objs(d).map(function (b) { return { id: b.id, label: b.label, title: b.title, date: b.latest_action_date, action: null, status: b.status, location: b.location, votes: b.votes, level: "state" }; }); });
      });
    }
    return loads.then(function (rows) {
      var statuses = []; rows.forEach(function (b) { if (b.status && statuses.indexOf(b.status) < 0) statuses.push(b.status); });
      var status = p.get("status") || "";
      if (statuses.length) controls.push(selectEl("status", "Status", [["", "Any status"]].concat(statuses.sort().map(function (s) { return [s, s]; })), status, apply));
      var filtered = rows.filter(function (b) {
        if (status && b.status !== status) return false;
        if (text && ((b.label || "") + " " + (b.title || "") + " " + (b.id || "")).toLowerCase().indexOf(text) < 0) return false;
        return true;
      });
      filtered.sort(function (a, b) { return (b.date || "").localeCompare(a.date || "") || a.label.localeCompare(b.label, undefined, { numeric: true }); });
      append(form, el("div", { class: "row wrap" }, controls),
        el("div", { class: "row" }, el("div", { class: "field grow" }, el("label", { for: "bills-q" }, "Filter by number or title"), el("input", { id: "bills-q", name: "q", type: "search", value: p.get("q") || "", autocomplete: "off" })), el("button", { type: "submit", class: "btn" }, "Apply")));
      var list = more(filtered, function (b) {
        return el("li", { class: "bill" },
          el("div", { class: "vote-head" }, badge(b.level), b.date ? el("span", { class: "when" }, "latest action ", time(b.date)) : null),
          el("h3", null, link(billHref(b.id), b.label), b.title ? ": " + b.title : ""),
          el("p", { class: "vt" }, b.status ? b.status + (b.location ? " · " + b.location : "") : (b.action || ""), " · " + b.votes + (b.votes === 1 ? " recorded vote" : " recorded votes")));
      }, { ulClass: "bills", empty: "No bills match these filters." });
      list.insertBefore(el("h2", { class: "results-h" }, filtered.length.toLocaleString() + (filtered.length === 1 ? " bill" : " bills")), list.firstChild);
      return { title: "Bills", lede: subtitle, body: frag(form, list) };
    });
  }

  // ---------- upcoming ----------
  function viewUpcoming(p) {
    var level = p.get("level") || "";
    return Promise.all([get("us/upcoming.json", true), get("us-ca/upcoming.json", true), get("us-ca/counties/upcoming.json", true), countyIndex(), manifest()]).then(function (r) {
      var cidx = r[3], man = r[4];
      var today = todayISO();
      var items = ((r[0] && r[0].items) || []).concat((r[1] && r[1].items) || [], ((r[2] && r[2].items) || []).map(function (m) { return Object.assign({ level: "county" }, m); }))
        .filter(function (u) { return ahead(u, today) && (!level || (u.level || levelOf(u.body)) === level); })
        .sort(function (a, b) { return whenKey(a).localeCompare(whenKey(b)) || (a.title || "").localeCompare(b.title || ""); });
      var form = el("form", { class: "filters", on: { submit: function (e) { e.preventDefault(); } } },
        el("div", { class: "row wrap" }, selectEl("level", "Level", [["", "All levels"], ["federal", "Federal"], ["state", "State"], ["county", "County"]], level, function (e) { navigate(href(["upcoming"], { level: e.target.value }), { keepScroll: true }); })));
      var groups = [];
      items.forEach(function (u) { var g = groups[groups.length - 1]; if (!g || g.date !== u.date) { g = { date: u.date, items: [] }; groups.push(g); } g.items.push(u); });
      var body = frag(
        note("What the official feeds list as scheduled: the House floor for the week, Senate hearings and floor items, California's Daily File and committee hearings within 45 days, and county board meetings. Federal times are Eastern; California and county times are Pacific."),
        form,
        groups.length ? groups.map(function (g) { return section(fmtDate(g.date), el("ul", { class: "plain ups" }, g.items.map(function (u) { return upcomingItem(u, cidx); })), "day"); }) : note("Nothing scheduled in the published feeds."),
        el("p", { class: "fresh" }, ["docs-house-floor", "senate-schedules", "senate-daily-press", "ca-leginfo-pubinfo"].map(function (sid) { var s = sourceOf(man, sid); return s ? el("span", null, s.name + ": checked ", time(s.last_checked_at, true), s.status !== "ok" ? " (" + statusWord(s) + ")" : "", ". ") : null; })));
      return { title: "Upcoming", lede: "Votes, hearings and meetings scheduled at the federal, state and county levels.", body: body };
    });
  }

  // ---------- search ----------
  function viewSearch(query) {
    var qv = document.getElementById("q"); if (qv) qv.value = query;
    var terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return { title: "Search", lede: "Type a bill number, a subject, or a legislator's name.", body: note("Try “AB 1”, “wildfire”, “Padilla” or “S. 2403”.") };
    return Promise.all([get("search/us.json", true), get("search/us-ca.json", true), states(), caCounties(), countyIndex()]).then(function (r) {
      var rows = rows2objs(r[0]).concat(rows2objs(r[1]));
      var st = r[2], geo = r[3], cidx = r[4];
      function hit(text) { var t = text.toLowerCase(); return terms.every(function (w) { return t.indexOf(w) >= 0; }); }
      var members = [], bills = [];
      rows.forEach(function (x) {
        if (!hit(x.label + " " + x.meta + " " + x.id)) return;
        (x.type === "member" ? members : bills).push(x);
      });
      var places = st.filter(function (s) { return hit(s.name); }).map(function (s) { return el("li", null, link(href([s.slug]), s.name), el("span", { class: "meta" }, " state")); })
        .concat(geo.filter(function (g) { return hit(g.name); }).map(function (g) { return el("li", null, link(href(["california", g.slug]), g.name), el("span", { class: "meta" }, " California county")); }));
      var supers = [];
      Object.keys(cidx).forEach(function (f) { var c = cidx[f]; if (c.coverage && c.members && hit(c.county)) supers.push(c); });
      var body = frag(
        places.length ? section("Places", el("ul", { class: "plain people" }, places), "places") : null,
        section("Legislators", members.length ? el("ul", { class: "plain people" }, members.slice(0, 100).map(function (m) { return el("li", null, badge(levelOf(m.body)), " ", link(memberHref(m.id), m.label), el("span", { class: "meta" }, " " + m.meta + " · " + bodyName(m.body))); })) : note("No legislators match."), "people"),
        section("Bills", bills.length ? el("ul", { class: "plain bills" }, bills.slice(0, 100).map(function (b) { return el("li", null, badge(levelOf(b.body)), " ", link(billHref(b.id), b.label), b.meta ? el("span", { class: "meta" }, " · " + b.meta) : null); })) : note("No bills match."), "bills"),
        members.length > 100 || bills.length > 100 ? note("Showing the first 100 in each group; add a word to narrow the search.") : null,
        note("County supervisors and agenda items are searched on each county's page."));
      return { title: "Search: " + query, lede: (members.length + bills.length + places.length) + " results for “" + query + "”", body: body };
    });
  }

  // ---------- sources ----------
  function viewSources() {
    return Promise.all([manifest(), countyIndex()]).then(function (r) {
      var man = r[0], cidx = r[1];
      var srcs = man.sources || {};
      var counties = Object.keys(srcs).filter(function (k) { return /^county-/.test(k); }).sort(function (a, b) { return srcs[a].name.localeCompare(srcs[b].name); });
      var ctable = el("table", { class: "tbl" }, el("caption", null, "County boards of supervisors"),
        el("thead", null, el("tr", null, el("th", { scope: "col" }, "County"), el("th", { scope: "col" }, "What is collected"), el("th", { scope: "col" }, "Status"), el("th", { scope: "col" }, "Last checked"), el("th", { scope: "col" }, "Source updated"))),
        el("tbody", null, counties.map(function (k) {
          var s = srcs[k]; var c = cidx[k.slice(7)] || {};
          return el("tr", null, el("th", { scope: "row" }, c.slug ? link(href(["california", c.slug]), c.county || s.name) : s.name, " ", s.url ? ext(s.url, "official page") : null), el("td", null, c.coverage === "votes" ? "meetings, agenda items and each supervisor's vote (Legistar)" : c.coverage === "agendas" ? "meetings and agenda items (Legistar), no per-member votes" : "links only (" + (c.platform || "county site") + ")"), el("td", null, el("span", { class: "st st-" + s.status }, statusWord(s)), s.error ? el("span", { class: "unk" }, " · " + s.error) : null), el("td", null, s.last_checked_at ? time(s.last_checked_at, true) : "never"), el("td", null, s.source_updated_at ? time(s.source_updated_at, true) : el("span", { class: "unk" }, "not stated")));
        })));
      var body = frag(
        el("p", null, "Everything in this section comes from official government publications, collected once a night by a scheduled job and published as static files. Nothing is edited by hand. When a source is down the job keeps the last good copy and marks it stale here; a feed that returns far fewer records than the night before is rejected rather than published."),
        freshnessTable(man),
        ctable,
        section("Method notes", el("ul", null,
          el("li", null, "Federal roll calls come from the Clerk of the House (evs XML) and the Senate Legislative Information System (vote XML). Members are matched by Bioguide ID through the public-domain congress-legislators dataset and the Senate's own member file. If senate.gov refuses the nightly job, votes already published stay, and new Senate votes are filled in from Voteview (UCLA) and labelled as such until the Senate's copy can be fetched."),
          el("li", null, "Federal bill details (sponsor, cosponsors, committees, summary, actions) come from GovInfo's Bill Status files, published by the Government Publishing Office and the Library of Congress. GovInfo can trail Congress.gov by a day or two for Senate actions; vote results always come from the roll calls."),
          el("li", null, "Upcoming Senate floor votes come from the Senate Daily Press Gallery's floor log, the only published source that names them; it is text, shown as written and linked. The House's come from the Majority Leader's weekly floor schedule on docs.house.gov."),
          el("li", null, "California bills, floor and committee votes, legislators and the Daily File come from the Legislature's nightly database export (LegInfo “pubinfo”). The export records the day of a vote but not the time of day. “No vote recorded” covers absent, abstaining and not-voting members alike, as the Legislature records it."),
          el("li", null, "Counties: 17 boards publish through Granicus Legistar, whose public API gives meetings, agenda items and, for most, each supervisor's vote; those are collected for the last 90 days. The other counties are linked to their official board and agenda pages, which are checked nightly. Their votes are only in minutes documents or on platforms that ask automated tools not to collect them."),
          el("li", null, "Which state and federal districts overlap a county comes from the Census Bureau's 2024 relationship files and, for the congressional map that applies from January 2027, the Senate Elections Committee's AB 604 block equivalency file."),
          el("li", null, "Times are shown in Pacific Time with the zone marked. Each record shows when its source last changed and when this site last checked it."))),
        el("p", { class: "links" }, ext("https://github.com/nbonasera/studenttrustee-websites", "The pipeline's source code")));
      return { title: "Sources and freshness", lede: "Where every record comes from, and when each source was last checked.", body: body };
    });
  }

  route();
})();
