// Sparklines for live telemetry: small multiples, one per signal.
//
// Design rules (from the dataviz method): a single hue for data — status
// colors stay reserved for status; 2px line with a soft area fill; grid and
// axes recessive to invisible (the spark's own box is the frame); the title
// names the single series so there is no legend; numbers wear text tokens,
// not the series color. Hover scrubs the history and shows the value at the
// pointer, because an HTML chart is interactive by default.
//
// Small multiples invite comparison, so tiles in one SharedScale group share
// a symmetric domain around a drawn zero line: a joint carrying 25x the
// torque must LOOK 25x, not identical.

const WINDOW_S = 60;

let PAL = null;
function palette() {
  if (PAL) return PAL;
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  PAL = {
    data: css('--data') || '#0ca3be',
    faint: css('--faint') || '#5d646b',
    line: css('--line') || '#21272e',
    surface: css('--surface') || '#13191f',
  };
  return PAL;
}
/** Call on theme change: colors are cached because getComputedStyle at
 * 10 Hz x 6 tiles forces a style recalc per call. */
export function invalidateChartTheme() { PAL = null; }

export class SharedScale {
  constructor() { this.half = 0.5; this.decay = 0; }

  /** Track the running max |v|, decaying slowly so an old spike does not
   * flatten the group forever. Returns the symmetric half-range. */
  update(absMax) {
    if (absMax > this.half) { this.half = absMax; this.decay = 0; }
    if (++this.decay > 600) {           // ~60 s at 10 Hz
      this.half = Math.max(0.5, this.half * 0.85);
      this.decay = 0;
    }
    return this.half * 1.1;
  }
}

export class Spark {
  /**
   * @param {HTMLElement} host   empty container; the spark builds its own DOM
   * @param {string} label       short signal name, e.g. "J1"
   * @param {SharedScale} scale  shared domain for the whole tile group
   */
  constructor(host, label, scale) {
    this.scale = scale;
    host.className = 'spark';
    host.innerHTML = `
      <div class="spark-head">
        <span>${label}</span><b>—</b>
      </div>
      <canvas></canvas>`;
    this.valueEl = host.querySelector('b');
    this.canvas = host.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');

    this.t = [];        // seconds (performance.now()/1000)
    this.v = [];
    this.hoverX = null; // 0..1 across the window, or null

    this.canvas.addEventListener('pointermove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.hoverX = (e.clientX - r.left) / r.width;
      this.draw();
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.hoverX = null;
      this.draw();
    });

    new ResizeObserver(() => this._resize()).observe(this.canvas);
    this._resize();
  }

  _resize() {
    // Tiles are 24px tall with no text: dpr 1 is indistinguishable and
    // divides the pixels pushed per redraw by dpr^2.
    const dpr = 1;
    const r = this.canvas.getBoundingClientRect();
    if (!r.width) return;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = r.width;
    this.h = r.height;
    this.draw();
  }

  /** Store a sample without painting: history stays complete even while
   * the tile is off-screen; the shell decides when drawing is worth it. */
  record(value) {
    const now = performance.now() / 1000;
    this.t.push(now);
    this.v.push(value);
    // drop everything older than the window (plus slack so the left edge
    // exits smoothly instead of popping)
    const cut = now - WINDOW_S - 2;
    let i = 0;
    while (i < this.t.length && this.t[i] < cut) i++;
    if (i) { this.t.splice(0, i); this.v.splice(0, i); }

    let m = 0;
    for (const v of this.v) { const a = Math.abs(v); if (a > m) m = a; }
    this._absMax = m;
  }

  push(value) {
    this.record(value);
    this.draw();
  }

  draw() {
    const g = this.ctx;
    if (!g || !this.w) return;
    g.clearRect(0, 0, this.w, this.h);
    const n = this.v.length;
    if (n < 2) { this.valueEl.textContent = '—'; return; }

    const now = performance.now() / 1000;
    const t0 = now - WINDOW_S;
    // symmetric shared domain with a zero baseline
    const half = this.scale ? this.scale.update(this._absMax || 0)
      : Math.max(0.5, (this._absMax || 0) * 1.1);

    const X = (t) => ((t - t0) / WINDOW_S) * this.w;
    const Y = (v) => this.h / 2 - (v / half) * (this.h / 2 - 3);

    const pal = palette();

    // zero baseline, recessive
    g.strokeStyle = pal.line;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, Y(0) + 0.5);
    g.lineTo(this.w, Y(0) + 0.5);
    g.stroke();

    // area fill, very quiet
    g.beginPath();
    g.moveTo(X(this.t[0]), Y(this.v[0]));
    for (let i = 1; i < n; i++) g.lineTo(X(this.t[i]), Y(this.v[i]));
    g.lineTo(X(this.t[n - 1]), Y(0));
    g.lineTo(X(this.t[0]), Y(0));
    g.closePath();
    g.globalAlpha = 0.12;
    g.fillStyle = pal.data;
    g.fill();
    g.globalAlpha = 1;

    // the line itself: 2px, the one data hue
    g.beginPath();
    g.moveTo(X(this.t[0]), Y(this.v[0]));
    for (let i = 1; i < n; i++) g.lineTo(X(this.t[i]), Y(this.v[i]));
    g.strokeStyle = pal.data;
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.stroke();

    // hover scrub: nearest sample, marked, value shown in the head
    let shown = this.v[n - 1];
    if (this.hoverX !== null) {
      const tx = t0 + this.hoverX * WINDOW_S;
      let best = 0, bd = Infinity;
      for (let i = 0; i < n; i++) {
        const d = Math.abs(this.t[i] - tx);
        if (d < bd) { bd = d; best = i; }
      }
      shown = this.v[best];
      const hx = X(this.t[best]), hy = Y(this.v[best]);
      g.strokeStyle = pal.faint;
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(hx, 0); g.lineTo(hx, this.h); g.stroke();
      g.fillStyle = pal.data;
      g.beginPath(); g.arc(hx, hy, 3, 0, Math.PI * 2); g.fill();
      g.strokeStyle = pal.surface;
      g.lineWidth = 2;
      g.beginPath(); g.arc(hx, hy, 3, 0, Math.PI * 2); g.stroke();
    }

    const digits = Math.abs(shown) >= 100 ? 1 : 2;
    this.valueEl.textContent = shown.toFixed(digits);
  }
}
