// The 3D stage painter, running OFF the UI thread.
//
// Same painting code as the in-page fallback in view3d.js — smoothed
// normals, two-tone material LUTs, solid-casting interior, batched fills.
// Moving it here means jog buttons, charts and DOM updates never compete
// with mesh rasterisation for the main thread. The page posts meshes once,
// then camera and pose updates; this worker owns the canvas.

let ctx = null;        // 2D context: full painter (no-GL fallback)
let backCtx = null;    // 2D: grid + envelope, behind the arm
let frontCtx = null;   // 2D: trail + triad + status text, above the arm
let gl = null;         // WebGL2: the arm itself
let glp = null;        // GL program + locations + per-link VBOs
let W = 0, H = 0, DPR = 1;

let meshes = null;       // [{v,f,fn,proj}]
let fb = null;           // shared face buffers
let theme = null;        // resolved colors from the page (no CSS in workers)
let lut = null, lutKey = '';

let yaw = -35 * Math.PI / 180;
let pitch = 22 * Math.PI / 180;
let dist = 2100;
let zc = 0;
let points = null;       // [[x,y,z],...]
let frames = null;       // [{R:[[..]],p:[..]}]
let model = null;        // {reach, isSim}
let hl = -1;             // joint index a jog control is about to drive
const trail = [];

let sig = '';
let rafPending = false;

/** Camera-locked key light: the "over the operator's left shoulder" light,
 * rotated by the camera yaw so it stays over the VIEWER's shoulder at any
 * orbit — a world-fixed key goes behind the subject at 180° and the arm
 * turns dull and flat. */
function keyLight() {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const l0x = -0.42, l0y = 0.32;
  return [l0x * cy + l0y * sy, -l0x * sy + l0y * cy, 0.85];
}

const hexRgb = (s) => {
  const h = String(s || '').replace('#', '');
  return h.length >= 6
    ? [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255,
       parseInt(h.slice(4, 6), 16) / 255]
    : [0.25, 0.62, 0.91];
};

/* ---------------------------------------------------------------- normals */

function smoothNormals(v, f) {
  const nFaces = f.length / 3;
  const raw = new Float32Array(nFaces * 3);
  const vertFaces = new Array(v.length / 3);

  for (let i = 0, fi = 0; i < f.length; i += 3, fi++) {
    const a = f[i] * 3, b = f[i + 1] * 3, c = f[i + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
    const qx = v[c] - v[a], qy = v[c + 1] - v[a + 1], qz = v[c + 2] - v[a + 2];
    const nx = uy * qz - uz * qy, ny = uz * qx - ux * qz, nz = ux * qy - uy * qx;
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
          if (d < 0) { px = -px; py = -py; pz = -pz; d = -d; }
          if (d < 0.4) continue;
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

/* ---------------------------------------------------------------- LUT */

function buildLUT(dark) {
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

/* ---------------------------------------------------------------- paint */

// The near plane for the 2D projection paths. Without it, a point closer
// than the camera makes dist+y2 negative: the scale flips sign and grid or
// trail segments mirror across the screen as garbage streaks (the GL path
// is safe — negative w clips on the GPU; these CPU paths are not).
const NEAR = 80;

function project(p) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const x1 = p[0] * cy - p[1] * sy;
  const y1 = p[0] * sy + p[1] * cy;
  const z1 = p[2] - zc;
  const y2 = y1 * cp - z1 * sp;
  const z2 = y1 * sp + z1 * cp;
  const f = Math.min(W, H) * 2.2;
  const den = dist + y2;
  const s = f / (den < NEAR ? NEAR : den);
  return [W / 2 + x1 * s, H / 2 - z2 * s, y2];
}

/** True when a projected point sits at/behind the near plane — its screen
 * position is clamped, so segments touching it should be skipped. */
const clipped = (p) => dist + p[2] < NEAR;

// AXIS_COLORS shared by the origin marker and the corner gizmo.
const AXIS_COLORS = ['#ff5d5d', '#54d17a', '#5aa2ff'];

function grid(g, line, line2) {
  // Hierarchy + edge fade: axis lines strongest, 200 mm majors fading
  // toward the rim, 100 mm minors only at close zoom. A single-weight grid
  // with a hard rectangular edge reads as a floating rug.
  const step = 200, n = 7;
  g.lineWidth = 1;
  const seg = (a, b) => {
    if (clipped(a) && clipped(b)) return;
    g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
  };
  for (let i = -n; i <= n; i++) {
    const fade = 1 - (Math.abs(i) / n) ** 2;
    g.strokeStyle = i === 0 ? line2 : line;
    g.globalAlpha = i === 0 ? 0.8 : 0.12 + 0.38 * fade;
    seg(project([i * step, -n * step, 0]), project([i * step, n * step, 0]));
    seg(project([-n * step, i * step, 0]), project([n * step, i * step, 0]));
  }
  if (dist < 1600) {
    g.strokeStyle = line;
    g.globalAlpha = 0.18;
    const m = 100;
    for (let i = -n * 2 + 1; i < n * 2; i += 2) {
      seg(project([i * m, -n * step, 0]), project([i * m, n * step, 0]));
      seg(project([-n * step, i * m, 0]), project([n * step, i * m, 0]));
    }
  }
  g.globalAlpha = 1;
}

/** Soft contact shadows under the joints: the one cue that anchors the arm
 * to the floor instead of floating above it. Drawn as world-space ellipses
 * projected through the camera, so they foreshorten correctly. */
function contactShadows(g) {
  if (!points) return;
  const spots = [];
  for (let i = 0; i < points.length; i++) {
    spots.push(points[i]);
    if (i < points.length - 1) {
      const q = points[i + 1];
      spots.push([(points[i][0] + q[0]) / 2, (points[i][1] + q[1]) / 2,
                  (points[i][2] + q[2]) / 2]);
    }
  }
  for (const p of spots) {
    const z = Math.max(0, p[2]);
    const alpha = 0.20 * Math.max(0, 1 - z / 1400);
    if (alpha <= 0.01) continue;
    const r = 55 + 0.06 * z;
    const c = project([p[0], p[1], 0]);
    const u = project([p[0] + r, p[1], 0]);
    const v = project([p[0], p[1] + r, 0]);
    if (clipped(c)) continue;
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

function envelope(g, line, reach) {
  g.strokeStyle = line;
  g.globalAlpha = 0.6;
  g.setLineDash([4, 5]);
  g.lineWidth = 1;
  g.beginPath();
  let pen = false;
  for (let a = 0; a <= 360; a += 6) {
    const p = project([reach * Math.cos(a * Math.PI / 180),
                       reach * Math.sin(a * Math.PI / 180), 0]);
    if (clipped(p)) { pen = false; continue; }
    pen ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]);
    pen = true;
  }
  g.stroke();
  g.setLineDash([]);
  g.globalAlpha = 1;
}

/** Small unlabeled origin marker, drawn BEHIND the arm (back layer) so the
 * robot correctly occludes it. Navigation labels live on the corner gizmo. */
function originMarker(g) {
  const L = 70;
  const o = project([0, 0, 0]);
  const ends = [[L, 0, 0], [0, L, 0], [0, 0, L]];
  g.lineWidth = 1.5;
  for (let i = 0; i < 3; i++) {
    const p = project(ends[i]);
    if (clipped(p) || clipped(o)) continue;
    g.strokeStyle = AXIS_COLORS[i];
    g.globalAlpha = 0.8;
    g.beginPath(); g.moveTo(o[0], o[1]); g.lineTo(p[0], p[1]); g.stroke();
  }
  g.globalAlpha = 1;
}

/** Screen-fixed navigation gizmo: a mini triad in the corner that rotates
 * with the camera but never occludes the scene and never swims. */
function cornerGizmo(g) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  // Above the TCP readout chip that owns the true bottom-left corner.
  const ox = 44, oy = H - 128, S = 26;
  g.lineWidth = 2;
  g.font = '10px ui-monospace, monospace';
  const names = ['X', 'Y', 'Z'];
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let i = 0; i < 3; i++) {
    const [ax, ay, az] = axes[i];
    const x1 = ax * cy - ay * sy;
    const y1 = ax * sy + ay * cy;
    const z2 = y1 * sp + (az) * cp;
    const px = ox + x1 * S, py = oy - z2 * S;
    g.strokeStyle = AXIS_COLORS[i];
    g.globalAlpha = 0.9;
    g.beginPath(); g.moveTo(ox, oy); g.lineTo(px, py); g.stroke();
    g.fillStyle = AXIS_COLORS[i];
    g.fillText(names[i], px + 3, py - 2);
  }
  g.globalAlpha = 1;
}

/** TCP context: a small tool triad at the flange (orientation at a glance)
 * and a dashed plumb line to the floor — the classic industrial cue that
 * makes Z height and XY position over the table instantly legible. */
function tcpMarkers(g) {
  if (!points || !points.length) return;
  const tip = points[points.length - 1];
  const foot = project([tip[0], tip[1], 0]);
  const tp = project(tip);
  if (!clipped(tp) && !clipped(foot)) {
    g.strokeStyle = theme.dim;
    g.globalAlpha = 0.65;
    g.lineWidth = 1;
    g.setLineDash([3, 4]);
    g.beginPath(); g.moveTo(tp[0], tp[1]); g.lineTo(foot[0], foot[1]); g.stroke();
    g.setLineDash([]);
    g.fillStyle = theme.dim;
    g.beginPath(); g.arc(foot[0], foot[1], 2.5, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 1;
  }
  if (frames && frames.length) {
    const F = frames[frames.length - 1];
    if (F && F.R) {
      const L = 55;
      const o = project(F.p);
      for (let i = 0; i < 3; i++) {
        const e = project([F.p[0] + F.R[0][i] * L,
                           F.p[1] + F.R[1][i] * L,
                           F.p[2] + F.R[2][i] * L]);
        if (clipped(e) || clipped(o)) continue;
        g.strokeStyle = AXIS_COLORS[i];
        g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(o[0], o[1]); g.lineTo(e[0], e[1]); g.stroke();
      }
    }
  }
}

/** Age-ramped TCP trail: where the motion came from fades, where it is
 * glows — a constant-alpha polyline has neither direction nor recency. */
function drawTrail(g) {
  if (trail.length < 2) return;
  const CH = 8;
  const per = Math.ceil(trail.length / CH);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.strokeStyle = theme.accent;
  for (let k = 0; k < CH; k++) {
    const from = k * per;
    const to = Math.min(trail.length - 1, (k + 1) * per);
    if (from >= to) continue;
    g.globalAlpha = 0.06 + 0.44 * (k / (CH - 1));
    g.lineWidth = 1 + 1.4 * (k / (CH - 1));
    g.beginPath();
    let pen = false;
    for (let i = from; i <= to; i++) {
      const s = project(trail[i]);
      if (clipped(s)) { pen = false; continue; }
      pen ? g.lineTo(s[0], s[1]) : g.moveTo(s[0], s[1]);
      pen = true;
    }
    g.stroke();
  }
  g.globalAlpha = 1;
  const head = project(trail[trail.length - 1]);
  if (!clipped(head)) {
    g.fillStyle = theme.accent;
    g.beginPath(); g.arc(head[0], head[1], 3, 0, Math.PI * 2); g.fill();
  }
}

/** Accent ring around the joint a jog control is about to drive. */
function highlightRing(g) {
  if (hl < 0 || !points || hl >= points.length) return;
  const p = project(points[hl]);
  if (clipped(p)) return;
  g.strokeStyle = theme.accent;
  g.lineWidth = 2.5;
  g.globalAlpha = 0.9;
  g.beginPath(); g.arc(p[0], p[1], 13, 0, Math.PI * 2); g.stroke();
  g.globalAlpha = 1;
}

function drawSkeleton(g) {
  const proj = points.map((p) => project(p));
  for (let i = 0; i < proj.length - 1; i++) {
    const a = proj[i], b = proj[i + 1];
    g.lineCap = 'round';
    g.strokeStyle = theme.line2;
    g.lineWidth = 15;
    g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
    g.strokeStyle = i === proj.length - 2 ? theme.accent : theme.text;
    g.lineWidth = 7;
    g.globalAlpha = 0.9;
    g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
    g.globalAlpha = 1;
  }
  proj.forEach((p, i) => {
    const last = i === proj.length - 1;
    g.fillStyle = last ? theme.data : theme.line2;
    g.strokeStyle = last ? theme.data : theme.dim;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(p[0], p[1], last ? 7 : 5.5, 0, Math.PI * 2);
    g.fill(); g.stroke();
  });
}

function drawMeshes(g) {
  const key = theme.dark ? 'd' : 'l';
  if (!lut || lutKey !== key) { lut = buildLUT(theme.dark); lutKey = key; }
  const colors = lut;

  const cyw = Math.cos(yaw), syw = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const foc = Math.min(W, H) * 2.2;
  const hw = W / 2, hh = H / 2;

  const [Lx, Ly, Lz] = keyLight();
  const vwx = -syw * cp, vwy = -cyw * cp, vwz = sp;
  let hx = Lx + vwx, hy = Ly + vwy, hz = Lz + vwz;
  const hn = Math.hypot(hx, hy, hz) || 1;
  hx /= hn; hy /= hn; hz /= hn;

  const MAT = [0, 0, 64, 64, 0, 0, 128];

  const inner = new Path2D();
  let nF = 0;

  for (let li = 0; li < meshes.length; li++) {
    const mesh = meshes[li];
    const fr = frames[li];
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
      const sc = foc / (den < NEAR ? NEAR : den);
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
      const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (cross >= 0 && cross < 0.05) continue;
      if (cross >= 0) {
        inner.moveTo(ax, ay);
        inner.lineTo(bx, by);
        inner.lineTo(cx, cy);
        inner.closePath();
        continue;
      }
      const lx = fn[i], ly = fn[i + 1], lz = fn[i + 2];
      let nx = r00 * lx + r01 * ly + r02 * lz;
      let ny = r10 * lx + r11 * ly + r12 * lz;
      let nz = r20 * lx + r21 * ly + r22 * lz;
      let ndv = nx * vwx + ny * vwy + nz * vwz;
      if (ndv < 0) { nx = -nx; ny = -ny; nz = -nz; ndv = -ndv; }
      const diff = Math.max(0, nx * Lx + ny * Ly + nz * Lz);
      const ndh = Math.max(0, nx * hx + ny * hy + nz * hz);
      const inten = 0.18 + 0.24 * (0.5 + 0.5 * nz)
                  + 0.72 * diff
                  + 0.28 * Math.pow(ndh, 6) * ndv;
      const lutIdx = base + Math.min(63, (inten * 44) | 0);

      const k6 = nF * 6;
      fb.xy[k6] = ax; fb.xy[k6 + 1] = ay;
      fb.xy[k6 + 2] = bx; fb.xy[k6 + 3] = by;
      fb.xy[k6 + 4] = cx; fb.xy[k6 + 5] = cy;
      fb.depth[nF] = s[a + 2] + s[b + 2] + s[c + 2];
      fb.lut[nF] = lutIdx;
      nF++;
    }
  }

  g.fillStyle = colors[192];
  g.fill(inner);

  const order = fb.order.subarray(0, nF);
  for (let i = 0; i < nF; i++) order[i] = i;
  const depth = fb.depth;
  order.sort((m, n) => depth[n] - depth[m]);

  const xy = fb.xy, lutArr = fb.lut;
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
    if (lutArr[i] !== cur) {
      flush();
      g.beginPath();
      cur = lutArr[i];
    }
    const k6 = i * 6;
    g.moveTo(xy[k6], xy[k6 + 1]);
    g.lineTo(xy[k6 + 2], xy[k6 + 3]);
    g.lineTo(xy[k6 + 4], xy[k6 + 5]);
    g.closePath();
  }
  flush();
}

function draw() {
  if (gl) { drawGLLayers(); return; }
  if (!ctx || !W || !theme) return;

  let ph = 0;
  if (points) {
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      ph += Math.round(p[0] * 10) * (i * 3 + 1)
          + Math.round(p[1] * 10) * (i * 3 + 2)
          + Math.round(p[2] * 10) * (i * 3 + 3);
    }
  }
  const now = `${yaw},${pitch},${dist},${zc.toFixed(1)},${W},${H},`
    + `${!points},${ph},${trail.length},${meshes ? 1 : 0},${theme.dark},${hl}`;
  if (now === sig) return;
  sig = now;

  const g = ctx;
  g.clearRect(0, 0, W, H);
  grid(g, theme.line, theme.line2);
  originMarker(g);
  contactShadows(g);

  if (!points) {
    g.fillStyle = theme.dim;
    g.font = '13px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText('waiting for telemetry…', W / 2, H / 2);
    g.textAlign = 'start';
    return;
  }

  if (model && model.reach) envelope(g, theme.line, model.reach);

  drawTrail(g);

  if (meshes && frames) drawMeshes(g);
  else drawSkeleton(g);

  tcpMarkers(g);
  highlightRing(g);
  cornerGizmo(g);
}

function drawGLLayers() {
  if (!W || !theme) return;
  let ph = 0;
  if (points) {
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      ph += Math.round(p[0] * 10) * (i * 3 + 1)
          + Math.round(p[1] * 10) * (i * 3 + 2)
          + Math.round(p[2] * 10) * (i * 3 + 3);
    }
  }
  const now = `${yaw},${pitch},${dist},${zc.toFixed(1)},${W},${H},`
    + `${!points},${ph},${trail.length},${meshes ? 1 : 0},${theme.dark},${hl}`;
  if (now === sig) return;
  sig = now;

  drawBackLayer();
  if (points && meshes && frames) glDraw();
  else if (gl) {
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }
  drawFrontLayer();
  // Skeleton fallback while meshes are still loading: draw on the front
  // layer so the arm is never invisible.
  if (points && !(meshes && frames)) drawSkeleton(frontCtx);
}

function schedule() {
  if (rafPending) return;
  rafPending = true;
  const raf = self.requestAnimationFrame
    ? self.requestAnimationFrame.bind(self)
    : (fn) => setTimeout(fn, 16);
  raf(() => {
    rafPending = false;
    // A painter exception outside handleMessage would otherwise die
    // silently, leaving a frozen stage with no scrim.
    try { draw(); } catch (err) {
      self.postMessage({ type: 'error', message: String(err && err.message || err) });
    }
  });
}

/* ---------------------------------------------------------------- inbox */

self.onmessage = (e) => {
  try {
    handleMessage(e.data);
  } catch (err) {
    // A malformed message must not kill the worker silently; report it so
    // the page's worker.onerror surfaces a scrim rather than a blank stage.
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};

function handleMessage(m) {
  switch (m.type) {
    case 'canvas':
      ctx = m.canvas.getContext('2d');
      break;
    case 'layers':
      // Three stacked canvases: 2D behind, GL middle, 2D in front. If GL
      // is unavailable the top canvas becomes the full 2D painter and the
      // other two stay blank.
      try {
        glp = glInit(m.glCanvas);
        gl = glp ? m.glCanvas.getContext('webgl2') : null;
      } catch { gl = null; glp = null; }
      if (gl) {
        backCtx = m.backCanvas.getContext('2d');
        frontCtx = m.mainCanvas.getContext('2d');
        if (meshes) glBuildLinks();
      } else {
        ctx = m.mainCanvas.getContext('2d');
      }
      self.postMessage({ type: 'mode', gl: Boolean(gl) });
      break;
    case 'resize': {
      W = m.w; H = m.h; DPR = m.dpr;
      // The 1.5x cap exists for the CPU full painter, where pixels are
      // expensive. The GL arm and the thin 2D line layers are nearly free at
      // native DPR — capping them too made grid hairlines and labels soft
      // on HiDPI screens.
      const cpuDpr = Math.min(DPR, 1.5);
      const fit2d = (c, d) => {
        if (!c) return;
        c.canvas.width = Math.max(1, Math.round(W * d));
        c.canvas.height = Math.max(1, Math.round(H * d));
        c.setTransform(d, 0, 0, d, 0, 0);
      };
      fit2d(ctx, cpuDpr); fit2d(backCtx, DPR); fit2d(frontCtx, DPR);
      if (gl) {
        gl.canvas.width = Math.max(1, Math.round(W * DPR));
        gl.canvas.height = Math.max(1, Math.round(H * DPR));
      }
      sig = '';
      schedule();
      break;
    }
    case 'theme':
      theme = m.theme;
      sig = '';
      schedule();
      break;
    case 'meshes': {
      meshes = m.links.map((name) => {
        const src = m.data[name];
        if (!src) return null;
        const v = new Float64Array(src.v.length * 3);
        src.v.forEach((p, i) => { v[i * 3] = p[0]; v[i * 3 + 1] = p[1]; v[i * 3 + 2] = p[2]; });
        const f = new Uint32Array(src.f.length * 3);
        src.f.forEach((t, i) => { f[i * 3] = t[0]; f[i * 3 + 1] = t[1]; f[i * 3 + 2] = t[2]; });
        return { v, f, fn: smoothNormals(v, f), proj: new Float64Array(v.length) };
      });
      const total = meshes.reduce((s, x) => s + (x ? x.f.length / 3 : 0), 0);
      fb = {
        depth: new Float32Array(total),
        xy: new Float32Array(total * 6),
        lut: new Uint8Array(total),
        order: new Uint32Array(total),
      };
      if (gl) glBuildLinks();
      sig = '';
      schedule();
      break;
    }
    case 'pose': {
      if (!Array.isArray(m.points) || !m.points.length) break;
      points = m.points;
      frames = m.frames;
      model = m.model;
      // Same easing + snap as the page renderer.
      const zs = points.map((p) => p[2]).concat([0]);
      const target = (Math.min(...zs) + Math.max(...zs)) / 2;
      const dz = target - zc;
      zc += Math.abs(dz) < 0.05 ? dz : dz * 0.08;
      const tip = points[points.length - 1];
      const last = trail[trail.length - 1];
      if (!last || Math.hypot(tip[0] - last[0], tip[1] - last[1], tip[2] - last[2]) > 3) {
        // Copy, don't alias: structured clone makes it safe today, but a
        // reference into m.points is a latent bug if messages are ever reused.
        trail.push([tip[0], tip[1], tip[2]]);
        if (trail.length > 240) trail.shift();
      }
      schedule();
      break;
    }
    case 'camera':
      yaw = m.yaw; pitch = m.pitch; dist = m.dist;
      if (m.zc !== undefined) zc = m.zc;
      schedule();
      break;
    case 'highlight':
      hl = Number.isInteger(m.link) ? m.link : -1;
      sig = '';
      schedule();
      break;
    case 'clearTrail':
      trail.length = 0;
      sig = '';
      schedule();
      break;
  }
};

/* ------------------------------------------------------------------ WebGL */
/* The same shading model as the 2D painter, evaluated on the GPU: smoothed
 * per-face normals (de-indexed to flat vertices), the piecewise material
 * ramp in GLSL, gl_FrontFacing giving the flat interior of the solid-
 * casting look, and the z-buffer replacing the painter's sort. Per frame
 * the CPU uploads seven small uniforms; the GPU does everything else. */

const VS = `#version 300 es
precision highp float;
in vec3 aPos;
in vec3 aNrm;
uniform mat3 uR;        // link rotation (world)
uniform vec3 uT;        // link translation (world mm)
uniform vec2 uCamYaw;   // cos, sin
uniform vec2 uCamPitch; // cos, sin
uniform vec4 uCam;      // dist, zc, f, unused
uniform vec2 uHalf;     // W/2, H/2
out vec3 vNrm;          // world-space smoothed normal
void main() {
  vec3 w = uR * aPos + uT;
  float x1 = w.x * uCamYaw.x - w.y * uCamYaw.y;
  float y1 = w.x * uCamYaw.y + w.y * uCamYaw.x;
  float z1 = w.z - uCam.y;
  float y2 = y1 * uCamPitch.x - z1 * uCamPitch.y;
  float z2 = y1 * uCamPitch.y + z1 * uCamPitch.x;
  float wclip = uCam.x + y2;                    // dist + depth
  gl_Position = vec4(
    x1 * uCam.z / uHalf.x,
    z2 * uCam.z / uHalf.y,
    (y2 / 6000.0) * wclip,                      // z/w = y2/6000: monotonic
    wclip);
  vNrm = uR * aNrm;
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vNrm;
uniform vec3 uEye;      // toward the camera, world space
uniform vec3 uLight;    // camera-locked key light, world space
uniform vec3 uHalfVec;  // light/view half-vector
uniform float uMat;     // 0 joint, 1 tube, 2 tool
uniform float uDark;    // 1 dark theme, 0 light
uniform float uHl;      // 1 = this link is jog-highlighted
uniform vec3 uAccent;   // page accent color for the highlight tint
uniform vec3 uInterior;
out vec4 frag;

vec3 ramp(float m, float t, float dark) {
  vec3 sh, base, hi;
  if (m < 0.5) {        // joint: graphite
    sh   = mix(vec3(84.,85.,90.),    vec3(22.,23.,27.),    dark);
    base = mix(vec3(152.,155.,162.), vec3(124.,127.,133.), dark);
    hi   = mix(vec3(228.,231.,236.), vec3(216.,220.,226.), dark);
  } else if (m < 1.5) { // tube: light alloy
    sh   = mix(vec3(112.,110.,106.), vec3(36.,36.,39.),    dark);
    base = mix(vec3(221.,218.,212.), vec3(189.,188.,184.), dark);
    hi   = mix(vec3(255.,255.,254.), vec3(252.,252.,250.), dark);
  } else {              // tool: teal
    sh   = mix(vec3(8.,74.,88.),     vec3(6.,48.,58.),     dark);
    base = mix(vec3(12.,140.,163.),  vec3(16.,150.,176.),  dark);
    hi   = mix(vec3(200.,244.,255.), vec3(190.,240.,252.), dark);
  }
  vec3 c = t < 0.72 ? mix(sh, base, t / 0.72) : mix(base, hi, (t - 0.72) / 0.28);
  return c / 255.0;
}

void main() {
  // Two-sided shading, no gl_FrontFacing: the source STLs wind triangles
  // inconsistently, so winding-based interior detection paints random
  // outward faces near-black. Flipping the normal toward the camera works
  // for every face; through openings the z-buffer shows the shell's far
  // wall, slightly dimmed below, so cavities still read as depth.
  vec3 n = normalize(vNrm);
  float ndv = dot(n, uEye);
  float back = gl_FrontFacing ? 1.0 : 0.72;   // gentle, never black
  if (ndv < 0.0) { n = -n; ndv = -ndv; }
  float diff = max(0.0, dot(n, uLight));
  float ndh = max(0.0, dot(n, uHalfVec));
  float inten = 0.18 + 0.24 * (0.5 + 0.5 * n.z)
              + 0.72 * diff
              + 0.28 * pow(ndh, 6.0) * ndv;
  float t = clamp(inten * back * 44.0 / 63.0, 0.0, 1.0);
  vec3 c = ramp(uMat, t, uDark);
  frag = vec4(mix(c, uAccent, uHl * 0.30), 1.0);
}`;

function glInit(canvas) {
  const g = canvas.getContext('webgl2', {
    antialias: true, alpha: true, depth: true,
    premultipliedAlpha: true, powerPreference: 'low-power',
  });
  if (!g) return null;
  const sh = (type, src) => {
    const o = g.createShader(type);
    g.shaderSource(o, src);
    g.compileShader(o);
    if (!g.getShaderParameter(o, g.COMPILE_STATUS)) {
      throw new Error(g.getShaderInfoLog(o));
    }
    return o;
  };
  const prog = g.createProgram();
  g.attachShader(prog, sh(g.VERTEX_SHADER, VS));
  g.attachShader(prog, sh(g.FRAGMENT_SHADER, FS));
  g.linkProgram(prog);
  if (!g.getProgramParameter(prog, g.LINK_STATUS)) {
    throw new Error(g.getProgramInfoLog(prog));
  }
  g.useProgram(prog);
  g.enable(g.DEPTH_TEST);
  g.disable(g.CULL_FACE);          // backfaces ARE the interior look
  const u = (n) => g.getUniformLocation(prog, n);
  return {
    prog,
    aPos: g.getAttribLocation(prog, 'aPos'),
    aNrm: g.getAttribLocation(prog, 'aNrm'),
    uR: u('uR'), uT: u('uT'), uCamYaw: u('uCamYaw'), uCamPitch: u('uCamPitch'),
    uCam: u('uCam'), uHalf: u('uHalf'), uEye: u('uEye'), uLight: u('uLight'),
    uHalfVec: u('uHalfVec'), uMat: u('uMat'), uDark: u('uDark'),
    uHl: u('uHl'), uAccent: u('uAccent'),
    uInterior: u('uInterior'),
    links: null,
  };
}

/** De-index each link into flat vertices with per-face smoothed normals
 * (WebGL flat-look without provoking-vertex games), one VAO per link. */
function glBuildLinks() {
  const g = gl;
  glp.links = meshes.map((mesh) => {
    if (!mesh) return null;
    const nFaces = mesh.f.length / 3;
    const buf = new Float32Array(nFaces * 3 * 6);
    let o = 0;
    for (let i = 0; i < mesh.f.length; i += 3) {
      const nx = mesh.fn[i], ny = mesh.fn[i + 1], nz = mesh.fn[i + 2];
      for (const vi of [mesh.f[i], mesh.f[i + 1], mesh.f[i + 2]]) {
        const v3 = vi * 3;
        buf[o++] = mesh.v[v3]; buf[o++] = mesh.v[v3 + 1]; buf[o++] = mesh.v[v3 + 2];
        buf[o++] = nx; buf[o++] = ny; buf[o++] = nz;
      }
    }
    const vao = g.createVertexArray();
    g.bindVertexArray(vao);
    const vbo = g.createBuffer();
    g.bindBuffer(g.ARRAY_BUFFER, vbo);
    g.bufferData(g.ARRAY_BUFFER, buf, g.STATIC_DRAW);
    g.enableVertexAttribArray(glp.aPos);
    g.vertexAttribPointer(glp.aPos, 3, g.FLOAT, false, 24, 0);
    g.enableVertexAttribArray(glp.aNrm);
    g.vertexAttribPointer(glp.aNrm, 3, g.FLOAT, false, 24, 12);
    g.bindVertexArray(null);
    return { vao, count: nFaces * 3 };
  });
}

const GL_MAT = [0, 0, 1, 1, 0, 0, 2];

function glDraw() {
  const g = gl;
  g.viewport(0, 0, g.canvas.width, g.canvas.height);
  g.clearColor(0, 0, 0, 0);
  g.clear(g.COLOR_BUFFER_BIT | g.DEPTH_BUFFER_BIT);
  if (!meshes || !frames || !glp.links) return;

  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const f = Math.min(W, H) * 2.2;
  g.uniform2f(glp.uCamYaw, cy, sy);
  g.uniform2f(glp.uCamPitch, cp, sp);
  g.uniform4f(glp.uCam, dist, zc, f, 0);
  g.uniform2f(glp.uHalf, W / 2, H / 2);

  const vwx = -sy * cp, vwy = -cy * cp, vwz = sp;
  const [klx, kly, klz] = keyLight();
  let hx = klx + vwx, hy = kly + vwy, hz = klz + vwz;
  const hn = Math.hypot(hx, hy, hz) || 1;
  g.uniform3f(glp.uEye, vwx, vwy, vwz);
  g.uniform3f(glp.uLight, klx, kly, klz);
  g.uniform3f(glp.uHalfVec, hx / hn, hy / hn, hz / hn);
  g.uniform1f(glp.uDark, theme && theme.dark ? 1 : 0);
  const acc = hexRgb(theme && theme.accent);
  g.uniform3f(glp.uAccent, acc[0], acc[1], acc[2]);
  const inr = theme && theme.dark ? [15 / 255, 17 / 255, 20 / 255]
    : [70 / 255, 74 / 255, 80 / 255];
  g.uniform3f(glp.uInterior, inr[0], inr[1], inr[2]);

  for (let li = 0; li < glp.links.length; li++) {
    const link = glp.links[li];
    const fr = frames[li];
    if (!link || !fr) continue;
    const R = fr.R;
    g.uniformMatrix3fv(glp.uR, false, [   // column-major
      R[0][0], R[1][0], R[2][0],
      R[0][1], R[1][1], R[2][1],
      R[0][2], R[1][2], R[2][2],
    ]);
    g.uniform3f(glp.uT, fr.p[0], fr.p[1], fr.p[2]);
    g.uniform1f(glp.uMat, GL_MAT[li] ?? 0);
    g.uniform1f(glp.uHl, li === hl ? 1 : 0);
    g.bindVertexArray(link.vao);
    g.drawArrays(g.TRIANGLES, 0, link.count);
  }
  g.bindVertexArray(null);
}

/* Layered 2D: grid/envelope behind the arm, trail/triad/status above it. */

function drawBackLayer() {
  const g = backCtx;
  if (!g) return;
  g.clearRect(0, 0, W, H);
  grid(g, theme.line, theme.line2);
  originMarker(g);
  contactShadows(g);
  if (model && model.reach) envelope(g, theme.line, model.reach);
}

function drawFrontLayer() {
  const g = frontCtx;
  if (!g) return;
  g.clearRect(0, 0, W, H);
  if (!points) {
    g.fillStyle = theme.dim;
    g.font = '13px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText('waiting for telemetry…', W / 2, H / 2);
    g.textAlign = 'start';
    return;
  }
  drawTrail(g);
  tcpMarkers(g);
  highlightRing(g);
  cornerGizmo(g);
}