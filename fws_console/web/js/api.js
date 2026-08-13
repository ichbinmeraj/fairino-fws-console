// REST client for an FWS gateway.
//
// Two things here are not incidental and should not be "simplified" away:
//
//   1. The control lease expires. FWS holds a 30 s lease and its watchdog
//      STOPS THE ROBOT when one lapses (fws/app.py, [watchdog]). A console
//      that forgets to renew does not merely lose permission -- it halts
//      motion mid-move. Lease.start() renews at a third of the TTL so two
//      consecutive failures still leave a whole interval of headroom.
//
//   2. Errors carry meaning. 423 means someone else holds the lock and the
//      body names them; 422 is a rejected argument with the bound that was
//      violated. Both are useful to a human, so ApiError keeps the parsed
//      body rather than flattening everything to a status code.

export class ApiError extends Error {
  constructor(status, body, path) {
    super(ApiError.describe(status, body, path));
    this.status = status;
    this.body = body;
    this.path = path;
  }

  static describe(status, body, path) {
    const d = body && body.detail;

    // FastAPI validation errors: a list of per-field failures. The bound that
    // was violated is the interesting part -- "step must be <= 15", not
    // "422 Unprocessable Entity".
    if (Array.isArray(d)) {
      return d.map((e) => {
        const field = (e.loc || []).slice(1).join('.') || 'body';
        const ctx = e.ctx ? ` (${Object.entries(e.ctx).map(([k, v]) => `${k}=${v}`).join(', ')})` : '';
        return `${field}: ${e.msg}${ctx}`;
      }).join('; ');
    }
    if (d && typeof d === 'object') {
      const holder = d.holder ? ` (held by ${d.holder.client_id})` : '';
      return `${d.message || JSON.stringify(d)}${holder}`;
    }
    if (typeof d === 'string') return d;
    return `HTTP ${status} from ${path}`;
  }

  /** True when this is the control lock refusing us, not a bad request. */
  get isLocked() { return this.status === 423; }
}

export class Api {
  /**
   * @param {string} base  gateway origin, or '' for same-origin (dev proxy)
   */
  constructor(base = '') {
    this.base = base.replace(/\/$/, '');
    this.apiKey = null;
    this.token = null;      // control lease token, set by Lease
  }

  get root() { return this.base || location.origin; }

  /** ws:// or wss:// origin for the telemetry stream. */
  get wsOrigin() {
    const u = new URL(this.base || location.origin);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return u.origin;
  }

  async request(method, path, body, { signal, timeout = 15000 } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.apiKey) headers['X-API-Key'] = this.apiKey;
    if (this.token) headers['X-FWS-Control-Token'] = this.token;

    // A gateway on the far side of a tunnel can hang rather than refuse.
    // Without this the UI has no way back to a usable state. Track WHY we
    // aborted so the error can tell a slow-but-reachable gateway apart from an
    // unreachable one -- conflating them once made a 45 s FTP probe read as
    // "cannot reach gateway", which is both wrong and alarming.
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeout);
    if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });

    let res, text;
    try {
      res = await fetch(this.base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
      if (res.status === 204) return null;
      // The body read is inside the try on purpose: a connection reset
      // mid-body throws here too, and it must surface as an ApiError with a
      // status-shaped body, not a raw TypeError that every `e.status` and
      // `e.isLocked` check downstream would mishandle.
      text = await res.text();
    } catch (e) {
      if (timedOut) {
        const secs = Math.round(timeout / 1000);
        throw new ApiError(0, { detail:
          `the gateway did not answer within ${secs}s. The controller-side `
          + `call may still be running — a slow FTP transfer or service probe `
          + `can take longer than that. Retry, or raise the request timeout.`,
        }, path);
      }
      if (signal && signal.aborted) {
        // The caller cancelled (navigated away, or a newer request supersedes
        // this one). Not a failure worth surfacing as a red banner.
        throw new ApiError(0, { detail: 'request cancelled' }, path);
      }
      throw new ApiError(0, { detail: `cannot reach gateway: ${e.message}` }, path);
    } finally {
      clearTimeout(timer);
    }

    let parsed = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = { detail: text }; }
    }
    if (!res.ok) throw new ApiError(res.status, parsed, path);
    return parsed;
  }

  get(p, o) { return this.request('GET', p, undefined, o); }
  post(p, b, o) { return this.request('POST', p, b, o); }
  put(p, b, o) { return this.request('PUT', p, b, o); }
  del(p, o) { return this.request('DELETE', p, undefined, o); }

  // --- read-only surfaces -------------------------------------------------

  state()        { return this.get('/api/v1/state'); }
  robot()        { return this.get('/api/v1/robot'); }
  limits()       { return this.get('/api/v1/robot/limits'); }
  capabilities() { return this.get('/api/v1/capabilities'); }
  health()       { return this.get('/api/v1/system/health'); }
  errors()       { return this.get('/api/v1/errors'); }
  events(limit = 100) { return this.get(`/api/v1/events?limit=${limit}`); }
  controlStatus(){ return this.get('/api/v1/control'); }

  // --- commanding ---------------------------------------------------------

  enable(on)     { return this.post('/api/v1/robot/enable', { enable: on, confirm: true }); }
  resetErrors()  { return this.post('/api/v1/errors/reset', {}); }
  stop()         { return this.post('/api/v1/motion/stop', {}); }

  jog(joint, direction, step, vel) {
    return this.post('/api/v1/motion/jog', { joint, direction, step, vel });
  }

  jogLinear(axis, direction, step, vel) {
    return this.post('/api/v1/motion/jog/linear', { axis, direction, step, vel });
  }
}

/**
 * A held control lease, kept alive.
 *
 * onChange(state) fires with 'held' | 'lost' | 'released' so the UI can grey
 * out every commanding control the moment the lease is in doubt -- before the
 * user presses something that will fail.
 */
export class Lease {
  // Both domains: jogging and enable need 'motion'; program load/select/run
  // checks 'program'. Holding one without the other makes half the console
  // fail with 423s that look like bugs.
  constructor(api, { clientId = `console-${Math.random().toString(36).slice(2, 8)}`,
                     domains = ['motion', 'program'], ttl = 30 } = {}) {
    this.api = api;
    this.clientId = clientId;
    this.domains = domains;
    this.ttl = ttl;
    this.timer = null;
    this.held = false;
    this.onChange = () => {};
    this.lastError = null;
    this.gen = 0;      // bumped on acquire/release so stale heartbeats no-op
  }

  async acquire() {
    this.gen++;
    const lease = await this.api.post('/api/v1/control', {
      client_id: this.clientId, domains: this.domains, ttl_s: this.ttl,
    });
    this.api.token = lease.token;
    this.held = true;
    this.lastError = null;
    this._schedule();
    this.onChange('held', lease);
    return lease;
  }

  _schedule() {
    clearInterval(this.timer);
    // A third of the TTL: two failures in a row and we still have ~10 s to
    // recover before the watchdog stops the arm.
    this.timer = setInterval(() => this._beat(), (this.ttl * 1000) / 3);
  }

  async _beat() {
    const gen = this.gen;
    try {
      const lease = await this.api.post(
        `/api/v1/control/heartbeat?ttl_s=${this.ttl}`, {},
      );
      // A release/acquire may have happened while this was in flight; a
      // stale success must not flip the UI back to "held".
      if (gen !== this.gen) return;
      this.onChange('held', lease);
    } catch (e) {
      if (gen !== this.gen) return;   // deliberate release, not a loss
      // 404 means the lease already lapsed; anything else may be transient,
      // but we cannot tell the difference from here and the consequence of
      // guessing wrong is an arm that keeps moving with nobody renewing.
      this.held = false;
      this.lastError = e;
      clearInterval(this.timer);
      this.api.token = null;
      this.onChange('lost', e);
    }
  }

  async release() {
    this.gen++;
    clearInterval(this.timer);
    const had = this.held;
    this.held = false;
    try {
      if (had) await this.api.del('/api/v1/control');
    } finally {
      this.api.token = null;
      this.onChange('released');
    }
  }
}
