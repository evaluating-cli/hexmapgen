// Pure algorithms for Hex Earth (no DOM, no fetch). Unit-testable in Node.
// Ported 1:1 from the Python backend (geo.py / terrain.py / rivers clipping).

export const R = 6371.0;            // mean Earth radius, km
export const ELEV_SNOW = 4200.0;

// --- centred azimuthal projections: geographic (deg) <-> tangent plane (km) ---
export function fwd(lat, lon, clat, clon, proj) {
  const phi = deg2rad(lat), lam = deg2rad(lon);
  const phi1 = deg2rad(clat), lam0 = deg2rad(clon);
  const dlam = lam - lam0;
  const sp1 = Math.sin(phi1), cp1 = Math.cos(phi1);
  const sp = Math.sin(phi), cp = Math.cos(phi);
  const cosc = clamp(sp1 * sp + cp1 * cp * Math.cos(dlam), -1, 1);
  let k;
  if (proj === "equalarea") {
    k = Math.sqrt(2 / (1 + cosc));
  } else { // equidistant
    const c = Math.acos(cosc);
    k = c > 1e-12 ? c / Math.sin(c) : 1.0;
  }
  let x = R * k * cp * Math.sin(dlam);
  let y = R * k * (cp1 * sp - sp1 * cp * Math.cos(dlam));
  if (proj !== "equalarea" && Math.acos(cosc) <= 1e-12) { x = 0; y = 0; }
  return [x, y];
}

export function inv(x, y, clat, clon, proj) {
  const phi1 = deg2rad(clat), lam0 = deg2rad(clon);
  const sp1 = Math.sin(phi1), cp1 = Math.cos(phi1);
  const rho = Math.hypot(x, y);
  if (rho <= 1e-9) return [clat, clon];
  const c = proj === "equalarea" ? 2 * Math.asin(clamp(rho / (2 * R), -1, 1)) : rho / R;
  const sc = Math.sin(c), cc = Math.cos(c);
  const lat = rad2deg(Math.asin(clamp(cc * sp1 + (y * sc * cp1) / rho, -1, 1)));
  const lon = rad2deg(lam0 + Math.atan2(x * sc, rho * cp1 * cc - y * sp1 * sc));
  return [lat, lon];
}

// --- region framing ------------------------------------------------------- //
// Exact projected extent of the lat/lon rectangle. The four corners are not
// enough: an azimuthal projection bows the north and south edges away from the
// centre, by 1.5% (New Zealand) to 4.9% (Scandinavia) of the region height, so
// a corner-only box crops the top and bottom of the map.
export function projectedBBox(latmin, latmax, lonmin, lonmax, proj, samples = 32) {
  const clat = (latmin + latmax) / 2, clon = (lonmin + lonmax) / 2;
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  const add = (la, lo) => {
    const [x, y] = fwd(la, lo, clat, clon, proj);
    if (x < xmin) xmin = x;
    if (x > xmax) xmax = x;
    if (y < ymin) ymin = y;
    if (y > ymax) ymax = y;
  };
  // corners are included by the sampled edges (t = 0 and t = 1), but add them
  // explicitly so a samples value of 0 still produces a sane box
  add(latmin, lonmin); add(latmin, lonmax);
  add(latmax, lonmin); add(latmax, lonmax);
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const la = latmin + (latmax - latmin) * t;
    const lo = lonmin + (lonmax - lonmin) * t;
    add(la, lonmin); add(la, lonmax);   // west and east edges
    add(latmin, lo); add(latmax, lo);   // south and north edges
  }
  return { xmin, xmax, ymin, ymax, Wkm: xmax - xmin, Hkm: ymax - ymin, clat, clon };
}

// Fit the projected box into a canvas of at most maxPx, leaving one hex radius
// of margin on every side so border cells render whole instead of being cut.
export function layoutCanvas(Wkm, Hkm, maxPx, hexSizeKm) {
  const scale = maxPx / (Math.max(Wkm, Hkm) + 2 * hexSizeKm);
  const padPx = hexSizeKm * scale;
  return {
    scale,
    padPx,
    cw: Math.round(Wkm * scale + 2 * padPx),
    ch: Math.round(Hkm * scale + 2 * padPx),
  };
}

// --- Web-Mercator tile math (for Terrarium DEM tiles) ---
export function latlonToGlobalPixel(lat, lon, z) {
  const n = (1 << z) * 256;
  const gx = (lon + 180) / 360 * n;
  const l = clamp(lat, -85.05112878, 85.05112878);
  const gy = (1 - Math.asinh(Math.tan(deg2rad(l))) / Math.PI) / 2 * n;
  return [gx, gy];
}

export function tileRange(latmin, latmax, lonmin, lonmax, z) {
  const [gx0, gy0] = latlonToGlobalPixel(latmax, lonmin, z);
  const [gx1, gy1] = latlonToGlobalPixel(latmin, lonmax, z);
  // Clamp into the tile pyramid: at the Mercator latitude limit the pixel
  // coordinate evaluates a hair below zero, which used to ask for /-1.png.
  const last = (1 << z) - 1;
  const tile = (px) => Math.max(0, Math.min(last, Math.floor(px / 256)));
  return [tile(gx0), tile(gx1), tile(gy0), tile(gy1)];
}

export function chooseZoom(latmin, latmax, lonmin, lonmax, maxTiles = 36) {
  for (const z of [12, 11, 10, 9, 8, 7, 6]) {
    const [tx0, tx1, ty0, ty1] = tileRange(latmin, latmax, lonmin, lonmax, z);
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= maxTiles) return z;
  }
  return 6;
}

// --- terrain classification ------------------------------------------------ //
// Two signals decide the map:
//   * water  — from Natural Earth vectors (land/lakes), never from colour:
//              Blue Marble paints the sea almost black, so its hue is noise;
//   * relief — elevation range inside the hex, which separates mountain from
//              hill from plain far better than a global altitude threshold,
//              because "350 m" means hill in Switzerland and plain in Kansas.
// Colour is then only used to split low-relief land into desert / forest /
// grassland, where it is actually informative.
export const RELIEF_MOUNTAIN = 500; // metres of relief inside one hex
export const RELIEF_HILL = 200;

export function hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const v = mx, s = mx > 0 ? (mx - mn) / mx : 0;
  const d = mx - mn > 0 ? mx - mn : 1e-9;
  let h;
  if (mx === mn) h = 0;
  else if (mx === r) h = 60 * (((g - b) / d) % 6);
  else if (mx === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  h = (h % 360 + 360) % 360;
  return [h, s, v];
}

/**
 * @param {[number, number, number]} rgb  sampled pixel, 0..255
 * @param {number} el      mean elevation of the hex, metres
 * @param {number} relief  max-min elevation inside the hex, metres
 * @param {boolean} water  true if a land/lake mask says this cell is water
 * @returns {number} index into TYPES
 */
export function classify(rgb, el, relief, water) {
  if (water) return 4;

  const [h, s, v] = hsv(rgb[0], rgb[1], rgb[2]);

  // snow / ice: white surface, or above the permanent snow line
  if ((v >= 200 && s <= 0.15) || el >= ELEV_SNOW) return 6;

  // Aridity is a property of the ground, not of the landform: a dry basin with
  // 300 m of relief is still desert. Only true mountains override the colour.
  if (relief < RELIEF_MOUNTAIN && h >= 8 && h <= 45 && s >= 0.30 && v >= 90) return 5;

  const vegetation = h >= 60 && h <= 175 && s >= 0.18;
  const canopy = vegetation && v < 60;

  // landform: relief beats absolute altitude, but a densely wooded slope is
  // still forest — only bare rock at altitude reads as mountain
  if (relief >= RELIEF_MOUNTAIN) {
    return canopy && relief < 1200 ? 1 : 3;
  }
  if (relief >= RELIEF_HILL) return 2;

  // low-relief vegetation
  if (vegetation) return canopy ? 1 : 0;
  return v < 60 ? 1 : 0;                                        // dark bare vs grass
}

// --- hexagon geometry (pointy-top), in canvas px (y down) ---
export function hexCorners(cx, cy, size) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 180 * (60 * i - 90);
    pts.push([cx + size * Math.cos(a), cy + size * Math.sin(a)]);
  }
  return pts; // CW in screen space
}

// Cyrus-Beck clip of segment P0->P1 to a convex polygon (array of [x,y]).
// Returns [[x0,y0],[x1,y1]] of the visible portion, or null.
export function clipSegment(P0, P1, poly) {
  const cx = poly.reduce((a, p) => a + p[0], 0) / poly.length;
  const cy = poly.reduce((a, p) => a + p[1], 0) / poly.length;
  const D = [P1[0] - P0[0], P1[1] - P0[1]];
  let tE = 0, tL = 1;
  for (let i = 0; i < poly.length; i++) {
    const A = poly[i], B = poly[(i + 1) % poly.length];
    const ex = B[0] - A[0], ey = B[1] - A[1];
    // outward normal (points away from centroid)
    let nx = -ey, ny = ex;
    const mx = (A[0] + B[0]) / 2 - cx, my = (A[1] + B[1]) / 2 - cy;
    if (nx * mx + ny * my < 0) { nx = -nx; ny = -ny; }
    const num = nx * (A[0] - P0[0]) + ny * (A[1] - P0[1]);
    const den = nx * D[0] + ny * D[1];
    if (Math.abs(den) < 1e-12) { if (num < 0) return null; continue; }
    const t = num / den;
    if (den < 0) { if (t > tE) tE = t; } else { if (t < tL) tL = t; }
  }
  if (tE > tL) return null;
  return [[P0[0] + tE * D[0], P0[1] + tE * D[1]],
          [P0[0] + tL * D[0], P0[1] + tL * D[1]]];
}

// --- vector masks (land / lakes) ------------------------------------------ //
// Natural Earth rings, spatially indexed so a few thousand hex centres can be
// tested against a few thousand rings without a linear scan each.
//
// Rings are flat [lon, lat, lon, lat, ...] arrays. Containment uses the
// even-odd rule across every ring of the dataset, so polygon holes (islands in
// lakes, lakes carved out of land) behave correctly.
//
// Two levels of acceleration:
//   * a coarse lon/lat cell grid, to pick candidate rings;
//   * per-ring latitude chunks, so a 20,000-vertex continent outline only
//     tests the handful of vertices its scan line can actually cross.
export function buildMask(rings, cellDeg = 2) {
  const parsed = [];
  const cells = new Map();
  const CHUNK = 64;
  for (const pts of rings) {
    const n = pts.length / 2;
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      const lon = pts[i], lat = pts[i + 1];
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    // edge v is (v-1 -> v); chunk k owns edges [s, e) so no edge is tested twice
    const chunks = [];
    for (let s = 1; s < n; s += CHUNK) {
      const e = Math.min(n, s + CHUNK);
      let cMin = Infinity, cMax = -Infinity;
      for (let v = s - 1; v <= e; v++) {
        const lat = pts[v * 2 + 1];
        if (lat < cMin) cMin = lat;
        if (lat > cMax) cMax = lat;
      }
      chunks.push({ s, e, cMin, cMax });
    }
    const idx = parsed.length;
    parsed.push({ pts, n, minLon, minLat, maxLon, maxLat, chunks });
    for (let cx = Math.floor(minLon / cellDeg); cx <= Math.floor(maxLon / cellDeg); cx++) {
      for (let cy = Math.floor(minLat / cellDeg); cy <= Math.floor(maxLat / cellDeg); cy++) {
        const key = cx + "," + cy;
        let list = cells.get(key);
        if (!list) { list = []; cells.set(key, list); }
        list.push(idx);
      }
    }
  }
  return { parsed, cells, cellDeg };
}

const crosses = (lon, lat, xj, yj, xi, yi) =>
  (yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi;

export function pointInMask(mask, lon, lat) {
  if (!mask || !mask.parsed.length) return false;
  const list = mask.cells.get(
    Math.floor(lon / mask.cellDeg) + "," + Math.floor(lat / mask.cellDeg));
  if (!list) return false;
  let inside = false;
  for (const idx of list) {
    const r = mask.parsed[idx];
    if (lon < r.minLon || lon > r.maxLon || lat < r.minLat || lat > r.maxLat) continue;
    const pts = r.pts;
    for (const c of r.chunks) {
      if (lat < c.cMin || lat > c.cMax) continue;
      for (let v = c.s; v < c.e; v++) {
        if (crosses(lon, lat, pts[(v - 1) * 2], pts[(v - 1) * 2 + 1], pts[v * 2], pts[v * 2 + 1])) {
          inside = !inside;
        }
      }
    }
    // the closing edge (last vertex -> first) belongs to no chunk
    if (crosses(lon, lat, pts[(r.n - 1) * 2], pts[(r.n - 1) * 2 + 1], pts[0], pts[1])) {
      inside = !inside;
    }
  }
  return inside;
}

// --- helpers ---
function deg2rad(d) { return d * Math.PI / 180; }
function rad2deg(r) { return r * 180 / Math.PI; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
