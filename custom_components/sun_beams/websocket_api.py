"""WebSocket commands the card uses to read/write building geometry.

The card's editor is the geometry editor; these commands persist what it draws
into the config entry so the server-side sensors share one source of truth.
Saving reloads the entry, which rebuilds the per-window sensor set."""

from __future__ import annotations

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import (
    CONF_ALBEDO,
    CONF_EFFICACY,
    CONF_GEOMETRY,
    CONF_LATITUDE,
    CONF_LONGITUDE,
    DEFAULT_ALBEDO,
    DEFAULT_EFFICACY,
    DOMAIN,
    GEO_BUILDING_HEIGHT,
    GEO_OBSTRUCTIONS,
    GEO_ORIGIN,
)
from .osm import async_fetch_surroundings


@websocket_api.websocket_command(
    {
        vol.Required("type"): "sun_beams/get_geometry",
        vol.Required("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_get_geometry(hass: HomeAssistant, connection, msg) -> None:
    entry = hass.config_entries.async_get_entry(msg["entry_id"])
    if entry is None or entry.domain != DOMAIN:
        connection.send_error(msg["id"], "not_found", "Config entry not found")
        return
    connection.send_result(
        msg["id"],
        {
            "geometry": entry.options.get(CONF_GEOMETRY)
            or entry.data.get(CONF_GEOMETRY)
            or {},
            "albedo": entry.options.get(CONF_ALBEDO, DEFAULT_ALBEDO),
            "efficacy": entry.options.get(CONF_EFFICACY, DEFAULT_EFFICACY),
        },
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "sun_beams/save_geometry",
        vol.Required("entry_id"): str,
        vol.Required("geometry"): dict,
        vol.Optional("albedo"): vol.Coerce(float),
        vol.Optional("efficacy"): vol.Coerce(float),
    }
)
@websocket_api.async_response
async def ws_save_geometry(hass: HomeAssistant, connection, msg) -> None:
    entry = hass.config_entries.async_get_entry(msg["entry_id"])
    if entry is None or entry.domain != DOMAIN:
        connection.send_error(msg["id"], "not_found", "Config entry not found")
        return

    options = dict(entry.options)
    options[CONF_GEOMETRY] = msg["geometry"]
    if "albedo" in msg:
        options[CONF_ALBEDO] = msg["albedo"]
    if "efficacy" in msg:
        options[CONF_EFFICACY] = msg["efficacy"]

    # Updating the options fires the entry's update listener, which reloads the
    # entry and rebuilds the per-window sensor set for the new geometry.
    hass.config_entries.async_update_entry(entry, options=options)
    connection.send_result(msg["id"], {"saved": True})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "sun_beams/refresh_geometry",
        vol.Required("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_refresh_geometry(hass: HomeAssistant, connection, msg) -> None:
    """Fetch the OSM surroundings (neighbour footprints + heights) for an entry,
    projected about its **existing** origin so they line up with already-saved
    floor/window coordinates. Fetch-only: it returns the data for the panel to
    merge into its in-memory geometry and Save — it does not touch the entry, so
    an in-progress drawing is never clobbered by a reload."""
    entry = hass.config_entries.async_get_entry(msg["entry_id"])
    if entry is None or entry.domain != DOMAIN:
        connection.send_error(msg["id"], "not_found", "Config entry not found")
        return

    geometry = entry.options.get(CONF_GEOMETRY) or entry.data.get(CONF_GEOMETRY) or {}
    origin = geometry.get(GEO_ORIGIN) or {}
    lat = entry.data.get(CONF_LATITUDE, origin.get("lat", hass.config.latitude))
    lon = entry.data.get(CONF_LONGITUDE, origin.get("lon", hass.config.longitude))
    origin_lat = origin.get("lat", lat)
    origin_lon = origin.get("lon", lon)

    session = async_get_clientsession(hass)
    result = await async_fetch_surroundings(session, lat, lon, origin_lat, origin_lon)
    if result is None:
        connection.send_error(msg["id"], "osm_unreachable", "Could not reach OpenStreetMap")
        return

    connection.send_result(
        msg["id"],
        {
            GEO_BUILDING_HEIGHT: result["building_height"],
            GEO_OBSTRUCTIONS: result["obstructions"],
        },
    )


def async_register(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, ws_get_geometry)
    websocket_api.async_register_command(hass, ws_save_geometry)
    websocket_api.async_register_command(hass, ws_refresh_geometry)
