/*
 * Sun Beams card — top-down solar view for the sun_beams integration.
 * Dependency-free (no Lit / no build step): plain custom element + inline SVG.
 *
 * View mode : footprint + interior floor, windows glowing by their irradiance
 *             sensor, a sun compass at the live sun.sun azimuth, and beams cast
 *             from sunlit windows into the floor.
 * Edit mode : draw the interior floor and drop windows onto walls; each window's
 *             azimuth is derived from the wall it sits on. Saved to the config
 *             entry via the sun_beams/save_geometry websocket command.
 */

const SVGNS = "http://www.w3.org/2000/svg";
const D2R = Math.PI / 180;
const MAX_IRRADIANCE = 900; // W/m² mapped to full glow

/* ---------- small geometry helpers (mirror geometry.py) ---------- */

function centroid(pts) {
  const n = pts.length || 1;
  return [
    pts.reduce((s, p) => s + p[0], 0) / n,
    pts.reduce((s, p) => s + p[1], 0) / n,
  ];
}

// Outward-normal compass azimuth (0=N clockwise) of segment p1->p2, chosen to
// point away from the reference polygon's centroid.
function segmentOutwardAzimuth(p1, p2, polygon) {
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const normals = [[dy, -dx], [-dy, dx]];
  const [cx, cy] = centroid(polygon);
  const mx = (p1[0] + p2[0]) / 2;
  const my = (p1[1] + p2[1]) / 2;
  const ox = mx - cx;
  const oy = my - cy;
  let best = normals[0];
  let bestDot = -Infinity;
  for (const n of normals) {
    const d = n[0] * ox + n[1] * oy;
    if (d > bestDot) {
      bestDot = d;
      best = n;
    }
  }
  return (Math.atan2(best[0], best[1]) / D2R + 360) % 360;
}

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

/* ---------- the card ---------- */

class SunBeamsCard extends HTMLElement {
  constructor() {
    super();
    this._geometry = null;
    this._geomKey = null;
    this._editing = false;
    this._draft = null; // {mode, floor:[], windows:[]}
    this._hass = null;
    this._built = false;
  }

  setConfig(config) {
    if (!config || !config.entry_id) {
      throw new Error("sun-beams-card: 'entry_id' is required");
    }
    this._config = config;
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
    if (this._geometry === null) {
      this._fetchGeometry();
    } else {
      this._update();
    }
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
      this._albedo = res.albedo;
      this._efficacy = res.efficacy;
    } catch (err) {
      this._geometry = {};
      this._error = err && err.message ? err.message : String(err);
    }
    this._update();
  }

  _build() {
    const root = document.createElement("ha-card");
    if (this._config.title) root.setAttribute("header", this._config.title);
    const style = document.createElement("style");
    style.textContent = `
      .wrap { position: relative; padding: 8px; }
      svg { width: 100%; height: auto; display: block; touch-action: none; }
      .toolbar { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
      .toolbar button {
        font: inherit; padding:4px 10px; border-radius:8px; cursor:pointer;
        border:1px solid var(--divider-color,#ccc);
        background: var(--card-background-color,#fff);
        color: var(--primary-text-color,#111);
      }
      .toolbar button.active { background: var(--primary-color,#03a9f4); color:#fff; }
      .hint { font-size:12px; color: var(--secondary-text-color,#666); margin-top:6px; }
      .err { color: var(--error-color,#c00); font-size:13px; padding:8px; }
    `;
    const wrap = document.createElement("div");
    wrap.className = "wrap";
    this._svgHost = document.createElement("div");
    this._toolbar = document.createElement("div");
    this._toolbar.className = "toolbar";
    this._hint = document.createElement("div");
    this._hint.className = "hint";
    wrap.appendChild(this._svgHost);
    wrap.appendChild(this._toolbar);
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
  // metres->SVG transform (north up), and return helpers.
  _transform() {
    const g = this._geometry || {};
    const pts = [];
    (g.footprint || []).forEach((p) => pts.push(p));
    (g.floor || []).forEach((p) => pts.push(p));
    (g.windows || []).forEach((w) => {
      pts.push([w.x1, w.y1]);
      pts.push([w.x2, w.y2]);
    });
    if (this._draft) {
      (this._draft.floor || []).forEach((p) => pts.push(p));
      (this._draft.windows || []).forEach((w) => {
        pts.push([w.x1, w.y1]);
        pts.push([w.x2, w.y2]);
      });
    }
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
    const H = W; // square canvas
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    // metres (east,north) -> svg (x right, y down); flip north to up.
    const toXY = (x, y) => [
      W / 2 + (x - cx) * scale,
      H / 2 - (y - cy) * scale,
    ];
    const toM = (sx, sy) => [
      cx + (sx - W / 2) / scale,
      cy - (sy - H / 2) / scale,
    ];
    return { toXY, toM, W, H, scale, cx, cy, span: Math.max(spanX, spanY) };
  }

  _update() {
    if (!this._hass) return;
    if (this._geometry === "loading" || this._geometry === null) {
      this._svgHost.innerHTML = `<div class="hint">Loading building…</div>`;
      return;
    }
    this._renderToolbar();
    this._renderSvg();
  }

  _renderToolbar() {
    const tb = this._toolbar;
    tb.innerHTML = "";
    const mkBtn = (label, active, on) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (active) b.classList.add("active");
      b.addEventListener("click", on);
      tb.appendChild(b);
      return b;
    };
    if (!this._editing) {
      mkBtn("✏️ Edit layout", false, () => this._startEdit());
    } else {
      mkBtn("Draw floor", this._draft.mode === "floor", () => this._setMode("floor"));
      mkBtn("Add window", this._draft.mode === "window", () => this._setMode("window"));
      mkBtn("Undo", false, () => this._undo());
      mkBtn("Save", false, () => this._save());
      mkBtn("Cancel", false, () => this._cancelEdit());
    }
  }

  _startEdit() {
    const g = this._geometry || {};
    this._editing = true;
    this._draft = {
      mode: "floor",
      floor: (g.floor || []).map((p) => [p[0], p[1]]),
      windows: (g.windows || []).map((w) => ({ ...w })),
      pendingWindow: null,
    };
    this._update();
  }

  _cancelEdit() {
    this._editing = false;
    this._draft = null;
    this._update();
  }

  _setMode(mode) {
    this._draft.mode = mode;
    this._draft.pendingWindow = null;
    this._update();
  }

  _undo() {
    const d = this._draft;
    if (d.mode === "floor" && d.floor.length) d.floor.pop();
    else if (d.mode === "window" && d.windows.length) d.windows.pop();
    this._update();
  }

  async _save() {
    const g = { ...(this._geometry || {}) };
    g.floor = this._draft.floor;
    g.windows = this._draft.windows;
    try {
      await this._hass.connection.sendMessagePromise({
        type: "sun_beams/save_geometry",
        entry_id: this._config.entry_id,
        geometry: g,
      });
      this._geometry = g;
      this._editing = false;
      this._draft = null;
      this._update();
    } catch (err) {
      this._hint.textContent = "Save failed: " + (err.message || err);
    }
  }

  _onSvgClick(evt, tf) {
    if (!this._editing) return;
    const rect = this._svgEl.getBoundingClientRect();
    const sx = ((evt.clientX - rect.left) / rect.width) * tf.W;
    const sy = ((evt.clientY - rect.top) / rect.height) * tf.H;
    const [mx, my] = tf.toM(sx, sy);
    const d = this._draft;
    if (d.mode === "floor") {
      d.floor.push([Math.round(mx * 100) / 100, Math.round(my * 100) / 100]);
    } else if (d.mode === "window") {
      if (!d.pendingWindow) {
        d.pendingWindow = [mx, my];
      } else {
        const p1 = d.pendingWindow;
        const p2 = [mx, my];
        const ref = (this._geometry.footprint && this._geometry.footprint.length
          ? this._geometry.footprint : d.floor);
        const az = ref.length >= 3 ? segmentOutwardAzimuth(p1, p2, ref) : 180;
        const id = "w" + (d.windows.length + 1) + "_" + Date.now().toString(36);
        d.windows.push({
          id,
          name: "Window " + (d.windows.length + 1),
          x1: Math.round(p1[0] * 100) / 100, y1: Math.round(p1[1] * 100) / 100,
          x2: Math.round(p2[0] * 100) / 100, y2: Math.round(p2[1] * 100) / 100,
          azimuth: Math.round(az * 10) / 10, tilt: 90, height: 2.0,
        });
        d.pendingWindow = null;
      }
    }
    this._update();
  }

  _windowIrradiance(win) {
    // Match the sensor by unique-id suffix -> entity. We look up any sensor whose
    // attributes carry this window's azimuth, else fall back to name matching.
    const states = this._hass.states;
    for (const eid in states) {
      if (!eid.startsWith("sensor.")) continue;
      const st = states[eid];
      if (st.attributes && st.attributes.window_azimuth === win.azimuth &&
          st.attributes.beam !== undefined) {
        return st;
      }
    }
    return null;
  }

  _renderSvg() {
    const tf = this._transform();
    const g = this._geometry || {};
    const sun = this._sun();
    const kids = [];

    // defs: soft glow filter + beam gradient
    const defs = svg("defs", {}, []);
    defs.innerHTML = `
      <filter id="sb-glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="3" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>`;
    if (g.floor && g.floor.length >= 3) {
      const clip = svg("clipPath", { id: "sb-floorclip" }, [
        svg("polygon", { points: g.floor.map((p) => tf.toXY(p[0], p[1]).join(",")).join(" ") }, []),
      ]);
      defs.appendChild(clip);
    }
    kids.push(defs);

    // compass ring + N marker
    const [ccx, ccy] = tf.toXY(tf.cx, tf.cy);
    const ringR = (tf.span / 2 + tf.span * 0.28) * tf.scale;
    kids.push(svg("circle", {
      cx: ccx, cy: ccy, r: ringR, fill: "none",
      stroke: "var(--divider-color,#8886)", "stroke-width": 1,
    }, []));
    const compass = [["N", 0], ["E", 90], ["S", 180], ["W", 270]];
    for (const [label, ang] of compass) {
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
        fill: "var(--secondary-background-color,#f2f2f2)",
        "fill-opacity": 0.5, stroke: "var(--primary-text-color,#555)",
        "stroke-width": 1.5,
      }, []));
    }
    // interior floor
    const floor = this._editing ? this._draft.floor : g.floor;
    if (floor && floor.length >= 2) {
      kids.push(svg("polyline", {
        points: floor.map((p) => tf.toXY(p[0], p[1]).join(",")).join(" "),
        fill: floor.length >= 3 ? "var(--card-background-color,#fff)" : "none",
        "fill-opacity": floor.length >= 3 ? 0.6 : 0,
        stroke: "var(--primary-color,#03a9f4)", "stroke-width": 1.5,
        "stroke-dasharray": this._editing ? "4 3" : "none",
      }, []));
      if (this._editing) {
        for (const p of floor) {
          const [x, y] = tf.toXY(p[0], p[1]);
          kids.push(svg("circle", { cx: x, cy: y, r: 3, fill: "var(--primary-color,#03a9f4)" }, []));
        }
      }
    }

    // beams (only in view mode, when sun is up)
    const windows = this._editing ? this._draft.windows : g.windows || [];
    if (!this._editing && sun && sun.elev > 0) {
      const az = sun.az;
      const beamDir = [-Math.sin(az * D2R), -Math.cos(az * D2R)]; // travel = away from sun
      const maxReach = this._config.max_beam_reach || 6.0;
      const reachBase = Math.min(maxReach, 2.0 / Math.tan(Math.max(sun.elev, 2) * D2R));
      for (const w of windows) {
        const st = this._windowIrradiance(w);
        const beam = st ? Number(st.attributes.beam || 0) : 0;
        if (beam <= 1) continue;
        const intensity = Math.max(0, Math.min(1, beam / MAX_IRRADIANCE));
        const reach = reachBase * (0.4 + 0.6 * intensity);
        const a = [w.x1, w.y1];
        const b = [w.x2, w.y2];
        const a2 = [a[0] + beamDir[0] * reach, a[1] + beamDir[1] * reach];
        const b2 = [b[0] + beamDir[0] * reach, b[1] + beamDir[1] * reach];
        const poly = [a, b, b2, a2].map((p) => tf.toXY(p[0], p[1]).join(",")).join(" ");
        kids.push(svg("polygon", {
          points: poly, fill: "rgb(255,214,110)",
          "fill-opacity": (0.15 + 0.4 * intensity).toFixed(3),
          ...(g.floor && g.floor.length >= 3 ? { "clip-path": "url(#sb-floorclip)" } : {}),
        }, []));
      }
    }

    // windows (glow) — drawn last so they sit above beams
    for (const w of windows) {
      const st = this._editing ? null : this._windowIrradiance(w);
      const irr = st ? Number(st.state) : 0;
      const t = Math.max(0, Math.min(1, irr / MAX_IRRADIANCE));
      const [x1, y1] = tf.toXY(w.x1, w.y1);
      const [x2, y2] = tf.toXY(w.x2, w.y2);
      kids.push(svg("line", {
        x1, y1, x2, y2, stroke: this._editing ? "var(--primary-color,#03a9f4)" : glowColor(t),
        "stroke-width": 6, "stroke-linecap": "round",
        ...(t > 0.05 && !this._editing ? { filter: "url(#sb-glow)" } : {}),
      }, []));
      if (!this._editing && st) {
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        const lbl = svg("text", {
          x: mx, y: my - 8, "text-anchor": "middle", "font-size": 11,
          fill: "var(--primary-text-color,#333)",
        }, []);
        lbl.textContent = `${Math.round(irr)} W/m²`;
        kids.push(lbl);
      }
    }
    // pending first click of a window
    if (this._editing && this._draft.pendingWindow) {
      const [x, y] = tf.toXY(this._draft.pendingWindow[0], this._draft.pendingWindow[1]);
      kids.push(svg("circle", { cx: x, cy: y, r: 4, fill: "var(--error-color,#c00)" }, []));
    }

    // sun marker on the ring
    if (sun) {
      const sx = ccx + ringR * Math.sin(sun.az * D2R);
      const sy = ccy - ringR * Math.cos(sun.az * D2R);
      const up = sun.elev > 0;
      kids.push(svg("line", {
        x1: ccx, y1: ccy, x2: sx, y2: sy,
        stroke: up ? "rgb(255,190,60)" : "#8886", "stroke-width": 1,
        "stroke-dasharray": "3 3",
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
    if (this._editing) s.addEventListener("click", (e) => this._onSvgClick(e, tf));
    this._svgHost.innerHTML = "";
    this._svgHost.appendChild(s);
    this._svgEl = s;

    // hint text
    if (this._error) {
      this._hint.textContent = "⚠ " + this._error;
    } else if (this._editing) {
      this._hint.textContent = this._draft.mode === "floor"
        ? "Click to add floor corners (interior outline). Beams land inside this."
        : "Click two points along a wall to place a window. Its compass direction is set from the wall.";
    } else if (!windows.length) {
      this._hint.textContent = "No windows yet — tap “Edit layout” to draw your floor and place windows.";
    } else {
      this._hint.textContent = "";
    }
  }

  static getConfigElement() {
    return document.createElement("sun-beams-card-editor");
  }

  static getStubConfig(hass) {
    // pick the first sun_beams config entry if we can find one via a device
    return { type: "custom:sun-beams-card", entry_id: "", title: "Sun Beams" };
  }
}

/* ---------- config editor (entry picker + title) ---------- */

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
      const list = await this._hass.connection.sendMessagePromise({
        type: "config_entries/get", domain: "sun_beams",
      });
      return list || [];
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
      </label>`;
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
  description: "Top-down solar irradiance and sun-beam view for your windows.",
  preview: false,
  documentationURL: "https://github.com/LukasScarfe/ha-sun-beams",
});

console.info("%c SUN-BEAMS-CARD %c 0.1.0 ", "background:#ff9800;color:#000", "");
