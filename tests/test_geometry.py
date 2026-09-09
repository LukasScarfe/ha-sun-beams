"""Known-answer tests for the pure geometry / shadow core.

Runs two ways:
  * pytest:            pytest tests/
  * plain interpreter: python3 tests/test_geometry.py   (no pytest needed)
"""

from __future__ import annotations

import math
import os
import sys

sys.path.insert(
    0,
    os.path.join(os.path.dirname(__file__), "..", "custom_components", "sun_beams"),
)

import geometry  # noqa: E402


def approx(a: float, b: float, tol: float = 1e-6) -> bool:
    return abs(a - b) <= tol


def test_sun_direction_cardinals():
    """0=N→(0,1) north, 90=E→(1,0) east, 180=S→(0,-1) south (x=east, y=north)."""
    ex, ny = geometry.sun_direction(0)
    assert approx(ex, 0.0, 1e-9) and approx(ny, 1.0, 1e-9)
    ex, ny = geometry.sun_direction(90)
    assert approx(ex, 1.0, 1e-9) and approx(ny, 0.0, 1e-9)
    ex, ny = geometry.sun_direction(180)
    assert approx(ex, 0.0, 1e-9) and approx(ny, -1.0, 1e-9)


def test_ray_hits_segment_ahead():
    """Ray east from the origin crosses a vertical wall at x=5 → distance 5."""
    t = geometry.ray_segment_distance(0, 0, 1, 0, 5, -1, 5, 1)
    assert t is not None and approx(t, 5.0, 1e-9)


def test_ray_misses_segment_behind():
    """A wall behind the origin (x=-5) is not crossed by an eastward ray."""
    assert geometry.ray_segment_distance(0, 0, 1, 0, -5, -1, -5, 1) is None


def test_ray_parallel_segment_none():
    """A wall parallel to the ray never crosses it."""
    assert geometry.ray_segment_distance(0, 0, 1, 0, 0, 1, 5, 1) is None


# A vertical wall 6 m tall crossing the eastward sun ray 10 m away.
_WALL = [{"ring": [[10, -3], [10, 3], [11, 3], [11, -3]], "height": 6.0}]


def test_no_obstruction_is_fully_lit():
    assert geometry.beam_shadow_factor(0, 0, 2.0, 90, 20, []) == 1.0


def test_low_sun_fully_shadowed():
    """Sun at 10° behind a 6 m wall 10 m away: shadow reaches 4.24 m, well over
    the 2 m window → fully shadowed."""
    f = geometry.beam_shadow_factor(0, 0, 2.0, 90, 10, _WALL)
    assert f == 0.0


def test_high_sun_clears_the_wall():
    """Sun at 45° (tanβ=1): the 6 m wall's shadow ends 4 m below ground → lit."""
    f = geometry.beam_shadow_factor(0, 0, 2.0, 90, 45, _WALL)
    assert f == 1.0


def test_partial_shadow_half():
    """elev=atan(0.5)=26.565°: shadow height = 6 − 10·0.5 = 1 m, half the 2 m
    window → lit fraction 0.5."""
    elev = math.degrees(math.atan(0.5))
    f = geometry.beam_shadow_factor(0, 0, 2.0, 90, elev, _WALL)
    assert approx(f, 0.5, 1e-6)


def test_own_wall_within_skip_is_ignored():
    """A wall closer than SELF_SKIP_M (the window's own outline) never shadows
    it, even if tall and directly in the sun path."""
    near = [{"ring": [[0.3, -1], [0.3, 1], [0.4, 1], [0.4, -1]], "height": 20.0}]
    assert geometry.beam_shadow_factor(0, 0, 2.0, 90, 10, near) == 1.0


def test_sun_below_horizon_is_unshadowed():
    """Below the horizon there's no beam to block, so the factor is a no-op 1.0."""
    assert geometry.beam_shadow_factor(0, 0, 2.0, 90, -5, _WALL) == 1.0


def test_wrong_azimuth_ray_misses_wall():
    """Same wall, but the sun is in the north — the ray goes away from the wall
    (which is due east) so the window is unshadowed."""
    assert geometry.beam_shadow_factor(0, 0, 2.0, 0, 10, _WALL) == 1.0


def _run_all() -> int:
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failures = 0
    for fn in fns:
        try:
            fn()
            print(f"  PASS  {fn.__name__}")
        except AssertionError as exc:
            failures += 1
            print(f"  FAIL  {fn.__name__}: {exc!r}")
    print(f"\n{len(fns) - failures}/{len(fns)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(_run_all())
