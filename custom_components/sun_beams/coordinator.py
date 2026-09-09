"""Open-Meteo polling coordinator."""

from __future__ import annotations

import logging
from datetime import timedelta

import aiohttp

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import (
    DATA_CLOUD,
    DATA_DHI,
    DATA_DNI,
    DATA_GHI,
    OPEN_METEO_CURRENT,
    OPEN_METEO_URL,
    UPDATE_INTERVAL_SECONDS,
)

_LOGGER = logging.getLogger(__name__)


class SunBeamsCoordinator(DataUpdateCoordinator[dict]):
    """Fetches current irradiance (DNI/DHI/GHI + cloud) from Open-Meteo."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, lat: float, lon: float) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name="Sun Beams (Open-Meteo)",
            update_interval=timedelta(seconds=UPDATE_INTERVAL_SECONDS),
        )
        self.config_entry = entry
        self._lat = lat
        self._lon = lon
        self._session = async_get_clientsession(hass)

    async def _async_update_data(self) -> dict:
        params = {
            "latitude": self._lat,
            "longitude": self._lon,
            "current": OPEN_METEO_CURRENT,
            "timezone": "auto",
        }
        try:
            async with self._session.get(
                OPEN_METEO_URL, params=params, timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                resp.raise_for_status()
                payload = await resp.json()
        except (aiohttp.ClientError, TimeoutError) as err:
            raise UpdateFailed(f"Open-Meteo request failed: {err}") from err
        except ValueError as err:
            raise UpdateFailed(f"Open-Meteo returned invalid JSON: {err}") from err

        cur = payload.get("current") or {}
        return {
            DATA_DNI: _num(cur.get("direct_normal_irradiance")),
            DATA_DHI: _num(cur.get("diffuse_radiation")),
            DATA_GHI: _num(cur.get("shortwave_radiation")),
            DATA_CLOUD: _num(cur.get("cloud_cover")),
        }


def _num(value) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0
