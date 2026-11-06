// Classification accuracy regression test.
//
// The fixture holds reference biomes sampled once from NASA Blue Marble and the
// AWS Terrarium DEM (see tools/make-biome-fixture.py). This test is fully
// offline: it reads the fixture and the committed Natural Earth masks.
//
// REVIEW.md measured the old colour+elevation classifier at 57% agreement.
// The relief-based classifier scores 92%. The floor is set below that so small
// threshold tweaks do not break CI, but a regression back towards 57% will.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildMask, pointInMask, classify } from "../public/lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const load = (p) => JSON.parse(readFileSync(join(here, p), "utf8"));

const TYPES = ["grass", "forest", "hill", "mountain", "water", "desert", "snow"];
const fixture = load("fixtures/biomes.json");
const land = buildMask(load("../public/geodata/land.json").rings);
const lakes = buildMask(load("../public/geodata/lakes.json").rings);

function run() {
  const rows = [];
  for (const p of fixture.points) {
    const water = pointInMask(lakes, p.lon, p.lat) || !pointInMask(land, p.lon, p.lat);
    const got = TYPES[classify(p.rgb, p.el, p.relief, water)];
    const accepted = (p.accept || [p.label]).includes(got);
    rows.push({ ...p, got, accepted });
  }
  return rows;
}

const rows = run();
const good = rows.filter((r) => r.accepted).length;
const pct = 100 * good / rows.length;

function report() {
  const labels = ["water", "forest", "desert", "grass", "mountain", "snow", "hill"];
  const lines = [`accuracy ${good}/${rows.length} = ${pct.toFixed(1)}%`];
  for (const label of labels) {
    for (const r of rows.filter((r) => r.label === label && !r.accepted)) {
      lines.push(`  ${label} -> ${r.got}: ${r.name} (el ${r.el} m, relief ${r.relief} m)`);
    }
  }
  return lines.join("\n");
}

test("classifier agrees with reference biomes at least 85% of the time", () => {
  assert.ok(pct >= 85, report());
});

test("every reference water body is classified as water", () => {
  // The old classifier managed 16/20: dark lakes high above sea level were
  // turned into hill or mountain by the elevation rule.
  const water = rows.filter((r) => r.label === "water");
  const wrong = water.filter((r) => r.got !== "water");
  assert.deepEqual(wrong.map((r) => `${r.name} -> ${r.got}`), []);
  assert.equal(water.length, 20);
});

test("no land reference point is classified as water", () => {
  const wrong = rows.filter((r) => r.label !== "water" && r.got === "water");
  assert.deepEqual(wrong.map((r) => `${r.name} (${r.label})`), []);
});

test("deserts are recognised without relying on brightness", () => {
  // Old rule required v >= 150, which missed Mojave (v=130), Gobi (v=136) and
  // Atacama after the elevation override; it scored 3/7.
  const desert = rows.filter((r) => r.label === "desert");
  const hits = desert.filter((r) => r.got === "desert").length;
  assert.ok(hits >= 6, report());
});

test("snow and ice are never confused with land types", () => {
  const snow = rows.filter((r) => r.label === "snow");
  assert.ok(snow.every((r) => r.got === "snow"), report());
});
