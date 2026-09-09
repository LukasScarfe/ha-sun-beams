"""Known-answer tests for the Sun Beams physics core.

Runs two ways:
  * pytest:            pytest tests/
  * plain interpreter: python3 tests/test_solar.py   (no pytest needed)
"""

from __future__ import annotations

import math
import os
import sys

sys.path.insert(
    0,
    os.path.join(os.path.dirname(__file__), "..", "custom_components", "sun_beams"),
)

import solar  # noqa: E402


def approx(a: float, b: float, tol: float = 1e-6) -> bool:
    return abs(a - b) <= tol


def test_beam_normal_to_south_window_low_sun():
    """Low sun due south, hitting a south-facing vertical window head-on:
    cosθ ≈ cos(elevation), so at 10° elevation cosθ ≈ 0.985."""
    c = solar.incidence_cos(sun_elevation=10, sun_azimuth=180, surface_azimuth=180)
    assert approx(c, math.cos(math.radians(10)), 1e-9)


def test_sun_behind_surface_is_negative():
    """Sun in the north, window faces south -> sun is behind the glass."""
    c = solar.incidence_cos(sun_elevation=30, sun_azimuth=0, surface_azimuth=180)
    assert c < 0


def test_overhead_sun_grazes_vertical_glass():
    """Sun near zenith barely illuminates a vertical surface (cosθ -> 0)."""
    c = solar.incidence_cos(sun_elevation=89, sun_azimuth=180, surface_azimuth=180)
    assert 0 <= c < 0.02


def test_no_beam_when_sun_below_horizon():
    """Sun below the horizon => zero beam even if geometry would face it."""
    poa = solar.poa_irradiance(
        dni=800, dhi=0, ghi=0,
        sun_elevation=-5, sun_azimuth=180, surface_azimuth=180,
    )
    assert poa.beam == 0.0


def test_beam_value_matches_dni_times_cos():
    poa = solar.poa_irradiance(
        dni=800, dhi=0, ghi=0,
        sun_elevation=10, sun_azimuth=180, surface_azimuth=180,
    )
    assert approx(poa.beam, 800 * math.cos(math.radians(10)), 1e-6)


def test_vertical_sky_diffuse_is_half():
    """A vertical surface sees half the sky, so sky diffuse = DHI/2."""
    poa = solar.poa_irradiance(
        dni=0, dhi=200, ghi=200,
        sun_elevation=30, sun_azimuth=90, surface_azimuth=180,
        albedo=0.0,
    )
    assert approx(poa.sky_diffuse, 100.0, 1e-9)


def test_ground_reflected_component():
    """Vertical surface, albedo 0.2, GHI 500 -> ground = 0.2*500*0.5 = 50."""
    poa = solar.poa_irradiance(
        dni=0, dhi=0, ghi=500,
        sun_elevation=30, sun_azimuth=90, surface_azimuth=180,
        albedo=0.2,
    )
    assert approx(poa.ground, 50.0, 1e-9)


def test_total_is_sum_of_components():
    poa = solar.poa_irradiance(
        dni=600, dhi=150, ghi=400,
        sun_elevation=25, sun_azimuth=200, surface_azimuth=180,
        albedo=0.2,
    )
    assert approx(poa.total, poa.beam + poa.sky_diffuse + poa.ground, 1e-9)


def test_shadow_scales_beam_only():
    """A shadow factor of 0.5 halves the beam but leaves diffuse/ground intact."""
    lit = solar.poa_irradiance(800, 150, 400, 30, 180, 180, albedo=0.2)
    shaded = solar.poa_irradiance(800, 150, 400, 30, 180, 180, albedo=0.2, shadow=0.5)
    assert approx(shaded.beam, lit.beam * 0.5, 1e-9)
    assert approx(shaded.sky_diffuse, lit.sky_diffuse, 1e-9)
    assert approx(shaded.ground, lit.ground, 1e-9)


def test_full_shadow_zeroes_beam_keeps_diffuse():
    poa = solar.poa_irradiance(800, 150, 400, 30, 180, 180, albedo=0.2, shadow=0.0)
    assert poa.beam == 0.0
    assert poa.sky_diffuse > 0 and poa.ground > 0


def test_lux_scales_with_efficacy():
    assert approx(solar.estimate_lux(500, efficacy=120), 60000.0)


def test_sunlit_fraction_clamped_and_night_zero():
    assert solar.sunlit_fraction(0.5, sun_elevation=20) == 0.5
    assert solar.sunlit_fraction(0.9, sun_elevation=-1) == 0.0
    assert solar.sunlit_fraction(2.0, sun_elevation=20) == 1.0


def test_realistic_now_snapshot():
    """Sanity with the live values seen while building (DNI 432, DHI 212,
    GHI 438, sun elev 32° az 124°). A SE window (az 135°) should get real beam;
    a NW window (az 315°) should get none (sun behind) but still some diffuse."""
    se = solar.poa_irradiance(432, 212, 438, 32, 124, 135)
    nw = solar.poa_irradiance(432, 212, 438, 32, 124, 315)
    assert se.beam > 200          # SE glass is well lit this morning
    assert nw.beam == 0.0         # NW glass sees no direct sun
    assert nw.sky_diffuse > 0     # but still gets sky diffuse


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
