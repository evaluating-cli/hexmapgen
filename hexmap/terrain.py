"""DEM (Terrarium) elevation grid + terrain classification.

Elevation lets us split land into Grassland / Hill / Mountain by altitude,
which pure satellite colour cannot do. The DEM is optional: if it cannot be
fetched, classification falls back to colour-only (no hills/mountains-by-height).
"""
import os
import math
import numpy as np
from PIL import Image
import requests
from concurrent.futures import ThreadPoolExecutor

from config import (DEM_CACHE, DEM_TILE_URL, DEM_MAX_TILES, DEM_ZOOMS,
                    ELEV_HILL, ELEV_MOUNTAIN, ELEV_SNOW)
from geo import latlon_to_global_pixel, tile_range


# --------------------------------------------------------------------------- #
#  DEM mosaic from Terrarium elevation tiles
# --------------------------------------------------------------------------- #
def _choose_zoom(latmin, latmax, lonmin, lonmax):
    for z in DEM_ZOOMS:
        tx0, tx1, ty0, ty1 = tile_range(latmin, latmax, lonmin, lonmax, z)
        if (tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= DEM_MAX_TILES:
            return z
    return DEM_ZOOMS[-1]


def _decode_elev(img):
    """Terrarium PNG -> elevation metres (R*256 + G + B/256 - 32768)."""
    a = np.asarray(img.convert("RGB"), dtype=np.float32)
    return a[..., 0] * 256.0 + a[..., 1] + a[..., 2] / 256.0 - 32768.0


def _fetch_tile(z, tx, ty):
    path = os.path.join(DEM_CACHE, str(z), str(tx), f"{ty}.png")
    if not os.path.exists(path) or os.path.getsize(path) < 200:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        url = DEM_TILE_URL.format(z=z, x=tx, y=ty)
        r = requests.get(url, timeout=60); r.raise_for_status()
        with open(path, "wb") as f:
            f.write(r.content)
    return Image.open(path)


def build_elevation_grid(latmin, latmax, lonmin, lonmax):
    """Return (mosaic elevations, tx0, ty0, z). Raises on failure."""
    z = _choose_zoom(latmin, latmax, lonmin, lonmax)
    tx0, tx1, ty0, ty1 = tile_range(latmin, latmax, lonmin, lonmax, z)
    cols, rows = tx1 - tx0 + 1, ty1 - ty0 + 1
    mosaic = np.zeros((rows * 256, cols * 256), dtype=np.float32)

    tiles = [(tx, ty) for ty in range(ty0, ty1 + 1) for tx in range(tx0, tx1 + 1)]
    with ThreadPoolExecutor(max_workers=8) as ex:
        imgs = dict(ex.map(lambda t: ((t[0], t[1]), _fetch_tile(z, t[0], t[1])), tiles))
    for (tx, ty), img in imgs.items():
        mosaic[(ty - ty0) * 256:(ty - ty0) * 256 + 256,
               (tx - tx0) * 256:(tx - tx0) * 256 + 256] = _decode_elev(img)
    return mosaic, tx0, ty0, z


def sample_elevations(mosaic, tx0, ty0, z, lat, lon):
    gx, gy = latlon_to_global_pixel(lat, lon, z)
    H, W = mosaic.shape
    px = np.clip((gx - tx0 * 256).astype(int), 0, W - 1)
    py = np.clip((gy - ty0 * 256).astype(int), 0, H - 1)
    el = mosaic[py, px]
    el = np.where(el < -1000.0, 0.0, el)   # treat nodata as sea level
    return el


def get_elevations(latmin, latmax, lonmin, lonmax, lat, lon):
    """Elevation (m) for each (lat, lon). Returns zeros on failure (colour-only)."""
    try:
        mosaic, tx0, ty0, z = build_elevation_grid(latmin, latmax, lonmin, lonmax)
        return sample_elevations(mosaic, tx0, ty0, z, lat, lon), z
    except Exception as e:
        print("[dem] unavailable, falling back to colour-only:", e)
        return np.zeros(len(np.atleast_1d(lat)), dtype=np.float32), None


# --------------------------------------------------------------------------- #
#  Terrain classification (colour + elevation)
# --------------------------------------------------------------------------- #
def _hsv(rgb):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = np.max(rgb, axis=-1); mn = np.min(rgb, axis=-1)
    v = mx
    s = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-9), 0.0)
    delta = np.maximum(mx - mn, 1e-9)
    rc = (mx - r) / delta; gc = (mx - g) / delta; bc = (mx - b) / delta
    h = np.where(mx == r, bc - gc, np.where(mx == g, 2.0 + rc - bc, 4.0 + gc - rc))
    return (h * 60.0) % 360.0, s, v


def classify(rgb, el):
    """rgb (...,3) float 0..255 + elevation (m) -> int type index 0..6."""
    rgb = np.asarray(rgb, float)
    el = np.asarray(el, float)
    h, s, v = _hsv(rgb)

    water = (h >= 185) & (h <= 265) & (s >= 0.25)
    snow_white = (v >= 228) & (s <= 0.18)
    desert = (h >= 20) & (h <= 58) & (v >= 150) & (s >= 0.15)
    green = (h >= 65) & (h <= 170) & (s >= 0.20)

    high = el >= ELEV_MOUNTAIN
    mid = (el >= ELEV_HILL) & ~high

    t = np.full(v.shape, 0, dtype=int)                      # default Grassland
    t[water] = 4
    t[desert] = 5
    # vegetated land split by elevation
    t[green & high] = 3                                     # Mountain
    t[green & mid] = 2                                      # Hill
    t[green & ~mid & ~high & (v < 80)] = 1                  # Forest
    t[green & ~mid & ~high & (v >= 80)] = 0                 # Grassland
    # bare (non-vegetated) land split by elevation
    bare = ~(water | snow_white | desert | green)
    t[bare & high] = 3
    t[bare & mid] = 2
    t[bare & ~mid & ~high] = 0
    # snow/ice last: white surface or extreme altitude overrides vegetation
    t[(snow_white) | (el >= ELEV_SNOW)] = 6
    return t
