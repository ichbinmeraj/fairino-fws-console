// Telemetry stream: ws://<gateway>/ws/state, ~10 Hz.
//
// The same-origin policy does not apply to WebSockets, so this connects to
// the gateway directly even when REST is going through the dev proxy.
//
// The frame carries its own health: `connected` is the gateway's view of the
// 8083 link, and `bad_checksum` counts frames the gateway threw away. Both
// matter. A socket that is open while `connected` is false means FWS is up
// and the robot link is not -- a distinction a plain "disconnected" dot would
// lose, and the one that tells you where to go looking.

const FIELDS = [
  'connected', 'frames', 'bad_checksum', 'error', 'counter', 'program_state',
  'joints', 'tcp', 'joint_torque', 'ft', 'force', 'error_main', 'error_sub',
  'limits',
];

export class Stream {
  constructor(wsOrigin) {
    this.url = `${wsOrigin}/ws/state`;
    this.ws = null;
    this.frame = null;
    this.socketOpen = false;
    this.stale = true;
    this.lastFrameAt = 0;
    this.retries = 0;
    this.closed = false;

    this.onFrame = () => {};
    this.onStatus = () => {};

    // Frames arrive at 10 Hz. Half a second of silence is already several
    // missed frames, which is worth showing before the socket itself notices.
    this._watch = setInterval(() => {
      const stale = !this.socketOpen || (performance.now() - this.lastFrameAt) > 500;
      if (stale !== this.stale) {
        this.stale = stale;
        this.onStatus(this.status);
      }
    }, 200);
  }

  get status() {
    if (!this.socketOpen) return 'offline';
    if (this.stale) return 'stale';
    if (this.frame && this.frame.connected === false) return 'no-robot';
    return 'live';
  }

  connect() {
    this.closed = false;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch {
      return this._retry();
    }
    this.ws = ws;

    ws.onopen = () => {
      this.socketOpen = true;
      this.retries = 0;
      this.onStatus(this.status);
    };

    ws.onmessage = (ev) => {
      let f;
      try { f = JSON.parse(ev.data); } catch { return; }
      this.frame = f;
      this.lastFrameAt = performance.now();
      if (this.stale) { this.stale = false; this.onStatus(this.status); }
      this.onFrame(f);
    };

    ws.onclose = () => {
      this.socketOpen = false;
      this.onStatus(this.status);
      if (!this.closed) this._retry();
    };

    ws.onerror = () => { try { ws.close(); } catch { /* onclose handles it */ } };
  }

  _retry() {
    // Backing off matters here: the gateway may be down for a while, and a
    // console retrying at 10 Hz over an SSH tunnel is its own problem.
    const delay = Math.min(500 * 2 ** this.retries++, 10000);
    setTimeout(() => { if (!this.closed) this.connect(); }, delay);
  }

  close() {
    this.closed = true;
    clearInterval(this._watch);
    if (this.ws) try { this.ws.close(); } catch { /* already gone */ }
  }
}

/** The gateway's EVENT socket: what changed, pushed, rather than what is.
 *
 * /ws/state is a 10 Hz sample. This is edge-triggered — a fault latching, a
 * program finishing, the watchdog stopping the arm — so the console reacts
 * the moment it happens instead of noticing on the next poll. The watchdog
 * stop in particular had no other way to reach a person.
 *
 * Deliberately a separate socket from the telemetry one: they have different
 * failure modes, and a console that loses its event feed should still show
 * live joint positions rather than going dark.
 */
export class Events {
  constructor(wsOrigin, getKey = () => null) {
    // The key is read at CONNECT time, not here: it is typed into the
    // sidebar after boot, so baking it in at construction would leave the
    // event socket permanently unauthenticated on a keyed gateway.
    this.wsOrigin = wsOrigin;
    this.getKey = getKey;
    this.ws = null;
    this.retries = 0;
    this.closed = false;
    this.onEvent = () => {};
  }

  connect() {
    this.closed = false;
    const key = this.getKey();
    const url = `${this.wsOrigin}/ws/events`
      + (key ? `?key=${encodeURIComponent(key)}` : '');
    let ws;
    try { ws = new WebSocket(url); } catch { return this._retry(); }
    this.ws = ws;
    ws.onopen = () => { this.retries = 0; };
    ws.onmessage = (ev) => {
      let e;
      try { e = JSON.parse(ev.data); } catch { return; }
      // The gateway sends a keepalive when idle so a quiet stream is
      // distinguishable from a dead one; it is not an event.
      if (!e || e.kind === 'keepalive') return;
      this.onEvent(e);
    };
    ws.onclose = () => { if (!this.closed) this._retry(); };
    ws.onerror = () => { try { ws.close(); } catch { /* onclose handles it */ } };
  }

  _retry() {
    const delay = Math.min(500 * 2 ** this.retries++, 10000);
    setTimeout(() => { if (!this.closed) this.connect(); }, delay);
  }

  close() {
    this.closed = true;
    if (this.ws) try { this.ws.close(); } catch { /* already gone */ }
  }
}

export { FIELDS };
