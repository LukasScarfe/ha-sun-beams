"""Async OpenStreetMap (Overpass) building-footprint lookup.

Kept small and best-effort: if OSM has no building at the coordinates, or every
Overpass mirror is unreachable, callers fall back to an empty footprint (the
card editor can still let the user draw one by hand)."""

from __future__ import annotations

import logging

import aiohttp

from .const import OVERPASS_SEARCH_RADIUS_M, OVERPASS_URLS
from .geometry import ensure_ccw, project_ring

_LOGGER = logging.getLogger(__name__)

_HEADERS = {"User-Agent": "ha-sun-beams/0.1 (github.com/LukasScarfe/ha-sun-beams)"}


def _overpass_query(lat: float, lon: float) -> str:
    r = OVERPASS_SEARCH_RADIUS_M
    return (
        f"[out:json][timeout:25];"
        f'(way["building"](around:{r},{lat},{lon});'
        f'relation["building"](around:{r},{lat},{lon}););'
        f"out tags geom;"
    )


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


async def async_fetch_building_footprint(
    session: aiohttp.ClientSession, lat: float, lon: float
) -> dict | None:
    """Return ``{"footprint": [[x,y]...], "origin": {"lat":, "lon":},
    "osm_way_id": int}`` for the building at (lat, lon), or ``None``.

    Footprint is projected to local ENU metres and wound counter-clockwise."""
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

        building = _closest_building(data.get("elements", []), lat, lon)
        if not building:
            return None
        ring = [(p["lat"], p["lon"]) for p in building["geometry"]]
        pts, olat, olon = project_ring(ring)
        pts = ensure_ccw(pts)
        return {
            "footprint": [[round(x, 2), round(y, 2)] for x, y in pts],
            "origin": {"lat": olat, "lon": olon},
            "osm_way_id": building.get("id"),
        }
    return None
