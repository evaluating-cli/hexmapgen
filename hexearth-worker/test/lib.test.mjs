// Unit tests for the pure algorithms in public/lib.mjs.
// Run with: npm test   (node --test, no dependencies required)

import test from "node:test";
import assert from "node:assert/strict";

import {
  R, ELEV_HILL, ELEV_MOUNTAIN, ELEV_SNOW,
  fwd, inv, hsv,
  latlonToGlobalPixel, tileRange, chooseZoom,
  classify, hexCorners, clipSegment,
} from "../public/lib.mjs";

const DEG = Math.PI / 180;
const near = (a, b, eps, msg) =>
  assert.ok(Math.abs(a - b) <= eps, `${msg ?? ""} expected ${b}, got ${a} (eps ${eps})`);

// --------------------------------------------------------------------------- //
//  Projections
// --------------------------------------------------------------------------- //
test("fwd maps the projection centre to the origin", () => {
  for (const proj of ["equalarea", "equidistant"]) {
    for (const [clat, clon] of [[0, 0], [45, 15], [-30, -170], [70, 100]]) {
      const [x, y] = fwd(clat, clon, clat, clon, proj);
      near(x, 0, 1e-9, `${proj} @ ${clat}/${clon} x`);
      near(y, 0, 1e-9, `${proj} @ ${clat}/${clon} y`);
    }
  }
});

test("inv inverts fwd to sub-microdegree accuracy", () => {
  let worst = 0;
  for (const proj of ["equalarea", "equidistant"]) {
    for (const [clat, clon] of [[0, 0], [45, 15], [-30, -170], [60, 25]]) {
      // span is clamped so every sample stays a valid latitude (|lat| <= 85)
      const span = Math.min(60, 2 * (85 - Math.abs(clat)));
      for (let i = 0; i < 30; i++) {
        for (let j = 0; j < 30; j++) {
          const lat = clat + (i / 29 - 0.5) * span;
          const lon = clon + (j / 29 - 0.5) * span;
          const [x, y] = fwd(lat, lon, clat, clon, proj);
          const [lat2, lon2] = inv(x, y, clat, clon, proj);
          worst = Math.max(worst, Math.abs(lat2 - lat), Math.abs(lon2 - lon));
        }
      }
    }
  }
  assert.ok(worst < 1e-6, `worst round-trip error ${worst} deg`);
});

// Earth area of a small lat/lon cell (exact on a sphere).
const cellAreaKm2 = (lat0, lat1, lon0, lon1) =>
  R * R * (lon1 - lon0) * DEG * Math.abs(Math.sin(lat1 * DEG) - Math.sin(lat0 * DEG));

const polygonArea = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
};

test("equal-area projection preserves area (Jacobian ~ 1)", () => {
  for (const [clat, clon] of [[0, 0], [45, 15], [-40, 120]]) {
    for (const [dLat, dLon] of [[8, 0], [0, 20], [25, -25]]) {
      const la = clat + dLat, lo = clon + dLon;
      const d = 0.25;
      const corners = [[la - d, lo - d], [la - d, lo + d], [la + d, lo + d], [la + d, lo - d]]
        .map(([a, b]) => fwd(a, b, clat, clon, "equalarea"));
      const ratio = polygonArea(corners) / cellAreaKm2(la - d, la + d, lo - d, lo + d);
      near(ratio, 1, 0.005, `area ratio at dLat ${dLat} dLon ${dLon}`);
    }
  }
});

test("equidistant projection preserves distance from the centre", () => {
  const clat = 40, clon = 10;
  for (let az = 0; az < 360; az += 15) {
    for (const distDeg of [5, 20, 40]) {
      const c = distDeg * DEG;
      const lat = Math.asin(Math.sin(clat * DEG) * Math.cos(c) +
        Math.cos(clat * DEG) * Math.sin(c) * Math.cos(az * DEG)) / DEG;
      const lon = clon + Math.atan2(
        Math.sin(az * DEG) * Math.sin(c) * Math.cos(clat * DEG),
        Math.cos(c) - Math.sin(clat * DEG) * Math.sin(lat * DEG)) / DEG;
      const [x, y] = fwd(lat, lon, clat, clon, "equidistant");
      near(Math.hypot(x, y), R * c, R * c * 2e-4, `radius at az ${az}`);
    }
  }
});

test("equidistant projection is NOT area preserving away from the centre", () => {
  // Radial scale is 1 by definition; the tangential scale is k = c / sin c,
  // so the local area scale equals k (~1.047 at 30 degrees from the centre).
  const clat = 0, clon = 0, d = 0.25;
  const la = 30, lo = 0;
  const corners = [[la - d, lo - d], [la - d, lo + d], [la + d, lo + d], [la + d, lo - d]]
    .map(([a, b]) => fwd(a, b, clat, clon, "equidistant"));
  const ratio = polygonArea(corners) / cellAreaKm2(la - d, la + d, lo - d, lo + d);
  const c = 30 * DEG;
  near(ratio, c / Math.sin(c), 0.002, "area scale k at 30 deg");
});

// --------------------------------------------------------------------------- //
//  Web-Mercator tile maths (Terrarium DEM)
// --------------------------------------------------------------------------- //
test("latlonToGlobalPixel follows the 256px tile convention", () => {
  for (const z of [0, 1, 7, 12]) {
    const n = 256 * 2 ** z;
    const [gx, gy] = latlonToGlobalPixel(0, 0, z);
    near(gx, n / 2, 1e-6, `gx at z${z}`);
    near(gy, n / 2, 1e-6, `gy at z${z}`);
  }
  // north edge of the Mercator domain maps to y = 0
  const [, gyNorth] = latlonToGlobalPixel(85.05112878, 0, 1);
  near(gyNorth, 0, 1e-4, "north edge");
});

test("tileRange covers a bbox and respects the Mercator domain", () => {
  const [tx0, tx1, ty0, ty1] = tileRange(43, 48, 5, 15, 7);
  assert.ok(tx0 <= tx1 && ty0 <= ty1);
  const [gx0] = latlonToGlobalPixel(48, 5, 7);
  assert.equal(tx0, Math.floor(gx0 / 256));
  // the south edge of a normal region stays inside the tile pyramid
  const [, , tySouth] = tileRange(43, 48, 5, 15, 7);
  assert.ok(tySouth >= 0);
});

// Known defect (REVIEW.md D12): at the Mercator latitude limit the north tile
// index evaluates to -1, so app.js would request terrarium/{z}/{x}/-1.png.
// Documented here so the regression is visible until the fix lands.
test.todo("tileRange never returns a negative tile index at the Mercator limit");

test("chooseZoom respects the tile budget and picks the coarsest acceptable zoom", () => {
  const small = chooseZoom(43, 48, 5, 15, 36);
  assert.ok(small <= 12 && small >= 6);
  const [tx0, tx1, ty0, ty1] = tileRange(43, 48, 5, 15, small);
  assert.ok((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= 36, "tile budget exceeded");
  // a slightly larger zoom must exceed the budget (otherwise a finer zoom was available)
  if (small < 12) {
    const [a0, a1, b0, b1] = tileRange(43, 48, 5, 15, small + 1);
    assert.ok((a1 - a0 + 1) * (b1 - b0 + 1) > 36);
  }
  const world = chooseZoom(-80, 80, -179, 179, 36);
  assert.equal(world, 6, "whole-world request falls back to the coarsest zoom");
});

// --------------------------------------------------------------------------- //
//  Terrain classification
// --------------------------------------------------------------------------- //
test("hsv returns degrees in [0,360) and normalised s/v", () => {
  near(hsv(255, 0, 0)[0], 0, 1e-9, "red hue");
  near(hsv(0, 255, 0)[0], 120, 1e-9, "green hue");
  near(hsv(0, 0, 255)[0], 240, 1e-9, "blue hue");
  near(hsv(10, 10, 10)[1], 0, 1e-9, "grey saturation");
  for (let i = 0; i < 500; i++) {
    const c = [Math.random() * 255, Math.random() * 255, Math.random() * 255];
    const [h] = hsv(...c);
    assert.ok(h >= 0 && h < 360, `hue out of range: ${h}`);
  }
});

test("classify recognises the unambiguous cases", () => {
  const cases = [
    ["open ocean", [2, 5, 20], 0, 4],
    ["bright snow", [245, 248, 250], 200, 6],
    ["snow by altitude", [60, 60, 60], ELEV_SNOW + 100, 6],
    ["desert sand", [203, 171, 122], 760, 5],
    ["high rock", [88, 71, 43], 3773, 3],
    ["mid rock", [130, 125, 120], ELEV_HILL + 100, 2],
    ["lowland green", [120, 170, 90], 100, 0],
  ];
  for (const [name, rgb, el, want] of cases) {
    assert.equal(classify(...rgb, el), want, name);
  }
});

test("classify always returns a valid type index", () => {
  const n = 2000;
  for (let i = 0; i < n; i++) {
    const rgb = [Math.random() * 255, Math.random() * 255, Math.random() * 255];
    const el = (Math.random() - 0.2) * 6000;
    const t = classify(...rgb, el);
    assert.ok(Number.isInteger(t) && t >= 0 && t <= 6, `bad index ${t}`);
  }
});

// --------------------------------------------------------------------------- //
//  Hexagon geometry + clipping
// --------------------------------------------------------------------------- //
test("hexCorners builds a regular pointy-top hexagon", () => {
  const cx = 12, cy = -7, s = 9;
  const pts = hexCorners(cx, cy, s);
  assert.equal(pts.length, 6);
  const radii = pts.map(([x, y]) => Math.hypot(x - cx, y - cy));
  for (const r of radii) near(r, s, 1e-9, "circumradius");
  const sides = pts.map((p, i) => {
    const q = pts[(i + 1) % 6];
    return Math.hypot(q[0] - p[0], q[1] - p[1]);
  });
  for (const side of sides) near(side, s, 1e-9, "side length equals circumradius");
  // pointy-top: the first vertex points straight up (screen y-down)
  near(pts[0][0], cx, 1e-9, "first vertex x");
  near(pts[0][1], cy - s, 1e-9, "first vertex y");
});

// Convex point-in-polygon that works for either winding.
function inside(p, poly) {
  const [x, y] = p;
  let pos = 0, neg = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    const c = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1);
    if (c > 1e-9) pos++;
    else if (c < -1e-9) neg++;
  }
  return pos === 0 || neg === 0;
}

test("clipSegment clips to the hexagon or rejects the segment", () => {
  const poly = hexCorners(0, 0, 10);

  const through = clipSegment([-50, 0], [50, 0], poly);
  assert.ok(through, "segment through the centre must clip");
  near(through[0][0], -Math.sqrt(3) / 2 * 10, 1e-9, "left intersection x");
  near(through[1][0], Math.sqrt(3) / 2 * 10, 1e-9, "right intersection x");

  assert.equal(clipSegment([-50, 30], [50, 30], poly), null, "above the hexagon");
  assert.equal(clipSegment([-50, -30], [50, -30], poly), null, "below the hexagon");
  assert.equal(clipSegment([-50, 0], [-20, 0], poly), null, "left of the hexagon");

  const insideSeg = clipSegment([-1, 0], [1, 0], poly);
  assert.deepEqual(insideSeg, [[-1, 0], [1, 0]], "fully interior segment is unchanged");
});

test("clipSegment output always lies inside the hexagon", () => {
  const poly = hexCorners(0, 0, 10);
  let hits = 0;
  for (let i = 0; i < 400; i++) {
    const a = [(Math.random() - 0.5) * 60, (Math.random() - 0.5) * 60];
    const b = [(Math.random() - 0.5) * 60, (Math.random() - 0.5) * 60];
    const seg = clipSegment(a, b, poly);
    if (!seg) continue;
    hits++;
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const p = [seg[0][0] + (seg[1][0] - seg[0][0]) * t,
                 seg[0][1] + (seg[1][1] - seg[0][1]) * t];
      assert.ok(inside(p, poly), `clipped point ${p} escaped the hexagon`);
    }
  }
  assert.ok(hits > 20, `too few segments hit the hexagon (${hits}); test is not exercising the code`);
});
