// Hex Earth — client-side engine. Runs entirely in the browser; the Worker is
// only a static host + CORS proxy. Imports pure algorithms from ./lib.mjs.
import { fwd, inv, latlonToGlobalPixel, tileRange, chooseZoom,
         classify, hexCorners, clipSegment } from "./lib.mjs";

const TYPES = [
  { key: "grass",    name: "Grassland",  color: "#8bc34a" },
  { key: "forest",   name: "Forest",     color: "#2e7d32" },
  { key: "hill",     name: "Hill",       color: "#d9c27a" },
  { key: "mountain", name: "Mountain",   color: "#8a6d4b" },
  { key: "water",    name: "Water",      color: "#1e88e5" },
  { key: "desert",   name: "Desert",     color: "#f4c542" },
  { key: "snow",     name: "Snow / Ice", color: "#e6edf3" },
];
const RIVER_COLOR = "#2f80c8";

const PRESETS = [
  { name: "European Alps",  lat0: 43, lat1: 48, lon0: 5,   lon1: 15 },
  { name: "Nile / Red Sea", lat0: 24, lat1: 33, lon0: 27,  lon1: 35 },
  { name: "British Isles",  lat0: 50, lat1: 59, lon0: -11, lon1: 2 },
  { name: "Scandinavia",    lat0: 55, lat1: 71, lon0: 4,   lon1: 31 },
  { name: "Iceland",        lat0: 63, lat1: 67, lon0: -25, lon1: -13 },
  { name: "Himalaya",       lat0: 26, lat1: 34, lon0: 78,  lon1: 92 },
  { name: "Japan",          lat0: 31, lat1: 45, lon0: 129, lon1: 146 },
  { name: "Grand Canyon",   lat0: 34, lat1: 38, lon0: -114,lon1: -111 },
  { name: "Sahara",         lat0: 16, lat1: 30, lon0: -8,  lon1: 18 },
  { name: "Atacama/Andes",  lat0: -27, lat1: -18, lon0: -71, lon1: -68 },
  { name: "New Zealand",    lat0: -47, lat1: -34, lon0: 166, lon1: 179 },
  { name: "Cape Town",      lat0: -35, lat1: -33, lon0: 18,  lon1: 20 },
];

// ---------------- DOM ----------------
const world = document.getElementById("world");
const overlay = document.getElementById("overlay");
const octx = overlay.getContext("2d");
const result = document.getElementById("result");
const rctx = result.getContext("2d");
const genbtn = document.getElementById("genbtn");
const regenbtn = document.getElementById("regenbtn");
const spin = document.getElementById("spin");
const errEl = document.getElementById("err");
const projSel = document.getElementById("proj");
const colsEl = document.getElementById("cols");
const viewport = document.getElementById("viewport");
const regionsBtn = document.getElementById("regionsBtn");
const regionsMenu = document.getElementById("regionsMenu");

let MAP = null, satImg = null;
const sel = { x0: 0.27, y0: 0.22, x1: 0.44, y1: 0.42 };
let BASE_W = 780, BASE_H = 390, zoom = 1;
const ZOOM_MIN = 1, ZOOM_MAX = 8;

// ---------------- region selection (world map) ----------------
const llToNorm = (lat, lon) => ({ nx: (lon + 180) / 360, ny: (90 - lat) / 180 });
const normToLL = (nx, ny) => ({ lat: 90 - ny * 180, lon: nx * 360 - 180 });
function setSelFromLL(lat0, lat1, lon0, lon1) {
  const hi = Math.max(lat0, lat1), lo = Math.min(lat0, lat1);
  const wlo = Math.min(lon0, lon1), whi = Math.max(lon0, lon1);
  const tl = llToNorm(hi, wlo), br = llToNorm(lo, whi);
  sel.x0 = tl.nx; sel.y0 = tl.ny; sel.x1 = br.nx; sel.y1 = br.ny;
}
function selToLL() {
  const nx0 = Math.min(sel.x0, sel.x1), nx1 = Math.max(sel.x0, sel.x1);
  const ny0 = Math.min(sel.y0, sel.y1), ny1 = Math.max(sel.y0, sel.y1);
  const tl = normToLL(nx0, ny0), br = normToLL(nx1, ny1);
  return { lat0: br.lat, lat1: tl.lat, lon0: tl.lon, lon1: br.lon };
}
function applyZoom() {
  const W = BASE_W * zoom, H = BASE_H * zoom;
  world.style.width = W + "px"; world.style.height = H + "px";
  const dpr = devicePixelRatio || 1;
  overlay.style.width = W + "px"; overlay.style.height = H + "px";
  overlay.width = Math.round(W * dpr); overlay.height = Math.round(H * dpr);
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  document.getElementById("zoomVal").textContent = zoom.toFixed(1) + "×";
  drawSelection();
}
function drawSelection() {
  const r = world.getBoundingClientRect(), W = r.width, H = r.height;
  if (!W || !H) return;
  octx.clearRect(0, 0, W, H);
  const nx0 = Math.min(sel.x0, sel.x1), nx1 = Math.max(sel.x0, sel.x1);
  const ny0 = Math.min(sel.y0, sel.y1), ny1 = Math.max(sel.y0, sel.y1);
  const x = nx0 * W, y = ny0 * H, w = (nx1 - nx0) * W, h = (ny1 - ny0) * H;
  octx.fillStyle = "rgba(78,161,255,0.18)"; octx.fillRect(x, y, w, h);
  octx.lineWidth = 2; octx.strokeStyle = "#4ea1ff"; octx.strokeRect(x, y, w, h);
}
function clientToNorm(e) {
  const r = viewport.getBoundingClientRect();
  const W = BASE_W * zoom, H = BASE_H * zoom;
  return {
    nx: clamp((e.clientX - r.left + viewport.scrollLeft) / W, 0, 1),
    ny: clamp((e.clientY - r.top + viewport.scrollTop) / H, 0, 1),
  };
}
function inputsFromSel() {
  const el = document.getElementById("boundsReadout");
  if (!el) return;
  const ll = selToLL();
  el.textContent = `${ll.lat0.toFixed(1)}°–${ll.lat1.toFixed(1)}°N, ${ll.lon0.toFixed(1)}°–${ll.lon1.toFixed(1)}°E`;
}
function centerOnSel() {
  const nx = (sel.x0 + sel.x1) / 2, ny = (sel.y0 + sel.y1) / 2;
  const r = viewport.getBoundingClientRect();
  viewport.scrollLeft = nx * BASE_W * zoom - r.width / 2;
  viewport.scrollTop = ny * BASE_H * zoom - r.height / 2;
}
function zoomBy(f, pivX, pivY) {
  const r = viewport.getBoundingClientRect();
  const px = pivX != null ? pivX : r.left + r.width / 2;
  const py = pivY != null ? pivY : r.top + r.height / 2;
  const W0 = BASE_W * zoom, H0 = BASE_H * zoom;
  const nx = (px - r.left + viewport.scrollLeft) / W0;
  const ny = (py - r.top + viewport.scrollTop) / H0;
  zoom = clamp(zoom * f, ZOOM_MIN, ZOOM_MAX);
  applyZoom();
  const W1 = BASE_W * zoom, H1 = BASE_H * zoom;
  viewport.scrollLeft = nx * W1 - (px - r.left);
  viewport.scrollTop = ny * H1 - (py - r.top);
}
let dragging = false;
viewport.addEventListener("pointerdown", e => { dragging = true; viewport.setPointerCapture(e.pointerId); e.preventDefault();
  const p = clientToNorm(e); sel.x0 = sel.x1 = p.nx; sel.y0 = sel.y1 = p.ny; drawSelection(); inputsFromSel(); });
viewport.addEventListener("pointermove", e => { if (!dragging) return;
  const p = clientToNorm(e); sel.x1 = p.nx; sel.y1 = p.ny; drawSelection(); inputsFromSel(); });
viewport.addEventListener("pointerup", () => dragging = false);
viewport.addEventListener("pointercancel", () => dragging = false);
viewport.addEventListener("wheel", e => { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.25 : 1 / 1.25, e.clientX, e.clientY); }, { passive: false });

// presets dropdown
PRESETS.forEach(p => {
  const it = document.createElement("button");
  it.className = "dropdown-item"; it.textContent = p.name;
  it.onclick = () => { setSelFromLL(p.lat0, p.lat1, p.lon0, p.lon1); drawSelection(); inputsFromSel(); centerOnSel(); regionsMenu.classList.remove("open"); };
  regionsMenu.appendChild(it);
});
regionsBtn.onclick = e => { e.stopPropagation(); regionsMenu.classList.toggle("open"); };
addEventListener("click", e => { if (!regionsMenu.contains(e.target) && e.target !== regionsBtn) regionsMenu.classList.remove("open"); });

function updNote() {
  projSel.title = projSel.value === "equalarea"
    ? "Lambert Azimuthal Equal-Area — each hex ≈ equal Earth area"
    : "Azimuthal Equidistant — true distance & direction from the centre";
}
projSel.onchange = updNote; updNote();
colsEl.oninput = () => document.getElementById("colsval").textContent = colsEl.value;

function fitBase() { BASE_W = Math.max(400, Math.min(2400, viewport.clientWidth - 2)); BASE_H = BASE_W / 2; }
function showScreen(name) {
  document.querySelectorAll(".screen").forEach(s => s.classList.toggle("active", s.id === "screen-" + name));
  if (name === "region") requestAnimationFrame(() => { fitBase(); applyZoom(); });
}
function setupWorld() { fitBase(); setSelFromLL(43, 48, 5, 15); applyZoom(); inputsFromSel(); }
world.onload = setupWorld;
if (world.complete && world.naturalWidth) setupWorld();
addEventListener("resize", () => { if (world.complete && document.getElementById("screen-region").classList.contains("active")) { fitBase(); applyZoom(); } });
document.getElementById("zoomIn").onclick = () => zoomBy(1.4);
document.getElementById("zoomOut").onclick = () => zoomBy(1 / 1.4);
document.getElementById("zoomReset").onclick = () => { zoom = 1; viewport.scrollLeft = 0; viewport.scrollTop = 0; applyZoom(); };

genbtn.onclick = () => {
  errEl.textContent = "";
  const ll = selToLL();
  const span = Math.max(Math.abs(ll.lat1 - ll.lat0), Math.abs(ll.lon1 - ll.lon0));
  if (span < 0.05) { errEl.textContent = "Region too small. Drag a larger area."; return; }
  if (span > 70) { errEl.textContent = "Region too large (max ~70° span)."; return; }
  showScreen("map");
  document.getElementById("stats").textContent = "Generating…";
  generate();
};
document.getElementById("backbtn").onclick = () => showScreen("region");
regenbtn.onclick = () => { document.getElementById("stats").textContent = "Generating…"; generate(); };

// ---------------- pipeline helpers ----------------
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

async function decodeImageBitmap(url) {
  const blob = await (await fetch(url)).blob();
  return await createImageBitmap(blob);
}
function bitmapToData(bmp) {
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext("2d"); ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, bmp.width, bmp.height);
}

async function fetchSatellite(latmin, latmax, lonmin, lonmax) {
  const dlat = Math.max(latmax - latmin, 1e-6), dlon = Math.max(lonmax - lonmin, 1e-6);
  let h = 700, w = Math.round(h * dlon / dlat);
  if (w * h > 1.6e6) { const f = Math.sqrt(1.6e6 / (w * h)); w = Math.round(w * f); h = Math.round(h * f); }
  w = clamp(w, 64, 2500); h = clamp(h, 64, 2500);
  const url = `/proxy/satellite?latmin=${latmin}&latmax=${latmax}&lonmin=${lonmin}&lonmax=${lonmax}&w=${w}&h=${h}`;
  const bmp = await decodeImageBitmap(url);
  const img = bitmapToData(bmp);
  return { data: img.data, w: bmp.width, h: bmp.height, latmin, latmax, lonmin, lonmax };
}
function sampleColor(sat, lat, lon) {
  const px = clamp((lon - sat.lonmin) / (sat.lonmax - sat.lonmin) * sat.w, 0, sat.w - 1) | 0;
  const py = clamp((sat.latmax - lat) / (sat.latmax - sat.latmin) * sat.h, 0, sat.h - 1) | 0;
  const i = (py * sat.w + px) * 4;
  return [sat.data[i], sat.data[i + 1], sat.data[i + 2]];
}

async function fetchTileElev(z, tx, ty) {
  const bmp = await decodeImageBitmap(`/proxy/dem?z=${z}&x=${tx}&y=${ty}`);
  const d = bitmapToData(bmp).data;
  const e = new Float32Array(256 * 256);
  for (let i = 0; i < e.length; i++) {
    e[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
  }
  return e;
}
async function buildDEM(latmin, latmax, lonmin, lonmax) {
  const z = chooseZoom(latmin, latmax, lonmin, lonmax);
  const [tx0, tx1, ty0, ty1] = tileRange(latmin, latmax, lonmin, lonmax, z);
  const cols = tx1 - tx0 + 1, rows = ty1 - ty0 + 1;
  const W = cols * 256, H = rows * 256;
  const mosaic = new Float32Array(W * H);
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++)
    jobs.push(fetchTileElev(z, tx, ty).then(e => ({ tx, ty, e })));
  const res = await Promise.all(jobs);
  for (const { tx, ty, e } of res) {
    const ox = (tx - tx0) * 256, oy = (ty - ty0) * 256;
    for (let r = 0; r < 256; r++) mosaic.set(e.subarray(r * 256, r * 256 + 256), (oy + r) * W + ox);
  }
  return { mosaic, W, H, tx0, ty0, z };
}
function sampleElev(dem, lat, lon) {
  const [gx, gy] = latlonToGlobalPixel(lat, lon, dem.z);
  const px = clamp((gx - dem.tx0 * 256) | 0, 0, dem.W - 1);
  const py = clamp((gy - dem.ty0 * 256) | 0, 0, dem.H - 1);
  let el = dem.mosaic[py * dem.W + px];
  return el < -1000 ? 0 : el;
}

let _rivers = null;
async function fetchRivers(latmin, latmax, lonmin, lonmax) {
  if (!_rivers) _rivers = (await (await fetch("/rivers.geojson")).json()).features;
  const polys = [];
  for (const f of _rivers) {
    const g = f.geometry;
    const parts = g.type === "LineString" ? [g.coordinates]
                : g.type === "MultiLineString" ? g.coordinates : null;
    if (!parts) continue;
    for (const part of parts) {
      let hit = false;
      for (const [lon, lat] of part)
        if (lon >= lonmin && lon <= lonmax && lat >= latmin && lat <= latmax) { hit = true; break; }
      if (hit) polys.push(part.map(([lon, lat]) => [lat, lon]));
    }
  }
  return polys;
}

function buildRiverOverlays(riverPolys, hexes, size_px, ll2px) {
  const segs = [];
  for (const poly of riverPolys) {
    let prev = null;
    for (const [la, lo] of poly) {
      const p = ll2px(la, lo);
      if (prev && (p[0] !== prev[0] || p[1] !== prev[1])) segs.push([prev, p]);
      prev = p;
    }
  }
  const cell = size_px * 2;
  const key = (x, y) => Math.floor(x / cell) + "," + Math.floor(y / cell);
  const map = new Map();
  hexes.forEach((h, i) => { const k = key(h.x, h.y); if (!map.has(k)) map.set(k, []); map.get(k).push(i); });
  const out = new Map();
  for (const [a, b] of segs) {
    const minX = Math.floor((Math.min(a[0], b[0]) - size_px) / cell);
    const maxX = Math.floor((Math.max(a[0], b[0]) + size_px) / cell);
    const minY = Math.floor((Math.min(a[1], b[1]) - size_px) / cell);
    const maxY = Math.floor((Math.max(a[1], b[1]) + size_px) / cell);
    const seen = new Set();
    for (let cx = minX; cx <= maxX; cx++) for (let cy = minY; cy <= maxY; cy++) {
      const arr = map.get(cx + "," + cy); if (!arr) continue;
      for (const i of arr) {
        if (seen.has(i)) continue; seen.add(i);
        const poly = hexCorners(hexes[i].x, hexes[i].y, size_px);
        const cl = clipSegment(a, b, poly);
        if (cl) { if (!out.has(i)) out.set(i, []); out.get(i).push(cl); }
      }
    }
  }
  return out;
}

function buildBackdrop(sat, xmin, xmax, ymin, ymax, clat, clon, proj, cw, ch, latmin, latmax, lonmin, lonmax) {
  const f = Math.min(1, 480 / Math.max(cw, ch));
  const bw = Math.max(2, Math.round(cw * f)), bh = Math.max(2, Math.round(ch * f));
  const img = new ImageData(bw, bh);
  const d = img.data;
  for (let py = 0; py < bh; py++) {
    const Y = ymax - (py + 0.5) / bh * (ymax - ymin);
    for (let px = 0; px < bw; px++) {
      const X = xmin + (px + 0.5) / bw * (xmax - xmin);
      const o = (py * bw + px) * 4;
      const [la, lo] = inv(X, Y, clat, clon, proj);
      if (la < latmin || la > latmax || lo < lonmin || lo > lonmax) continue;
      const [r, g, b] = sampleColor(sat, la, lo);
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    }
  }
  const c = new OffscreenCanvas(bw, bh);
  c.getContext("2d").putImageData(img, 0, 0);
  return c.convertToBlob({ type: "image/png" }).then(blob => URL.createObjectURL(blob));
}

// ---------------- main generate ----------------
async function generate() {
  errEl.textContent = "";
  const ll = selToLL();
  const latmin = Math.min(ll.lat0, ll.lat1), latmax = Math.max(ll.lat0, ll.lat1);
  const lonmin = Math.min(ll.lon0, ll.lon1), lonmax = Math.max(ll.lon0, ll.lon1);
  if (latmax - latmin < 0.05 || lonmax - lonmin < 0.05) { errEl.textContent = "Region too small. Drag a larger area."; return; }
  if (latmax - latmin > 70 || lonmax - lonmin > 70) { errEl.textContent = "Region too large (max ~70° span)."; return; }

  const proj = projSel.value, cols = +colsEl.value;
  genbtn.disabled = true; if (regenbtn) regenbtn.disabled = true; spin.classList.add("show");
  const t0 = performance.now();
  try {
    const clat = (latmin + latmax) / 2, clon = (lonmin + lonmax) / 2;
    const cs = [[latmin, lonmin], [latmin, lonmax], [latmax, lonmin], [latmax, lonmax]];
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (const [la, lo] of cs) { const [x, y] = fwd(la, lo, clat, clon, proj);
      xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
    const Wkm = xmax - xmin, Hkm = ymax - ymin;
    const s_km = Wkm / (Math.sqrt(3) * cols), hx = Math.sqrt(3) * s_km, hy = 1.5 * s_km;
    const ncols = Math.ceil(Wkm / hx) + 2, nrows = Math.ceil(Hkm / hy) + 2;

    const scale = 940 / Math.max(Wkm, Hkm);
    const cw = Math.round(Wkm * scale), ch = Math.round(Hkm * scale);
    const size_px = s_km * scale;
    const ll2px = (la, lo) => { const [x, y] = fwd(la, lo, clat, clon, proj); return [(x - xmin) * scale, (ymax - y) * scale]; };

    const [sat, dem] = await Promise.all([
      fetchSatellite(latmin, latmax, lonmin, lonmax).catch(() => null),
      buildDEM(latmin, latmax, lonmin, lonmax).catch(e => { console.warn("DEM failed", e); return null; }),
    ]);
    if (!sat) throw new Error("Could not load satellite imagery (proxy/GIBS).");

    const hexes = [];
    const counts = new Array(TYPES.length).fill(0);
    for (let r = 0; r < nrows; r++) {
      for (let c = 0; c < ncols; c++) {
        const pkx = xmin + c * hx + (r % 2) * (hx / 2);
        const pky = ymin + r * hy;
        const [la, lo] = inv(pkx, pky, clat, clon, proj);
        if (la < latmin || la > latmax || lo < lonmin || lo > lonmax) continue;
        const [R0, G0, B0] = sampleColor(sat, la, lo);
        const el = dem ? sampleElev(dem, la, lo) : 0;
        const t = classify(R0, G0, B0, el);
        const [X, Y] = [(pkx - xmin) * scale, (ymax - pky) * scale];
        hexes.push({ x: X, y: Y, t });
        counts[t]++;
      }
    }
    if (hexes.length === 0) throw new Error("No hexes inside the region.");
    if (hexes.length > 40000) throw new Error(`Too many hexes (${hexes.length}). Lower density.`);

    let river_count = 0;
    try {
      const polys = await fetchRivers(latmin, latmax, lonmin, lonmax);
      const overlays = buildRiverOverlays(polys, hexes, size_px, ll2px);
      for (const [i, segs] of overlays) { hexes[i].river = segs; river_count++; }
    } catch (e) { console.warn("rivers failed", e); }

    let backdropURL = null;
    try { backdropURL = await buildBackdrop(sat, xmin, xmax, ymin, ymax, clat, clon, proj, cw, ch, latmin, latmax, lonmin, lonmax); }
    catch (e) { console.warn("backdrop failed", e); }

    MAP = { hexes, size_px, cw, ch, counts, total: hexes.length, river_count,
            projection: proj === "equalarea" ? "Lambert Azimuthal Equal-Area" : "Azimuthal Equidistant",
            center: [+clat.toFixed(3), +clon.toFixed(3)],
            bbox: [+latmin.toFixed(3), +latmax.toFixed(3), +lonmin.toFixed(3), +lonmax.toFixed(3)] };

    if (satImg) URL.revokeObjectURL(satImg.src);
    if (backdropURL) { satImg = new Image(); satImg.onload = drawMap; satImg.src = backdropURL; }
    else satImg = null;

    drawMap(); updateStats(MAP); buildLegend(MAP);
    console.log(`generated ${hexes.length} hexes, ${river_count} rivers in ${((performance.now() - t0) / 1000).toFixed(2)}s`);
  } catch (e) {
    document.getElementById("stats").innerHTML = `<span style="color:#ff8a80">⚠ ${e.message}</span> — use “← Region” to adjust.`;
  } finally {
    genbtn.disabled = false; if (regenbtn) regenbtn.disabled = false; spin.classList.remove("show");
  }
}

// ---------------- rendering ----------------
function hexPath(ctx, cx, cy, size) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) { const a = Math.PI / 180 * (60 * i - 90);
    const x = cx + size * Math.cos(a), y = cy + size * Math.sin(a);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  ctx.closePath();
}
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const f = amt * 255;
  return "rgb(" + [0, 1, 2].map(i => clamp(Math.round(((n >> ((2 - i) * 4)) & 255) + f), 0, 255)).join(",") + ")";
}
function drawRiver(polys) {
  for (const poly of polys) {
    rctx.beginPath();
    poly.forEach((p, i) => i ? rctx.lineTo(p[0], p[1]) : rctx.moveTo(p[0], p[1]));
    rctx.stroke();
  }
}
function drawMap() {
  if (!MAP) return;
  const dpr = devicePixelRatio || 1;
  result.width = MAP.cw * dpr; result.height = MAP.ch * dpr;
  result.style.width = MAP.cw + "px"; result.style.height = MAP.ch + "px";
  rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  rctx.clearRect(0, 0, MAP.cw, MAP.ch);
  const showSat = document.getElementById("sat").checked && satImg && satImg.complete;
  const borders = document.getElementById("borders").checked;
  const showRivers = document.getElementById("rivers").checked;
  rctx.fillStyle = "#0a0e12"; rctx.fillRect(0, 0, MAP.cw, MAP.ch);
  if (showSat) { rctx.globalAlpha = 1; rctx.drawImage(satImg, 0, 0, MAP.cw, MAP.ch); }
  const size = MAP.size_px, fillA = showSat ? 0.5 : 1;
  for (const h of MAP.hexes) {
    hexPath(rctx, h.x, h.y, size);
    rctx.globalAlpha = fillA; rctx.fillStyle = TYPES[h.t].color; rctx.fill();
    if (borders) { rctx.globalAlpha = showSat ? 0.85 : 1; rctx.lineWidth = Math.max(0.5, size * 0.06);
      rctx.strokeStyle = showSat ? "rgba(0,0,0,0.55)" : shade(TYPES[h.t].color, -0.35); rctx.stroke(); }
  }
  if (showRivers) {
    const w = Math.max(1.4, size * 0.26);
    rctx.lineCap = "round"; rctx.lineJoin = "round";
    for (const h of MAP.hexes) {
      if (!h.river) continue;
      rctx.globalAlpha = showSat ? 0.45 : 0.8; rctx.strokeStyle = "#9fc4e8"; rctx.lineWidth = w * 1.8; drawRiver(h.river);
      rctx.globalAlpha = 1; rctx.strokeStyle = RIVER_COLOR; rctx.lineWidth = w; drawRiver(h.river);
    }
  }
  rctx.globalAlpha = 1;
}
document.getElementById("sat").onchange = drawMap;
document.getElementById("borders").onchange = drawMap;
document.getElementById("rivers").onchange = drawMap;

function updateStats(d) {
  document.getElementById("stats").innerHTML =
    `<b>${d.total.toLocaleString()}</b> hexes · <b>${(d.river_count || 0).toLocaleString()}</b> river hexes ` +
    `· <b>${d.projection}</b> · centre ${d.center[0]}°, ${d.center[1]}°`;
}
function buildLegend(d) {
  const lg = document.getElementById("legend"); lg.innerHTML = "";
  const tot = d.total || 1;
  TYPES.forEach((t, i) => {
    const c = d.counts[i] || 0;
    const el = document.createElement("div"); el.className = "item";
    el.innerHTML = `<span class="sw" style="background:${t.color}"></span><span>${t.name}</span>` +
      `<span class="cnt">${c.toLocaleString()} (${(100 * c / tot).toFixed(1)}%)</span>`;
    lg.appendChild(el);
  });
  const rc = d.river_count || 0;
  const r = document.createElement("div"); r.className = "item";
  r.innerHTML = `<span class="sw" style="background:${RIVER_COLOR}"></span><span>River (overlay)</span><span class="cnt">${rc.toLocaleString()} hexes</span>`;
  lg.appendChild(r);
}
document.getElementById("dl").onclick = () => {
  if (!MAP) return;
  const a = document.createElement("a"); a.download = "hexearth.png";
  a.href = result.toDataURL("image/png"); a.click();
};
