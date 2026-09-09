# CLAUDE.md — ha-sun-beams developer guide

Operating guide for developing the **Sun Beams** Home Assistant integration. Read this before
editing. It's the single source of truth for how this repo is built and tested — keep it current
(edit in place; git history is the changelog). Higher-level context lives in raccoon's memory
`[[ha-sun-beams-integration]]` and `claude/docs/homeassistant.md`; don't duplicate those, link them.

## What this is

A **custom HA integration** (domain `sun_beams`) that models the solar irradiance + approximate
illuminance on each of a building's windows and **bundles its own Lovelace card** (auto-registered,
no manual resource). The card draws a top-down plan: windows **glow** with irradiance, a sun marker
rides a compass ring, and **beams** project from sunlit windows onto the interior floor. Per-window
values are also real `sensor.*` entities, so automations can use them.

Built because the installed **Helios** HACS card is a solar-*PV-production* card and does none of
this. Production HA is off-box at `192.168.1.217` (raccoon can't restart it) — hence the dev
container below.

## Status (2026-09-09)

Validated end-to-end in the dev instance: config flow → OSM footprint → Open-Meteo → per-window
sensors → WS geometry save → entry reload, all correct. **Not yet deployed to production HA.**
Version `0.1.0`.

## Repo layout

```
custom_components/sun_beams/
  __init__.py       setup/unload; creates coordinator, registers frontend+WS once,
                    forwards sensor platform, reloads entry on options change
  const.py          all keys/URLs/defaults — no magic strings elsewhere
  solar.py          PURE physics (no HA import). incidence_cos, poa_irradiance, estimate_lux
  geometry.py       PURE geometry. lat/lon→local metres, edge/segment azimuths, winding
  osm.py            async Overpass footprint fetch (best-effort; falls back to empty)
  coordinator.py    DataUpdateCoordinator → Open-Meteo current DNI/DHI/GHI + cloud, 900 s
  config_flow.py    user step (lat/lon, OSM seed) + options (albedo, efficacy)
  sensor.py         WindowIrradianceSensor + WindowLuxSensor, one pair per window
  websocket_api.py  sun_beams/get_geometry, sun_beams/save_geometry
  frontend.py       serves /sun_beams_static, add_extra_js_url (card), registers the panel
  frontend/sun-beams-card.js    DISPLAY-ONLY card — vanilla JS + SVG, NO build step
  frontend/sun-beams-panel.js   the geometry EDITOR — sidebar panel (draw floor, place windows)
  strings.json, translations/en.json
tests/test_solar.py runs under plain python3 OR pytest
dev/docker-compose.yml  throwaway HA (see below); dev/config/ is gitignored state
```

## Dev loop

Production HA is off-box and can't be restarted from here, and a **new** integration only loads on
an HA restart — so develop against the throwaway container, never production.

```bash
docker compose -f dev/docker-compose.yml up -d      # HA on http://localhost:8124 (LAN/Tailscale)
docker compose -f dev/docker-compose.yml restart    # after editing Python (reloads the integration)
docker logs sun-beams-dev-ha 2>&1 | tail -40        # check for errors
docker compose -f dev/docker-compose.yml down       # stop (keeps ./config); add -v only to wipe state
```

The integration is bind-mounted read-only into the container. **Card JS** changes don't need a
container restart — just hard-refresh the browser (the static path is served `cache_headers=False`).
**Python** changes need `restart`. **Config-entry** changes (geometry/options) reload automatically
via the entry's update listener.

Dev instance is onboarded: user **`dev`** / **`devpass1234`** (state persists in `dev/config/`
across restarts; only `down -v` wipes it, forcing re-onboarding).

Logged in raccoon `claude/docs/inventory.md` as dev-only + removable.

### Reaching the dev HA programmatically

REST needs a bearer token. In a fresh session, mint one from the dev login:

```python
# start login flow, then submit username/password provider
import json, urllib.request
BASE="http://localhost:8124"; CLIENT=BASE+"/"
def post(p, d): 
    return json.loads(urllib.request.urlopen(urllib.request.Request(
        BASE+p, json.dumps(d).encode(), {"Content-Type":"application/json"})).read())
flow=post("/auth/login_flow", {"client_id":CLIENT,"handler":["homeassistant",None],"redirect_uri":CLIENT})
step=post("/auth/login_flow/"+flow["flow_id"], {"client_id":CLIENT,"username":"dev","password":"devpass1234"})
tok=post("/auth/token", ...)  # grant_type=authorization_code, code=step["result"], form-encoded
```
(The onboarding-based variant used while building is in that session's scratchpad; re-mint per above.)

WebSocket (for the geometry commands and anything REST can't do): raccoon has **no ws library**, so
use a raw stdlib client — see `[[ha-websocket-registry-access]]` for the auth handshake and the
`ws.py` pattern. Auth flow: connect `/api/websocket` → `auth_required` → `{"type":"auth",
"access_token":…}` → `auth_ok` → id-incremented commands. Client→server frames MUST be masked.

## Physics reference (`solar.py`)

Angle convention matches HA `sun.sun`: **azimuth 0=N, clockwise** (90=E, 180=S, 270=W); elevation
degrees above horizon. Surface azimuth = the outward normal (compass direction the glass faces);
tilt = degrees from horizontal, **90 = vertical window**.

```
cosθ  = sin(elev)·cos(β) + cos(elev)·sin(β)·cos(sun_az − surf_az)     # incidence
beam  = DNI · max(0, cosθ)          (only while elevation > 0)
sky   = DHI · (1 + cos β) / 2       (isotropic sky view factor)
ground= albedo · GHI · (1 − cos β)/2
total = beam + sky + ground         # W/m²
lux  ≈ total · efficacy             (default 120 lm/W — a single-factor approximation)
```

DNI = `direct_normal_irradiance`, DHI = `diffuse_radiation`, GHI = `shortwave_radiation` (all from
Open-Meteo). Test the math offline: `python3 tests/test_solar.py` (11 known-answer cases). Keep
`solar.py`/`geometry.py` free of HA imports so they stay unit-testable.

## Geometry model (`geometry.py`)

Everything after projection is in **local ENU metres**, x=east, y=north, about a per-building origin
(equirectangular — sub-metre accurate at building scale). Footprint is stored wound
counter-clockwise. A window is:

```json
{"id","name","x1","y1","x2","y2","azimuth","tilt":90,"height":2.0}
```

Azimuth is derived from the wall a window is dropped on via `segment_outward_azimuth` (picks the
normal pointing away from the polygon centroid, so winding doesn't matter). The card mirrors these
helpers in JS — **keep the two in sync** if you change either.

## Data sources

- **Open-Meteo** — `GET https://api.open-meteo.com/v1/forecast` with
  `current=direct_normal_irradiance,diffuse_radiation,shortwave_radiation,direct_radiation,cloud_cover`.
  No key; snaps to its own weather grid near the coords. Cloud effect is already baked in.
- **Overpass/OSM** — footprint at setup. **Gotcha:** `overpass-api.de` returns **406** to urllib's
  default User-Agent — always send a real `User-Agent` (osm.py does). `overpass.kumi.systems` is the
  fallback mirror. The real 2930 Spruce building is way `327526032`.

## Frontend: card + panel (both vanilla JS, no build step / no Lit)

**Separation of concerns:** the display card only *reads*; all geometry *editing* lives in an
integration-owned sidebar panel. This was a deliberate design decision (2026-09-09) — a display
card shouldn't also be a setup tool, and HA config-flow forms can't host a drawing canvas.

- **`sun-beams-card.js`** — display only. Reads geometry via `sun_beams/get_geometry` and
  sun/irradiance from `hass.states`, renders the SVG plan (footprint, floor, glowing windows,
  beams, sun compass). Matches a window to its sensor by `attributes.window_id` (azimuth fallback).
  Its config editor only picks the config entry + a title.
- **`sun-beams-panel.js`** — the editor. A full-page custom element registered as a sidebar panel
  by `frontend.py` via `panel_custom.async_register_panel` (admin-only, URL `/sun-beams`). Loads
  the OSM footprint, lets you draw the floor and drop windows (clicks snap to the nearest footprint
  wall within `SNAP_M`; azimuth from `segmentOutwardAzimuth`), rename/delete windows, and **Save**
  via `sun_beams/save_geometry` (reloads the entry, rebuilds the sensor set). HA sets `.hass` on the
  element repeatedly — the panel builds its shell once and never re-renders the canvas from a `hass`
  update, so the in-progress drawing is never clobbered. The canvas has a **live ruler** (rubber-band
  length while drawing a wall/window, plus per-edge and per-window length labels), a **scale bar**
  (nice 1/2/5 metre value), and **zoom/pan**: wheel zooms about the cursor, toolbar `＋`/`−`/`Reset
  view`, and dragging empty canvas pans. Manual zoom/pan freezes the auto-fit into `_view` (so adding
  points no longer reflows the frame) until **Reset view**.

Both theme through standard HA CSS vars (`--primary-text-color`, `--card-background-color`,
`--primary-color`, `--accent-color`, …) with hard-coded fallbacks. The geometry helpers in the
panel mirror `geometry.py` — keep them in sync.

## Deploy to production (needs the user)

1. HACS → custom repositories → add `https://github.com/LukasScarfe/ha-sun-beams` (Integration) →
   install → **user restarts HA** (raccoon can't).
2. Settings → Devices & Services → Add **Sun Beams** (confirm location; OSM footprint auto-fetched).
3. Open the **Sun Beams** sidebar panel and draw the floor + real windows (saving creates sensors).
4. Add the **Sun Beams** display card to the **2930 Spruce** dashboard via the Lovelace WS API (per
   `claude/docs/homeassistant.md`).

Bump `manifest.json` `version` on every released change (HACS keys updates off it).

## Known limitations / TODO

- ~~Sensor↔window matching is fragile.~~ **Fixed** — the irradiance sensor exposes `window_id` and
  the card matches on it (azimuth kept only as a fallback for old entities).
- **Illuminance** is one broadband efficacy; calibrate against a real `..._illuminance` sensor near a
  window if accuracy matters. Beam-vs-diffuse have different efficacy.
- **Beams** are a geometric projection (direction + reach), not a photometric floor-exposure sim.
- **Sky model** is isotropic (no Perez circumsolar/horizon brightening).
- **Forecast/timeline** — coordinator only fetches `current`; Open-Meteo also returns hourly, which
  would enable a "sun through the day" scrubber and predictive automations.
- **Multiple buildings** — supported by the entry unique-id (lat,lon) but untested with >1 entry.
- No `strings.json` coverage for entities yet; entity names come from the window names.

## Conventions

- Buildless card; **no host packages** (no node, no `gh`). Push over SSH.
- `solar.py` + `geometry.py` stay HA-free and tested.
- One logical change per commit; commit messages end with the Co-Authored-By/Claude-Session trailer.
- Never commit `dev/config/` (onboarding/DB/secrets) — it's gitignored.
