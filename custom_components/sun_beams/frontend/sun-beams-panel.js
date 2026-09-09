/*
 * Sun Beams setup panel — the integration-owned geometry editor.
 *
 * Full-page sidebar panel (registered by frontend.py via panel_custom) to draw
 * the interior floor and place windows on the OSM building outline. Geometry is
 * persisted to the config entry via sun_beams/save_geometry; the display card
 * only reads it. Dependency-free.
 *
 * Interaction:
 *   - Look around tool (default) : no click-to-add; just pan/zoom and drag
 *     handles. Wall (floor) corners snap onto the building outline within 0.1 m.
 *   - Draw floor tool : click empty space to extend the wall chain, or click on
 *     an existing wall to insert a corner there (a hollow dot previews where).
 *   - Add window tool : click two points on a wall to place a window.
 *   - Drag (any tool) : floor corners, window endpoints, and whole windows are
 *     draggable handles. Endpoint drags snap to the nearest building wall; a
 *     window's compass azimuth is recomputed from its wall as it moves.
 *   - Undo : snapshot-based; reverts the last add/delete/clear/drag, so a moved
 *     corner returns to its previous position.
 */

const SVGNS = "http://www.w3.org/2000/svg";
const D2R = Math.PI / 180;
const SNAP_M = 1.6;      // snap window points to a footprint wall within this many metres
const CORNER_SNAP_M = 0.1; // snap dragged floor (wall) corners onto the footprint outline within this many metres
const HIT_PX = 11;       // pointer hit-tolerance for handles, in screen pixels
const DRAG_PX = 3;       // movement beyond this counts as a drag, not a click
const VB = 640;          // svg viewBox size (square, world units)
const ZOOM_MIN = 0.25, ZOOM_MAX = 40, ZOOM_STEP = 1.25;
const SCALEBAR_PX = 130; // target on-screen length of the scale bar, in viewBox px

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
// unit direction vector of the polygon edge nearest to point p (closed polygon)
function nearestEdgeDir(p, poly) {
  if (!poly || poly.length < 2) return null;
  let best = null, bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const len2 = vx * vx + vy * vy || 1e-9;
    let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
    if (d < bestD) { bestD = d; const L = Math.hypot(vx, vy) || 1; best = [vx / L, vy / L]; }
  }
  return best;
}
function distToSeg(cx, cy, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy || 1e-9;
  let t = ((cx - ax) * vx + (cy - ay) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(cx - (ax + t * vx), cy - (ay + t * vy));
}
function r2(n) { return Math.round(n * 100) / 100; }
function segLen(a, b) { return Math.hypot(b[0] - a[0], b[1] - a[1]); }
function fmtLen(m) { return (m < 9.95 ? m.toFixed(1) : Math.round(m)) + " m"; }
// nearest 1/2/5 ×10ⁿ value not exceeding maxM (for the scale bar)
function niceLen(maxM) {
  const p = Math.pow(10, Math.floor(Math.log10(maxM || 1)));
  const n = (maxM || 1) / p;
  return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * p;
}
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
    this._tool = "select";  // default: look around (no click-to-add)
    this._undoStack = [];    // snapshots of {floor, windows} for undo
    this._pending = null;   // first click of a new window
    this._dirty = false;
    this._status = "";
    this._ptr = null;       // active pointer gesture
    this._drag = null;      // active drag descriptor
    this._stageTf = null;
    this._view = null;      // manual zoom/pan: null = auto-fit; else {scale0,cx,cy,zoom,pan}
    this._hoverM = null;    // cursor position in metres, for the live ruler
    this._shift = false;    // Shift held → lock the drawn segment to the wall / 90°
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
      // Spread first so fields the panel doesn't edit (building_height,
      // obstructions, osm_way_id) round-trip untouched through Save; then
      // override the arrays the editor actually mutates with fresh copies.
      this._geom = {
        ...g,
        footprint: g.footprint || [],
        origin: g.origin || {},
        floor: (g.floor || []).map((p) => [p[0], p[1]]),
        windows: (g.windows || []).map((w) => ({ ...w })),
      };
      this._dirty = false;
      this._status = "";
      this._undoStack = [];
    } catch (e) {
      this._geom = { footprint: [], origin: {}, floor: [], windows: [] };
      this._undoStack = [];
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
    // idle hover drives the live ruler; wheel zooms about the cursor
    this._stage.addEventListener("pointermove", (e) => this._onHoverMove(e));
    this._stage.addEventListener("pointerleave", () => {
      if (this._hoverM) { this._hoverM = null; if (this._rubberActive()) this._renderStage(); }
    });
    this._stage.addEventListener("wheel", (e) => {
      const rect = this._svgRect(); if (!rect || !this._stageTf) return;
      e.preventDefault();
      const [ax, ay] = this._clientToViewbox(e.clientX, e.clientY, this._stageTf, rect);
      this._zoomAbout(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, ax, ay);
    }, { passive: false });
    // Shift toggles the wall/90° lock; refresh the rubber-band as it changes
    const onShift = (e) => {
      if (e.shiftKey === this._shift) return;
      this._shift = e.shiftKey;
      if (this._rubberActive() && !this._ptr) this._renderStage();
    };
    window.addEventListener("keydown", onShift);
    window.addEventListener("keyup", onShift);
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

  // the content-fit base transform (zoom 1, no pan) that frames all geometry
  _fitBase() {
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
    const scale0 = (VB - 60) / (span + 2 * pad);
    return { scale0, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  }

  // once the user zooms/pans we freeze the current fit so the view stops
  // reflowing as points are added; Reset view clears it back to auto-fit.
  _ensureView() {
    if (!this._view) {
      const f = this._fitBase();
      this._view = { scale0: f.scale0, cx: f.cx, cy: f.cy, zoom: 1, pan: { x: 0, y: 0 } };
    }
    return this._view;
  }

  _transform() {
    const base = this._view || (() => {
      const f = this._fitBase();
      return { scale0: f.scale0, cx: f.cx, cy: f.cy, zoom: 1, pan: { x: 0, y: 0 } };
    })();
    const scale = base.scale0 * base.zoom;
    const px = base.pan.x, py = base.pan.y;
    const toXY = (x, y) => [VB / 2 + (x - base.cx) * scale + px, VB / 2 - (y - base.cy) * scale + py];
    const toM = (sx, sy) => [base.cx + (sx - VB / 2 - px) / scale, base.cy - (sy - VB / 2 - py) / scale];
    return { toXY, toM, W: VB, H: VB, scale };
  }

  // zoom about a viewBox anchor point, keeping the metre point under it fixed
  _zoomAbout(factor, ax, ay) {
    const v = this._ensureView();
    const tf = this._transform();
    const m = tf.toM(ax, ay);
    v.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v.zoom * factor));
    const scale = v.scale0 * v.zoom;
    v.pan.x = ax - VB / 2 - (m[0] - v.cx) * scale;
    v.pan.y = ay - VB / 2 + (m[1] - v.cy) * scale;
    this._renderStage();
  }

  // reference wall direction (unit vector) the Shift lock aligns to
  _lockRef(anchor) {
    const g = this._geom;
    if (this._tool === "floor" && g.floor.length >= 2) {
      const a = g.floor[g.floor.length - 2], b = g.floor[g.floor.length - 1];
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
      if (L > 1e-6) return [dx / L, dy / L];
    }
    return nearestEdgeDir(anchor, g.footprint) || [1, 0];
  }

  // project the cursor onto whichever of {along the wall, 90° to it} it's nearer
  _applyLock(anchor, cursor) {
    const ref = this._lockRef(anchor);
    const perp = [-ref[1], ref[0]];
    const vx = cursor[0] - anchor[0], vy = cursor[1] - anchor[1];
    const dPar = vx * ref[0] + vy * ref[1];
    const dPer = vx * perp[0] + vy * perp[1];
    const [u, d] = Math.abs(dPar) >= Math.abs(dPer) ? [ref, dPar] : [perp, dPer];
    return [anchor[0] + u[0] * d, anchor[1] + u[1] * d];
  }

  _rubberActive() {
    const g = this._geom;
    return !!(g && ((this._tool === "floor" && g.floor && g.floor.length >= 1) ||
                    (this._tool === "window" && this._pending)));
  }

  // a metre-length label centred on the screen midpoint of a metre segment
  _lenLabel(tf, a, b, opts) {
    opts = opts || {};
    const [x1, y1] = tf.toXY(a[0], a[1]);
    const [x2, y2] = tf.toXY(b[0], b[1]);
    const t = svgEl("text", {
      x: (x1 + x2) / 2, y: (y1 + y2) / 2 + (opts.dy || 0), "text-anchor": "middle",
      "font-size": 10.5, "font-weight": opts.strong ? 600 : 400,
      "paint-order": "stroke", stroke: "var(--card-background-color,#fff)", "stroke-width": 3,
      "stroke-linejoin": "round", fill: opts.fill || "var(--secondary-text-color,#607d8b)",
      "font-variant-numeric": "tabular-nums", style: "pointer-events:none",
    }, []);
    t.textContent = fmtLen(segLen(a, b));
    return t;
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
      // edge length labels (include the closing edge once it's a polygon)
      const nEdges = g.floor.length >= 3 ? g.floor.length : g.floor.length - 1;
      for (let i = 0; i < nEdges; i++) {
        kids.push(this._lenLabel(tf, g.floor[i], g.floor[(i + 1) % g.floor.length], { dy: -4 }));
      }
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
      kids.push(this._lenLabel(tf, [w.x1, w.y1], [w.x2, w.y2],
        { dy: 15, fill: "var(--accent-color,#ff9800)" }));
    });
    // pending first point of a new window
    if (this._pending) {
      const [x, y] = tf.toXY(this._pending[0], this._pending[1]);
      kids.push(svgEl("circle", { cx: x, cy: y, r: 5, fill: "var(--error-color,#e53935)" }, []));
    }
    // live ruler: rubber-band from the last placed point to the cursor — but in
    // Draw-floor mode hovering over an existing wall, show an insertion marker
    // (a hollow dot on the wall) instead: the click will splice a corner there.
    const insHover = (this._hoverM && this._tool === "floor" && !this._ptr)
      ? this._hitFloorEdge(this._hoverM) : null;
    if (insHover) {
      const [ix, iy] = tf.toXY(insHover.pt[0], insHover.pt[1]);
      kids.push(svgEl("circle", {
        cx: ix, cy: iy, r: 5, fill: "var(--card-background-color,#fff)",
        stroke: "var(--primary-color,#03a9f4)", "stroke-width": 2,
        style: "pointer-events:none",
      }, []));
    } else if (this._hoverM && this._rubberActive() && !this._ptr) {
      let anchor, to = this._hoverM;
      anchor = this._tool === "window" ? this._pending : g.floor[g.floor.length - 1];
      if (this._shift) {
        to = this._applyLock(anchor, to);                 // Shift: lock along/perp to the wall
      } else if (this._tool === "window") {
        const snap = nearestOnPolygon(to, g.footprint);   // preview the same snap a click gets
        if (snap && snap.d <= SNAP_M) to = snap.pt;
      }
      const [ax, ay] = tf.toXY(anchor[0], anchor[1]);
      const [bx, by] = tf.toXY(to[0], to[1]);
      kids.push(svgEl("line", {
        x1: ax, y1: ay, x2: bx, y2: by, stroke: "var(--primary-color,#03a9f4)",
        "stroke-width": 1.5, "stroke-dasharray": "4 4", style: "pointer-events:none",
      }, []));
      kids.push(this._lenLabel(tf, anchor, to,
        { dy: -6, strong: true, fill: "var(--primary-color,#0277bd)" }));
    }
    // scale bar (bottom-left, in fixed viewBox coords)
    const barM = niceLen(SCALEBAR_PX / tf.scale);
    const barPx = barM * tf.scale;
    const bx0 = 18, by0 = tf.H - 22;
    kids.push(svgEl("line", { x1: bx0, y1: by0, x2: bx0 + barPx, y2: by0,
      stroke: "var(--primary-text-color,#455a64)", "stroke-width": 2, style: "pointer-events:none" }, []));
    for (const tx of [bx0, bx0 + barPx]) {
      kids.push(svgEl("line", { x1: tx, y1: by0 - 4, x2: tx, y2: by0 + 4,
        stroke: "var(--primary-text-color,#455a64)", "stroke-width": 2, style: "pointer-events:none" }, []));
    }
    const barLbl = svgEl("text", { x: bx0 + barPx / 2, y: by0 - 7, "text-anchor": "middle",
      "font-size": 11, "paint-order": "stroke", stroke: "var(--card-background-color,#fff)",
      "stroke-width": 3, "stroke-linejoin": "round", fill: "var(--primary-text-color,#455a64)",
      "font-variant-numeric": "tabular-nums", style: "pointer-events:none" }, []);
    barLbl.textContent = fmtLen(barM);
    kids.push(barLbl);

    const s = svgEl("svg", { viewBox: `0 0 ${tf.W} ${tf.H}`,
      style: `cursor:${this._tool === "select" ? "default" : "crosshair"}` }, kids);
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

  // In Draw-floor mode, find the floor edge (wall) a metre-point `m` lands on so
  // a new corner can be *inserted* there instead of appended to the chain end.
  // Returns { i, pt } — insert after floor[i]; pt is the click projected onto
  // the wall so the new corner starts collinear — or null if not near any edge.
  _hitFloorEdge(m) {
    const g = this._geom, tf = this._stageTf, rect = this._svgRect();
    if (!tf || !rect || !g.floor || g.floor.length < 2) return null;
    const n = g.floor.length, nEdges = n >= 3 ? n : n - 1;
    const c = this._screenOf(m, tf, rect);
    let best = null, bestD = HIT_PX;
    for (let i = 0; i < nEdges; i++) {
      const a = g.floor[i], b = g.floor[(i + 1) % n];
      const as = this._screenOf(a, tf, rect), bs = this._screenOf(b, tf, rect);
      const d = distToSeg(c[0], c[1], as[0], as[1], bs[0], bs[1]);
      if (d < bestD) {
        bestD = d;
        const vx = b[0] - a[0], vy = b[1] - a[1];
        const len2 = vx * vx + vy * vy;
        let t = len2 ? ((m[0] - a[0]) * vx + (m[1] - a[1]) * vy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        best = { i, pt: [a[0] + t * vx, a[1] + t * vy] };
      }
    }
    return best;
  }

  // idle cursor tracking (no button) → live ruler rubber-band
  _onHoverMove(e) {
    if (this._ptr) return;            // an active gesture handles its own moves
    if (!this._rubberActive()) { if (this._hoverM) this._hoverM = null; return; }
    const rect = this._svgRect(), tf = this._stageTf;
    if (!rect || !tf) return;
    if (e.clientX < rect.left || e.clientX > rect.right ||
        e.clientY < rect.top || e.clientY > rect.bottom) return;
    this._shift = e.shiftKey;
    this._hoverM = tf.toM(...this._clientToViewbox(e.clientX, e.clientY, tf, rect));
    this._renderStage();
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
    this._ptr = { rect, tf, startX: e.clientX, startY: e.clientY,
                  lastX: e.clientX, lastY: e.clientY, moved: false };
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
      if (!this._ptr.undoPushed) { this._pushUndo(); this._ptr.undoPushed = true; }
      const m = this._ptr.tf.toM(...this._clientToViewbox(e.clientX, e.clientY, this._ptr.tf, this._ptr.rect));
      this._applyDrag(m);
      this._renderStage(this._ptr.tf); // frozen transform: no rescale mid-drag
      if (!this._dirty) this._markDirty();
    } else if (!this._drag && this._ptr.moved) {
      // drag on empty canvas → pan the view (a click without motion still adds a point)
      const v = this._ensureView();
      const k = this._ptr.tf.W / this._ptr.rect.width; // client px → viewBox px
      v.pan.x += (e.clientX - this._ptr.lastX) * k;
      v.pan.y += (e.clientY - this._ptr.lastY) * k;
      this._ptr.lastX = e.clientX; this._ptr.lastY = e.clientY;
      this._renderStage();
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
      this._shift = e.shiftKey;
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
      let p = [m[0], m[1]];
      const snap = nearestOnPolygon(p, g.footprint);   // lock wall corners onto the building outline
      if (snap && snap.d <= CORNER_SNAP_M) p = [snap.pt[0], snap.pt[1]];
      g.floor[d.idx] = [r2(p[0]), r2(p[1])];
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
    if (this._tool === "select") return;   // look-around: no click-to-add
    if (this._tool === "floor") {
      const ins = this._hitFloorEdge(m);
      if (ins) {
        // click landed on an existing wall → split it (insert a corner there)
        this._pushUndo();
        g.floor.splice(ins.i + 1, 0, [r2(ins.pt[0]), r2(ins.pt[1])]);
        this._markDirty();
      } else {
        let p = [m[0], m[1]];
        if (this._shift && g.floor.length >= 1) p = this._applyLock(g.floor[g.floor.length - 1], p);
        this._pushUndo();
        g.floor.push([r2(p[0]), r2(p[1])]);
        this._markDirty();
      }
    } else if (this._tool === "window") {
      let p = [m[0], m[1]];
      if (this._pending && this._shift) {
        p = this._applyLock(this._pending, p);          // Shift overrides the wall-proximity snap
      } else {
        const snap = nearestOnPolygon(p, g.footprint);
        if (snap && snap.d <= SNAP_M) p = [snap.pt[0], snap.pt[1]];
      }
      if (!this._pending) {
        this._pending = p;
      } else {
        this._pushUndo();
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
        <button data-tool="select" class="${this._tool === "select" ? "active" : ""}">Look around</button>
        <button data-tool="floor" class="${this._tool === "floor" ? "active" : ""}">Draw floor</button>
        <button data-tool="window" class="${this._tool === "window" ? "active" : ""}">Add window</button>
        <button data-act="undo" ${this._undoStack.length || this._pending ? "" : "disabled"}>Undo</button>
        <button data-act="clearfloor">Clear floor</button>
      </div>
      <h2>View</h2>
      <div class="sb-tools">
        <button data-act="zoomout" title="Zoom out">−</button>
        <button data-act="zoomin" title="Zoom in">＋</button>
        <button data-act="resetview">Reset view</button>
      </div>
      <h2>Surroundings</h2>
      <div class="sb-tools">
        <button data-act="refresh">Refresh from OSM</button>
      </div>
      <p class="instr">Loads neighbouring buildings + heights so windows can be shadowed by them
        (and by this building's own shape). <b>${(g.obstructions || []).length}</b> loaded${
          g.building_height ? `, this building ${g.building_height} m` : ""}. Click <b>Save</b> after refreshing.</p>
      <p class="instr">${this._tool === "select"
        ? "Drag any wall corner, window end, or window to adjust. Wall corners snap onto the building outline within 0.1 m. Undo reverts the last move."
        : this._tool === "floor"
        ? "Click to add floor corners. Drag any corner, window end, or window to adjust. Beams land on this floor."
        : "Click two points on a wall to place a window (snaps to the outline). Drag any corner, window end, or window to adjust."}
        ${this._tool === "select" ? "" : "<br>Hold <b>Shift</b> to lock the segment along the wall or square to it (90°)."}
        <br>Scroll to zoom about the cursor; drag empty space to pan. Lengths are in metres.</p>
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
      if (g.floor.length) { this._pushUndo(); g.floor = []; this._markDirty(); this._renderStage(); this._renderSide(); }
    });
    this._side.querySelector('[data-act="zoomin"]').addEventListener("click", () => this._zoomAbout(ZOOM_STEP, VB / 2, VB / 2));
    this._side.querySelector('[data-act="zoomout"]').addEventListener("click", () => this._zoomAbout(1 / ZOOM_STEP, VB / 2, VB / 2));
    this._side.querySelector('[data-act="resetview"]').addEventListener("click", () => { this._view = null; this._renderStage(); });
    this._side.querySelector('[data-act="refresh"]').addEventListener("click", () => this._refresh());
    wl.querySelectorAll("input[data-i]").forEach((inp) =>
      inp.addEventListener("input", (e) => {
        g.windows[+e.target.dataset.i].name = e.target.value;
        this._markDirty();
        const st = this._side.querySelector("#sb-status");
        st.textContent = this._status; st.classList.add("dirty");
        this._side.querySelector("#sb-save").disabled = false;
      }));
    wl.querySelectorAll("button[data-del]").forEach((b) =>
      b.addEventListener("click", () => { this._pushUndo(); g.windows.splice(+b.dataset.del, 1); this._markDirty(); this._renderStage(); this._renderSide(); }));
    this._side.querySelector("#sb-save").addEventListener("click", () => this._save());
  }

  // snapshot the mutable geometry (floor + windows) before a change, for undo
  _pushUndo() {
    const g = this._geom;
    this._undoStack.push({
      floor: g.floor.map((p) => [p[0], p[1]]),
      windows: g.windows.map((w) => ({ ...w })),
    });
    if (this._undoStack.length > 100) this._undoStack.shift();
  }

  _undo() {
    // an in-progress window (one point placed) undoes to nothing on the stack
    if (this._pending) { this._pending = null; this._renderStage(); this._renderSide(); return; }
    if (!this._undoStack.length) return;
    const s = this._undoStack.pop();
    this._geom.floor = s.floor.map((p) => [p[0], p[1]]);
    this._geom.windows = s.windows.map((w) => ({ ...w }));
    this._markDirty();
    this._renderStage();
    this._renderSide();
  }

  // Fetch neighbour buildings + heights from OSM (about the entry's existing
  // origin) and merge them into the in-memory geometry, then mark dirty so the
  // normal Save persists them. Fetch-only server-side: no reload, so this never
  // clobbers an in-progress drawing.
  async _refresh() {
    const status = this._side.querySelector("#sb-status");
    status.textContent = "Fetching surroundings from OSM…"; status.classList.remove("dirty");
    try {
      const res = await this._hass.callWS({ type: "sun_beams/refresh_geometry", entry_id: this._entryId });
      this._geom.obstructions = res.obstructions || [];
      this._geom.building_height = res.building_height;
      this._markDirty();
      this._status = `Loaded ${this._geom.obstructions.length} neighbour building(s); ` +
        `this building ${res.building_height} m. Click Save to apply.`;
      this._renderSide();
    } catch (e) {
      this._status = "Refresh failed: " + (e.message || e);
      status.textContent = this._status; status.classList.add("dirty");
    }
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
console.info("%c SUN-BEAMS-PANEL %c 0.8.0 ", "background:#ff9800;color:#000", "");
