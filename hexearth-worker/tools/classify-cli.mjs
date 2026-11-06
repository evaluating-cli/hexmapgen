// Classify a batch of samples from JSON on stdin, print type indices as JSON.
// Used by tools/preview.mjs and handy for debugging against real data.
import { readFileSync } from "node:fs";
import { buildMask, pointInMask, classify } from "../public/lib.mjs";

const here = new URL("../public/geodata/", import.meta.url);
const land = buildMask(JSON.parse(readFileSync(new URL("land.json", here))).rings);
const lakes = buildMask(JSON.parse(readFileSync(new URL("lakes.json", here))).rings);
const input = JSON.parse(readFileSync(0, "utf8"));
const out = input.map(([lon, lat, r, g, b, el, relief]) => {
  const water = pointInMask(lakes, lon, lat) || !pointInMask(land, lon, lat);
  return classify([r, g, b], el, relief, water);
});
process.stdout.write(JSON.stringify(out));
