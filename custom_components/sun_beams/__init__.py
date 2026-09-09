"""The Sun Beams integration."""

from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant

from .const import CONF_LATITUDE, CONF_LONGITUDE, DOMAIN
from .coordinator import SunBeamsCoordinator
from .frontend import async_register_frontend, async_remove_panel
from .websocket_api import async_register as async_register_ws

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [Platform.SENSOR]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Sun Beams from a config entry."""
    hass.data.setdefault(DOMAIN, {})

    lat = entry.data.get(CONF_LATITUDE, hass.config.latitude)
    lon = entry.data.get(CONF_LONGITUDE, hass.config.longitude)

    coordinator = SunBeamsCoordinator(hass, entry, lat, lon)
    await coordinator.async_config_entry_first_refresh()

    hass.data[DOMAIN][entry.entry_id] = {"coordinator": coordinator}

    await async_register_frontend(hass)
    async_register_ws(hass)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_reload_on_update))
    return True


async def _async_reload_on_update(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload when options change (geometry save, albedo/efficacy) so the
    per-window sensor set and parameters follow the new configuration."""
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        hass.data[DOMAIN].pop(entry.entry_id, None)
        # If no Sun Beams entries remain, take the setup panel down too.
        remaining = [k for k in hass.data[DOMAIN] if not k.startswith("_")]
        if not remaining:
            async_remove_panel(hass)
    return unloaded
