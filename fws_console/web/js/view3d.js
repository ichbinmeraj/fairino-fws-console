// A dependency-free 3D arm view on a 2D canvas.
//
// No Three.js: the console must work on an air-gapped cell with no CDN, and
// an orbiting camera over five line segments does not need a scene graph.
// Everything here is a projection, a depth sort and a stroke.

const RAD = Math.PI / 180;
const AXIS_COLORS = ['#ff5d5d', '#54d17a', '#5aa2ff'];

/**
 * Per-face unit normals in the link frame, smoothed once at load: the 6 mm
 * vertex clustering that decimated the meshes leaves the surface rough, and
 * raw facet normals shade it as glitter. Each face's normal is averaged with
 * vertex-adjacent neighbours over two passes, skipping neighbours across a
 * crease (dot < 0.4) so cylinder rims stay sharp. Returns Float32Array, 3
 * per face; orientation is unified against the raw geometric normal so a
 * flipped triangle in the source STL cannot flip the average.
 */
function smoothNormals(v, f) {
  const nFaces = f.length / 3;
  const raw = new Float32Array(nFaces * 3);
  const vertFaces = new Array(v.length / 3);

  for (let i = 0, fi = 0; i < f.length; i += 3, fi++) {
    const a = f[i] * 3, b = f[i + 1] * 3, c = f[i + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
    const qx = v[c] - v[a], qy = v[c + 1] - v[a + 1], qz = v[c + 2] - v[a + 2];
    let nx = uy * qz - uz * qy, ny = uz * qx - ux * qz, nz = ux * qy - uy * qx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    raw[fi * 3] = nx / nl; raw[fi * 3 + 1] = ny / nl; raw[fi * 3 + 2] = nz / nl;
    for (const k of [f[i], f[i + 1], f[i + 2]]) {
      (vertFaces[k] || (vertFaces[k] = [])).push(fi);
    }
  }

  let cur = raw;
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float32Array(nFaces * 3);
    for (let i = 0, fi = 0; i < f.length; i += 3, fi++) {
      const ox = cur[fi * 3], oy = cur[fi * 3 + 1], oz = cur[fi * 3 + 2];
      let sx = ox, sy = oy, sz = oz;
      for (const k of [f[i], f[i + 1], f[i + 2]]) {
        for (const nf of vertFaces[k]) {
          if (nf === fi) continue;
          let px = cur[nf * 3], py = cur[nf * 3 + 1], pz = cur[nf * 3 + 2];
          let d = ox * px + oy * py + oz * pz;
          if (d < 0) { px = -px; py = -py; pz = -pz; d = -d; }  // winding-safe
          if (d < 0.4) continue;                                // crease
          sx += px; sy += py; sz += pz;
        }
      }
      const sl = Math.hypot(sx, sy, sz) || 1;
      next[fi * 3] = sx / sl; next[fi * 3 + 1] = sy / sl; next[fi * 3 + 2] = sz / sl;
    }
    cur = next;
  }
  return cur;
}

export class View3D {
  constructor(canvas) {
    this.c = canvas;
    this.yaw = -35 * RAD;
    this.pitch = 22 * RAD;
    this.dist = 2100;
    this.points = null;
    this.model = null;
    this.frames = null;   // per-link {R, p} world transforms, for meshes
    this.meshes = null;   // per-link {v: Float64Array, f: Uint16Array}
    this.trail = [];
    this.zc = 0;      // vertical centre, follows the pose (smoothed)

    // Offload rendering to a worker when the browser can: the page thread
    // then never rasterises a triangle, so jog buttons, charts and DOM
    // updates stop competing with the stage. Same painter code either way.
    this.worker = null;
    // Only take the worker path when we can transfer ALL THREE layers, and
    // only transfer once every element is confirmed — a transfer that
    // succeeds on the main canvas and then throws on a sibling would leave
    // the main canvas both un-contextable and un-drawable, bricking the
    // stage. Checking first keeps the 2D fallback intact on any failure.
    const backEl = document.getElementById('view-back');
    const glEl = document.getElementById('view-gl');
    let transferred = false;
    if ('transferControlToOffscreen' in canvas && typeof Worker === 'function'
        && backEl && glEl) {
      try {
        this.worker = new Worker('js/stage-worker.js', { type: 'module' });
        // A worker that fails to load, or throws, must not leave a silently
        // blank stage — surface it and drop the layer from view.
        this.worker.onerror = (e) => {
          const ov = document.getElementById('stage-scrim');
          if (ov) {
            ov.hidden = false;
            ov.textContent = '3D view unavailable (worker error)';
          }
          try { this.worker.terminate(); } catch { /* already gone */ }
        };
        // postMessage from a worker does NOT fire worker.onerror — without
        // this handler the worker's own error reports (and its gl/2d mode
        // report) were dropped on the floor and a painter crash froze the
        // stage silently.
        this.worker.onmessage = (e) => {
          const m = e.data || {};
          if (m.type === 'error') {
            const ov = document.getElementById('stage-scrim');
            if (ov) {
              ov.hidden = false;
              ov.textContent = `3D view error: ${m.message || 'render failed'}`;
            }
          } else if (m.type === 'mode') {
            this.glMode = Boolean(m.gl);   // false = compatibility rendering
          }
        };
        const offMain = canvas.transferControlToOffscreen();
        transferred = true;
        const offBack = backEl.transferControlToOffscreen();
        const offGl = glEl.transferControlToOffscreen();
        this.worker.postMessage(
          { type: 'layers', mainCanvas: offMain, backCanvas: offBack, glCanvas: offGl },
          [offMain, offBack, offGl]);
      } catch {
        try { this.worker.terminate(); } catch { /* ignore */ }
        this.worker = null;
      }
    }
    // getContext must come AFTER the transfer attempt: a canvas with a 2D
    // context can no longer be transferred. If a transfer half-completed the
    // main canvas is dead either way; leave ctx null and the worker.onerror /
    // scrim covers it.
    this.ctx = (this.worker || transferred) ? null : canvas.getContext('2d');

    this._bindOrbit();
    this._resize();
    new ResizeObserver(() => this._resize()).observe(canvas);
    // A pure devicePixelRatio change (window dragged to another monitor,
    // browser zoom) does not fire the ResizeObserver; re-arm a one-shot
    // media query at each current DPR.
    const armDpr = () => {
      matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
        .addEventListener('change', () => { this._resize(); armDpr(); },
          { once: true });
    };
    armDpr();
  }

  _post(msg) { this.worker.postMessage(msg); }

  _camera() {
    this._post({ type: 'camera', yaw: this.yaw, pitch: this.pitch,
                 dist: this.dist });
  }

  /** Coalesce redraw requests to one paint per display frame. Purely a
   * scheduling change: what gets painted, and how the drag responds, is
   * untouched. */
  _schedule() {
    if (this.worker) {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = 0; this._camera(); });
      return;
    }
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); });
  }

  _resize() {
    // The worker gets the true DPR (capped at 2 for sanity) and decides per
    // layer: the GL arm and thin 2D line layers are nearly free at native
    // DPR, while its CPU full painter keeps the 1.5 cap. The in-page
    // fallback IS the CPU painter, so it keeps 1.5 here.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.c.getBoundingClientRect();
    this.w = r.width;
    this.h = r.height;
    if (this.worker) {
      this._post({ type: 'resize', w: this.w, h: this.h, dpr });
      return;
    }
    const cpu = Math.min(dpr, 1.5);
    this.c.width = Math.max(1, Math.round(r.width * cpu));
    this.c.height = Math.max(1, Math.round(r.height * cpu));
    this.ctx.setTransform(cpu, 0, 0, cpu, 0, 0);
    this.draw();
  }

  _bindOrbit() {
    // Pointer-events orbit with two-pointer pinch zoom for touch.
    const active = new Map();
    let pinchDist = 0;

    this.c.addEventListener('pointerdown', (e) => {
      // A grab has full authority: kill any preset fly-to instantly so the
      // tween can never fight the (frozen) drag mapping.
      if (this._flyCancel) this._flyCancel();
      this.c.setPointerCapture(e.pointerId);
      if (this.onGrab) this.onGrab();
      active.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (active.size === 2) {
        const [a, b] = [...active.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    const end = (e) => { active.delete(e.pointerId); };
    this.c.addEventListener('pointerup', end);
    this.c.addEventListener('pointercancel', end);

    this.c.addEventListener('pointermove', (e) => {
      const prev = active.get(e.pointerId);
      if (!prev) return;
      if (active.size === 1) {
        this.yaw += (e.clientX - prev.x) * 0.01;
        this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch + (e.clientY - prev.y) * 0.01));
      }
      active.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (active.size === 2) {
        const [a, b] = [...active.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist > 0) {
          this.dist = Math.max(700, Math.min(5000, this.dist * pinchDist / d));
        }
        pinchDist = d;
      }
      this._schedule();
    });

    this.c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.dist = Math.max(700, Math.min(5000, this.dist * (1 + Math.sign(e.deltaY) * 0.12)));
      this._schedule();
    }, { passive: false });
  }

  /** Fixed viewpoints, cockpit-style: each flies to a framed view. */
  preset(name) {
    const views = {
      iso: [-35, 22], front: [90, 10], back: [-90, 10],
      left: [0, 10], right: [180, 10], top: [-35, 78],
    };
    const [yawDeg, pitchDeg] = views[name] || views.iso;
    // Solve the framing AT the target orbit (solving at iso and then
    // swinging the camera left front/top views misframed).
    const t = this._solveFit(yawDeg * RAD, pitchDeg * RAD);
    this._flyTo(t);
  }

  /** Frame the whole arm at the home (iso) orbit. */
  fit() {
    this._flyTo(this._solveFit(-35 * RAD, 22 * RAD));
  }

  /** Solve zc + camera distance so every point of the pose fits on screen
   * with a margin at the GIVEN orbit — projected, not guessed from a
   * bounding sphere. Pure: does not disturb the live camera. */
  _solveFit(yaw, pitch) {
    const saved = [this.yaw, this.pitch, this.dist, this.zc];
    this.yaw = yaw;
    this.pitch = pitch;
    let dist = 2100;
    let zc = this.zc;
    if (this.points && this.points.length) {
      const zs = this.points.map((p) => p[2]).concat([0]);
      zc = (Math.min(...zs) + Math.max(...zs)) / 2;
      this.zc = zc;
      this.dist = 2000;
      for (let pass = 0; pass < 3; pass++) {
        let worst = 0;
        for (const p of this.points.concat([[0, 0, 0]])) {
          const [sx, sy] = this.project(p);
          // 0.32, not 0.40: the solve bounds JOINT POINTS, but the meshes
          // extend beyond them (the tool most of all) — at 0.40 a front
          // view cropped the tool at the frame edge.
          worst = Math.max(worst,
            Math.abs(sx - this.w / 2) / (this.w * 0.32),
            Math.abs(sy - this.h / 2) / (this.h * 0.32));
        }
        if (worst < 1e-6) break;
        this.dist = Math.max(700, Math.min(5000, this.dist * worst));
      }
      dist = this.dist;
    }
    [this.yaw, this.pitch, this.dist, this.zc] = saved;
    return { yaw, pitch, dist, zc };
  }

  _applyCamera() {
    if (this.worker) {
      this._post({ type: 'camera', yaw: this.yaw, pitch: this.pitch,
                   dist: this.dist, zc: this.zc });
      return;
    }
    this.draw();
  }

  /** Ease the camera to a target over ~250 ms. Camera state only — the
   * pointer-drag mapping is untouched, and a grab cancels the tween
   * immediately (see pointerdown). Honors prefers-reduced-motion. */
  _flyTo(t) {
    if (this._flyCancel) this._flyCancel();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.yaw = t.yaw; this.pitch = t.pitch;
      this.dist = t.dist; this.zc = t.zc;
      this._applyCamera();
      return;
    }
    const s = { yaw: this.yaw, pitch: this.pitch, dist: this.dist, zc: this.zc };
    // Shortest yaw path so LEFT -> RIGHT swings 180°, not 340°.
    const TAU = Math.PI * 2;
    const dyaw = ((t.yaw - s.yaw + Math.PI) % TAU + TAU) % TAU - Math.PI;
    const t0 = performance.now();
    const DUR = 250;
    let raf = 0;
    this._flyCancel = () => { cancelAnimationFrame(raf); this._flyCancel = null; };
    const tick = (now) => {
      const u = Math.min(1, (now - t0) / DUR);
      const e = 1 - (1 - u) ** 3;              // easeOutCubic
      this.yaw = s.yaw + dyaw * e;
      this.pitch = s.pitch + (t.pitch - s.pitch) * e;
      this.dist = s.dist + (t.dist - s.dist) * e;
      this.zc = s.zc + (t.zc - s.zc) * e;
      this._applyCamera();
      if (u < 1) raf = requestAnimationFrame(tick);
      else this._flyCancel = null;
    };
    raf = requestAnimationFrame(tick);
  }

  /** Show (or clear, with null) a simulated pose — drawn as a translucent
   * dashed skeleton labelled SIM, never mistakable for the live arm. */
  setGhost(points) {
    const g = Array.isArray(points) && points.length ? points : null;
    if (this.worker) { this._post({ type: 'ghost', points: g }); return; }
    this._ghost = g;
    this.draw();
  }

  /** Tint the link (and ring the joint) a jog control is about to drive;
   * -1 clears. */
  highlightJoint(i) {
    const link = Number.isInteger(i) ? i : -1;
    if (this._hl === link) return;
    this._hl = link;
    if (this.worker) { this._post({ type: 'highlight', link }); return; }
    this.draw();
  }

  /** World (mm, z up) -> screen. Returns [x, y, depth]. */
  project(p) {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);

    // Yaw about z, then pitch, into a camera frame looking down -y.
    const x1 = p[0] * cy - p[1] * sy;
    const y1 = p[0] * sy + p[1] * cy;
    const z1 = p[2] - this.zc;             // centre on the arm, wherever it is

    const y2 = y1 * cp - z1 * sp;          // depth toward the camera
    const z2 = y1 * sp + z1 * cp;

    // Simple pinhole: focal length in px over camera distance in mm. Wheel
    // zoom changes dist; y2 gives per-point perspective.
    const f = Math.min(this.w, this.h) * 2.2;
    const den = this.dist + y2;
    const s = f / (den < 80 ? 80 : den);   // near-plane clamp: no sign flip

    return [this.w / 2 + x1 * s, this.h / 2 - z2 * s, y2];
  }

  /**
   * Load per-link meshes: {linkName: {v: [[x,y,z],...], f: [[a,b,c],...]}},
   * in link-frame mm. Flattened to typed arrays once, here, not per frame.
   */
  setMeshes(data, linkNames) {
    if (this.worker) {
      this._post({ type: 'meshes', data, links: linkNames });
      this.meshes = true;   // truthy: "meshes are in play" for callers
      return;
    }
    this.meshes = linkNames.map((name) => {
      const m = data[name];
      if (!m) return null;
      const v = new Float64Array(m.v.length * 3);
      m.v.forEach((p, i) => { v[i * 3] = p[0]; v[i * 3 + 1] = p[1]; v[i * 3 + 2] = p[2]; });
      const f = new Uint32Array(m.f.length * 3);
      m.f.forEach((t, i) => { f[i * 3] = t[0]; f[i * 3 + 1] = t[1]; f[i * 3 + 2] = t[2]; });
      return {
        v, f,
        fn: smoothNormals(v, f),
        proj: new Float64Array(v.length),
      };
    });
    // Per-frame face buffers, sized once to the worst case (every face
    // front-facing) and never reallocated.
    const total = this.meshes.reduce((s, m) => s + (m ? m.f.length / 3 : 0), 0);
    this._fb = {
      depth: new Float32Array(total),
      xy: new Float32Array(total * 6),
      lut: new Uint8Array(total),
      order: new Uint32Array(total),
    };
    this.draw();
  }

  setPose(points, model, frames) {
    this.points = points;
    this.model = model;
    this.frames = frames || null;
    if (this.worker) {
      if (points) {
        // Mirror the worker's easing so fit() frames from the same centre.
        let zlo = 0, zhi = 0;
        for (const q of points) {
          if (q[2] < zlo) zlo = q[2]; if (q[2] > zhi) zhi = q[2];
        }
        const dz = (zlo + zhi) / 2 - this.zc;
        this.zc += Math.abs(dz) < 0.05 ? dz : dz * 0.08;
      }
      this._post({
        type: 'pose', points, frames,
        model: model ? { reach: model.reach } : null,
      });
      return;
    }
    if (points) {
      // Follow the arm vertically, slowly, so the view neither jumps per
      // frame nor loses an arm working entirely below the base plane.
      const zs = points.map((p) => p[2]).concat([0]);   // keep the grid in view
      const target = (Math.min(...zs) + Math.max(...zs)) / 2;
      // Ease exactly as before, but snap the last 0.05 mm: an asymptote
      // that never lands keeps every parked frame "different" and defeats
      // the identical-frame skip below.
      const dz = target - this.zc;
      this.zc += Math.abs(dz) < 0.05 ? dz : dz * 0.08;
      const tip = points[points.length - 1];
      const last = this.trail[this.trail.length - 1];
      if (!last || Math.hypot(tip[0] - last[0], tip[1] - last[1], tip[2] - last[2]) > 3) {
        this.trail.push([...tip]);
        if (this.trail.length > 240) this.trail.shift();
      }
    }
    this.draw();
  }

  clearTrail() {
    if (this.worker) { this._post({ type: 'clearTrail' }); return; }
    this.trail = [];
    this.draw();
  }

  /** Resolve theme tokens on the page (workers cannot read CSS) and ship
   * them across. Also called at boot and on resize. */
  syncTheme() {
    if (!this.worker) return;
    this._post({
      type: 'theme',
      theme: {
        dark: this._isDark(),
        line: this._css('--line', '#21272e'),
        line2: this._css('--line-2', '#313941'),
        dim: this._css('--dim', '#9299a1'),
        text: this._css('--text', '#e5e8ec'),
        accent: this._css('--accent', '#3f9fe8'),
        data: this._css('--data', '#0ca3be'),
      },
    });
  }

  _css(name, fallback) {
    const v = getComputedStyle(this.c).getPropertyValue(name).trim();
    return v || fallback;
  }

  /** Resolved theme colors, cached: getComputedStyle at 10 Hz forces style
   * recalc right after the tables mutate the DOM. invalidateTheme() on a
   * theme switch. */
  _theme() {
    if (this._pal) return this._pal;
    this._pal = {
      line: this._css('--line', '#21272e'),
      line2: this._css('--line-2', '#313941'),
      dim: this._css('--dim', '#9299a1'),
      text: this._css('--text', '#e5e8ec'),
      accent: this._css('--accent', '#3f9fe8'),
      data: this._css('--data', '#0ca3be'),
      ok: this._css('--ok', '#43c07a'),
    };
    return this._pal;
  }

  invalidateTheme() {
    this._pal = null;
    if (this.worker) { this.syncTheme(); return; }
    this.draw();
  }

  draw() {
    if (this.worker) { this._schedule(); return; }
    const g = this.ctx;
    if (!g || !this.w) return;

    // Telemetry arrives at 10 Hz whether or not the arm moves; a parked arm
    // re-renders identically, so skip the frame when nothing changed.
    // Quantised to 0.1 mm: real encoders jitter a few micrometres between
    // frames, so bit-exact comparison never matches on live hardware even
    // with the arm parked. 0.1 mm is far below a pixel at stage scale.
    let ph = 0;
    if (this.points) {
      for (let i = 0; i < this.points.length; i++) {
        const p = this.points[i];
        ph += Math.round(p[0] * 10) * (i * 3 + 1)
            + Math.round(p[1] * 10) * (i * 3 + 2)
            + Math.round(p[2] * 10) * (i * 3 + 3);
      }
    }
    const sig = `${this.yaw},${this.pitch},${this.dist},${this.zc.toFixed(1)},${this.w},`
      + `${this.h},${!this.points},${ph},${this.trail.length},`
      + `${this.meshes ? 1 : 0},${this._isDark()},${this._hl ?? -1},`
      + `${this._ghost ? this._ghost[this._ghost.length - 1].map(Math.round) : 'g0'}`;
    if (sig === this._sig) return;
    this._sig = sig;

    g.clearRect(0, 0, this.w, this.h);

    const { line, line2, dim, text, accent, data, ok } = this._theme();

    this._grid(g, line, line2);
    this._originMarker(g);
    this._shadows(g);

    if (!this.points) {
      g.fillStyle = dim;
      g.font = '13px system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText('waiting for telemetry…', this.w / 2, this.h / 2);
      return;
    }

    // Reach envelope, so an operator can see how close to the edge they are.
    if (this.model && this.model.reach) this._envelope(g, line);

    this._trail(g, accent);

    if (this.meshes && this.frames) {
      this._drawMeshes(g);
    } else {
      this._drawSkeleton(g, line2, dim, text, accent, data);
    }

    this._drawGhost(g, accent);
    this._tcpMarkers(g, dim);
    this._ring(g, accent);
    this._gizmo(g);
  }

  _drawGhost(g, accent) {
    const gh = this._ghost;
    if (!gh || gh.length < 2) return;
    const proj = gh.map((p) => this.project(p));
    g.strokeStyle = accent;
    g.globalAlpha = 0.5;
    g.lineWidth = 4;
    g.lineCap = 'round';
    g.setLineDash([7, 5]);
    g.beginPath();
    for (let i = 0; i < proj.length; i++) {
      const p = proj[i];
      if (this._clipped(p)) continue;
      i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]);
    }
    g.stroke();
    g.setLineDash([]);
    g.lineWidth = 1.8;
    for (let i = 0; i < proj.length; i++) {
      const p = proj[i];
      if (this._clipped(p)) continue;
      g.beginPath();
      g.arc(p[0], p[1], i === proj.length - 1 ? 6 : 4.5, 0, Math.PI * 2);
      g.stroke();
    }
    const tip = proj[proj.length - 1];
    if (!this._clipped(tip)) {
      g.font = '10px ui-monospace, monospace';
      g.fillStyle = accent;
      g.fillText('SIM', tip[0] + 9, tip[1] - 8);
    }
    g.globalAlpha = 1;
  }

  /** Near-plane test for the 2D paths (mirrors the worker). */
  _clipped(p) { return this.dist + p[2] < 80; }

  _keyLight() {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const l0x = -0.42, l0y = 0.32;
    return [l0x * cy + l0y * sy, -l0x * sy + l0y * cy, 0.85];
  }

  _shadows(g) {
    if (!this.points) return;
    const pts = this.points;
    const spots = [];
    for (let i = 0; i < pts.length; i++) {
      spots.push(pts[i]);
      if (i < pts.length - 1) {
        const q = pts[i + 1];
        spots.push([(pts[i][0] + q[0]) / 2, (pts[i][1] + q[1]) / 2,
                    (pts[i][2] + q[2]) / 2]);
      }
    }
    for (const p of spots) {
      const z = Math.max(0, p[2]);
      const alpha = 0.20 * Math.max(0, 1 - z / 1400);
      if (alpha <= 0.01) continue;
      const r = 55 + 0.06 * z;
      const c = this.project([p[0], p[1], 0]);
      const u = this.project([p[0] + r, p[1], 0]);
      const v = this.project([p[0], p[1] + r, 0]);
      if (this._clipped(c)) continue;
      g.save();
      g.transform(u[0] - c[0], u[1] - c[1], v[0] - c[0], v[1] - c[1], c[0], c[1]);
      const grad = g.createRadialGradient(0, 0, 0, 0, 0, 1);
      grad.addColorStop(0, `rgba(0,0,0,${alpha})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(-1, -1, 2, 2);
      g.restore();
    }
  }

  _trail(g, accent) {
    if (this.trail.length < 2) return;
    const CH = 8;
    const per = Math.ceil(this.trail.length / CH);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = accent;
    for (let k = 0; k < CH; k++) {
      const from = k * per;
      const to = Math.min(this.trail.length - 1, (k + 1) * per);
      if (from >= to) continue;
      g.globalAlpha = 0.06 + 0.44 * (k / (CH - 1));
      g.lineWidth = 1 + 1.4 * (k / (CH - 1));
      g.beginPath();
      let pen = false;
      for (let i = from; i <= to; i++) {
        const s = this.project(this.trail[i]);
        if (this._clipped(s)) { pen = false; continue; }
        pen ? g.lineTo(s[0], s[1]) : g.moveTo(s[0], s[1]);
        pen = true;
      }
      g.stroke();
    }
    g.globalAlpha = 1;
    const head = this.project(this.trail[this.trail.length - 1]);
    if (!this._clipped(head)) {
      g.fillStyle = accent;
      g.beginPath(); g.arc(head[0], head[1], 3, 0, Math.PI * 2); g.fill();
    }
  }

  _tcpMarkers(g, dim) {
    if (!this.points || !this.points.length) return;
    const tip = this.points[this.points.length - 1];
    const foot = this.project([tip[0], tip[1], 0]);
    const tp = this.project(tip);
    if (!this._clipped(tp) && !this._clipped(foot)) {
      g.strokeStyle = dim;
      g.globalAlpha = 0.65;
      g.lineWidth = 1;
      g.setLineDash([3, 4]);
      g.beginPath(); g.moveTo(tp[0], tp[1]); g.lineTo(foot[0], foot[1]); g.stroke();
      g.setLineDash([]);
      g.fillStyle = dim;
      g.beginPath(); g.arc(foot[0], foot[1], 2.5, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 1;
    }
    if (this.frames && this.frames.length) {
      const F = this.frames[this.frames.length - 1];
      if (F && F.R) {
        const L = 55;
        const o = this.project(F.p);
        for (let i = 0; i < 3; i++) {
          const e2 = this.project([F.p[0] + F.R[0][i] * L,
                                   F.p[1] + F.R[1][i] * L,
                                   F.p[2] + F.R[2][i] * L]);
          if (this._clipped(e2) || this._clipped(o)) continue;
          g.strokeStyle = AXIS_COLORS[i];
          g.lineWidth = 1.5;
          g.beginPath(); g.moveTo(o[0], o[1]); g.lineTo(e2[0], e2[1]); g.stroke();
        }
      }
    }
  }

  _ring(g, accent) {
    const hl = this._hl ?? -1;
    if (hl < 0 || !this.points || hl >= this.points.length) return;
    const p = this.project(this.points[hl]);
    if (this._clipped(p)) return;
    g.strokeStyle = accent;
    g.lineWidth = 2.5;
    g.globalAlpha = 0.9;
    g.beginPath(); g.arc(p[0], p[1], 13, 0, Math.PI * 2); g.stroke();
    g.globalAlpha = 1;
  }

  _originMarker(g) {
    const L = 70;
    const o = this.project([0, 0, 0]);
    const ends = [[L, 0, 0], [0, L, 0], [0, 0, L]];
    g.lineWidth = 1.5;
    for (let i = 0; i < 3; i++) {
      const p = this.project(ends[i]);
      if (this._clipped(p) || this._clipped(o)) continue;
      g.strokeStyle = AXIS_COLORS[i];
      g.globalAlpha = 0.8;
      g.beginPath(); g.moveTo(o[0], o[1]); g.lineTo(p[0], p[1]); g.stroke();
    }
    g.globalAlpha = 1;
  }

  _gizmo(g) {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const sp = Math.sin(this.pitch), cp = Math.cos(this.pitch);
    const ox = 44, oy = this.h - 128, S = 26;
    g.lineWidth = 2;
    g.font = '10px ui-monospace, monospace';
    const names = ['X', 'Y', 'Z'];
    const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let i = 0; i < 3; i++) {
      const [ax, ay, az] = axes[i];
      const x1 = ax * cy - ay * sy;
      const y1 = ax * sy + ay * cy;
      const z2 = y1 * sp + az * cp;
      const px = ox + x1 * S, py = oy - z2 * S;
      g.strokeStyle = AXIS_COLORS[i];
      g.globalAlpha = 0.9;
      g.beginPath(); g.moveTo(ox, oy); g.lineTo(px, py); g.stroke();
      g.fillStyle = AXIS_COLORS[i];
      g.fillText(names[i], px + 3, py - 2);
    }
    g.globalAlpha = 1;
  }

  _drawSkeleton(g, line, dim, fg, accent, tip) {
    const proj = this.points.map((p) => this.project(p));

    // Links, thick, with a lighter core so they read as tubes.
    for (let i = 0; i < proj.length - 1; i++) {
      const a = proj[i], b = proj[i + 1];
      g.lineCap = 'round';
      g.strokeStyle = line;
      g.lineWidth = 15;
      g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
      g.strokeStyle = i === proj.length - 2 ? accent : fg;
      g.lineWidth = 7;
      g.globalAlpha = 0.9;
      g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
      g.globalAlpha = 1;
    }

    // Joints
    proj.forEach((p, i) => {
      const last = i === proj.length - 1;
      g.fillStyle = last ? tip : line;
      g.strokeStyle = last ? tip : dim;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(p[0], p[1], last ? 7 : 5.5, 0, Math.PI * 2);
      g.fill(); g.stroke();
    });
  }

  /**
   * Painter's-algorithm mesh render: transform each link's vertices by its
   * frame, project, backface-cull, depth-sort every visible face across all
   * links, flat-shade. ~11k faces at 10 Hz is comfortably within canvas 2D.
   */
  /** Colour LUTs: three material ramps x 64 shades, plus the tool ramp and
   * one interior colour. Two-tone like the real FR5: light-alloy tubes for
   * the long arm segments, graphite for the joint modules and base, teal
   * for the tool flange. Each ramp runs shadow -> base -> near-white so the
   * specular top end reads as a sheen, not a sticker. */
  _buildLUT(dark) {
    const mix = (a, b, t) => (a + (b - a) * t) | 0;
    const ramp = (sh, base, hi) => {
      const out = [];
      for (let i = 0; i < 64; i++) {
        const t = i / 63;
        const u = t < 0.72 ? t / 0.72 : (t - 0.72) / 0.28;
        const [f, g2] = t < 0.72 ? [sh, base] : [base, hi];
        out.push(`rgb(${mix(f[0], g2[0], u)},${mix(f[1], g2[1], u)},${mix(f[2], g2[2], u)})`);
      }
      return out;
    };
    const joint = dark
      ? ramp([22, 23, 27], [124, 127, 133], [216, 220, 226])
      : ramp([84, 85, 90], [152, 155, 162], [228, 231, 236]);
    const tube = dark
      ? ramp([36, 36, 39], [189, 188, 184], [252, 252, 250])
      : ramp([112, 110, 106], [221, 218, 212], [255, 255, 254]);
    const tip = dark
      ? ramp([6, 48, 58], [16, 150, 176], [190, 240, 252])
      : ramp([8, 74, 88], [12, 140, 163], [200, 244, 255]);
    const colors = joint.concat(tube, tip);
    colors[192] = dark ? 'rgb(15,17,20)' : 'rgb(70,74,80)';
    return colors;
  }

  /**
   * Painter's-algorithm mesh render: transform each link's vertices by its
   * frame, project, depth-sort the front faces across all links, shade with
   * a key light plus a broad sheen from precomputed smoothed normals.
   * Backfaces are not culled — they are filled once, flat and dark, beneath
   * all front faces, so the meshes read as solid castings instead of hollow
   * shells wherever they have openings. All buffers are preallocated in
   * setMeshes; per-frame allocation is one Path2D.
   */
  _drawMeshes(g) {
    const dark = this._isDark();
    if (!this._lut || this._lutDark !== dark) {
      this._lut = this._buildLUT(dark);
      this._lutDark = dark;
    }
    const colors = this._lut;

    // Camera constants hoisted out of the vertex loop — project() would
    // redo the trig ~4k times per frame.
    const cyw = Math.cos(this.yaw), syw = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const foc = Math.min(this.w, this.h) * 2.2;
    const hw = this.w / 2, hh = this.h / 2;
    const zc = this.zc, dist = this.dist;

    // Camera-locked key light over the viewer's left shoulder, plus the
    // light/view half-vector for the specular term.
    const [Lx, Ly, Lz] = this._keyLight();
    const vwx = -syw * cp, vwy = -cyw * cp, vwz = sp;   // toward the camera
    let hx = Lx + vwx, hy = Ly + vwy, hz = Lz + vwz;
    const hl = Math.hypot(hx, hy, hz) || 1;
    hx /= hl; hy /= hl; hz /= hl;

    // Material per link: base + shoulder + wrist modules in graphite (0),
    // the two long tubes in light alloy (64), the tool flange in teal (128).
    const MAT = [0, 0, 64, 64, 0, 0, 128];

    const fb = this._fb;
    const inner = new Path2D();
    let nF = 0;

    for (let li = 0; li < this.meshes.length; li++) {
      const mesh = this.meshes[li];
      const fr = this.frames[li];
      if (!mesh || !fr) continue;
      const { R, p } = fr;
      const r00 = R[0][0], r01 = R[0][1], r02 = R[0][2], px = p[0];
      const r10 = R[1][0], r11 = R[1][1], r12 = R[1][2], py = p[1];
      const r20 = R[2][0], r21 = R[2][1], r22 = R[2][2], pz = p[2];
      const v = mesh.v, s = mesh.proj, fn = mesh.fn;

      for (let i = 0; i < v.length; i += 3) {
        const x = v[i], y = v[i + 1], z = v[i + 2];
        const wx = r00 * x + r01 * y + r02 * z + px;
        const wy = r10 * x + r11 * y + r12 * z + py;
        const wz = r20 * x + r21 * y + r22 * z + pz;
        const x1 = wx * cyw - wy * syw;
        const y1 = wx * syw + wy * cyw;
        const z1 = wz - zc;
        const y2 = y1 * cp - z1 * sp;
        const den = dist + y2;
        const sc = foc / (den < 80 ? 80 : den);   // near-plane clamp
        s[i]     = hw + x1 * sc;
        s[i + 1] = hh - (y1 * sp + z1 * cp) * sc;
        s[i + 2] = y2;
      }

      const f = mesh.f;
      const base = MAT[li] ?? 0;
      for (let i = 0; i < f.length; i += 3) {
        const a = f[i] * 3, b = f[i + 1] * 3, c = f[i + 2] * 3;
        const ax = s[a], ay = s[a + 1];
        const bx = s[b], by = s[b + 1];
        const cx = s[c], cy = s[c + 1];
        // Screen-space winding decides which side of the surface we see:
        // outward faces come out NEGATIVE in canvas coords. Tiny interior
        // slivers are skipped; front slivers are kept — dropping them
        // notches the silhouette with interior colour.
        const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        if (cross >= 0 && cross < 0.05) continue;

        // Interior faces are one flat colour; collect them into one path
        // filled beneath every front face so openings read as solid depth.
        if (cross >= 0) {
          inner.moveTo(ax, ay);
          inner.lineTo(bx, by);
          inner.lineTo(cx, cy);
          inner.closePath();
          continue;
        }

        // Rotate the precomputed smoothed link-frame normal into the world.
        const lx = fn[i], ly = fn[i + 1], lz = fn[i + 2];
        let nx = r00 * lx + r01 * ly + r02 * lz;
        let ny = r10 * lx + r11 * ly + r12 * lz;
        let nz = r20 * lx + r21 * ly + r22 * lz;
        // Orient toward the camera: the STL winding sign is not trusted;
        // only the screen-space test says which side we are looking at.
        let ndv = nx * vwx + ny * vwy + nz * vwz;
        if (ndv < 0) { nx = -nx; ny = -ny; nz = -nz; ndv = -ndv; }
        const diff = Math.max(0, nx * Lx + ny * Ly + nz * Lz);
        const ndh = Math.max(0, nx * hx + ny * hy + nz * hz);
        // Broad low-gain sheen scaled by ndv: a tight highlight glitters on
        // decimated facets, and edge-on slivers would all catch it.
        const inten = 0.18 + 0.24 * (0.5 + 0.5 * nz)          // sky fill
                    + 0.72 * diff
                    + 0.28 * Math.pow(ndh, 6) * ndv;
        const lut = base + Math.min(63, (inten * 44) | 0);

        const k6 = nF * 6;
        fb.xy[k6] = ax; fb.xy[k6 + 1] = ay;
        fb.xy[k6 + 2] = bx; fb.xy[k6 + 3] = by;
        fb.xy[k6 + 4] = cx; fb.xy[k6 + 5] = cy;
        fb.depth[nF] = s[a + 2] + s[b + 2] + s[c + 2];
        fb.lut[nF] = lut;
        nF++;
      }
    }

    g.fillStyle = colors[192];
    g.fill(inner);

    const order = fb.order.subarray(0, nF);
    for (let i = 0; i < nF; i++) order[i] = i;
    const depth = fb.depth;
    order.sort((m, n) => depth[n] - depth[m]);   // far to near

    // Consecutive faces sharing a colour merge into one path; opaque
    // same-colour fills commute, so painter's order is preserved. Each
    // batch is stroked in its own colour too: antialiased triangle edges
    // otherwise double-composite and draw a bright hairline web.
    const xy = fb.xy, lut = fb.lut;
    g.lineWidth = 1;
    g.lineJoin = 'bevel';
    let cur = -1;
    const flush = () => {
      if (cur < 0) return;
      g.fillStyle = colors[cur];
      g.strokeStyle = colors[cur];
      g.fill();
      g.stroke();
    };
    for (let k = 0; k < nF; k++) {
      const i = order[k];
      if (lut[i] !== cur) {
        flush();
        g.beginPath();
        cur = lut[i];
      }
      const k6 = i * 6;
      g.moveTo(xy[k6], xy[k6 + 1]);
      g.lineTo(xy[k6 + 2], xy[k6 + 3]);
      g.lineTo(xy[k6 + 4], xy[k6 + 5]);
      g.closePath();
    }
    flush();
  }

  _isDark() {
    const t = document.documentElement.dataset.theme;
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  _grid(g, line, line2) {
    const step = 200, n = 7;
    g.lineWidth = 1;
    const seg = (a, b) => {
      if (this._clipped(a) && this._clipped(b)) return;
      g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
    };
    for (let i = -n; i <= n; i++) {
      const fade = 1 - (Math.abs(i) / n) ** 2;
      g.strokeStyle = i === 0 ? line2 : line;
      g.globalAlpha = i === 0 ? 0.8 : 0.12 + 0.38 * fade;
      seg(this.project([i * step, -n * step, 0]),
          this.project([i * step, n * step, 0]));
      seg(this.project([-n * step, i * step, 0]),
          this.project([n * step, i * step, 0]));
    }
    if (this.dist < 1600) {
      g.strokeStyle = line;
      g.globalAlpha = 0.18;
      const m = 100;
      for (let i = -n * 2 + 1; i < n * 2; i += 2) {
        seg(this.project([i * m, -n * step, 0]),
            this.project([i * m, n * step, 0]));
        seg(this.project([-n * step, i * m, 0]),
            this.project([n * step, i * m, 0]));
      }
    }
    g.globalAlpha = 1;
  }

  _envelope(g, line) {
    g.strokeStyle = line;
    g.globalAlpha = 0.6;
    g.setLineDash([4, 5]);
    g.lineWidth = 1;
    g.beginPath();
    let pen = false;
    for (let a = 0; a <= 360; a += 6) {
      const p = this.project([
        this.model.reach * Math.cos(a * RAD),
        this.model.reach * Math.sin(a * RAD),
        0,
      ]);
      if (this._clipped(p)) { pen = false; continue; }
      pen ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]);
      pen = true;
    }
    g.stroke();
    g.setLineDash([]);
    g.globalAlpha = 1;
  }
}
