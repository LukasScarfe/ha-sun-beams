"""Config + options flow for Sun Beams."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import (
    CONF_ALBEDO,
    CONF_EFFICACY,
    CONF_GEOMETRY,
    CONF_LATITUDE,
    CONF_LONGITUDE,
    CONF_OSM_WAY,
    DEFAULT_ALBEDO,
    DEFAULT_EFFICACY,
    DOMAIN,
    GEO_FLOOR,
    GEO_FOOTPRINT,
    GEO_ORIGIN,
    GEO_WINDOWS,
)
from .osm import async_fetch_building_footprint


class SunBeamsConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle the initial setup: pick a location, seed the footprint from OSM."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            lat = float(user_input[CONF_LATITUDE])
            lon = float(user_input[CONF_LONGITUDE])
            await self.async_set_unique_id(f"{lat:.5f},{lon:.5f}")
            self._abort_if_unique_id_configured()

            session = async_get_clientsession(self.hass)
            osm = await async_fetch_building_footprint(session, lat, lon)
            geometry: dict[str, Any] = {
                GEO_FOOTPRINT: osm["footprint"] if osm else [],
                GEO_ORIGIN: osm["origin"] if osm else {"lat": lat, "lon": lon},
                GEO_FLOOR: [],
                GEO_WINDOWS: [],
            }
            data = {
                CONF_LATITUDE: lat,
                CONF_LONGITUDE: lon,
                CONF_GEOMETRY: geometry,
                CONF_OSM_WAY: osm["osm_way_id"] if osm else None,
            }
            return self.async_create_entry(title="Sun Beams", data=data)

        schema = vol.Schema(
            {
                vol.Required(
                    CONF_LATITUDE, default=self.hass.config.latitude
                ): vol.Coerce(float),
                vol.Required(
                    CONF_LONGITUDE, default=self.hass.config.longitude
                ): vol.Coerce(float),
            }
        )
        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return SunBeamsOptionsFlow()


class SunBeamsOptionsFlow(OptionsFlow):
    """Tune the physics parameters (geometry is edited from the card)."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        if user_input is not None:
            options = dict(self.config_entry.options)
            options[CONF_ALBEDO] = float(user_input[CONF_ALBEDO])
            options[CONF_EFFICACY] = float(user_input[CONF_EFFICACY])
            return self.async_create_entry(title="", data=options)

        opts = self.config_entry.options
        schema = vol.Schema(
            {
                vol.Required(
                    CONF_ALBEDO, default=opts.get(CONF_ALBEDO, DEFAULT_ALBEDO)
                ): vol.All(vol.Coerce(float), vol.Range(min=0, max=1)),
                vol.Required(
                    CONF_EFFICACY, default=opts.get(CONF_EFFICACY, DEFAULT_EFFICACY)
                ): vol.All(vol.Coerce(float), vol.Range(min=50, max=200)),
            }
        )
        return self.async_show_form(step_id="init", data_schema=schema)
