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


# --- shadow / occlusion --------------------------------------------------
#
# A window only gets DIRECT beam if nothing stands between it and the sun.
# We model every obstruction (this building's own outline + neighbours) as a
# vertical prism of a given height and cast a horizontal ray from the window
# toward the sun's azimuth. Where the ray crosses a wall, that wall shadows the
# window up to a height that depends on the wall height, the crossing distance
# and the sun's elevation — see beam_shadow_factor.

# Ignore wall crossings closer than this: a window sits ON its own wall, so its
# own (and immediately-adjacent) footprint edges would otherwise register a
# spurious hit at ~0 m. Any real occluding wing/neighbour is metres away.
SELF_SKIP_M = 0.5


def sun_direction(azimuth):
    """Unit vector (east, north) pointing horizontally TOWARD the sun.

    Azimuth is 0=N, clockwise (90=E, 180=S, 270=W) — HA's convention — so the
    east component is sin(az) and the north component cos(az)."""
    a = math.radians(azimuth)
    return math.sin(a), math.cos(a)


def ray_segment_distance(ox, oy, dx, dy, ax, ay, bx, by):
    """Distance along the ray O + t·D (D a UNIT vector, t in metres) at which it
    crosses segment A→B, or ``None`` if it doesn't cross ahead of the origin.

    Standard 2-D segment intersection: with p=O, r=D, q=A, s=B−A the crossing is
    t = (q−p)×s / (r×s), u = (q−p)×r / (r×s), valid for t≥0 and 0≤u≤1."""
    ex, ey = bx - ax, by - ay
    rxs = dx * ey - dy * ex
    if abs(rxs) < 1e-12:
        return None  # parallel (or degenerate) — treat as no crossing
    qpx, qpy = ax - ox, ay - oy
    t = (qpx * ey - qpy * ex) / rxs
    u = (qpx * dy - qpy * dx) / rxs
    if t >= 0.0 and 0.0 <= u <= 1.0:
        return t
    return None


def beam_shadow_factor(
    win_x,
    win_y,
    win_height,
    sun_azimuth,
    sun_elevation,
    obstructions,
    self_skip_m=SELF_SKIP_M,
):
    """Fraction (0..1) of a window's height that the direct sun still reaches.

    1.0 = fully sunlit, 0.0 = fully shadowed, in between = partially shadowed.

    ``obstructions`` is a list of ``{"ring": [[x, y], ...], "height": m}`` — the
    building's own footprint (for self-shadowing) plus any neighbours, all in the
    same local ENU metres as the window midpoint (``win_x``, ``win_y``).

    Model: each obstruction is a vertical prism. A wall crossed by the sun-ward
    ray at horizontal distance ``t`` shadows the window from the ground up to
    ``S = height − t·tan(elevation)`` metres (the height at which the sightline to
    the sun clears the wall's top). The window, treated as spanning 0..win_height
    above the ground, is lit above the tallest such shadow, so the lit fraction is
    ``1 − clamp(maxS, 0, win_height) / win_height``.
    """
    if sun_elevation <= 0.0:
        return 1.0  # no direct beam below the horizon anyway
    win_height = win_height or 2.0
    dx, dy = sun_direction(sun_azimuth)
    tan_e = math.tan(math.radians(sun_elevation))
    max_shadow = 0.0
    for obs in obstructions or []:
        ring = obs.get("ring") or []
        n = len(ring)
        if n < 3:
            continue
        h = obs.get("height") or 0.0
        if h <= 0.0:
            continue
        for i in range(n):
            ax, ay = ring[i]
            bx, by = ring[(i + 1) % n]
            t = ray_segment_distance(win_x, win_y, dx, dy, ax, ay, bx, by)
            if t is None or t <= self_skip_m:
                continue
            shadow_h = h - t * tan_e
            if shadow_h > max_shadow:
                max_shadow = shadow_h
    shadowed = min(win_height, max(0.0, max_shadow))
    return max(0.0, 1.0 - shadowed / win_height)
