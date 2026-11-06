"""Map projections (geographic <-> tangent plane) and Web-Mercator tile math.

Two centred azimuthal projections are supported, chosen because no single
projection can be both equidistant *and* equal-area -- the GUI lets the user
pick either:
  * "equalarea"   -> Lambert Azimuthal Equal-Area  (each hex ~= equal Earth area)
  * "equidistant" -> Azimuthal Equidistant         (true distance/direction from centre)
"""
import math
import numpy as np

R = 6371.0  # mean Earth radius, km


def forward(lat, lon, clat, clon, proj):
    """Geographic (deg) -> tangent plane (x = east km, y = north km). Vectorised."""
    lat = np.asarray(lat, float); lon = np.asarray(lon, float)
    phi = np.radians(lat); lam = np.radians(lon)
    phi1 = math.radians(clat); lam0 = math.radians(clon)
    dlam = lam - lam0
    sinp1, cosp1 = math.sin(phi1), math.cos(phi1)
    sinp, cosp = np.sin(phi), np.cos(phi)
    cosc = np.clip(sinp1 * sinp + cosp1 * cosp * np.cos(dlam), -1.0, 1.0)

    if proj == "equalarea":
        k = np.sqrt(2.0 / (1.0 + cosc))
    else:  # equidistant
        c = np.arccos(cosc)
        with np.errstate(divide="ignore", invalid="ignore"):
            k = np.where(c > 1e-12, c / np.sin(c), 1.0)

    x = R * k * cosp * np.sin(dlam)
    y = R * k * (cosp1 * sinp - sinp1 * cosp * np.cos(dlam))
    if proj == "equidistant":
        zero = np.arccos(cosc) <= 1e-12
        x = np.where(zero, 0.0, x)
        y = np.where(zero, 0.0, y)
    return x, y


def inverse(x, y, clat, clon, proj):
    """Tangent plane (km) -> geographic (deg). Vectorised."""
    x = np.asarray(x, float); y = np.asarray(y, float)
    phi1 = math.radians(clat); lam0 = math.radians(clon)
    sinp1, cosp1 = math.sin(phi1), math.cos(phi1)
    rho = np.sqrt(x * x + y * y)
    near0 = rho <= 1e-9

    c = (2.0 * np.arcsin(np.clip(rho / (2.0 * R), -1.0, 1.0))
         if proj == "equalarea" else rho / R)
    sin_c, cos_c = np.sin(c), np.cos(c)

    lat = np.degrees(np.arcsin(np.clip(
        cos_c * sinp1 + np.where(near0, 0.0, y * sin_c * cosp1 / np.where(near0, 1.0, rho)),
        -1.0, 1.0)))
    lon = np.degrees(lam0 + np.arctan2(
        x * sin_c,
        np.where(near0, 1.0, rho * cosp1 * cos_c - y * sinp1 * sin_c)))
    return np.where(near0, clat, lat), np.where(near0, clon, lon)


# --------------------------------------------------------------------------- #
#  Web-Mercator tile math (for DEM Terrarium tiles)
# --------------------------------------------------------------------------- #
def latlon_to_global_pixel(lat, lon, z):
    """Lat/lon -> global Web-Mercator pixel coords at zoom z (256 px tiles)."""
    n = (2 ** z) * 256.0
    gx = (np.asarray(lon, float) + 180.0) / 360.0 * n
    lat = np.clip(np.asarray(lat, float), -85.05112878, 85.05112878)
    gy = (1.0 - np.arcsinh(np.tan(np.radians(lat))) / np.pi) / 2.0 * n
    return gx, gy


def tile_range(latmin, latmax, lonmin, lonmax, z):
    """Tile (x,y) indices covering the bbox at zoom z."""
    gx0, gy0 = latlon_to_global_pixel(latmax, lonmin, z)
    gx1, gy1 = latlon_to_global_pixel(latmin, lonmax, z)
    tx0 = math.floor(gx0 / 256.0); tx1 = math.floor(gx1 / 256.0)
    ty0 = math.floor(gy0 / 256.0); ty1 = math.floor(gy1 / 256.0)
    return tx0, tx1, ty0, ty1
