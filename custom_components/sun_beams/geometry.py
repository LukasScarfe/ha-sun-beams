"""Geometry helpers: project OSM lat/lon footprints to a local metric plane
and derive wall azimuths. Pure functions — no HA, no network (the HTTP fetch
lives in the async code that calls ``project_ring``)."""

from __future__ import annotations

import math

EARTH_R = 6378137.0  # metres, WGS84 equatorial


def latlon_to_local(lat: float, lon: float, origin_lat: float, origin_lon: float):
    """Equirectangular projection of (lat, lon) to local ENU metres about an
    origin. x = east, y = north. Accurate to well under a metre at building
    scale, which is all we need for a floor plan."""
    x = math.radians(lon - origin_lon) * math.cos(math.radians(origin_lat)) * EARTH_R
    y = math.radians(lat - origin_lat) * EARTH_R
    return [x, y]


def ring_centroid(latlon_ring):
    """Simple average of ring vertices (good enough as a projection origin)."""
    n = len(latlon_ring)
    return (
        sum(p[0] for p in latlon_ring) / n,
        sum(p[1] for p in latlon_ring) / n,
    )


def project_ring(latlon_ring):
    """Project a ring of (lat, lon) vertices to local metres.

    Returns ``(points_xy, origin_lat, origin_lon)``. Drops a duplicated closing
    vertex if present so the polygon is open (first != last)."""
    ring = list(latlon_ring)
    if len(ring) >= 2 and ring[0] == ring[-1]:
        ring = ring[:-1]
    olat, olon = ring_centroid(ring)
    pts = [latlon_to_local(lat, lon, olat, olon) for lat, lon in ring]
    return pts, olat, olon


def edge_azimuth(p1, p2):
    """Compass azimuth (deg, 0=N clockwise) of the OUTWARD normal of edge p1->p2
    for a polygon wound counter-clockwise in an x=east/y=north plane.

    For CCW winding the outward normal is the edge direction rotated -90°
    (to the right of travel). We return that normal's compass bearing."""
    dx = p2[0] - p1[0]
    dy = p2[1] - p1[1]
    # right-hand (outward for CCW) normal = (dy, -dx)
    nx, ny = dy, -dx
    # compass bearing from north, clockwise: atan2(east, north)
    return (math.degrees(math.atan2(nx, ny)) + 360.0) % 360.0


def polygon_signed_area(pts):
    """Signed area (shoelace). Positive => counter-clockwise winding."""
    a = 0.0
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        a += x1 * y2 - x2 * y1
    return a / 2.0


def ensure_ccw(pts):
    """Return the ring wound counter-clockwise (so edge_azimuth points outward)."""
    return pts if polygon_signed_area(pts) > 0 else list(reversed(pts))


def segment_outward_azimuth(p1, p2, polygon_pts):
    """Outward-normal azimuth of the wall segment p1->p2, disambiguated against
    the polygon centroid so it works regardless of segment/polygon winding.

    Used when a window is dropped on an arbitrary wall: pick whichever of the two
    normals points away from the building interior (the centroid)."""
    dx, dy = p2[0] - p1[0], p2[1] - p1[1]
    normals = [(dy, -dx), (-dy, dx)]
    cx = sum(p[0] for p in polygon_pts) / len(polygon_pts)
    cy = sum(p[1] for p in polygon_pts) / len(polygon_pts)
    mx, my = (p1[0] + p2[0]) / 2.0, (p1[1] + p2[1]) / 2.0
    # vector from centroid to segment midpoint = the "outward" direction
    ox, oy = mx - cx, my - cy
    nx, ny = max(normals, key=lambda n: n[0] * ox + n[1] * oy)
    return (math.degrees(math.atan2(nx, ny)) + 360.0) % 360.0
