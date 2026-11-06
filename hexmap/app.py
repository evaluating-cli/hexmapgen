"""Hex Earth — Flask app that turns real satellite imagery into a hex map.

Pipeline (per /api/generate request):
  1. project the region onto a tangent plane (equal-area or equidistant);
  2. lay a uniform hex grid in that plane;
  3. sample the true Blue Marble colour + Terrarium elevation at each hex;
  4. classify into one of 7 terrain types;
  5. overlay Natural Earth rivers clipped to the hexes they cross;
  6. reproject a satellite backdrop and return everything as JSON.
"""
import io
import os
import math
import base64
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image
from flask import Flask, request, jsonify, send_file

import config
from geo import forward, inverse
from terrain import classify, build_elevation_grid, sample_elevations
from rivers import clip_rivers_to_hexes
from imagery import fetch_satellite, get_world, sample_image, reproject_satellite

app = Flask(__name__)


@app.route("/")
def index():
    return send_file(config.NE_RIVERS_CACHE.replace("ne_rivers.geojson", "index.html"))


@app.route("/api/worldmap")
def worldmap():
    return send_file(get_world(), mimetype="image/jpeg")


@app.route("/api/types")
def types():
    return jsonify({"types": config.TYPES, "river": config.RIVER_COLOR})


@app.route("/api/health")
def health():
    return jsonify({"ok": True})


@app.route("/api/generate")
def generate():
    try:
        lat0 = float(request.args["lat0"]); lat1 = float(request.args["lat1"])
        lon0 = float(request.args["lon0"]); lon1 = float(request.args["lon1"])
    except (KeyError, ValueError):
        return jsonify({"error": "Missing or invalid lat/lon parameters."}), 400

    cols = max(10, min(int(request.args.get("cols", 70)), 200))
    proj = request.args.get("proj", "equalarea")
    proj = "equidistant" if proj == "equidistant" else "equalarea"
    use_rivers = request.args.get("rivers", "1") not in ("0", "false")

    latmin, latmax = sorted([lat0, lat1])
    lonmin, lonmax = sorted([lon0, lon1])
    if (latmax - latmin) < 0.05 or (lonmax - lonmin) < 0.05:
        return jsonify({"error": "Selected region is too small (need >= 0.05 deg)."}), 400
    if (latmax - latmin) > 70 or (lonmax - lonmin) > 70:
        return jsonify({"error": "Region too large for an azimuthal projection (max ~70 deg)."}), 400
    latmin = max(latmin, -85.0); latmax = min(latmax, 85.0)

    clat = (latmin + latmax) / 2.0
    clon = (lonmin + lonmax) / 2.0

    # --- projected bounding box from the four corners ---
    corners = [(latmin, lonmin), (latmin, lonmax), (latmax, lonmin), (latmax, lonmax)]
    xs, ys = [], []
    for la, lo in corners:
        x, y = forward(la, lo, clat, clon, proj)
        xs.append(float(x)); ys.append(float(y))
    xmin, xmax = min(xs), max(xs)
    ymin, ymax = min(ys), max(ys)
    Wkm, Hkm = xmax - xmin, ymax - ymin

    # --- pointy-top hex lattice covering the projected box ---
    s_km = Wkm / (math.sqrt(3) * cols)
    hx, hy = math.sqrt(3) * s_km, 1.5 * s_km
    ncols = int(math.ceil(Wkm / hx)) + 2
    nrows = int(math.ceil(Hkm / hy)) + 2
    rr, cc = np.meshgrid(np.arange(nrows), np.arange(ncols), indexing="ij")
    cxs = (xmin + cc * hx + (rr % 2) * (hx / 2.0)).ravel()
    cys = (ymin + rr * hy).ravel()

    # --- keep only centres inside the region ---
    lat, lon = inverse(cxs, cys, clat, clon, proj)
    mask = (lat >= latmin) & (lat <= latmax) & (lon >= lonmin) & (lon <= lonmax)
    cxs, cys = cxs[mask], cys[mask]
    lat, lon = lat[mask], lon[mask]
    if cxs.size == 0:
        return jsonify({"error": "No hexes fell inside the region."}), 400
    if cxs.size > 40000:
        return jsonify({"error": f"Too many hexes ({cxs.size}). Lower the density."}), 400

    # --- fetch satellite + build DEM concurrently ---
    try:
        sat_err = None
        with ThreadPoolExecutor(2) as ex:
            fut_img = ex.submit(fetch_satellite, latmin, latmax, lonmin, lonmax)
            fut_dem = ex.submit(build_elevation_grid, latmin, latmax, lonmin, lonmax)
            img = fut_img.result()
            try:
                mosaic, tx0, ty0, z = fut_dem.result()
                el = sample_elevations(mosaic, tx0, ty0, z, lat, lon)
            except Exception as e:           # DEM optional -> colour-only
                print("[generate] DEM failed:", e); el = np.zeros(cxs.size)
    except Exception as e:
        return jsonify({"error": f"Could not fetch satellite imagery: {e}"}), 502

    # --- classify ---
    arr = np.asarray(img).astype(float)
    rgb = sample_image(arr, lat, lon, latmin, latmax, lonmin, lonmax)
    t = classify(rgb, el)

    # --- canvas mapping (km -> px), north up ---
    maxpx = 940
    scale = maxpx / max(Wkm, Hkm)
    cw, ch = int(round(Wkm * scale)), int(round(Hkm * scale))
    X = (cxs - xmin) * scale
    Y = (ymax - cys) * scale
    size_px = s_km * scale

    # --- river overlays ---
    rivers_by_hex = {}
    if use_rivers:
        def ll2px(la, lo):
            xk, yk = forward(la, lo, clat, clon, proj)
            return (xk - xmin) * scale, (ymax - yk) * scale
        try:
            rivers_by_hex = clip_rivers_to_hexes(
                latmin, latmax, lonmin, lonmax, ll2px,
                list(zip(X.tolist(), Y.tolist())), float(size_px))
        except Exception as e:
            print("[generate] rivers failed:", e)

    # --- assemble hexes ---
    Xl, Yl, tl = X.tolist(), Y.tolist(), t.tolist()
    hexes = []
    for i in range(len(Xl)):
        h = {"x": Xl[i], "y": Yl[i], "t": tl[i]}
        if i in rivers_by_hex:
            h["river"] = rivers_by_hex[i]
        hexes.append(h)

    counts = np.bincount(t, minlength=len(config.TYPES)).tolist()
    river_count = len(rivers_by_hex)

    # --- satellite backdrop (reprojected), reduced resolution ---
    sat_b64 = None
    try:
        f = min(1.0, 640.0 / max(cw, ch))
        sw, sh = max(2, int(round(cw * f))), max(2, int(round(ch * f)))
        sat_rgba = reproject_satellite(arr, latmin, latmax, lonmin, lonmax,
                                       xmin, xmax, ymin, ymax, clat, clon, proj, sw, sh)
        buf = io.BytesIO()
        Image.fromarray(sat_rgba).save(buf, "PNG", optimize=True)
        sat_b64 = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception as e:
        print("[generate] backdrop failed:", e)

    return jsonify({
        "hexes": hexes,
        "size_px": float(size_px),
        "cw": cw, "ch": ch,
        "counts": counts,
        "total": int(len(hexes)),
        "river_count": int(river_count),
        "types": config.TYPES,
        "river_color": config.RIVER_COLOR,
        "projection": "Lambert Azimuthal Equal-Area" if proj == "equalarea"
                      else "Azimuthal Equidistant",
        "projection_key": proj,
        "center": [round(clat, 3), round(clon, 3)],
        "bbox": [round(latmin, 3), round(latmax, 3),
                 round(lonmin, 3), round(lonmax, 3)],
        "sat": sat_b64,
    })


if __name__ == "__main__":
    try:
        get_world()
        print("world map cached")
    except Exception as e:
        print("world map prefetch failed:", e)
    app.run(host="0.0.0.0", port=8080, threaded=True)
