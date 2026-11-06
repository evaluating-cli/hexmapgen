// Pure algorithms for Hex Earth (no DOM, no fetch). Unit-testable in Node.
// Ported 1:1 from the Python backend (geo.py / terrain.py / rivers clipping).

export const R = 6371.0;            // mean Earth radius, km
export const ELEV_HILL = 350.0;
export const ELEV_MOUNTAIN = 1000.0;
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
  return [Math.floor(gx0 / 256), Math.floor(gx1 / 256),
          Math.floor(gy0 / 256), Math.floor(gy1 / 256)];
}

export function chooseZoom(latmin, latmax, lonmin, lonmax, maxTiles = 36) {
  for (const z of [12, 11, 10, 9, 8, 7, 6]) {
    const [tx0, tx1, ty0, ty1] = tileRange(latmin, latmax, lonmin, lonmax, z);
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= maxTiles) return z;
  }
  return 6;
}

// --- terrain classification (colour + elevation) ---
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

export function classify(r, g, b, el) {
  const [h, s, v] = hsv(r, g, b);
  const water = h >= 185 && h <= 265 && s >= 0.25;
  const snowWhite = v >= 228 && s <= 0.18;
  const desert = h >= 20 && h <= 58 && v >= 150 && s >= 0.15;
  const green = h >= 65 && h <= 170 && s >= 0.20;
  const high = el >= ELEV_MOUNTAIN;
  const mid = el >= ELEV_HILL && !high;
  let t = 0; // Grassland
  if (water) t = 4;
  else if (desert) t = 5;
  else if (green) { t = high ? 3 : mid ? 2 : v < 80 ? 1 : 0; }
  else { t = high ? 3 : mid ? 2 : 0; } // bare
  if (snowWhite || el >= ELEV_SNOW) t = 6;
  return t;
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

// --- helpers ---
function deg2rad(d) { return d * Math.PI / 180; }
function rad2deg(r) { return r * 180 / Math.PI; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
