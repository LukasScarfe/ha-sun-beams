"""Pure solar-geometry / irradiance math for Sun Beams.

No Home Assistant imports on purpose: everything here is plain functions of
numbers so it can be unit-tested offline (``python3 tests/test_solar.py`` or
pytest) and reasoned about independently of HA.

Angle conventions (matching Home Assistant's ``sun.sun``):
  * ``elevation`` — degrees of the sun above the horizon (negative below).
  * ``azimuth``   — degrees clockwise from true north (0=N, 90=E, 180=S, 270=W).
  * surface ``azimuth`` — compass direction the glass faces (its outward
    normal), same 0=N clockwise convention.
  * surface ``tilt`` — degrees from horizontal: 0 = facing straight up,
    90 = vertical wall (the default for a window).

Irradiance inputs (all W/m², as Open-Meteo provides them):
  * ``dni`` — direct normal irradiance (beam, measured ⟂ to the sun).
  * ``dhi`` — diffuse horizontal irradiance (``diffuse_radiation``).
  * ``ghi`` — global horizontal irradiance (``shortwave_radiation``).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

# Default broadband luminous efficacy of global daylight (lm per W). Real values
# range ~90 (beam) to ~145 (overcast diffuse); 120 is a reasonable single-factor
# midpoint. Exposed as a parameter so it can be tuned/calibrated later.
DEFAULT_LUMINOUS_EFFICACY = 120.0

# Default ground reflectance (albedo) for the ground-reflected component.
DEFAULT_ALBEDO = 0.2

# Vertical surface (a normal window).
VERTICAL_TILT = 90.0


def incidence_cos(
    sun_elevation: float,
    sun_azimuth: float,
    surface_azimuth: float,
    surface_tilt: float = VERTICAL_TILT,
) -> float:
    """Cosine of the angle of incidence of the beam on the surface.

    Standard tilted-surface form (Duffie & Beckman):
        cosθ = cos(z)·cos(β) + sin(z)·sin(β)·cos(γs − γ)
    with zenith z = 90 − elevation, so cos(z)=sin(elev), sin(z)=cos(elev).

    Returns a value in [-1, 1]; negative means the sun is behind the surface.
    Not clamped here — callers clamp with max(0, …) for the beam component.
    """
    elev = math.radians(sun_elevation)
    beta = math.radians(surface_tilt)
    delta_az = math.radians(sun_azimuth - surface_azimuth)
    return (
        math.sin(elev) * math.cos(beta)
        + math.cos(elev) * math.sin(beta) * math.cos(delta_az)
    )


@dataclass(frozen=True)
class PoaIrradiance:
    """Plane-of-array irradiance components on a surface (W/m²)."""

    beam: float          # direct beam landing on the surface
    sky_diffuse: float   # isotropic sky diffuse seen by the tilted surface
    ground: float        # ground-reflected
    total: float         # sum of the above
    incidence_cos: float # cosθ used for the beam (for beam-geometry / debugging)


def poa_irradiance(
    dni: float,
    dhi: float,
    ghi: float,
    sun_elevation: float,
    sun_azimuth: float,
    surface_azimuth: float,
    surface_tilt: float = VERTICAL_TILT,
    albedo: float = DEFAULT_ALBEDO,
) -> PoaIrradiance:
    """Total irradiance on an arbitrarily-oriented surface (isotropic sky model).

    beam        = DNI · max(0, cosθ)          (only while the sun is up)
    sky_diffuse = DHI · (1 + cos β) / 2       (isotropic sky view factor)
    ground      = albedo · GHI · (1 − cos β) / 2
    """
    dni = max(0.0, dni or 0.0)
    dhi = max(0.0, dhi or 0.0)
    ghi = max(0.0, ghi or 0.0)
    beta = math.radians(surface_tilt)

    cos_theta = incidence_cos(sun_elevation, sun_azimuth, surface_azimuth, surface_tilt)
    sun_up = sun_elevation > 0.0
    beam = dni * max(0.0, cos_theta) if sun_up else 0.0

    sky_diffuse = dhi * (1.0 + math.cos(beta)) / 2.0
    ground = albedo * ghi * (1.0 - math.cos(beta)) / 2.0

    total = beam + sky_diffuse + ground
    return PoaIrradiance(
        beam=beam,
        sky_diffuse=sky_diffuse,
        ground=ground,
        total=total,
        incidence_cos=cos_theta,
    )


def estimate_lux(poa_total: float, efficacy: float = DEFAULT_LUMINOUS_EFFICACY) -> float:
    """Approximate illuminance (lux) from plane-of-array irradiance (W/m²)."""
    return max(0.0, poa_total) * efficacy


def sunlit_fraction(cos_theta: float, sun_elevation: float) -> float:
    """0..1 measure of how directly the sun strikes the surface, for glow/beam
    intensity. Just the clamped incidence cosine while the sun is up."""
    if sun_elevation <= 0.0:
        return 0.0
    return max(0.0, min(1.0, cos_theta))
