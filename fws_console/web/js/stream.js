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

export { FIELDS };
