/*
 * Sun Beams setup panel — the integration-owned geometry editor.
 *
 * A full-page sidebar panel (registered by frontend.py via panel_custom) where
 * you draw your interior floor and place windows on the OSM building outline.
 * Geometry is persisted to the config entry through the sun_beams/save_geometry
 * websocket command; the display card only reads it. Dependency-free.
 */

const SVGNS = "http://www.w3.org/2000/svg";
const D2R = Math.PI / 180;
const SNAP_M = 1.6; // snap window clicks to a footprint wall within this distance

/* ---------- geometry helpers (mirror geometry.py) ---------- */
function centroid(pts) {
  const n = pts.length || 1;
  return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
}
function segmentOutwardAzimuth(p1, p2, polygon) {
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
  const normals = [[dy, -dx], [-dy, dx]];
  const [cx, cy] = centroid(polygon);
  const mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
  const ox = mx - cx, oy = my - cy;
  let best = normals[0], bestDot = -Infinity;
  for (const n of normals) {
    const d = n[0] * ox + n[1] * oy;
    if (d > bestDot) { bestDot = d; best = n; }
  }
  return (Math.atan2(best[0], best[1]) / D2R + 360) % 360;
}
// nearest point on a polygon's edges to p; returns {pt,d} or null
function nearestOnPolygon(p, poly) {
  if (!poly || poly.length < 2) return null;
  let best = null, bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const len2 = vx * vx + vy * vy || 1e-9;
    let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
    t = Math.max(0, Math.min(1, t));
    const q = [a[0] + t * vx, a[1] + t * vy];
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (d < bestD) { bestD = d; best = q; }
  }
  return { pt: best, d: bestD };
}
function r2(n) { return Math.round(n * 100) / 100; }
function svgEl(tag, attrs, children) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  for (const c of children || []) e.appendChild(c);
  return e;
}

class SunBeamsPanel extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._built = false;
    this._entries = [];
    this._entryId = null;
    this._geom = null;      // {footprint, origin, floor, windows}
    this._tool = "floor";
    this._pending = null;
    this._dirty = false;
    this._status = "";
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) {
      this._buildShell();
      this._built = true;
      this._loadEntries();
    }
  }
  get hass() { return this._hass; }

  async _loadEntries() {
    try {
      this._entries = (await this._hass.callWS({ type: "config_entries/get", domain: "sun_beams" })) || [];
    } catch (e) {
      this._entries = [];
    }
    if (this._entries.length) {
      this._entryId = this._entries[0].entry_id;
      await this._loadGeometry();
    }
    this._renderAll();
  }

  async _loadGeometry() {
    try {
      const res = await this._hass.callWS({ type: "sun_beams/get_geometry", entry_id: this._entryId });
      const g = res.geometry || {};
      this._geom = {
        footprint: g.footprint || [],
        origin: g.origin || {},
        floor: (g.floor || []).map((p) => [p[0], p[1]]),
        windows: (g.windows || []).map((w) => ({ ...w })),
      };
      this._dirty = false;
      this._status = "";
    } catch (e) {
      this._geom = { footprint: [], origin: {}, floor: [], windows: [] };
      this._status = "Failed to load: " + (e.message || e);
    }
  }

  _buildShell() {
    const style = document.createElement("style");
    style.textContent = `
      :host, .sb-root { display:block; }
      .sb-root {
        min-height: 100vh; background: var(--primary-background-color, #f4f6f8);
        color: var(--primary-text-color, #111);
        font-family: var(--paper-font-body1_-_font-family, "Roboto", system-ui, sans-serif);
      }
      .sb-top {
        display:flex; align-items:center; gap:12px; padding:14px 20px;
        background: var(--app-header-background-color, var(--primary-color,#03a9f4));
        color: var(--app-header-text-color, #fff);
      }
      .sb-top h1 { font-size:18px; font-weight:500; margin:0; flex:1; }
      .sb-top select {
        font:inherit; padding:4px 8px; border-radius:6px; border:none; max-width:50%;
      }
      .sb-body {
        display:grid; grid-template-columns: 1fr 320px; gap:16px; padding:16px 20px 40px;
        max-width:1200px; margin:0 auto; align-items:start;
      }
      @media (max-width: 780px) { .sb-body { grid-template-columns: 1fr; } }
      .sb-stage, .sb-side {
        background: var(--card-background-color,#fff); border-radius:12px;
        box-shadow: var(--ha-card-box-shadow, 0 2px 6px rgba(0,0,0,.12)); padding:10px;
      }
      .sb-stage svg { width:100%; height:auto; display:block; cursor: crosshair; touch-action:none; }
      .sb-side { padding:16px; }
      .sb-side h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em;
        color: var(--secondary-text-color,#666); margin:0 0 10px; }
      .sb-tools { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:14px; }
      .sb-tools button, .sb-save, .wrow button {
        font:inherit; padding:6px 12px; border-radius:8px; cursor:pointer;
        border:1px solid var(--divider-color,#ccc);
        background: var(--secondary-background-color,#f2f2f2); color: var(--primary-text-color,#111);
      }
      .sb-tools button.active { background: var(--primary-color,#03a9f4); color:#fff; border-color:transparent; }
      .instr { font-size:13px; color: var(--secondary-text-color,#666); margin:0 0 14px; line-height:1.5; }
      .wlist { display:flex; flex-direction:column; gap:8px; margin-bottom:16px; }
      .wrow { display:grid; grid-template-columns: 1fr auto auto; gap:8px; align-items:center;
        border:1px solid var(--divider-color,#e0e0e0); border-radius:8px; padding:6px 8px; }
      .wrow input { font:inherit; width:100%; border:none; background:transparent;
        color: var(--primary-text-color,#111); border-bottom:1px solid var(--divider-color,#ddd); }
      .wrow .az { font-size:12px; color: var(--secondary-text-color,#888); font-variant-numeric:tabular-nums; white-space:nowrap; }
      .wrow button { padding:2px 8px; }
      .sb-save { background: var(--primary-color,#03a9f4); color:#fff; border-color:transparent;
        width:100%; padding:10px; font-weight:500; }
      .sb-save[disabled] { opacity:.5; cursor:default; }
      .status { font-size:12.5px; color: var(--secondary-text-color,#666); margin-top:10px; min-height:16px; }
      .status.dirty { color: var(--warning-color,#c67c00); }
      .empty { padding:40px 20px; text-align:center; color: var(--secondary-text-color,#666); }
    `;
    const root = document.createElement("div");
    root.className = "sb-root";
    root.innerHTML = `
      <div class="sb-top">
        <h1>Sun Beams — building setup</h1>
        <select id="sb-entrysel" hidden></select>
      </div>
      <div class="sb-body">
        <div class="sb-stage" id="sb-stage"></div>
        <div class="sb-side" id="sb-side"></div>
      </div>`;
    this.appendChild(style);
    this.appendChild(root);
    this._stage = root.querySelector("#sb-stage");
    this._side = root.querySelector("#sb-side");
    this._entrySel = root.querySelector("#sb-entrysel");
    this._entrySel.addEventListener("change", async (e) => {
      this._entryId = e.target.value;
      await this._loadGeometry();
      this._renderAll();
    });
  }

  _renderAll() {
    // entry selector
    if (this._entries.length > 1) {
      this._entrySel.hidden = false;
      this._entrySel.innerHTML = this._entries
        .map((e) => `<option value="${e.entry_id}" ${e.entry_id === this._entryId ? "selected" : ""}>${e.title || e.entry_id}</option>`)
        .join("");
    } else {
      this._entrySel.hidden = true;
    }
    if (!this._entryId || !this._geom) {
      this._stage.innerHTML = `<div class="empty">No Sun Beams integration is set up yet.<br>Add it under Settings → Devices &amp; Services first.</div>`;
      this._side.innerHTML = "";
      return;
    }
    this._renderStage();
    this._renderSide();
  }

  _transform() {
    const pts = [];
    (this._geom.footprint || []).forEach((p) => pts.push(p));
    (this._geom.floor || []).forEach((p) => pts.push(p));
    (this._geom.windows || []).forEach((w) => { pts.push([w.x1, w.y1]); pts.push([w.x2, w.y2]); });
    if (pts.length === 0) pts.push([-12, -12], [12, 12]);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const span = Math.max(maxX - minX, maxY - minY) || 1;
    const pad = span * 0.12 + 2;
    const W = 640, H = 640;
    const scale = (W - 2 * 30) / (span + 2 * pad);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const toXY = (x, y) => [W / 2 + (x - cx) * scale, H / 2 - (y - cy) * scale];
    const toM = (sx, sy) => [cx + (sx - W / 2) / scale, cy - (sy - H / 2) / scale];
    return { toXY, toM, W, H, scale };
  }

  _renderStage() {
    const tf = this._transform();
    const g = this._geom;
    const kids = [];
    // footprint
    if (g.footprint && g.footprint.length >= 3) {
      kids.push(svgEl("polygon", {
        points: g.footprint.map((p) => tf.toXY(p[0], p[1]).join(",")).join(" "),
        fill: "var(--secondary-background-color,#eceff1)", "fill-opacity": 0.7,
        stroke: "var(--primary-text-color,#607d8b)", "stroke-width": 2,
      }, []));
      // footprint vertices (faint)
      for (const p of g.footprint) {
        const [x, y] = tf.toXY(p[0], p[1]);
        kids.push(svgEl("circle", { cx: x, cy: y, r: 2, fill: "var(--secondary-text-color,#90a4ae)" }, []));
      }
    }
    // floor (draft)
    if (g.floor && g.floor.length) {
      const pts = g.floor.map((p) => tf.toXY(p[0], p[1]).join(",")).join(" ");
      kids.push(svgEl(g.floor.length >= 3 ? "polygon" : "polyline", {
        points: pts, fill: g.floor.length >= 3 ? "var(--primary-color,#03a9f4)" : "none",
        "fill-opacity": 0.14, stroke: "var(--primary-color,#03a9f4)", "stroke-width": 2,
        "stroke-dasharray": "5 4",
      }, []));
      g.floor.forEach((p, i) => {
        const [x, y] = tf.toXY(p[0], p[1]);
        kids.push(svgEl("circle", { cx: x, cy: y, r: 4, fill: "var(--primary-color,#03a9f4)" }, []));
      });
    }
    // windows
    (g.windows || []).forEach((w, i) => {
      const [x1, y1] = tf.toXY(w.x1, w.y1);
      const [x2, y2] = tf.toXY(w.x2, w.y2);
      kids.push(svgEl("line", {
        x1, y1, x2, y2, stroke: "var(--accent-color,#ff9800)", "stroke-width": 6, "stroke-linecap": "round",
      }, []));
      const t = svgEl("text", {
        x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 9, "text-anchor": "middle",
        "font-size": 11, fill: "var(--primary-text-color,#455a64)",
      }, []);
      t.textContent = w.name || ("Window " + (i + 1));
      kids.push(t);
    });
    // pending window first point
    if (this._pending) {
      const [x, y] = tf.toXY(this._pending[0], this._pending[1]);
      kids.push(svgEl("circle", { cx: x, cy: y, r: 5, fill: "var(--error-color,#e53935)" }, []));
    }
    const s = svgEl("svg", { viewBox: `0 0 ${tf.W} ${tf.H}` }, kids);
    s.addEventListener("click", (e) => this._onClick(e, tf));
    this._stage.innerHTML = "";
    this._stage.appendChild(s);
    this._stageTf = tf;
  }

  _onClick(evt, tf) {
    const svg = this._stage.querySelector("svg");
    const rect = svg.getBoundingClientRect();
    const sx = ((evt.clientX - rect.left) / rect.width) * tf.W;
    const sy = ((evt.clientY - rect.top) / rect.height) * tf.H;
    let [mx, my] = tf.toM(sx, sy);

    if (this._tool === "floor") {
      this._geom.floor.push([r2(mx), r2(my)]);
      this._markDirty();
    } else if (this._tool === "window") {
      // snap to nearest footprint wall
      const snap = nearestOnPolygon([mx, my], this._geom.footprint);
      if (snap && snap.d <= SNAP_M) { mx = snap.pt[0]; my = snap.pt[1]; }
      if (!this._pending) {
        this._pending = [mx, my];
      } else {
        const p1 = this._pending, p2 = [mx, my];
        const ref = (this._geom.footprint && this._geom.footprint.length >= 3)
          ? this._geom.footprint : this._geom.floor;
        const az = ref.length >= 3 ? segmentOutwardAzimuth(p1, p2, ref) : 180;
        const n = this._geom.windows.length + 1;
        this._geom.windows.push({
          id: "w" + n + "_" + Date.now().toString(36),
          name: "Window " + n,
          x1: r2(p1[0]), y1: r2(p1[1]), x2: r2(p2[0]), y2: r2(p2[1]),
          azimuth: Math.round(az * 10) / 10, tilt: 90, height: 2.0,
        });
        this._pending = null;
        this._markDirty();
      }
    }
    this._renderStage();
    this._renderSide();
  }

  _markDirty() { this._dirty = true; this._status = "Unsaved changes"; }

  _renderSide() {
    const g = this._geom;
    this._side.innerHTML = `
      <h2>Tools</h2>
      <div class="sb-tools">
        <button data-tool="floor" class="${this._tool === "floor" ? "active" : ""}">Draw floor</button>
        <button data-tool="window" class="${this._tool === "window" ? "active" : ""}">Add window</button>
        <button data-act="undo">Undo</button>
        <button data-act="clearfloor">Clear floor</button>
      </div>
      <p class="instr">${this._tool === "floor"
        ? "Click inside the outline to add floor corners. Beams land on this floor."
        : "Click two points along a wall to place a window — clicks snap to the building outline, and the compass direction is taken from the wall."}</p>
      <h2>Windows (${(g.windows || []).length})</h2>
      <div class="wlist" id="sb-wlist"></div>
      <button class="sb-save" id="sb-save" ${this._dirty ? "" : "disabled"}>Save layout</button>
      <div class="status ${this._dirty ? "dirty" : ""}" id="sb-status">${this._status}</div>`;

    const wl = this._side.querySelector("#sb-wlist");
    (g.windows || []).forEach((w, i) => {
      const row = document.createElement("div");
      row.className = "wrow";
      row.innerHTML = `
        <input type="text" value="${(w.name || "").replace(/"/g, "&quot;")}" data-i="${i}">
        <span class="az">${Math.round(w.azimuth)}°</span>
        <button data-del="${i}">✕</button>`;
      wl.appendChild(row);
    });

    this._side.querySelectorAll(".sb-tools button[data-tool]").forEach((b) =>
      b.addEventListener("click", () => { this._tool = b.dataset.tool; this._pending = null; this._renderStage(); this._renderSide(); }));
    this._side.querySelector('[data-act="undo"]').addEventListener("click", () => this._undo());
    this._side.querySelector('[data-act="clearfloor"]').addEventListener("click", () => {
      if (g.floor.length) { g.floor = []; this._markDirty(); this._renderStage(); this._renderSide(); }
    });
    wl.querySelectorAll('input[data-i]').forEach((inp) =>
      inp.addEventListener("input", (e) => { g.windows[+e.target.dataset.i].name = e.target.value; this._markDirty();
        this._side.querySelector("#sb-status").textContent = this._status;
        this._side.querySelector("#sb-status").classList.add("dirty");
        this._side.querySelector("#sb-save").disabled = false; }));
    wl.querySelectorAll('button[data-del]').forEach((b) =>
      b.addEventListener("click", () => { g.windows.splice(+b.dataset.del, 1); this._markDirty(); this._renderStage(); this._renderSide(); }));
    this._side.querySelector("#sb-save").addEventListener("click", () => this._save());
  }

  _undo() {
    const g = this._geom;
    if (this._tool === "floor" && g.floor.length) g.floor.pop();
    else if (this._tool === "window") {
      if (this._pending) this._pending = null;
      else if (g.windows.length) g.windows.pop();
    }
    this._markDirty();
    this._renderStage();
    this._renderSide();
  }

  async _save() {
    const btn = this._side.querySelector("#sb-save");
    const status = this._side.querySelector("#sb-status");
    btn.disabled = true; status.textContent = "Saving…"; status.classList.remove("dirty");
    try {
      await this._hass.callWS({
        type: "sun_beams/save_geometry",
        entry_id: this._entryId,
        geometry: this._geom,
      });
      this._dirty = false;
      this._status = "Saved ✓  (sensors updated)";
      status.textContent = this._status;
    } catch (e) {
      this._status = "Save failed: " + (e.message || e);
      status.textContent = this._status;
      status.classList.add("dirty");
      btn.disabled = false;
    }
  }
}

customElements.define("sun-beams-panel", SunBeamsPanel);
console.info("%c SUN-BEAMS-PANEL %c 0.2.0 ", "background:#ff9800;color:#000", "");
