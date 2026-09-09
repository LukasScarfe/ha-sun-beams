"""Constants for the Sun Beams integration."""

from __future__ import annotations

DOMAIN = "sun_beams"

# Config-entry data / options keys.
CONF_LATITUDE = "latitude"
CONF_LONGITUDE = "longitude"
CONF_ALBEDO = "albedo"
CONF_EFFICACY = "efficacy"
CONF_GEOMETRY = "geometry"          # {footprint, floor, windows, ...}
CONF_OSM_WAY = "osm_way_id"

# geometry sub-keys
GEO_FOOTPRINT = "footprint"         # list[[x, y]] metres, local ENU (x=east, y=north)
GEO_FLOOR = "floor"                 # list[[x, y]] metres — interior polygon for beams
GEO_WINDOWS = "windows"             # list[window dict]
GEO_ORIGIN = "origin"               # {"lat":, "lon":} the ENU projection origin

# window dict keys
WIN_ID = "id"
WIN_NAME = "name"
WIN_X1 = "x1"
WIN_Y1 = "y1"
WIN_X2 = "x2"
WIN_Y2 = "y2"
WIN_AZIMUTH = "azimuth"             # degrees, outward normal, 0=N clockwise
WIN_TILT = "tilt"                   # degrees from horizontal (90 = vertical)
WIN_HEIGHT = "height"               # metres (for future facade / lux area work)

# Open-Meteo
OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
OPEN_METEO_CURRENT = (
    "direct_normal_irradiance,diffuse_radiation,shortwave_radiation,"
    "direct_radiation,cloud_cover"
)
# coordinator data keys
DATA_DNI = "dni"                    # direct_normal_irradiance
DATA_DHI = "dhi"                    # diffuse_radiation
DATA_GHI = "ghi"                    # shortwave_radiation
DATA_CLOUD = "cloud_cover"

UPDATE_INTERVAL_SECONDS = 900       # 15 min — Open-Meteo updates ~quarter-hourly

# Overpass (server-side building lookup during config flow)
OVERPASS_URLS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)
OVERPASS_SEARCH_RADIUS_M = 60

DEFAULT_ALBEDO = 0.2
DEFAULT_EFFICACY = 120.0
