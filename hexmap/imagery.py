"""Fetching and sampling real satellite imagery (NASA GIBS / Blue Marble)."""
import io
import os
import math
import numpy as np
import requests
from PIL import Image

from config import GIBS_WMS, WORLD_CACHE, WORLD_URL
from geo import inverse


def fetch_satellite(latmin, latmax, lonmin, lonmax, layer="BlueMarble_NextGeneration"):
    """EPSG:4326 Blue Marble image for the bbox."""
    dlat = max(latmax - latmin, 1e-6)
    dlon = max(lonmax - lonmin, 1e-6)
    h = 700
    w = int(round(h * dlon / dlat))
    if w * h > 1_600_000:
        f = math.sqrt(1_600_000 / (w * h)); w = int(w * f); h = int(h * f)
    w = min(max(w, 64), 2500); h = min(max(h, 64), 2500)
    url = (GIBS_WMS.replace("{layer}", layer)
           .format(latmin=latmin, lonmin=lonmin, latmax=latmax, lonmax=lonmax,
                   w=w, h=h))
    r = requests.get(url, timeout=90); r.raise_for_status()
    return Image.open(io.BytesIO(r.content)).convert("RGB")


def get_world():
    if not os.path.exists(WORLD_CACHE) or os.path.getsize(WORLD_CACHE) < 1000:
        r = requests.get(WORLD_URL, timeout=120); r.raise_for_status()
        with open(WORLD_CACHE, "wb") as f:
            f.write(r.content)
    return WORLD_CACHE


def sample_image(arr, lat, lon, latmin, latmax, lonmin, lonmax):
    """Sample the EPSG:4326 image at each (lat,lon). arr: (H,W,3) float."""
    H, W = arr.shape[:2]
    px = np.clip(((lon - lonmin) / (lonmax - lonmin) * W).astype(int), 0, W - 1)
    py = np.clip(((latmax - lat) / (latmax - latmin) * H).astype(int), 0, H - 1)
    return arr[py, px]


def reproject_satellite(arr, latmin, latmax, lonmin, lonmax,
                        xmin, xmax, ymin, ymax, clat, clon, proj, cw, ch):
    """Reproject the EPSG:4326 image into the region's tangent plane (RGBA)."""
    Wd, Hd = arr.shape[1], arr.shape[0]
    xs = xmin + (np.arange(cw) + 0.5) / cw * (xmax - xmin)
    ys = ymax - (np.arange(ch) + 0.5) / ch * (ymax - ymin)
    XX, YY = np.meshgrid(xs, ys)                       # (ch, cw)
    lat, lon = inverse(XX, YY, clat, clon, proj)
    inside = (lat >= latmin) & (lat <= latmax) & (lon >= lonmin) & (lon <= lonmax)
    rgb = sample_image(arr, lat, lon, latmin, latmax, lonmin, lonmax).astype(np.uint8)
    rgba = np.zeros((ch, cw, 4), np.uint8)
    rgba[..., :3] = rgb
    rgba[..., 3] = np.where(inside, 255, 0)
    return rgba
