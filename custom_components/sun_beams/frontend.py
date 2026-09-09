"""Serve and auto-register the bundled Lovelace card.

Registering a static path + an extra JS module means installing the integration
is enough for the card to be available — no manual Lovelace resource needed."""

from __future__ import annotations

import os

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

from .const import DOMAIN

URL_BASE = "/sun_beams_static"
CARD_FILENAME = "sun-beams-card.js"
CARD_URL = f"{URL_BASE}/{CARD_FILENAME}"


async def async_register_frontend(hass: HomeAssistant) -> None:
    """Idempotently expose the card directory and load the card module."""
    if hass.data[DOMAIN].get("_frontend_registered"):
        return
    frontend_dir = os.path.join(os.path.dirname(__file__), "frontend")
    await hass.http.async_register_static_paths(
        [StaticPathConfig(URL_BASE, frontend_dir, cache_headers=False)]
    )
    add_extra_js_url(hass, CARD_URL)
    hass.data[DOMAIN]["_frontend_registered"] = True
