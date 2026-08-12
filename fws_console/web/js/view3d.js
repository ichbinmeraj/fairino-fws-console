// A dependency-free 3D arm view on a 2D canvas.
//
// No Three.js: the console must work on an air-gapped cell with no CDN, and
// an orbiting camera over five line segments does not need a scene graph.
// Everything here is a projection, a depth sort and a stroke.

const RAD = Math.PI / 180;

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
      return { v, f, world: new Float64Array(v.length), proj: new Float64Array(v.length) };
    });
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
  _drawMeshes(g) {
    const dark = this._isDark();
    // Fixed light from over the operator's left shoulder, in world space.
    const L = [-0.42, 0.32, 0.85];

    const faces = [];
    for (let li = 0; li < this.meshes.length; li++) {
      const mesh = this.meshes[li];
      const fr = this.frames[li];
      if (!mesh || !fr) continue;
      const { R, p } = fr;
      const v = mesh.v, w = mesh.world, s = mesh.proj;

      for (let i = 0; i < v.length; i += 3) {
        const x = v[i], y = v[i + 1], z = v[i + 2];
        w[i]     = R[0][0] * x + R[0][1] * y + R[0][2] * z + p[0];
        w[i + 1] = R[1][0] * x + R[1][1] * y + R[1][2] * z + p[1];
        w[i + 2] = R[2][0] * x + R[2][1] * y + R[2][2] * z + p[2];
        const q = this.project([w[i], w[i + 1], w[i + 2]]);
        s[i] = q[0]; s[i + 1] = q[1]; s[i + 2] = q[2];
      }

      const f = mesh.f;
      for (let i = 0; i < f.length; i += 3) {
        const a = f[i] * 3, b = f[i + 1] * 3, c = f[i + 2] * 3;
        const ax = s[a], ay = s[a + 1], az = s[a + 2];
        const bx = s[b], by = s[b + 1], bz = s[b + 2];
        const cx = s[c], cy = s[c + 1], cz = s[c + 2];
        // screen-space winding: cull faces turned away (canvas y is down,
        // so outward CCW STL faces appear clockwise -> positive cross)
        const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        if (cross <= 0) continue;
        // world-space normal for stable lighting
        const ux = w[b] - w[a], uy = w[b + 1] - w[a + 1], uz = w[b + 2] - w[a + 2];
        const vx = w[c] - w[a], vy = w[c + 1] - w[a + 1], vz = w[c + 2] - w[a + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const nl = Math.hypot(nx, ny, nz) || 1;
        const lam = Math.abs(nx * L[0] + ny * L[1] + nz * L[2]) / nl;
        faces.push([(az + bz + cz) / 3, ax, ay, bx, by, cx, cy, lam, li]);
      }
    }

    faces.sort((m, n) => n[0] - m[0]);   // far to near

    for (const [, ax, ay, bx, by, cx, cy, lam, li] of faces) {
      const last = li === this.meshes.length - 1;
      const shade = 0.18 + 0.82 * lam;
      const v = dark ? 34 + 165 * shade : 72 + 175 * shade;
      g.fillStyle = last
        ? `rgb(${0.30 * v | 0},${1.18 * v > 255 ? 255 : 1.18 * v | 0},${1.28 * v > 255 ? 255 : 1.28 * v | 0})`
        : `rgb(${v | 0},${v + 3 | 0},${v + 9 | 0})`;
      g.beginPath();
      g.moveTo(ax, ay); g.lineTo(bx, by); g.lineTo(cx, cy);
      g.closePath();
      g.fill();
    }
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
