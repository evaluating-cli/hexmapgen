"""Shared configuration: tile types, colours, thresholds and data-source URLs."""
import os

HERE = os.path.dirname(os.path.abspath(__file__))

# 7 base terrain hex types. Indices must match terrain.classify().
TYPES = [
    {"key": "grass",    "name": "Grassland",  "color": "#8bc34a"},  # 0 lowland vegetation
    {"key": "forest",   "name": "Forest",     "color": "#2e7d32"},  # 1 dense dark lowland
    {"key": "hill",     "name": "Hill",       "color": "#d9c27a"},  # 2 mid-elevation (350-1000 m)
    {"key": "mountain", "name": "Mountain",   "color": "#8a6d4b"},  # 3 high elevation (>=1000 m)
    {"key": "water",    "name": "Water",      "color": "#1e88e5"},  # 4 sea / lake
    {"key": "desert",   "name": "Desert",     "color": "#f4c542"},  # 5
    {"key": "snow",     "name": "Snow / Ice", "color": "#e6edf3"},  # 6
]

# River overlay (not a base type) - drawn on top of the underlying terrain.
RIVER_COLOR = "#2f80c8"

# Elevation thresholds (metres) used to split grass / hill / mountain.
ELEV_HILL = 350.0
ELEV_MOUNTAIN = 1000.0
ELEV_SNOW = 4200.0      # very high elevation forced to snow/ice

# --- caches ---
WORLD_CACHE = os.path.join(HERE, "world.jpg")
DEM_CACHE = os.path.join(HERE, "dem_cache")
NE_RIVERS_CACHE = os.path.join(HERE, "ne_rivers.geojson")

# --- data sources ---
GIBS_WMS = ("https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
            "?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0"
            "&LAYERS=BlueMarble_NextGeneration&CRS=EPSG:4326"
            "&BBOX={latmin},{lonmin},{latmax},{lonmax}"
            "&WIDTH={w}&HEIGHT={h}&FORMAT=image/jpeg")

WORLD_URL = ("https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
             "?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0"
             "&LAYERS=BlueMarble_NextGeneration&CRS=EPSG:4326"
             "&BBOX=-90,-180,90,180&WIDTH=2048&HEIGHT=1024&FORMAT=image/jpeg")

DEM_TILE_URL = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png"

NE_RIVERS_URL = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
                 "master/geojson/ne_10m_rivers_lake_centerlines.geojson")

DEM_MAX_TILES = 36          # cap fetched tiles per region
DEM_ZOOMS = (12, 11, 10, 9, 8, 7, 6)
