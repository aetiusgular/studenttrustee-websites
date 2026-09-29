"use strict";
/* studenttrustee.net district map. Loaded after vendor/leaflet. The roster is
   stamped into the page by tools/build.py as <script type="application/json"
   id="roster"> from data/roster.json, so this file never changes when the
   roster does. */
const DATA = JSON.parse(document.getElementById("roster").textContent);
const ALLOW_EMAILS = true;

const REGIONS = ["I","II","III","IV","V","VI","VII","VIII","IX","X"];
const REGION_NAME = {
  I:"Far North", II:"Sacramento & North Valley", III:"East & North Bay",
  IV:"South Bay & Central Coast", V:"Central Valley", VI:"South Central Coast",
  VII:"Los Angeles", VIII:"Orange County & San Gabriel", IX:"Inland Empire & Desert",
  X:"San Diego & Imperial"
};
/* District outlines are a static snapshot (tools/legislation/boundaries.py)
   served from this site's own CDN. The live ArcGIS query took 2.5 to 3.5 s of
   server time per visit and was cacheable for 30 s; this file is ~90 KB
   compressed and arrives in tens of milliseconds. */
const BOUNDARY_URL = "/data/districts.geojson";

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const regionColor = (r) => css("--r" + (REGIONS.indexOf(r) + 1));

/* ---------- name matching ---------- */
const STOP = new Set(["community","college","colleges","district","districts","ccd","joint",
  "county","area","the","of","junior","unified","and"]);
function norm(s){
  return (s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase().replace(/[^a-z0-9]+/g," ")
    .split(" ").filter(Boolean)
    .map(w => w==="mount"?"mt":(w==="saint"?"st":w))
    .filter(w => !STOP.has(w)).join(" ");
}
const byNorm = new Map(), byCompact = new Map();
DATA.districts.forEach(d => {
  d.key = norm(d.name);
  byNorm.set(d.key, d);
  byCompact.set(d.key.replace(/ /g, ""), d);   // "Foothill-DeAnza" vs "Foothill-De Anza"
});
function matchDistrict(raw){
  const k = norm(raw);
  if (byNorm.has(k)) return byNorm.get(k);
  const kc = k.replace(/ /g, "");
  if (byCompact.has(kc)) return byCompact.get(kc);
  const kt = new Set(k.split(" "));
  let best = null, bestScore = 0;
  for (const d of DATA.districts){
    const dt = new Set(d.key.split(" "));
    let inter = 0; kt.forEach(t => { if (dt.has(t)) inter++; });
    const score = inter / new Set([...kt, ...dt]).size;
    if (score > bestScore){ bestScore = score; best = d; }
  }
  return bestScore >= 0.55 ? best : null;
}

/* ---------- geometry helpers ---------- */
function ringCentroid(ring){
  let a = 0, x = 0, y = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++){
    const f = ring[j][0]*ring[i][1] - ring[i][0]*ring[j][1];
    a += f; x += (ring[j][0]+ring[i][0])*f; y += (ring[j][1]+ring[i][1])*f;
  }
  if (!a) return ring[0] ? [ring[0][0], ring[0][1]] : null;
  return [x/(3*a), y/(3*a)];
}
function ringArea(ring){
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    a += ring[j][0]*ring[i][1] - ring[i][0]*ring[j][1];
  return Math.abs(a/2);
}
function bestCentroid(geom){
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  let best = null, bestA = -1;
  for (const p of polys){
    const a = ringArea(p[0]);
    if (a > bestA){ bestA = a; best = p[0]; }
  }
  const c = best && ringCentroid(best);
  return c ? [c[1], c[0]] : null;   // [lat, lng]
}

/* ---------- map ---------- */
const map = L.map("map", { zoomControl:false, minZoom:5, maxZoom:13, preferCanvas:true })
  .setView([37.3, -119.4], 6);
L.control.zoom({ position:"bottomright" }).addTo(map);
map.createPane("labels"); map.getPane("labels").style.zIndex = 640;
map.getPane("labels").style.pointerEvents = "none";
map.createPane("chips"); map.getPane("chips").style.zIndex = 660;

let baseLayer = null, labelLayer = null;
/* CARTO began requiring an API key on its raster basemaps and is retiring them;
   unkeyed tiles come back stamped "API KEY REQUIRED". Esri's Light Gray Canvas
   is the closest match to the Positron look we had, needs no key, and keeps the
   city labels that orient people. Attribution below is the required one. */
const BASE_URL  = "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}";
const LABEL_URL = "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}";
function setBasemap(){
  if (baseLayer) map.removeLayer(baseLayer);
  if (labelLayer) map.removeLayer(labelLayer);
  const attr = 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &middot; sources: Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &middot; district boundaries: Foundation for California Community Colleges';
  /* Two raster layers (base + labels) means every zoom fires two full sets of
     tile requests, and on a retina screen each tile is 4x the pixels. Fetching
     mid-animation is what leaves black gaps while the zoom is still moving:
     updateWhenZooming defers the requests to the end of the gesture, and
     keepBuffer holds a ring of tiles outside the viewport so there is something
     to show in the meantime. */
  /* Esri serves one tile per zoom level with no retina variant and no
     subdomains, so this is already half the requests the two CARTO layers made.
     updateWhenZooming defers fetches to the end of the gesture and keepBuffer
     holds a ring of tiles outside the viewport, which is what stops the black
     gaps mid-zoom. */
  const tileOpts = { maxZoom:16, updateWhenZooming:false, keepBuffer:3, crossOrigin:true };
  baseLayer = L.tileLayer(BASE_URL,
    Object.assign({ attribution: attr }, tileOpts)).addTo(map);
  labelLayer = L.tileLayer(LABEL_URL,
    Object.assign({ pane:"labels", opacity:.9 }, tileOpts)).addTo(map);
}
setBasemap();

/* ---------- state ---------- */
const active = new Set(REGIONS);
let query = "";
let showEmails = true;
const slug = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"")
  .replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
const bySlug = new Map(DATA.districts.map(d => [slug(d.name), d]));
const layers = new Map();   // district name -> {poly, chip}
const regionLabels = [];
let usingFallback = false;

/* ---------- popup ---------- */
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function popupHTML(d){
  const sw = `<span class="sw" style="background:${regionColor(d.region)}"></span>`;
  const people = d.trustees.map(p => `
    <div class="who">
      <div class="n">${esc(p.first)} ${esc(p.last)}</div>
      <dl class="kv">
        ${showEmails ? (p.email ? `<dt>Email</dt><dd><a href="mailto:${esc(p.email)}">${esc(p.email)}</a></dd>` : `<dt>Email</dt><dd class="unk">Not listed yet</dd>`) : ""}
        <dt>District</dt><dd>${esc(p.district)}</dd>
        ${p.college ? `<dt>College</dt><dd>${esc(p.college)}</dd>` : ""}
      </dl>
    </div>`).join("");
  const hid = (ALLOW_EMAILS && !showEmails && d.trustees.length)
    ? '<div class="hid">Contact info hidden &middot; enable “Show contact info” in the top bar.</div>' : "";
  return `<div class="pop">
    <div class="rg">${sw} Region ${d.region} &middot; ${esc(REGION_NAME[d.region])}</div>
    <h3>${esc(d.name)}</h3>
    <p class="cols">${d.colleges.map(esc).join(" &middot; ")}</p>
    ${people || (d.seat === "vacant"
      ? `<div class="none">The district lists this seat as vacant.${d.seatSource ? ` <a href="${esc(d.seatSource)}" target="_blank" rel="noopener">Board page &#8599;</a>` : ""}</div>`
      : '<div class="none">No student trustee listed in this roster.</div>')}
    ${hid}
    ${d.web ? `<div class="links">
      <a href="${esc(d.web)}" target="_blank" rel="noopener">District website ↗</a>
      <a href="${esc(d.board)}" target="_blank" rel="noopener">Board of Trustees ↗</a>
    </div>` : ""}
    <div class="share">
      <button type="button" data-share="${esc(slug(d.name))}">Copy link to this district</button>
      <span class="hid" data-share-msg></span>
    </div>
  </div>`;
}

/* ---------- styling ---------- */
function visible(d){
  if (!active.has(d.region)) return false;
  if (!query) return true;
  const hay = (d.name + " " + d.region + " " + d.colleges.join(" ") + " " +
    d.trustees.map(p => p.first + " " + p.last + " " + p.email + " " + p.college).join(" ")).toLowerCase();
  return hay.includes(query);
}
function polyStyle(d, hover){
  const on = visible(d);
  const c = d.trustees.length ? regionColor(d.region) : css("--none");
  return {
    color: c,
    weight: hover ? 2.6 : 1.2,
    opacity: on ? (hover ? 1 : .85) : .12,
    fillColor: c,
    fillOpacity: on ? (hover ? .55 : (d.trustees.length ? .34 : .12)) : .03,
  };
}
/* The map renders to canvas (preferCanvas), which is right for 72 multipolygons
   but means CSS can't transition individual districts. So isolating a region is
   tweened in JS instead: 220ms of interpolated opacity, one canvas redraw per
   frame. Typing in the search box does NOT animate — search should feel instant. */
const lastStyle = new Map();
let tweenRAF = null;
function reduceMotion(){
  return !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
}
function applyPolyStyles(animate){
  const jobs = [];
  for (const [name, o] of layers){
    if (!o.poly) continue;
    const to = polyStyle(o.d, false);
    const from = lastStyle.get(name) || { opacity: to.opacity, fillOpacity: to.fillOpacity };
    jobs.push([o, name, from, to]);
  }
  if (tweenRAF){ cancelAnimationFrame(tweenRAF); tweenRAF = null; }
  // document.hidden: rAF is paused in a background tab, which would freeze the
  // tween on its first frame and leave districts at the wrong opacity.
  if (!animate || reduceMotion() || document.hidden){
    for (const [o, name, , to] of jobs){
      o.poly.setStyle(to);
      lastStyle.set(name, { opacity: to.opacity, fillOpacity: to.fillOpacity });
    }
    return;
  }
  const t0 = performance.now(), D = 220;
  (function step(now){
    const k = Math.min(1, (now - t0) / D), e = k * (2 - k);   // ease-out quad
    for (const [o, name, from, to] of jobs){
      const op = from.opacity + (to.opacity - from.opacity) * e;
      const fo = from.fillOpacity + (to.fillOpacity - from.fillOpacity) * e;
      o.poly.setStyle(Object.assign({}, to, { opacity: op, fillOpacity: fo }));
      lastStyle.set(name, { opacity: op, fillOpacity: fo });   // so an interrupted tween resumes from where it looks
    }
    tweenRAF = k < 1 ? requestAnimationFrame(step) : null;
  })(t0);
}
function refresh(animate){
  applyPolyStyles(animate === true);
  for (const [, o] of layers){
    if (o.chip){
      const el = o.chip.getElement();
      if (el) el.style.opacity = visible(o.d) ? 1 : .18;
    }
  }
  renderList();
  updateZoomLayers();
}

/* ---------- build map layers ---------- */
function addDistrict(d, geom){
  const o = { d, poly:null, chip:null };
  let center = [d.lat, d.lng];
  if (geom){
    /* smoothFactor is a simplification tolerance in pixels: HIGHER means fewer
       points drawn. The 72 districts carry ~23,000 coordinates between them
       (Mendocino-Lake's coastline alone is 1,746), and all of them are redrawn
       on every zoom frame. 0.6 was below Leaflet's default of 1.0, so it was
       keeping more detail than stock and paying for it on every frame. */
    o.poly = L.geoJSON(geom, { style: polyStyle(d, false), smoothFactor: 2 }).addTo(map);
    o.poly.on("mouseover", () => o.poly.setStyle(polyStyle(d, true)));
    o.poly.on("mouseout",  () => o.poly.setStyle(polyStyle(d, false)));
    o.poly.on("click", (e) => openDistrict(d, e.latlng));
    const c = bestCentroid(geom);
    if (c) center = c;
  }
  o.center = center;
  const n = d.trustees.length;
  const bg = n ? regionColor(d.region) : css("--none");
  o.chip = L.marker(center, {
    pane: "chips",
    icon: L.divIcon({
      className: "",
      html: `<div class="dchip${n?"":" none"}" style="box-shadow:0 0 0 2px ${bg}" title="${esc(d.name)}">${d.region}${n>1?`<span class="ct">${n}</span>`:""}</div>`,
      iconSize: null, iconAnchor: [12, 10],
    }),
    riseOnHover: true, keyboard: false,
  }).addTo(map);
  o.chip.on("click", () => openDistrict(d, center));
  layers.set(d.name, o);
}

function openDistrict(d, latlng){
  L.popup({ maxWidth: 340, autoPanPadding:[30,30] })
    .setLatLng(latlng || layers.get(d.name).center)
    .setContent(popupHTML(d))
    .openOn(map);
  syncHash({ d: slug(d.name) });
}

/* ---------- deep links ---------- */
function syncHash(extra){
  const o = Object.assign({
    r: active.size === 1 ? [...active][0] : "",
    q: query || "",
  }, extra || {});
  const parts = [];
  if (o.d) parts.push("d=" + o.d);
  if (o.r) parts.push("r=" + o.r);
  if (o.q) parts.push("q=" + encodeURIComponent(o.q));
  history.replaceState(null, "", parts.length ? "#" + parts.join("&") : location.pathname + location.search);
}
function readHash(){
  const o = {};
  location.hash.replace(/^#/, "").split("&").filter(Boolean).forEach(kv => {
    const i = kv.indexOf("="); if (i < 0) return;
    o[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
  });
  return o;
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-share]");
  if (!b) return;
  const url = location.href.split("#")[0] + "#d=" + b.dataset.share;
  const msg = b.parentElement.querySelector("[data-share-msg]");
  const done = (t) => { if (msg){ msg.textContent = t; msg.setAttribute("role", "status"); } };
  if (navigator.clipboard && navigator.clipboard.writeText)
    navigator.clipboard.writeText(url).then(() => done("Copied to clipboard"), () => done(url));
  else done(url);
});

function buildRegionLabels(){
  regionLabels.forEach(m => map.removeLayer(m));
  regionLabels.length = 0;
  for (const r of REGIONS){
    const pts = DATA.districts.filter(d => d.region === r)
      .map(d => layers.get(d.name)?.center).filter(Boolean);
    if (!pts.length) continue;
    const lat = pts.reduce((a,p)=>a+p[0],0)/pts.length;
    const lng = pts.reduce((a,p)=>a+p[1],0)/pts.length;
    const m = L.marker([lat,lng], {
      pane:"labels", interactive:false, keyboard:false,
      icon: L.divIcon({ className:"", iconSize:null, iconAnchor:[45,16],
        html:`<div class="rlab">REGION ${r}<i>${REGION_NAME[r]}</i></div>` })
    });
    regionLabels.push(m);
  }
  updateZoomLayers();
}

function updateZoomLayers(){
  const z = map.getZoom();
  const showRegion = z < 8;
  regionLabels.forEach(m => { showRegion ? m.addTo(map) : map.removeLayer(m); });
  for (const [, o] of layers){
    const el = o.chip && o.chip.getElement();
    if (el) el.style.display = (!showRegion || !o.poly) ? "" : "none";
  }
}
map.on("zoomend", updateZoomLayers);

/* ---------- sidebar ---------- */
function renderList(){
  const list = document.getElementById("list");
  const frag = document.createDocumentFragment();
  for (const r of REGIONS){
    const ds = DATA.districts.filter(d => d.region === r && visible(d));
    if (!ds.length) continue;
    const h = document.createElement("h3");
    h.textContent = `Region ${r} · ${REGION_NAME[r]}`;
    frag.appendChild(h);
    for (const d of ds){
      const b = document.createElement("button");
      b.type = "button";
      b.className = "drow" + (d.trustees.length ? "" : " empty");
      const names = d.trustees.map(p => `${p.first} ${p.last}`).join(", ");
      b.innerHTML = `<span class="bar" style="background:${d.trustees.length?regionColor(r):css("--none")}"></span>
        <span class="t">
          <span class="nm">${esc(d.name)}</span>
          <span class="sub">${names ? esc(names) : "No student trustee listed"}</span>
        </span>`;
      b.onclick = () => focusDistrict(d);
      frag.appendChild(b);
    }
  }
  if (!frag.childNodes.length){
    const p = document.createElement("p");
    p.className = "nomatch";
    p.textContent = "No matches.";
    frag.appendChild(p);
  }
  list.replaceChildren(frag);
}

function focusDistrict(d){
  const o = layers.get(d.name);
  if (o && o.poly){
    map.fitBounds(o.poly.getBounds(), { padding:[70,70], maxZoom:11 });
    setTimeout(() => openDistrict(d), 260);
  } else {
    map.setView(o ? o.center : [d.lat,d.lng], 10);
    setTimeout(() => openDistrict(d), 260);
  }
  if (window.innerWidth <= 860) document.getElementById("side").classList.remove("on");
}

function renderChips(){
  const wrap = document.getElementById("chips");
  wrap.replaceChildren();
  for (const r of REGIONS){
    const n = DATA.districts.filter(d => d.region===r).reduce((a,d)=>a+d.trustees.length,0);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip"; b.setAttribute("aria-pressed", active.has(r));
    b.innerHTML = `<span class="sw" style="background:${regionColor(r)}"></span><span>Region ${r}</span><span class="n">${n}</span>`;
    b.onclick = (e) => {
      if (active.size === REGIONS.length && !e.shiftKey){ active.clear(); active.add(r); }
      else if (active.has(r)){ active.delete(r); if (!active.size) REGIONS.forEach(x=>active.add(x)); }
      else active.add(r);
      renderChips(); refresh(true); syncHash({ d:"" });
    };
    wrap.appendChild(b);
  }
}

/* ---------- table view ---------- */
function renderTable(){
  const rows = [];
  for (const d of DATA.districts)
    for (const p of d.trustees)
      rows.push({ ...p, region:d.region });
  rows.sort((a,b) => a.last.localeCompare(b.last));
  document.getElementById("t-count").textContent = `${rows.length} people · ${DATA.districts.length} districts`;
  document.getElementById("tbl").innerHTML =
    `<thead><tr><th>Region</th><th>First name</th><th>Last name</th>${showEmails?"<th>Email</th>":""}<th>District</th><th>College</th></tr></thead><tbody>` +
    rows.map(r => `<tr>
      <td class="rgc"><span class="sw-dot" style="background:${regionColor(r.region)}"></span>${r.region}</td>
      <td>${esc(r.first)}</td><td>${esc(r.last)}</td>
      ${showEmails ? (r.email ? `<td><a href="mailto:${esc(r.email)}" style="color:var(--accent);text-decoration:none">${esc(r.email)}</a></td>` : `<td><span class="unk">&mdash;</span></td>`) : ""}
      <td>${esc(r.district)}</td><td>${r.college ? esc(r.college) : "<span class=\"unk\">—</span>"}</td></tr>`).join("") + "</tbody>";
}

/* ---------- boot ---------- */
const intro = document.getElementById("intro");
function closeIntro(){
  if (intro.open) intro.close();
  intro.classList.add("off");
}
document.getElementById("intro-go").onclick = closeIntro;
intro.addEventListener("close", () => { intro.classList.add("off"); document.getElementById("q").focus(); });
/* Show the intro at once (not after the boundaries arrive) unless the visitor
   followed a deep link, in which case they already know what the page is. */
if (location.hash.replace(/^#/, "")) closeIntro();
else if (typeof intro.showModal === "function") intro.showModal();
else intro.setAttribute("open", "");

document.getElementById("q").addEventListener("input", (e) => {
  query = e.target.value.trim().toLowerCase(); refresh(); syncHash({ d:"" });
});
document.getElementById("reset").onclick = () => {
  REGIONS.forEach(r => active.add(r));
  document.getElementById("q").value = ""; query = "";
  renderChips(); refresh(true); syncHash({ d:"" });
  map.setView([37.3,-119.4], 6);
};
document.getElementById("btn-side").onclick = (e) => {
  const on = document.getElementById("side").classList.toggle("on");
  e.currentTarget.setAttribute("aria-expanded", on);
};
const sheet = document.getElementById("sheet"), btnTable = document.getElementById("btn-table");
btnTable.onclick = () => {
  const on = !sheet.classList.contains("on");
  sheet.classList.toggle("on", on); btnTable.setAttribute("aria-pressed", on);
};
document.getElementById("t-close").onclick = () => {
  sheet.classList.remove("on"); btnTable.setAttribute("aria-pressed", false);
};
if (!ALLOW_EMAILS){
  showEmails = false;
  document.getElementById("q").placeholder = "Search trustee, district, college…";
}

function banner(text, kind){
  const b = document.getElementById("banner");
  if (!text){ b.style.display = "none"; return; }
  b.style.display = "flex";
  b.className = "banner" + (kind === "err" ? " err" : "");
  b.innerHTML = (kind ? "" : '<span class="spin"></span>') + `<span>${text}</span>`;
  if (kind === "err"){
    const x = document.createElement("button");
    x.type = "button"; x.className = "btn"; x.textContent = "Dismiss";
    x.onclick = () => b.style.display = "none";
    b.appendChild(x);
  }
}

async function loadBoundaries(){
  const res = await fetch(BOUNDARY_URL, { credentials:"same-origin" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const gj = await res.json();
  if (!gj.features || !gj.features.length) throw new Error("no features in boundary file");
  return gj;
}

/* ---------- reveal ----------
   Districts fade in north to south over ~850ms. The delay is per element and is
   cleared once the reveal is done, so the region-filter crossfade that uses the
   same properties later isn't dragged behind a stale transition-delay. */
/* Only arm the reveal when we actually intend to play it. A hidden tab pauses
   both rAF and CSS transitions, so arming there could leave the map hidden until
   the tab is focused; not arming means there is nothing to go wrong. */
function armReveal(){
  if (reduceMotion() || document.hidden) return false;
  document.body.classList.add("reveal-armed");
  return true;
}
function revealDistricts(){
  if (!document.body.classList.contains("reveal-armed")) return;
  const els = [];
  for (const [, o] of layers){
    const lat = (o.center && o.center[0]) || 0;
    const ce = o.chip && o.chip.getElement();
    const chip = ce && ce.querySelector(".dchip");
    if (chip) els.push([lat, chip]);
  }
  /* Once the reveal has played, take the classes back off. Leaving them on would
     leave a permanent `transition: opacity` on the boundary canvas and on all 72
     chips, which is dead weight on every subsequent zoom. */
  const finish = () => {
    els.forEach(([, e]) => { e.style.transitionDelay = ""; });
    document.body.classList.remove("reveal-armed", "reveal-on");
  };
  if (!els.length){ document.body.classList.add("reveal-on"); finish(); return; }

  els.sort((a, b) => b[0] - a[0]);          // Del Norte first, Imperial last
  const SPAN = 850;
  els.forEach(([, e], i) => { e.style.transitionDelay = Math.round(i / els.length * SPAN) + "ms"; });
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.body.classList.add("reveal-on");
    setTimeout(finish, SPAN + 700);
  }));
}

(async function init(){
  renderChips(); renderTable();
  if (armReveal()){
    // failsafe: if anything below throws, the map must not stay invisible
    setTimeout(() => {
      if (document.body.classList.contains("reveal-armed")) document.body.classList.add("reveal-on");
    }, 4000);
  }
  let gj = null;
  try { gj = await loadBoundaries(); }
  catch (err){ usingFallback = true; console.warn("boundary load failed:", err); }

  const used = new Set(); const unmatched = [];
  if (gj){
    for (const f of gj.features){
      // the snapshot carries the roster's own district name; fall back to fuzzy matching on the source name
      const raw = f.properties.district || f.properties.DistrictNa || f.properties.ShortName || "";
      const d = byNorm.get(norm(raw)) || matchDistrict(raw);
      if (!d){ unmatched.push(raw); continue; }
      if (used.has(d.name)) continue;
      used.add(d.name);
      addDistrict(d, f.geometry);
    }
  }
  for (const d of DATA.districts) if (!used.has(d.name)) addDistrict(d, null);
  buildRegionLabels();

  const h = readHash();
  if (h.r && REGIONS.indexOf(h.r) > -1){ active.clear(); active.add(h.r); renderChips(); }
  if (h.q){ document.getElementById("q").value = h.q; query = h.q.toLowerCase(); }
  if (h.d || h.r || h.q) closeIntro();
  refresh();
  revealDistricts();
  if (h.d && bySlug.has(h.d)) focusDistrict(bySlug.get(h.d));

  if (usingFallback){
    banner("Couldn’t load the district outlines, so trustee pins are placed at each district’s main campus instead. " +
           "Reload to try again.", "err");
  } else if (used.size < DATA.districts.length){
    banner(`${used.size} of ${DATA.districts.length} district outlines loaded; the rest are shown as pins.`, "err");
  } else {
    banner(null);
  }
  console.log("outlined:", used.size, "of", DATA.districts.length, "unmatched source names:", unmatched);
})();
