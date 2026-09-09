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
Version `0.6.0`.

Latest: per-window **beam shadowing** — the direct beam is now blocked when the building's own
outline (concave/L/U shapes) or a neighbouring building stands between a window and the sun (see
the shadow model in Physics reference). **Validated live in the dev instance**: after *Refresh from
OSM* + Save, the SW-afternoon sun (elev 36°, az 228°) correctly gave the shielded south window
`shadow_factor=0.0` (beam 0), an east window 0.5, and the open south window 1.0. Existing entries
created before 0.6.0 pick this up via the panel's **Refresh from OSM** button (no re-add needed —
see Known limitations).

## Repo layout

```
custom_components/sun_beams/
  __init__.py       setup/unload; creates coordinator, registers frontend+WS once,
                    forwards sensor platform, reloads entry on options change
  const.py          all keys/URLs/defaults — no magic strings elsewhere
  solar.py          PURE physics (no HA import). incidence_cos, poa_irradiance (shadow-aware),
                    estimate_lux
  geometry.py       PURE geometry. lat/lon→local metres, edge/segment azimuths, winding,
                    beam_shadow_factor (sun-ray occlusion vs. building prisms)
  osm.py            async Overpass fetch: building footprint + neighbours as shadow casters,
                    with heights from OSM tags (best-effort; falls back to empty)
  coordinator.py    DataUpdateCoordinator → Open-Meteo current DNI/DHI/GHI + cloud, 900 s
  config_flow.py    user step (lat/lon, OSM seed) + options (albedo, efficacy)
  sensor.py         WindowIrradianceSensor + WindowLuxSensor, one pair per window
  websocket_api.py  sun_beams/get_geometry, sun_beams/save_geometry,
                    sun_beams/refresh_geometry (re-fetch OSM neighbours+heights)
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
beam  = DNI · max(0, cosθ) · shadow (only while elevation > 0)
sky   = DHI · (1 + cos β) / 2       (isotropic sky view factor)
ground= albedo · GHI · (1 − cos β)/2
total = beam + sky + ground         # W/m²
lux  ≈ total · efficacy             (default 120 lm/W — a single-factor approximation)
```

**Shadowing (`geometry.beam_shadow_factor`, used by `sensor.py`).** `shadow` ∈ [0,1] is the
fraction of the direct beam that actually reaches a window — 1 = clear, 0 = fully blocked. Each
obstruction (this building's own footprint, for self-shadowing, **plus** every OSM neighbour) is
treated as a vertical prism of a given height. A horizontal ray is cast from the window's plan
midpoint toward the sun's azimuth (`sun_direction`); where it crosses a wall at distance `t`, that
wall shadows the window from the ground up to `S = wall_height − t·tan(elev)`. The window spans
`0..height` above ground, so `shadow = 1 − clamp(maxS, 0, height)/height` (a smooth partial
shadow, exact for the vertical-window / vertical-wall model). It scales the **beam only** — a
shadowed window still gets sky-diffuse + ground-reflected light. Crossings within `SELF_SKIP_M`
(0.5 m) are ignored so a window never shadows itself with its own wall. Convex footprints can't
self-shadow (an outward ray never re-crosses them); only concave/L/U/courtyard shapes do.
Obstructions live in the geometry dict (`building_height`, `obstructions:[{ring,height}]`, same ENU
origin) so the server sensors and the panel share one source of truth.

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
helpers in JS — **keep the two in sync** if you change either. The shadow helpers
(`sun_direction`, `ray_segment_distance`, `beam_shadow_factor`) are **server-side only** and have no
JS mirror — the card gets the result through the sensor's `beam`, so don't duplicate them.

The geometry dict also carries the shadow inputs: `building_height` (this building, metres) and
`obstructions: [{ring:[[x,y]...], height}]` (neighbours, same ENU origin). Both are seeded from OSM
at setup and round-trip untouched through the panel's Save (it spreads the loaded geometry, then
overrides only `floor`/`windows`).

## Data sources

- **Open-Meteo** — `GET https://api.open-meteo.com/v1/forecast` with
  `current=direct_normal_irradiance,diffuse_radiation,shortwave_radiation,direct_radiation,cloud_cover`.
  No key; snaps to its own weather grid near the coords. Cloud effect is already baked in.
- **Overpass/OSM** — footprint at setup, **plus every other building in the 60 m radius** kept as a
  shadow-casting `obstruction` (projected about the same origin, tagged with a height from the OSM
  `height` tag, else `building:levels`×3 m, else a 6 m default). **Gotcha:** `overpass-api.de`
  returns **406** to urllib's default User-Agent — always send a real `User-Agent` (osm.py does).
  `overpass.kumi.systems` is the fallback mirror. The real 2930 Spruce building is way `327526032`.

## Frontend: card + panel (both vanilla JS, no build step / no Lit)

**Separation of concerns:** the display card only *reads*; all geometry *editing* lives in an
integration-owned sidebar panel. This was a deliberate design decision (2026-09-09) — a display
card shouldn't also be a setup tool, and HA config-flow forms can't host a drawing canvas.

- **`sun-beams-card.js`** — display only. Reads geometry via `sun_beams/get_geometry` and
  sun/irradiance from `hass.states`, renders the SVG plan (**floorplan walls only** once a floor is
  drawn — the whole-building footprint shows *only* as a fallback before any floor exists; the plan
  also frames/zooms on the floor in that case), glowing windows, beams, sun compass. Matches a
  window to its sensor by `attributes.window_id` (azimuth fallback). Per-window value **labels**
  honour the `window_units` config — `wm2` (default, the irradiance sensor's W/m²), `lux`, or `fc`
  (foot-candles); lux/fc read the window's *illuminance* sensor (`_windowLuxSensor`, same
  id/azimuth match) so they track the configured luminous efficacy, and fall back to W/m² if no lux
  entity exists. Glow intensity is always irradiance, independent of the label unit. Below the plan
  it draws **stacked timeline plots** (historic + forecast, `now` divider), one per entry in
  `_plotSpecs()` — currently just **GHI** (`shortwave_radiation`, W/m², auto-scaled): fetched
  **client-side straight from Open-Meteo** (`hourly=<spec keys>`, `timeformat=unixtime`,
  CORS-enabled, no key) using `geometry.origin` lat/lon, cached 15 min. Irradiance is the honest
  "incoming light" measure (cloud *optical depth* baked in) — cloud-cover % was dropped as a proxy
  (thin cirrus reads high but passes light). Window is per-card via `cloud_past_hours` /
  `cloud_future_hours` (default 24/24; keys kept for back-compat). Config editor picks the config
  entry, title, `window_units`, and those two hour fields.
- **`sun-beams-panel.js`** — the editor. A full-page custom element registered as a sidebar panel
  by `frontend.py` via `panel_custom.async_register_panel` (admin-only, URL `/sun-beams`). Loads
  the OSM footprint, lets you draw the floor and drop windows (clicks snap to the nearest footprint
  wall within `SNAP_M`; azimuth from `segmentOutwardAzimuth`), rename/delete windows, and **Save**
  via `sun_beams/save_geometry` (reloads the entry, rebuilds the sensor set). Three tools: **Look
  around** (default — no click-to-add, just pan/zoom and drag handles), **Draw floor**, **Add
  window**; dragging handles works under any tool. In **Draw floor**, clicking empty space extends
  the wall chain, but clicking *on an existing wall* inserts a corner there (splits the edge via
  `_hitFloorEdge` → `floor.splice`; a hollow dot previews the insertion point, projected onto the
  wall). Dragging a floor (wall) corner snaps it onto the
  footprint outline within `CORNER_SNAP_M` (0.1 m). **Undo** is snapshot-based (`_pushUndo` stacks
  `{floor, windows}` before each add/delete/clear/drag) so it reverts a moved corner to its previous
  position, not just the last placed point. HA sets `.hass` on the
  element repeatedly — the panel builds its shell once and never re-renders the canvas from a `hass`
  update, so the in-progress drawing is never clobbered. The canvas has a **live ruler** (rubber-band
  length while drawing a wall/window, plus per-edge and per-window length labels), a **scale bar**
  (nice 1/2/5 metre value), and **zoom/pan**: wheel zooms about the cursor, toolbar `＋`/`−`/`Reset
  view`, and dragging empty canvas pans. Manual zoom/pan freezes the auto-fit into `_view` (so adding
  points no longer reflows the frame) until **Reset view**. Holding **Shift** while drawing locks the
  new segment (via `_applyLock`) either along the reference wall or square to it (90°), whichever the
  cursor is nearer — reference is the previous floor edge, else the nearest footprint wall; the lock
  overrides the wall-proximity snap. A **Surroundings → Refresh from OSM** button fetches neighbour
  buildings + heights (via `sun_beams/refresh_geometry`, projected about the existing origin) and
  merges them into the in-memory geometry as `obstructions`/`building_height`, marking the layout
  dirty; **Save** then persists them and the shadow test picks them up. Fetch-only server-side, so a
  refresh never clobbers an in-progress drawing.

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
- **Shadowing** blocks the direct **beam** only (sky-diffuse/ground still arrive — a big obstruction
  also cuts the diffuse *sky view*, which we don't model). Assumes windows sit at ground level
  (sill = 0, single-storey) and every obstruction is a flat-topped vertical prism; the neighbour
  search is the same 60 m radius as the footprint, so a tall building further out won't register.
  **Config entries created before 0.6.0 have no `obstructions`/`building_height`** and stay
  unshadowed until populated — hit **Refresh from OSM** in the Sun Beams panel (then **Save**), which
  fetches neighbours + heights *about the entry's existing origin* (so saved floor/window coords
  stay valid) and merges them in. No need to remove/re-add the entry. The card needs no change: it
  reads the sensor's `beam`, so shadowed windows stop glowing and stop casting beams automatically.
  Neighbours aren't drawn on the card (it frames on the floor).
- **Forecast/timeline** — coordinator only fetches `current` (the card's GHI plot fetches hourly
  itself, client-side). Pulling hourly *irradiance* server-side would enable a "sun through the day"
  scrubber and predictive automations.
- **Multiple buildings** — supported by the entry unique-id (lat,lon) but untested with >1 entry.
- No `strings.json` coverage for entities yet; entity names come from the window names.

## Conventions

- Buildless card; **no host packages** (no node, no `gh`). Push over SSH.
- `solar.py` + `geometry.py` stay HA-free and tested.
- One logical change per commit; commit messages end with the Co-Authored-By/Claude-Session trailer.
- Never commit `dev/config/` (onboarding/DB/secrets) — it's gitignored.
