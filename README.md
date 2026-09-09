# Sun Beams

A Home Assistant custom integration that models the **solar irradiance on each of your
windows** and draws a top-down plan where the windows **glow** with the light they're
getting and **sun beams** are cast onto your floor — updated live from the real sun
position and real (cloud-affected) irradiance.

It ships **with its own Lovelace card** — installing the integration is all you need; the
card registers itself automatically.

![Sun Beams](https://github.com/LukasScarfe/ha-sun-beams) <!-- add a screenshot here -->

## What it does

- Pulls your **building footprint** from OpenStreetMap (Overpass) so the plan is correctly
  oriented to true north, with no manual measuring.
- You draw your **interior floor** and drop **windows** onto the walls in the integration's
  **Sun Beams** sidebar panel; each window's compass azimuth is derived from the wall it sits on.
  (The dashboard card is display-only.)
- For every window it computes, live:
  - **Effective irradiance** `E = max(0, DNI·cosθ) + DHI·(1+cos β)/2 + albedo·GHI·(1−cos β)/2`
    (W/m²), exposed as `sensor.sun_beams_<window>_irradiance`.
  - An approximate **illuminance** (lux), exposed as `sensor.sun_beams_<window>_illuminance`.
- Renders it: windows glow cool→warm with irradiance, a sun marker rides the compass ring,
  and beams project from sunlit windows into the floor (longer at low sun, clipped to the room).

Because the per-window values are **real entities**, you can automate on them: close the
blinds when the west window passes 500 W/m², warn about glare on the desk, and so on.

## Data sources

| Quantity | Source |
|---|---|
| Sun elevation / azimuth | Home Assistant's built-in `sun.sun` (computed locally) |
| Direct / diffuse / global irradiance | [Open-Meteo](https://open-meteo.com) — free, no API key, real cloud cover baked in |
| Building footprint | OpenStreetMap via the Overpass API (fetched once at setup) |

## Installation (HACS)

1. HACS → ⋮ → **Custom repositories** → add `https://github.com/LukasScarfe/ha-sun-beams`,
   category **Integration**.
2. Install **Sun Beams**, then **restart Home Assistant**.
3. **Settings → Devices & Services → Add Integration → Sun Beams.** Confirm the location; it
   will try to fetch your building outline from OpenStreetMap.
4. Open the **Sun Beams** panel in the left sidebar and draw your interior floor + place your
   windows on the outline. Saving creates the per-window sensors.
5. Add the **Sun Beams** card to a dashboard and pick your building — it displays the live plan.

## Options

- **Ground reflectance (albedo)** — 0–1, default 0.2.
- **Luminous efficacy** — lm/W for the lux estimate, default 120 (broadband daylight).

## Accuracy notes

- The sky-diffuse term uses an isotropic model; it's a good approximation, not a ray-traced
  simulation. The lux figure is a single-efficacy estimate — calibrate against a real lux
  sensor near a window if you need it tight.
- Beams are a geometric projection of direct sun through the window opening; they show
  direction and reach, not photometric exposure on the floor.

## Development

A throwaway Home Assistant instance is included for iterating without touching production:

```bash
docker compose -f dev/docker-compose.yml up -d   # HA on http://localhost:8124
# edit code, then:
docker compose -f dev/docker-compose.yml restart
```

The integration is bind-mounted into that container. Physics is pure and unit-tested with no
HA dependency:

```bash
python3 tests/test_solar.py     # or: pytest tests/
```

## License

MIT — see [LICENSE](LICENSE).
