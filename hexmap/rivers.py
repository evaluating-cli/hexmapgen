"""River detection from Natural Earth vector data.

Rivers are *overlays*, not a base terrain type: we clip each river polyline to
the hexagons it crosses and store the in-hex segment, so the front-end can draw
a "grass + river", "hill + river", ... tile. Plain water hexes are reserved for
seas and lakes.
"""
import os
import json
import math
import numpy as np
import requests
from shapely.geometry import LineString, Polygon
from shapely.strtree import STRtree
from collections import defaultdict

from config import NE_RIVERS_CACHE, NE_RIVERS_URL

_polylines = None   # cache: list of polylines, each = list of [lon, lat]


def load_rivers():
    """Return cached list of river polylines ([[lon,lat], ...])."""
    global _polylines
    if _polylines is not None:
        return _polylines
    if not os.path.exists(NE_RIVERS_CACHE) or os.path.getsize(NE_RIVERS_CACHE) < 1000:
        os.makedirs(os.path.dirname(NE_RIVERS_CACHE), exist_ok=True)
        r = requests.get(NE_RIVERS_URL, timeout=180)
        r.raise_for_status()
        with open(NE_RIVERS_CACHE, "wb") as f:
            f.write(r.content)
    with open(NE_RIVERS_CACHE) as f:
        gj = json.load(f)
    polys = []
    for feat in gj.get("features", []):
        g = feat.get("geometry") or {}
        gt = g.get("type")
        if gt == "LineString":
            polys.append(g["coordinates"])
        elif gt == "MultiLineString":
            polys.extend(g["coordinates"])
    _polylines = polys
    print(f"[rivers] loaded {len(polys)} river polylines")
    return _polylines


def rivers_in_bbox(latmin, latmax, lonmin, lonmax):
    """River polylines that touch the bbox (quick bbox reject on vertices)."""
    out = []
    for coords in load_rivers():
        for x, y in coords:
            if lonmin <= x <= lonmax and latmin <= y <= latmax:
                out.append(coords)
                break
    return out


def _hex_polygon(cx, cy, size):
    pts = [(cx + size * math.cos(math.radians(60 * i - 90)),
            cy + size * math.sin(math.radians(60 * i - 90))) for i in range(6)]
    return Polygon(pts)


def clip_rivers_to_hexes(latmin, latmax, lonmin, lonmax,
                         ll2px, hex_centers, hex_size):
    """Return {hex_index: [polyline, ...]} where each polyline is a list of
    [px_x, px_y] points clipped to that hexagon.

    ll2px: callable (lat, lon) -> (px_x, px_y) using the region's projection.
    hex_centers: list of (px_x, px_y). hex_size: centre-to-vertex radius in px.
    """
    polylines_ll = rivers_in_bbox(latmin, latmax, lonmin, lonmax)
    if not polylines_ll or len(hex_centers) > 30000:
        return {}

    # Project river vertices to canvas pixels -> shapely LineStrings.
    lines = []
    for coords in polylines_ll:
        pts = []
        for lon, lat in coords:
            try:
                X, Y = ll2px(float(lat), float(lon))
            except Exception:
                continue
            if np.isfinite(X) and np.isfinite(Y):
                pts.append((X, Y))
        # drop consecutive duplicates
        dedup = [pts[0]] + [pts[i] for i in range(1, len(pts))
                            if pts[i] != pts[i - 1]]
        if len(dedup) >= 2:
            lines.append(LineString(dedup))
    if not lines:
        return {}

    # Build hex polygons + spatial index, query per river line.
    hex_polys = [_hex_polygon(cx, cy, hex_size) for cx, cy in hex_centers]
    tree = STRtree(hex_polys)
    rivers_by_hex = defaultdict(list)
    for line in lines:
        for hi in tree.query(line):
            inter = hex_polys[int(hi)].intersection(line)
            if inter.is_empty:
                continue
            geoms = [inter] if inter.geom_type == "LineString" else list(inter.geoms)
            for g in geoms:
                if g.geom_type == "LineString" and not g.is_empty:
                    rivers_by_hex[int(hi)].append([[c[0], c[1]] for c in g.coords])
    return rivers_by_hex
