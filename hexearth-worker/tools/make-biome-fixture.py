"""Regenerate test/fixtures/biomes.json from live data.

Requires numpy, pillow and requests (see requirements.txt). Network access to
NASA GIBS and the AWS Terrarium tiles is needed; the test that consumes the
fixture does not.

For each point: satellite RGB at the centre, plus elevation mean/min/max over a
3x3 grid spanning ~6 km (a typical hex at 70 columns). Written to JSON so the
JS classifier can be regression-tested without network access.
"""
import json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "hexmap"))
import numpy as np
from imagery import fetch_satellite, sample_image
from terrain import build_elevation_grid, sample_elevations

P = [
 ("water","N Atlantic",40,-40),("water","Mid Pacific",0,-150),("water","S Pacific",-30,-120),
 ("water","Indian Ocean",-20,80),("water","S Ocean",-55,0),("water","N Pacific",35,170),
 ("water","Arabian Sea",15,65),("water","Bay of Bengal",15,88),("water","Coral Sea",-15,150),
 ("water","Norwegian Sea",65,5),("water","L. Superior",47.7,-87.5),("water","L. Victoria",-1,33),
 ("water","L. Baikal",53.5,108),("water","L. Tanganyika",-6,29.5),("water","Great Bear L.",66,-121),
 ("water","L. Ladoga",61,31.5),("water","L. Michigan",44,-87),("water","L. Titicaca",-15.8,-69.4),
 ("water","Caspian",42,50.5),("water","L. Ontario",43.7,-77.8),
 ("forest","Amazon",-4,-62),("forest","Congo",1,22),("forest","Borneo",0.5,114),
 ("forest","Boreal Sweden",64,18),("forest","Taiga Siberia",60,100),("forest","Appalachian",38,-80),
 ("forest","New Guinea",-5,141),("forest","Finland",63,27),
 ("desert","Sahara",23,10),("desert","Rub al Khali",20,51),("desert","Namib",-24,15),
 ("desert","Atacama",-23,-69),("desert","Gobi",43,105),("desert","Simpson",-25,137),
 ("desert","Mojave",35,-116),
 ("grass","Kansas",38.5,-99),("grass","Ukrainian steppe",47,34),("grass","Mongolian steppe",46,105),
 ("grass","Pampas",-35,-62),("grass","Cerrado",-15,-47),("grass","Sahel",14,0),
 ("mountain","Himalaya",28,86.9),("mountain","Andes",-32.6,-70.0),("mountain","Rockies",39.1,-106.5),
 ("mountain","Caucasus",43.3,42.4),("mountain","Alaska Range",63.1,-151),
 ("snow","Greenland",72,-40),("snow","Antarctica",-75,0),("snow","Vatnajokull",64.4,-16.8),
]

D = 0.03  # ~3.3 km; the 3x3 grid spans ~6.6 km
out = []
for label, name, la, lo in P:
    bbox = (la - 2.5, la + 2.5, lo - 2.5, lo + 2.5)
    try:
        img = fetch_satellite(*bbox)
        arr = np.asarray(img).astype(float)
        mosaic, tx0, ty0, z = build_elevation_grid(*bbox)
        lats = np.array([la + D * dy for dy in (-1, 0, 1) for dx in (-1, 0, 1)])
        lons = np.array([lo + D * dx for dy in (-1, 0, 1) for dx in (-1, 0, 1)])
        els = sample_elevations(mosaic, tx0, ty0, z, lats, lons)
        rgb = sample_image(arr, np.array([la]), np.array([lo]), *bbox)[0]
        rec = {
            "label": label, "name": name, "lat": la, "lon": lo,
            "rgb": [int(v) for v in rgb],
            "el": int(round(float(np.mean(els)))),
            "elMin": int(round(float(np.min(els)))),
            "elMax": int(round(float(np.max(els)))),
            "relief": int(round(float(np.max(els) - np.min(els)))),
        }
        out.append(rec)
        print(f"{name:18s} el={rec['el']:6d} relief={rec['relief']:5d} rgb={tuple(rec['rgb'])!s:18s} ({label})", flush=True)
    except Exception as e:
        print(f"{name:18s} FAILED: {e}", flush=True)

json.dump({"note": "49 reference biomes sampled from NASA Blue Marble + Terrarium DEM. "
                   "el = mean of a 3x3 grid spanning ~6 km, relief = max-min over that grid.",
           "points": out},
          open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test", "fixtures", "biomes.json"), "w"), indent=1)
print(f"\nwrote {len(out)} points")
