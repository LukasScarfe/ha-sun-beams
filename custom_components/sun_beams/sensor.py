"""Per-window irradiance and illuminance sensors."""

from __future__ import annotations

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import LIGHT_LUX, UnitOfIrradiance
from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from . import geometry, solar
from .const import (
    CONF_ALBEDO,
    CONF_EFFICACY,
    CONF_GEOMETRY,
    DATA_DHI,
    DATA_DNI,
    DATA_GHI,
    DEFAULT_ALBEDO,
    DEFAULT_BUILDING_HEIGHT_M,
    DEFAULT_EFFICACY,
    DOMAIN,
    GEO_BUILDING_HEIGHT,
    GEO_FOOTPRINT,
    GEO_OBSTRUCTIONS,
    GEO_WINDOWS,
    WIN_AZIMUTH,
    WIN_HEIGHT,
    WIN_ID,
    WIN_NAME,
    WIN_TILT,
    WIN_X1,
    WIN_X2,
    WIN_Y1,
    WIN_Y2,
)
from .coordinator import SunBeamsCoordinator

SUN_ENTITY = "sun.sun"


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Create two sensors per configured window. Re-run on entry reload (which
    is how geometry saves take effect), so the entity set follows the windows."""
    store = hass.data[DOMAIN][entry.entry_id]
    coordinator: SunBeamsCoordinator = store["coordinator"]
    geo = (entry.options.get(CONF_GEOMETRY) or entry.data.get(CONF_GEOMETRY) or {})
    windows = geo.get(GEO_WINDOWS, [])
    obstructions = _build_obstructions(geo)

    albedo = float(entry.options.get(CONF_ALBEDO, DEFAULT_ALBEDO))
    efficacy = float(entry.options.get(CONF_EFFICACY, DEFAULT_EFFICACY))

    entities: list[SensorEntity] = []
    for win in windows:
        entities.append(WindowIrradianceSensor(coordinator, entry, win, albedo, obstructions))
        entities.append(WindowLuxSensor(coordinator, entry, win, albedo, efficacy, obstructions))
    async_add_entities(entities)


def _build_obstructions(geo: dict) -> list[dict]:
    """Shadow casters for the beam test: this building's own footprint (so it can
    shadow its own windows in concave/L/U shapes) plus every neighbour fetched
    from OSM, each as ``{"ring": [[x, y], ...], "height": m}``."""
    obstructions: list[dict] = []
    footprint = geo.get(GEO_FOOTPRINT) or []
    if len(footprint) >= 3:
        obstructions.append(
            {
                "ring": footprint,
                "height": float(geo.get(GEO_BUILDING_HEIGHT) or DEFAULT_BUILDING_HEIGHT_M),
            }
        )
    for obs in geo.get(GEO_OBSTRUCTIONS) or []:
        ring = obs.get("ring") or []
        if len(ring) >= 3:
            obstructions.append(
                {"ring": ring, "height": float(obs.get("height") or DEFAULT_BUILDING_HEIGHT_M)}
            )
    return obstructions


def _sun_position(hass: HomeAssistant) -> tuple[float, float] | None:
    state = hass.states.get(SUN_ENTITY)
    if state is None:
        return None
    elev = state.attributes.get("elevation")
    az = state.attributes.get("azimuth")
    if elev is None or az is None:
        return None
    return float(elev), float(az)


class _WindowBase(CoordinatorEntity[SunBeamsCoordinator], SensorEntity):
    """Common wiring: recompute both on Open-Meteo refresh and as the sun moves."""

    _attr_has_entity_name = True
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(
        self,
        coordinator: SunBeamsCoordinator,
        entry: ConfigEntry,
        window: dict,
        obstructions: list[dict] | None = None,
    ) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self._window = window
        self._win_az = float(window.get(WIN_AZIMUTH, 180.0))
        self._win_tilt = float(window.get(WIN_TILT, solar.VERTICAL_TILT))
        self._win_height = float(window.get(WIN_HEIGHT, 2.0)) or 2.0
        # plan-view midpoint of the window, used as the shadow ray's origin
        self._win_x = (float(window.get(WIN_X1, 0.0)) + float(window.get(WIN_X2, 0.0))) / 2.0
        self._win_y = (float(window.get(WIN_Y1, 0.0)) + float(window.get(WIN_Y2, 0.0))) / 2.0
        self._obstructions = obstructions or []
        self._unsub_sun: CALLBACK_TYPE | None = None
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name="Sun Beams",
            manufacturer="Sun Beams",
            model="Window solar model",
        )

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self._unsub_sun = async_track_state_change_event(
            self.hass, [SUN_ENTITY], self._on_sun_change
        )

    async def async_will_remove_from_hass(self) -> None:
        if self._unsub_sun:
            self._unsub_sun()
            self._unsub_sun = None
        await super().async_will_remove_from_hass()

    @callback
    def _on_sun_change(self, _event) -> None:
        self.async_write_ha_state()

    def _shadow(self, elev: float, az: float) -> float:
        """Fraction of the direct beam reaching this window given who's in the
        way (own building + neighbours). 1.0 when nothing is configured."""
        if not self._obstructions:
            return 1.0
        return geometry.beam_shadow_factor(
            self._win_x, self._win_y, self._win_height, az, elev, self._obstructions
        )

    def _poa(self, albedo: float) -> solar.PoaIrradiance | None:
        data = self.coordinator.data or {}
        sun = _sun_position(self.hass)
        if sun is None:
            return None
        elev, az = sun
        return solar.poa_irradiance(
            dni=data.get(DATA_DNI, 0.0),
            dhi=data.get(DATA_DHI, 0.0),
            ghi=data.get(DATA_GHI, 0.0),
            sun_elevation=elev,
            sun_azimuth=az,
            surface_azimuth=self._win_az,
            surface_tilt=self._win_tilt,
            albedo=albedo,
            shadow=self._shadow(elev, az),
        )


class WindowIrradianceSensor(_WindowBase):
    _attr_device_class = SensorDeviceClass.IRRADIANCE
    _attr_native_unit_of_measurement = UnitOfIrradiance.WATTS_PER_SQUARE_METER
    _attr_suggested_display_precision = 0

    def __init__(self, coordinator, entry, window, albedo, obstructions=None) -> None:
        super().__init__(coordinator, entry, window, obstructions)
        self._albedo = albedo
        self._attr_unique_id = f"{entry.entry_id}_{window[WIN_ID]}_irradiance"
        self._attr_name = f"{window[WIN_NAME]} irradiance"

    @property
    def native_value(self) -> float | None:
        poa = self._poa(self._albedo)
        return None if poa is None else round(poa.total, 1)

    @property
    def extra_state_attributes(self) -> dict:
        poa = self._poa(self._albedo)
        if poa is None:
            return {}
        sun = _sun_position(self.hass)
        shadow = self._shadow(*sun) if sun else 1.0
        return {
            "beam": round(poa.beam, 1),
            "sky_diffuse": round(poa.sky_diffuse, 1),
            "ground": round(poa.ground, 1),
            "incidence_cos": round(poa.incidence_cos, 4),
            "shadow_factor": round(shadow, 3),
            "window_id": self._window.get(WIN_ID),
            "window_azimuth": self._win_az,
            "window_tilt": self._win_tilt,
        }


class WindowLuxSensor(_WindowBase):
    _attr_device_class = SensorDeviceClass.ILLUMINANCE
    _attr_native_unit_of_measurement = LIGHT_LUX
    _attr_suggested_display_precision = 0

    def __init__(self, coordinator, entry, window, albedo, efficacy, obstructions=None) -> None:
        super().__init__(coordinator, entry, window, obstructions)
        self._albedo = albedo
        self._efficacy = efficacy
        self._attr_unique_id = f"{entry.entry_id}_{window[WIN_ID]}_lux"
        self._attr_name = f"{window[WIN_NAME]} illuminance"

    @property
    def native_value(self) -> float | None:
        poa = self._poa(self._albedo)
        return None if poa is None else round(solar.estimate_lux(poa.total, self._efficacy))

    @property
    def extra_state_attributes(self) -> dict:
        # window_id/azimuth let the card match this lux entity to its window
        # (same matching rules as the irradiance sensor).
        return {
            "window_id": self._window.get(WIN_ID),
            "window_azimuth": self._win_az,
        }
