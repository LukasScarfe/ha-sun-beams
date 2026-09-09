"""Serve and auto-register the bundled card + the setup panel.

Installing the integration is enough for both to appear:
  * the display card is registered as an extra JS module (no Lovelace resource);
  * the geometry editor is a sidebar panel served by the integration itself.
"""

from __future__ import annotations

import os

from homeassistant.components import frontend, panel_custom
from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

from .const import DOMAIN

URL_BASE = "/sun_beams_static"
CARD_URL = f"{URL_BASE}/sun-beams-card.js"
PANEL_URL = f"{URL_BASE}/sun-beams-panel.js"
PANEL_PATH = "sun-beams"  # sidebar URL: /sun-beams


async def async_register_frontend(hass: HomeAssistant) -> None:
    """Idempotently expose the static dir, the card module, and the setup panel."""
    if not hass.data[DOMAIN].get("_static_registered"):
        frontend_dir = os.path.join(os.path.dirname(__file__), "frontend")
        await hass.http.async_register_static_paths(
            [StaticPathConfig(URL_BASE, frontend_dir, cache_headers=False)]
        )
        add_extra_js_url(hass, CARD_URL)
        hass.data[DOMAIN]["_static_registered"] = True

    if not hass.data[DOMAIN].get("_panel_registered"):
        await panel_custom.async_register_panel(
            hass,
            frontend_url_path=PANEL_PATH,
            webcomponent_name="sun-beams-panel",
            module_url=PANEL_URL,
            sidebar_title="Sun Beams",
            sidebar_icon="mdi:white-balance-sunny",
            require_admin=True,
        )
        hass.data[DOMAIN]["_panel_registered"] = True


def async_remove_panel(hass: HomeAssistant) -> None:
    """Remove the sidebar panel (called when the last entry is unloaded)."""
    if hass.data.get(DOMAIN, {}).get("_panel_registered"):
        frontend.async_remove_panel(hass, PANEL_PATH)
        hass.data[DOMAIN]["_panel_registered"] = False
