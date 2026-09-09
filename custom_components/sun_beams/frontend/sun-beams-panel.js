/*
 * Sun Beams setup panel — the integration-owned geometry editor.
 *
 * Full-page sidebar panel (registered by frontend.py via panel_custom) to draw
 * the interior floor and place windows on the OSM building outline. Geometry is
 * persisted to the config entry via sun_beams/save_geometry; the display card
 * only reads it. Dependency-free.
 *
 * Interaction:
 *   - Draw floor tool : click to add interior-floor corners.
 *   - Add window tool : click two points on a wall to place a window.
 *   - Drag (any tool) : floor corners, window endpoints, and whole windows are
 *     draggable handles. Endpoint drags snap to the nearest building wall; a
 *     window's compass azimuth is recomputed from its wall as it moves.
 */

const SVGNS = "http://www.w3.org/2000/svg";
const D2R = Math.PI / 180;
const SNAP_M = 1.6;      // snap window points to a footprint wall within this many metres
const HIT_PX = 11;       // pointer hit-tolerance for handles, in screen pixels
const DRAG_PX = 3;       // movement beyond this counts as a drag, not a click

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
// distance (px) from point c to segment a-b, all in screen coords
function distToSeg(cx, cy, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy || 1e-9;
  let t = ((cx - ax) * vx + (cy - ay) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(cx - (ax + t * vx), cy - (ay + t * vy));
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
    this._pending = null;   // first click of a new window
    this._dirty = false;
    this._status = "";
    this._ptr = null;       // active pointer gesture
    this._drag = null;      // active drag descriptor
    this._stageTf = null;
    this._moveBound = (e) => this._onPointerMove(e);
    this._upBound = (e) => this._onPointerUp(e);
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
      .sb-root { display:block; min-height:100vh; background:var(--primary-background-color,#f4f6f8);
        color:var(--primary-text-color,#111);
        font-family:var(--paper-font-body1_-_font-family,"Roboto",system-ui,sans-serif); }
      .sb-top { display:flex; align-items:center; gap:12px; padding:14px 20px;
        background:var(--app-header-background-color,var(--primary-color,#03a9f4));
        color:var(--app-header-text-color,#fff); }
      .sb-top h1 { font-size:18px; font-weight:500; margin:0; flex:1; }
      .sb-top select { font:inherit; padding:4px 8px; border-radius:6px; border:none; max-width:50%; }
      .sb-body { display:grid; grid-template-columns:1fr 320px; gap:16px; padding:16px 20px 40px;
        max-width:1200px; margin:0 auto; align-items:start; }
      @media (max-width:780px){ .sb-body{ grid-template-columns:1fr; } }
      .sb-stage, .sb-side { background:var(--card-background-color,#fff); border-radius:12px;
        box-shadow:var(--ha-card-box-shadow,0 2px 6px rgba(0,0,0,.12)); padding:10px; }
      .sb-stage svg { width:100%; height:auto; display:block; touch-action:none; cursor:crosshair;
        user-select:none; -webkit-user-select:none; }
      .sb-side { padding:16px; }
      .sb-side h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em;
        color:var(--secondary-text-color,#666); margin:0 0 10px; }
      .sb-tools { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:14px; }
      .sb-tools button, .sb-save, .wrow button { font:inherit; padding:6px 12px; border-radius:8px;
        cursor:pointer; border:1px solid var(--divider-color,#ccc);
        background:var(--secondary-background-color,#f2f2f2); color:var(--primary-text-color,#111); }
      .sb-tools button.active { background:var(--primary-color,#03a9f4); color:#fff; border-color:transparent; }
      .instr { font-size:13px; color:var(--secondary-text-color,#666); margin:0 0 14px; line-height:1.5; }
      .wlist { display:flex; flex-direction:column; gap:8px; margin-bottom:16px; }
      .wrow { display:grid; grid-template-columns:1fr auto auto; gap:8px; align-items:center;
        border:1px solid var(--divider-color,#e0e0e0); border-radius:8px; padding:6px 8px; }
      .wrow input { font:inherit; width:100%; border:none; background:transparent;
        color:var(--primary-text-color,#111); border-bottom:1px solid var(--divider-color,#ddd); }
      .wrow .az { font-size:12px; color:var(--secondary-text-color,#888); font-variant-numeric:tabular-nums; white-space:nowrap; }
      .wrow button { padding:2px 8px; }
      .sb-save { background:var(--primary-color,#03a9f4); color:#fff; border-color:transparent;
        width:100%; padding:10px; font-weight:500; }
      .sb-save[disabled] { opacity:.5; cursor:default; }
      .status { font-size:12.5px; color:var(--secondary-text-color,#666); margin-top:10px; min-height:16px; }
      .status.dirty { color:var(--warning-color,#c67c00); }
      .empty { padding:40px 20px; text-align:center; color:var(--secondary-text-color,#666); }
    `;
    const root = document.createElement("div");
    root.className = "sb-root";
    root.innerHTML = `
      <div class="sb-top"><h1>Sun Beams — building setup</h1><select id="sb-entrysel" hidden></select></div>
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
      this._entryId = e.target.value; await this._loadGeometry(); this._renderAll();
    });
    // one persistent pointerdown listener on the stable container
    this._stage.addEventListener("pointerdown", (e) => this._onPointerDown(e));
  }

  _renderAll() {
    if (this._entries.length > 1) {
      this._entrySel.hidden = false;
      this._entrySel.innerHTML = this._entries
        .map((e) => `<option value="${e.entry_id}" ${e.entry_id === this._entryId ? "selected" : ""}>${e.title || e.entry_id}</option>`).join("");
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
    const scale = (W - 60) / (span + 2 * pad);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const toXY = (x, y) => [W / 2 + (x - cx) * scale, H / 2 - (y - cy) * scale];
    const toM = (sx, sy) => [cx + (sx - W / 2) / scale, cy - (sy - H / 2) / scale];
    return { toXY, toM, W, H, scale };
  }

  // render the plan; pass a frozen transform during a drag so it doesn't rescale
  _renderStage(tfOverride) {
    const tf = tfOverride || this._transform();
    this._stageTf = tf;
    const g = this._geom;
    const kids = [];
    // footprint (fixed — from OSM; not draggable)
    if (g.footprint && g.footprint.length >= 3) {
      kids.push(svgEl("polygon", {
        points: g.footprint.map((p) => tf.toXY(p[0], p[1]).join(",")).join(" "),
        fill: "var(--secondary-background-color,#eceff1)", "fill-opacity": 0.7,
        stroke: "var(--primary-text-color,#607d8b)", "stroke-width": 2,
      }, []));
    }
    // floor (draft) + draggable corner handles
    if (g.floor && g.floor.length) {
      const pts = g.floor.map((p) => tf.toXY(p[0], p[1]).join(",")).join(" ");
      kids.push(svgEl(g.floor.length >= 3 ? "polygon" : "polyline", {
        points: pts, fill: g.floor.length >= 3 ? "var(--primary-color,#03a9f4)" : "none",
        "fill-opacity": 0.14, stroke: "var(--primary-color,#03a9f4)", "stroke-width": 2,
        "stroke-dasharray": "5 4",
      }, []));
      g.floor.forEach((p) => {
        const [x, y] = tf.toXY(p[0], p[1]);
        kids.push(svgEl("circle", {
          cx: x, cy: y, r: 5, fill: "var(--primary-color,#03a9f4)",
          stroke: "var(--card-background-color,#fff)", "stroke-width": 1.5, style: "cursor:grab",
        }, []));
      });
    }
    // windows: line body (draggable) + endpoint handles (draggable) + label
    (g.windows || []).forEach((w, i) => {
      const [x1, y1] = tf.toXY(w.x1, w.y1);
      const [x2, y2] = tf.toXY(w.x2, w.y2);
      kids.push(svgEl("line", {
        x1, y1, x2, y2, stroke: "var(--accent-color,#ff9800)", "stroke-width": 6,
        "stroke-linecap": "round", style: "cursor:move",
      }, []));
      for (const [hx, hy] of [[x1, y1], [x2, y2]]) {
        kids.push(svgEl("circle", {
          cx: hx, cy: hy, r: 5, fill: "var(--accent-color,#ff9800)",
          stroke: "var(--card-background-color,#fff)", "stroke-width": 1.5, style: "cursor:grab",
        }, []));
      }
      const t = svgEl("text", {
        x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 10, "text-anchor": "middle",
        "font-size": 11, fill: "var(--primary-text-color,#455a64)", style: "pointer-events:none",
      }, []);
      t.textContent = w.name || ("Window " + (i + 1));
      kids.push(t);
    });
    // pending first point of a new window
    if (this._pending) {
      const [x, y] = tf.toXY(this._pending[0], this._pending[1]);
      kids.push(svgEl("circle", { cx: x, cy: y, r: 5, fill: "var(--error-color,#e53935)" }, []));
    }
    const s = svgEl("svg", { viewBox: `0 0 ${tf.W} ${tf.H}` }, kids);
    this._stage.innerHTML = "";
    this._stage.appendChild(s);
  }

  /* ---------- pointer interaction ---------- */

  _svgRect() {
    const s = this._stage.querySelector("svg");
    return s ? s.getBoundingClientRect() : null;
  }
  _clientToViewbox(cx, cy, tf, rect) {
    return [((cx - rect.left) / rect.width) * tf.W, ((cy - rect.top) / rect.height) * tf.H];
  }
  _screenOf(pt, tf, rect) {
    const [vx, vy] = tf.toXY(pt[0], pt[1]);
    return [rect.left + (vx / tf.W) * rect.width, rect.top + (vy / tf.H) * rect.height];
  }

  _hitTest(cx, cy, tf, rect) {
    const g = this._geom;
    // window endpoints first (highest priority)
    for (let i = 0; i < (g.windows || []).length; i++) {
      const w = g.windows[i];
      const e1 = this._screenOf([w.x1, w.y1], tf, rect);
      if (Math.hypot(cx - e1[0], cy - e1[1]) <= HIT_PX) return { kind: "win-end", wi: i, end: 1 };
      const e2 = this._screenOf([w.x2, w.y2], tf, rect);
      if (Math.hypot(cx - e2[0], cy - e2[1]) <= HIT_PX) return { kind: "win-end", wi: i, end: 2 };
    }
    // floor corners
    for (let i = 0; i < (g.floor || []).length; i++) {
      const h = this._screenOf(g.floor[i], tf, rect);
      if (Math.hypot(cx - h[0], cy - h[1]) <= HIT_PX) return { kind: "floor", idx: i };
    }
    // window bodies (translate whole window)
    for (let i = 0; i < (g.windows || []).length; i++) {
      const w = g.windows[i];
      const a = this._screenOf([w.x1, w.y1], tf, rect);
      const b = this._screenOf([w.x2, w.y2], tf, rect);
      if (distToSeg(cx, cy, a[0], a[1], b[0], b[1]) <= HIT_PX) return { kind: "win-body", wi: i };
    }
    return null;
  }

  _onPointerDown(e) {
    const rect = this._svgRect();
    if (!rect || !this._stageTf) return;
    // ignore presses in the card padding, outside the drawing itself
    if (e.clientX < rect.left || e.clientX > rect.right ||
        e.clientY < rect.top || e.clientY > rect.bottom) return;
    const tf = this._stageTf;
    const drag = this._hitTest(e.clientX, e.clientY, tf, rect);
    const downM = tf.toM(...this._clientToViewbox(e.clientX, e.clientY, tf, rect));
    if (drag && drag.kind === "win-body") {
      const w = this._geom.windows[drag.wi];
      drag.grab = downM;
      drag.o = { x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 };
    }
    this._ptr = { rect, tf, startX: e.clientX, startY: e.clientY, moved: false };
    this._drag = drag;
    window.addEventListener("pointermove", this._moveBound);
    window.addEventListener("pointerup", this._upBound);
    if (drag) e.preventDefault();
  }

  _onPointerMove(e) {
    if (!this._ptr) return;
    if (Math.hypot(e.clientX - this._ptr.startX, e.clientY - this._ptr.startY) > DRAG_PX) {
      this._ptr.moved = true;
    }
    if (this._drag && this._ptr.moved) {
      const m = this._ptr.tf.toM(...this._clientToViewbox(e.clientX, e.clientY, this._ptr.tf, this._ptr.rect));
      this._applyDrag(m);
      this._renderStage(this._ptr.tf); // frozen transform: no rescale mid-drag
      if (!this._dirty) this._markDirty();
    }
  }

  _onPointerUp(e) {
    window.removeEventListener("pointermove", this._moveBound);
    window.removeEventListener("pointerup", this._upBound);
    const ptr = this._ptr, drag = this._drag;
    this._ptr = null; this._drag = null;
    if (!ptr) return;
    if (drag && ptr.moved) {
      this._markDirty();
      this._renderStage();  // re-fit the view now the drag is done
      this._renderSide();
    } else if (!ptr.moved && !drag) {
      // a plain click on empty space → add via the current tool
      const m = ptr.tf.toM(...this._clientToViewbox(e.clientX, e.clientY, ptr.tf, ptr.rect));
      this._onClickAdd(m);
    }
  }

  _winAz(w) {
    const g = this._geom;
    const ref = (g.footprint && g.footprint.length >= 3) ? g.footprint : g.floor;
    if (!ref || ref.length < 3) return w.azimuth;
    return Math.round(segmentOutwardAzimuth([w.x1, w.y1], [w.x2, w.y2], ref) * 10) / 10;
  }

  _applyDrag(m) {
    const g = this._geom, d = this._drag;
    if (d.kind === "floor") {
      g.floor[d.idx] = [r2(m[0]), r2(m[1])];
    } else if (d.kind === "win-end") {
      let p = [m[0], m[1]];
      const snap = nearestOnPolygon(p, g.footprint);
      if (snap && snap.d <= SNAP_M) p = [snap.pt[0], snap.pt[1]];
      const w = g.windows[d.wi];
      if (d.end === 1) { w.x1 = r2(p[0]); w.y1 = r2(p[1]); }
      else { w.x2 = r2(p[0]); w.y2 = r2(p[1]); }
      w.azimuth = this._winAz(w);
    } else if (d.kind === "win-body") {
      const w = g.windows[d.wi];
      const dx = m[0] - d.grab[0], dy = m[1] - d.grab[1];
      w.x1 = r2(d.o.x1 + dx); w.y1 = r2(d.o.y1 + dy);
      w.x2 = r2(d.o.x2 + dx); w.y2 = r2(d.o.y2 + dy);
      w.azimuth = this._winAz(w);
    }
  }

  _onClickAdd(m) {
    const g = this._geom;
    if (this._tool === "floor") {
      g.floor.push([r2(m[0]), r2(m[1])]);
      this._markDirty();
    } else if (this._tool === "window") {
      let p = [m[0], m[1]];
      const snap = nearestOnPolygon(p, g.footprint);
      if (snap && snap.d <= SNAP_M) p = [snap.pt[0], snap.pt[1]];
      if (!this._pending) {
        this._pending = p;
      } else {
        const n = g.windows.length + 1;
        const w = {
          id: "w" + n + "_" + Date.now().toString(36), name: "Window " + n,
          x1: r2(this._pending[0]), y1: r2(this._pending[1]), x2: r2(p[0]), y2: r2(p[1]),
          azimuth: 180, tilt: 90, height: 2.0,
        };
        w.azimuth = this._winAz(w);
        g.windows.push(w);
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
        ? "Click to add floor corners. Drag any corner, window end, or window to adjust. Beams land on this floor."
        : "Click two points on a wall to place a window (snaps to the outline). Drag any corner, window end, or window to adjust."}</p>
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
    wl.querySelectorAll("input[data-i]").forEach((inp) =>
      inp.addEventListener("input", (e) => {
        g.windows[+e.target.dataset.i].name = e.target.value;
        this._markDirty();
        const st = this._side.querySelector("#sb-status");
        st.textContent = this._status; st.classList.add("dirty");
        this._side.querySelector("#sb-save").disabled = false;
      }));
    wl.querySelectorAll("button[data-del]").forEach((b) =>
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
      await this._hass.callWS({ type: "sun_beams/save_geometry", entry_id: this._entryId, geometry: this._geom });
      this._dirty = false;
      this._status = "Saved ✓  (sensors updated)";
      status.textContent = this._status;
    } catch (e) {
      this._status = "Save failed: " + (e.message || e);
      status.textContent = this._status; status.classList.add("dirty");
      btn.disabled = false;
    }
  }
}

customElements.define("sun-beams-panel", SunBeamsPanel);
console.info("%c SUN-BEAMS-PANEL %c 0.3.0 ", "background:#ff9800;color:#000", "");
