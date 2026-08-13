// A dependency-free 3D arm view on a 2D canvas.
//
// No Three.js: the console must work on an air-gapped cell with no CDN, and
// an orbiting camera over five line segments does not need a scene graph.
// Everything here is a projection, a depth sort and a stroke.

const RAD = Math.PI / 180;

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
    this.ctx = canvas.getContext('2d');
    this.yaw = -35 * RAD;
    this.pitch = 22 * RAD;
    this.dist = 2100;
    this.points = null;
    this.model = null;
    this.frames = null;   // per-link {R, p} world transforms, for meshes
    this.meshes = null;   // per-link {v: Float64Array, f: Uint16Array}
    this.trail = [];
    this.zc = 0;      // vertical centre, follows the pose (smoothed)

    this._bindOrbit();
    this._resize();
    new ResizeObserver(() => this._resize()).observe(canvas);
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.c.getBoundingClientRect();
    this.c.width = Math.max(1, Math.round(r.width * dpr));
    this.c.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = r.width;
    this.h = r.height;
    this.draw();
  }

  _bindOrbit() {
    // Pointer-events orbit with two-pointer pinch zoom for touch.
    const active = new Map();
    let pinchDist = 0;

    this.c.addEventListener('pointerdown', (e) => {
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
      this.draw();
    });

    this.c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.dist = Math.max(700, Math.min(5000, this.dist * (1 + Math.sign(e.deltaY) * 0.12)));
      this.draw();
    }, { passive: false });
  }

  /** Fixed viewpoints, cockpit-style: each snaps to a framed view. */
  preset(name) {
    const views = {
      iso: [-35, 22], front: [90, 10], back: [-90, 10],
      left: [0, 10], right: [180, 10], top: [-35, 78],
    };
    const [yawDeg, pitchDeg] = views[name] || views.iso;
    this.fit();
    this.yaw = yawDeg * RAD;
    this.pitch = pitchDeg * RAD;
    this.draw();
  }

  /** Frame the whole arm: reset the orbit, then solve for the camera
   * distance at which every point of the pose actually fits on screen with
   * a margin — projected, not guessed from a bounding sphere. */
  fit() {
    this.yaw = -35 * Math.PI / 180;
    this.pitch = 22 * Math.PI / 180;
    if (this.points && this.points.length) {
      // stop the vertical centre drifting after the fit is computed
      const zs = this.points.map((p) => p[2]).concat([0]);
      this.zc = (Math.min(...zs) + Math.max(...zs)) / 2;

      this.dist = 2000;
      for (let pass = 0; pass < 3; pass++) {
        let worst = 0;
        for (const p of this.points.concat([[0, 0, 0]])) {
          const [sx, sy] = this.project(p);
          worst = Math.max(worst,
            Math.abs(sx - this.w / 2) / (this.w * 0.40),
            Math.abs(sy - this.h / 2) / (this.h * 0.40));
        }
        if (worst < 1e-6) break;
        this.dist = Math.max(700, Math.min(5000, this.dist * worst));
      }
    } else {
      this.dist = 2100;
    }
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
    const s = f / (this.dist + y2);

    return [this.w / 2 + x1 * s, this.h / 2 - z2 * s, y2];
  }

  /**
   * Load per-link meshes: {linkName: {v: [[x,y,z],...], f: [[a,b,c],...]}},
   * in link-frame mm. Flattened to typed arrays once, here, not per frame.
   */
  setMeshes(data, linkNames) {
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
    if (points) {
      // Follow the arm vertically, slowly, so the view neither jumps per
      // frame nor loses an arm working entirely below the base plane.
      const zs = points.map((p) => p[2]).concat([0]);   // keep the grid in view
      const target = (Math.min(...zs) + Math.max(...zs)) / 2;
      this.zc += (target - this.zc) * 0.08;
      const tip = points[points.length - 1];
      const last = this.trail[this.trail.length - 1];
      if (!last || Math.hypot(tip[0] - last[0], tip[1] - last[1], tip[2] - last[2]) > 3) {
        this.trail.push([...tip]);
        if (this.trail.length > 240) this.trail.shift();
      }
    }
    this.draw();
  }

  clearTrail() { this.trail = []; this.draw(); }

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

  invalidateTheme() { this._pal = null; this.draw(); }

  draw() {
    const g = this.ctx;
    if (!g || !this.w) return;
    g.clearRect(0, 0, this.w, this.h);

    const { line, line2, dim, text, accent, data, ok } = this._theme();

    this._grid(g, line);

    if (!this.points) {
      g.fillStyle = dim;
      g.font = '13px system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText('waiting for telemetry…', this.w / 2, this.h / 2);
      return;
    }

    // Reach envelope, so an operator can see how close to the edge they are.
    if (this.model && this.model.reach) this._envelope(g, line);

    // TCP trail
    if (this.trail.length > 1) {
      g.strokeStyle = accent;
      g.globalAlpha = 0.35;
      g.lineWidth = 1.5;
      g.beginPath();
      this.trail.forEach((p, i) => {
        const s = this.project(p);
        i ? g.lineTo(s[0], s[1]) : g.moveTo(s[0], s[1]);
      });
      g.stroke();
      g.globalAlpha = 1;
    }

    if (this.meshes && this.frames) {
      this._drawMeshes(g);
    } else {
      this._drawSkeleton(g, line2, dim, text, accent, data);
    }

    this._triad(g);
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

    // Fixed key light from over the operator's left shoulder, plus the
    // light/view half-vector for the specular term.
    const Lx = -0.42, Ly = 0.32, Lz = 0.85;
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
        const sc = foc / (dist + y2);
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

  _grid(g, line) {
    const step = 200, n = 5;
    g.strokeStyle = line;
    g.lineWidth = 1;
    g.globalAlpha = 0.55;
    for (let i = -n; i <= n; i++) {
      const a = this.project([i * step, -n * step, 0]);
      const b = this.project([i * step, n * step, 0]);
      const c = this.project([-n * step, i * step, 0]);
      const d = this.project([n * step, i * step, 0]);
      g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
      g.beginPath(); g.moveTo(c[0], c[1]); g.lineTo(d[0], d[1]); g.stroke();
    }
    g.globalAlpha = 1;
  }

  _envelope(g, line) {
    g.strokeStyle = line;
    g.globalAlpha = 0.6;
    g.setLineDash([4, 5]);
    g.lineWidth = 1;
    g.beginPath();
    for (let a = 0; a <= 360; a += 6) {
      const p = this.project([
        this.model.reach * Math.cos(a * RAD),
        this.model.reach * Math.sin(a * RAD),
        0,
      ]);
      a ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]);
    }
    g.stroke();
    g.setLineDash([]);
    g.globalAlpha = 1;
  }

  _triad(g) {
    const L = 220;
    const o = this.project([0, 0, 0]);
    const axes = [
      [[L, 0, 0], '#ff5d5d', 'X'],
      [[0, L, 0], '#54d17a', 'Y'],
      [[0, 0, L], '#5aa2ff', 'Z'],
    ];
    g.lineWidth = 2;
    g.font = '11px ui-monospace, monospace';
    for (const [v, col, name] of axes) {
      const p = this.project(v);
      g.strokeStyle = col;
      g.beginPath(); g.moveTo(o[0], o[1]); g.lineTo(p[0], p[1]); g.stroke();
      g.fillStyle = col;
      g.fillText(name, p[0] + 4, p[1] - 2);
    }
  }
}
