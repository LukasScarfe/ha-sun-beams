/*
 * Sun Beams card — DISPLAY ONLY.
 * Dependency-free (no Lit / no build step): plain custom element + inline SVG.
 *
 * Renders a top-down plan: footprint + interior floor, windows glowing by their
 * irradiance sensor, a sun marker on the compass ring at the live sun.sun
 * azimuth, and beams cast from sunlit windows into the floor.
 *
 * All geometry setup (draw floor, place windows) lives in the integration's
 * "Sun Beams" sidebar panel (sun-beams-panel.js), not here. This card only reads.
 */

const SVGNS = "http://www.w3.org/2000/svg";
const D2R = Math.PI / 180;
const MAX_IRRADIANCE = 900; // W/m² mapped to full glow

function lerpColor(a, b, t) {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

// 0 (no sun) -> 1 (full sun) mapped to a cool->warm glow.
function glowColor(t) {
  t = Math.max(0, Math.min(1, t));
  if (t < 0.5) return lerpColor([58, 74, 90], [255, 207, 92], t / 0.5);
  return lerpColor([255, 207, 92], [255, 122, 61], (t - 0.5) / 0.5);
}

function svg(tag, attrs, children) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  for (const c of children || []) e.appendChild(c);
  return e;
}

class SunBeamsCard extends HTMLElement {
  constructor() {
    super();
    this._geometry = null;
    this._hass = null;
    this._built = false;
  }

  setConfig(config) {
    // Don't throw on a missing entry_id — that's the normal state right after
    // adding the card from the picker, before a building is chosen. Render a
    // prompt instead so the GUI editor can be used.
    this._config = config || {};
    this._geometry = null; // force refetch on new config
  }

  getCardSize() {
    return 8;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) {
      this._build();
      this._built = true;
    }
    if (!this._config.entry_id) {
      this._renderPrompt("Select a building in the card settings (⋮ → Edit).");
      return;
    }
    if (this._geometry === null) {
      this._fetchGeometry();
    } else {
      this._render();
    }
  }

  _renderPrompt(msg) {
    this._svgHost.innerHTML = "";
    this._hint.textContent = msg;
  }

  async _fetchGeometry() {
    if (this._geometry === "loading") return;
    this._geometry = "loading";
    try {
      const res = await this._hass.connection.sendMessagePromise({
        type: "sun_beams/get_geometry",
        entry_id: this._config.entry_id,
      });
      this._geometry = res.geometry || {};
    } catch (err) {
      this._geometry = {};
      this._error = err && err.message ? err.message : String(err);
    }
    this._render();
  }

  _build() {
    const root = document.createElement("ha-card");
    if (this._config.title) root.setAttribute("header", this._config.title);
    const style = document.createElement("style");
    style.textContent = `
      .wrap { position: relative; padding: 8px; }
      svg { width: 100%; height: auto; display: block; }
      .hint { font-size: 12px; color: var(--secondary-text-color,#666); margin-top: 6px; }
    `;
    const wrap = document.createElement("div");
    wrap.className = "wrap";
    this._svgHost = document.createElement("div");
    this._hint = document.createElement("div");
    this._hint.className = "hint";
    wrap.appendChild(this._svgHost);
    wrap.appendChild(this._hint);
    root.appendChild(style);
    root.appendChild(wrap);
    this.appendChild(root);
  }

  _sun() {
    const s = this._hass && this._hass.states["sun.sun"];
    if (!s) return null;
    const e = s.attributes.elevation;
    const a = s.attributes.azimuth;
    if (e == null || a == null) return null;
    return { elev: Number(e), az: Number(a) };
  }

  // Combine footprint + floor + windows into a bounding box, build a
  // metres->SVG transform (north up).
  _transform() {
    const g = this._geometry || {};
    const pts = [];
    (g.footprint || []).forEach((p) => pts.push(p));
    (g.floor || []).forEach((p) => pts.push(p));
    (g.windows || []).forEach((w) => {
      pts.push([w.x1, w.y1]);
      pts.push([w.x2, w.y2]);
    });
    if (pts.length === 0) pts.push([-10, -10], [10, 10]);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    const pad = Math.max(spanX, spanY) * 0.35 + 2; // room for the compass ring
    const W = 600;
    const scale = (W - 2 * 40) / (Math.max(spanX, spanY) + 2 * pad);
    const H = W;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const toXY = (x, y) => [W / 2 + (x - cx) * scale, H / 2 - (y - cy) * scale];
    return { toXY, W, H, scale, cx, cy, span: Math.max(spanX, spanY) };
  }

  _windowSensor(win) {
    // Match a window to its sensor by the window id carried in the sensor's
    // attributes (falls back to azimuth for older entities).
    const states = this._hass.states;
    for (const eid in states) {
      if (!eid.startsWith("sensor.")) continue;
      const a = states[eid].attributes;
      if (!a || a.beam === undefined) continue;
      if (a.window_id === win.id) return states[eid];
    }
    for (const eid in states) {
      if (!eid.startsWith("sensor.")) continue;
      const a = states[eid].attributes;
      if (a && a.beam !== undefined && a.window_azimuth === win.azimuth) return states[eid];
    }
    return null;
  }

  _render() {
    if (!this._hass) return;
    if (this._geometry === "loading" || this._geometry === null) {
      this._svgHost.innerHTML = `<div class="hint">Loading building…</div>`;
      return;
    }
    const tf = this._transform();
    const g = this._geometry || {};
    const sun = this._sun();
    const kids = [];

    const defs = svg("defs", {}, []);
    defs.innerHTML = `
      <filter id="sb-glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="3" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>`;
    if (g.floor && g.floor.length >= 3) {
      defs.appendChild(svg("clipPath", { id: "sb-floorclip" }, [
        svg("polygon", { points: g.floor.map((p) => tf.toXY(p[0], p[1]).join(",")).join(" ") }, []),
      ]));
    }
    kids.push(defs);

    // compass ring + cardinal marks
    const [ccx, ccy] = tf.toXY(tf.cx, tf.cy);
    const ringR = (tf.span / 2 + tf.span * 0.28) * tf.scale;
    kids.push(svg("circle", {
      cx: ccx, cy: ccy, r: ringR, fill: "none",
      stroke: "var(--divider-color,#8886)", "stroke-width": 1,
    }, []));
    for (const [label, ang] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]]) {
      const lx = ccx + ringR * Math.sin(ang * D2R);
      const ly = ccy - ringR * Math.cos(ang * D2R);
      const t = svg("text", {
        x: lx, y: ly, "text-anchor": "middle", "dominant-baseline": "middle",
        "font-size": 13, fill: "var(--secondary-text-color,#888)",
      }, []);
      t.textContent = label;
      kids.push(t);
    }

    // footprint
    if (g.footprint && g.footprint.length >= 3) {
      kids.push(svg("polygon", {
        points: g.footprint.map((p) => tf.toXY(p[0], p[1]).join(",")).join(" "),
        fill: "var(--secondary-background-color,#f2f2f2)", "fill-opacity": 0.5,
        stroke: "var(--primary-text-color,#555)", "stroke-width": 1.5,
      }, []));
    }
    // interior floor
    if (g.floor && g.floor.length >= 3) {
      kids.push(svg("polygon", {
        points: g.floor.map((p) => tf.toXY(p[0], p[1]).join(",")).join(" "),
        fill: "var(--card-background-color,#fff)", "fill-opacity": 0.6,
        stroke: "var(--primary-color,#03a9f4)", "stroke-width": 1.5,
      }, []));
    }

    // beams (sun up only)
    const windows = g.windows || [];
    if (sun && sun.elev > 0) {
      const beamDir = [-Math.sin(sun.az * D2R), -Math.cos(sun.az * D2R)];
      const maxReach = this._config.max_beam_reach || 6.0;
      const reachBase = Math.min(maxReach, 2.0 / Math.tan(Math.max(sun.elev, 2) * D2R));
      for (const w of windows) {
        const st = this._windowSensor(w);
        const beam = st ? Number(st.attributes.beam || 0) : 0;
        if (beam <= 1) continue;
        const intensity = Math.max(0, Math.min(1, beam / MAX_IRRADIANCE));
        const reach = reachBase * (0.4 + 0.6 * intensity);
        const a = [w.x1, w.y1], b = [w.x2, w.y2];
        const a2 = [a[0] + beamDir[0] * reach, a[1] + beamDir[1] * reach];
        const b2 = [b[0] + beamDir[0] * reach, b[1] + beamDir[1] * reach];
        kids.push(svg("polygon", {
          points: [a, b, b2, a2].map((p) => tf.toXY(p[0], p[1]).join(",")).join(" "),
          fill: "rgb(255,214,110)", "fill-opacity": (0.15 + 0.4 * intensity).toFixed(3),
          ...(g.floor && g.floor.length >= 3 ? { "clip-path": "url(#sb-floorclip)" } : {}),
        }, []));
      }
    }

    // windows (glow) + labels
    for (const w of windows) {
      const st = this._windowSensor(w);
      const irr = st ? Number(st.state) : 0;
      const t = Math.max(0, Math.min(1, irr / MAX_IRRADIANCE));
      const [x1, y1] = tf.toXY(w.x1, w.y1);
      const [x2, y2] = tf.toXY(w.x2, w.y2);
      kids.push(svg("line", {
        x1, y1, x2, y2, stroke: glowColor(t), "stroke-width": 6, "stroke-linecap": "round",
        ...(t > 0.05 ? { filter: "url(#sb-glow)" } : {}),
      }, []));
      if (st) {
        const lbl = svg("text", {
          x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 8, "text-anchor": "middle",
          "font-size": 11, fill: "var(--primary-text-color,#333)",
        }, []);
        lbl.textContent = `${Math.round(irr)} W/m²`;
        kids.push(lbl);
      }
    }

    // sun marker
    if (sun) {
      const sx = ccx + ringR * Math.sin(sun.az * D2R);
      const sy = ccy - ringR * Math.cos(sun.az * D2R);
      const up = sun.elev > 0;
      kids.push(svg("line", {
        x1: ccx, y1: ccy, x2: sx, y2: sy, stroke: up ? "rgb(255,190,60)" : "#8886",
        "stroke-width": 1, "stroke-dasharray": "3 3",
      }, []));
      kids.push(svg("circle", {
        cx: sx, cy: sy, r: 9, fill: up ? "rgb(255,196,64)" : "#9993",
        stroke: "rgb(255,150,30)", "stroke-width": up ? 1.5 : 0,
        ...(up ? { filter: "url(#sb-glow)" } : {}),
      }, []));
      const et = svg("text", {
        x: sx, y: sy + 22, "text-anchor": "middle", "font-size": 10,
        fill: "var(--secondary-text-color,#888)",
      }, []);
      et.textContent = `${Math.round(sun.elev)}° / ${Math.round(sun.az)}°`;
      kids.push(et);
    }

    const s = svg("svg", { viewBox: `0 0 ${tf.W} ${tf.H}` }, kids);
    this._svgHost.innerHTML = "";
    this._svgHost.appendChild(s);

    if (this._error) {
      this._hint.textContent = "⚠ " + this._error;
    } else if (!windows.length) {
      this._hint.textContent = "No windows yet — open the Sun Beams panel in the sidebar to draw your floor and place windows.";
    } else {
      this._hint.textContent = "";
    }
  }

  static getConfigElement() {
    return document.createElement("sun-beams-card-editor");
  }

  static getStubConfig() {
    return { type: "custom:sun-beams-card", entry_id: "", title: "Sun Beams" };
  }
}

/* ---------- card config editor (entry picker + title only) ---------- */

class SunBeamsCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...config };
    this._render();
  }
  set hass(hass) {
    this._hass = hass;
    if (this._built) return;
    this._render();
  }
  _emit() {
    this.dispatchEvent(new CustomEvent("config-changed", {
      detail: { config: this._config }, bubbles: true, composed: true,
    }));
  }
  async _entries() {
    try {
      return (await this._hass.connection.sendMessagePromise({
        type: "config_entries/get", domain: "sun_beams",
      })) || [];
    } catch (e) {
      return [];
    }
  }
  async _render() {
    if (!this._hass || !this._config) return;
    this._built = true;
    const entries = await this._entries();
    this.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.style.padding = "8px";
    const opts = entries
      .map((e) => `<option value="${e.entry_id}" ${e.entry_id === this._config.entry_id ? "selected" : ""}>${e.title || e.entry_id}</option>`)
      .join("");
    wrap.innerHTML = `
      <label style="display:block;margin-bottom:8px;">Building (config entry)
        <select id="sb-entry" style="display:block;width:100%;margin-top:4px;">
          <option value="">— choose —</option>${opts}
        </select>
      </label>
      <label style="display:block;">Title
        <input id="sb-title" type="text" value="${this._config.title || ""}"
               style="display:block;width:100%;margin-top:4px;">
      </label>
      <p style="color:var(--secondary-text-color,#888);font-size:12px;margin-top:10px;">
        Draw your floor and place windows in the <b>Sun Beams</b> panel (left sidebar).</p>`;
    this.appendChild(wrap);
    wrap.querySelector("#sb-entry").addEventListener("change", (e) => {
      this._config.entry_id = e.target.value; this._emit();
    });
    wrap.querySelector("#sb-title").addEventListener("input", (e) => {
      this._config.title = e.target.value; this._emit();
    });
  }
}

customElements.define("sun-beams-card", SunBeamsCard);
customElements.define("sun-beams-card-editor", SunBeamsCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "sun-beams-card",
  name: "Sun Beams",
  description: "Top-down solar irradiance and sun-beam view for your windows (display only).",
  preview: false,
  documentationURL: "https://github.com/LukasScarfe/ha-sun-beams",
});

console.info("%c SUN-BEAMS-CARD %c 0.3.1 ", "background:#ff9800;color:#000", "");
