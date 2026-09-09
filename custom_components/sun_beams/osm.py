"""Async OpenStreetMap (Overpass) building-footprint lookup.

Kept small and best-effort: if OSM has no building at the coordinates, or every
Overpass mirror is unreachable, callers fall back to an empty footprint (the
card editor can still let the user draw one by hand).

Besides the building the user sits in, we keep every *other* building the query
returns as a shadow-casting ``obstruction`` (projected about the same origin and
tagged with a height), so the per-window beam can be blocked by a neighbour."""

from __future__ import annotations

import logging
import re

import aiohttp

from .const import (
    DEFAULT_BUILDING_HEIGHT_M,
    LEVEL_HEIGHT_M,
    OVERPASS_SEARCH_RADIUS_M,
    OVERPASS_URLS,
)
from .geometry import ensure_ccw, latlon_to_local, project_ring

_LOGGER = logging.getLogger(__name__)

_HEADERS = {"User-Agent": "ha-sun-beams/0.1 (github.com/LukasScarfe/ha-sun-beams)"}

_NUM_RE = re.compile(r"[-+]?\d*\.?\d+")


def _overpass_query(lat: float, lon: float) -> str:
    r = OVERPASS_SEARCH_RADIUS_M
    return (
        f"[out:json][timeout:25];"
        f'(way["building"](around:{r},{lat},{lon});'
        f'relation["building"](around:{r},{lat},{lon}););'
        f"out tags geom;"
    )


def _first_number(value) -> float | None:
    """Leading number out of an OSM tag value like ``"12 m"`` or ``"3"``."""
    if value is None:
        return None
    m = _NUM_RE.search(str(value))
    return float(m.group()) if m else None


def _building_height(tags: dict | None) -> float:
    """Best-effort building height in metres from OSM tags: an explicit ``height``
    if present, else ``building:levels`` × a per-storey height, else the default."""
    tags = tags or {}
    h = _first_number(tags.get("height"))
    if h and h > 0:
        return h
    levels = _first_number(tags.get("building:levels"))
    if levels and levels > 0:
        return levels * LEVEL_HEIGHT_M
    return DEFAULT_BUILDING_HEIGHT_M


def _closest_building(elements: list[dict], lat: float, lon: float) -> dict | None:
    """Pick the building whose centroid is nearest the coordinates."""
    best = None
    best_d = float("inf")
    for el in elements:
        geom = el.get("geometry") or []
        if len(geom) < 3:
            continue
        clat = sum(p["lat"] for p in geom) / len(geom)
        clon = sum(p["lon"] for p in geom) / len(geom)
        d = (clat - lat) ** 2 + (clon - lon) ** 2
        if d < best_d:
            best_d, best = d, el
    return best


def _obstructions_about(
    elements: list[dict], main: dict, origin_lat: float, origin_lon: float
) -> list[dict]:
    """Every building except ``main`` as ``{"ring": [[x, y]...], "height": m}``,
    projected to local ENU metres about the given origin."""
    obstructions: list[dict] = []
    for el in elements:
        if el is main:
            continue
        geom = el.get("geometry") or []
        if len(geom) < 3:
            continue
        ring = [latlon_to_local(p["lat"], p["lon"], origin_lat, origin_lon) for p in geom]
        obstructions.append(
            {
                "ring": [[round(x, 2), round(y, 2)] for x, y in ring],
                "height": round(_building_height(el.get("tags")), 1),
            }
        )
    return obstructions


async def _fetch_elements(
    session: aiohttp.ClientSession, lat: float, lon: float
) -> list[dict] | None:
    """POST the Overpass query to each mirror in turn; return the ``elements``
    list from the first that answers, or ``None`` if all fail."""
    query = _overpass_query(lat, lon)
    for url in OVERPASS_URLS:
        try:
            async with session.post(
                url, data={"data": query}, headers=_HEADERS, timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                if resp.status != 200:
                    _LOGGER.debug("Overpass %s returned %s", url, resp.status)
                    continue
                data = await resp.json(content_type=None)
        except (aiohttp.ClientError, TimeoutError, ValueError) as err:
            _LOGGER.debug("Overpass %s failed: %s", url, err)
            continue
        return data.get("elements", [])
    return None


async def async_fetch_building_footprint(
    session: aiohttp.ClientSession, lat: float, lon: float
) -> dict | None:
    """Return the building at (lat, lon) with its neighbours as shadow casters::

        {"footprint": [[x, y], ...], "origin": {"lat":, "lon":},
         "osm_way_id": int, "building_height": m,
         "obstructions": [{"ring": [[x, y], ...], "height": m}, ...]}

    or ``None``. All geometry is projected to local ENU metres about the main
    building's centroid and the footprint is wound counter-clockwise; neighbours
    keep their raw winding (the shadow test is winding-agnostic)."""
    elements = await _fetch_elements(session, lat, lon)
    if elements is None:
        return None
    building = _closest_building(elements, lat, lon)
    if not building:
        return None
    ring = [(p["lat"], p["lon"]) for p in building["geometry"]]
    pts, olat, olon = project_ring(ring)
    pts = ensure_ccw(pts)
    return {
        "footprint": [[round(x, 2), round(y, 2)] for x, y in pts],
        "origin": {"lat": olat, "lon": olon},
        "osm_way_id": building.get("id"),
        "building_height": round(_building_height(building.get("tags")), 1),
        "obstructions": _obstructions_about(elements, building, olat, olon),
    }


async def async_fetch_surroundings(
    session: aiohttp.ClientSession,
    lat: float,
    lon: float,
    origin_lat: float,
    origin_lon: float,
) -> dict | None:
    """Refresh just the shadow inputs for an existing building, **without** moving
    its projection origin (so already-saved floor/window coordinates stay valid).

    Returns ``{"building_height": m, "obstructions": [...]}`` projected about the
    supplied ``origin_lat/lon``, or ``None`` if OSM couldn't be reached."""
    elements = await _fetch_elements(session, lat, lon)
    if elements is None:
        return None
    building = _closest_building(elements, lat, lon)
    return {
        "building_height": round(_building_height(building.get("tags")), 1)
        if building
        else DEFAULT_BUILDING_HEIGHT_M,
        "obstructions": _obstructions_about(elements, building, origin_lat, origin_lon),
    }
