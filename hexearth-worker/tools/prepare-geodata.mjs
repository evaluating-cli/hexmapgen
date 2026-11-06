// Reduce Natural Earth vectors to what the classifier needs: polygon rings,
// coordinates rounded to 4 decimal places (~11 m), no attributes.
//
//   node tools/prepare-geodata.mjs <land.geojson> <lakes.geojson> <outdir>
//
// Source (public domain): https://github.com/nvkelso/natural-earth-vector
//   ne_50m_land.geojson   ne_50m_lakes.geojson

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [, , landPath, lakesPath, outDir] = process.argv;
if (!landPath || !lakesPath || !outDir) {
  console.error("usage: node tools/prepare-geodata.mjs <land.geojson> <lakes.geojson> <outdir>");
  process.exit(1);
}

const PRECISION = 4; // ~11 m at the equator

function ringsOf(geometry) {
  const out = [];
  const addPolygon = (rings) => {
    for (const ring of rings) {
      const pts = [];
      for (const [lon, lat] of ring) {
        pts.push(Number(lon.toFixed(PRECISION)), Number(lat.toFixed(PRECISION)));
      }
      if (pts.length >= 6) out.push(pts);
    }
  };
  if (geometry.type === "Polygon") addPolygon(geometry.coordinates);
  else if (geometry.type === "MultiPolygon") for (const p of geometry.coordinates) addPolygon(p);
  return out;
}

function convert(path) {
  const gj = JSON.parse(readFileSync(path, "utf8"));
  const rings = [];
  for (const f of gj.features) {
    const g = f.geometry;
    if (!g) continue;
    rings.push(...ringsOf(g));
  }
  let vertices = 0;
  for (const r of rings) vertices += r.length / 2;
  return { rings, vertices };
}

mkdirSync(outDir, { recursive: true });
for (const [path, name] of [[landPath, "land"], [lakesPath, "lakes"]]) {
  const { rings, vertices } = convert(path);
  // flat [lon, lat, lon, lat, ...] per ring keeps the payload small
  const flat = rings.map((r) => r);
  const json = JSON.stringify({ rings: flat });
  const out = join(outDir, `${name}.json`);
  writeFileSync(out, json);
  console.log(`${name}: ${rings.length} rings, ${vertices} vertices, ${(json.length / 1024).toFixed(0)} KB -> ${out}`);
}
