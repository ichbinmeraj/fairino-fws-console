// Console shell: theme, navigation, status, control lease, jogging, charts.

import { Api, ApiError, Lease } from './api.js';
import { Stream } from './stream.js';
import { View3D } from './view3d.js';
import { MODELS, agreement, modelFor, verdict } from './kin.js';
import { PANELS } from './panels.js';
import { DEV_PANELS } from './devpanels.js';
import { WB_PANELS } from './workbench.js';
import { invalidateChartTheme, SharedScale, Spark } from './charts.js';
import {
  closePalette, dialog, openPalette, paletteOpen, registerPalette,
  shortcutsSheet,
} from './ui.js';

const api = new Api('');            // same origin: the gateway serves this page
const lease = new Lease(api);
const stream = new Stream(api.wsOrigin);
const $ = (id) => document.getElementById(id);

let model = MODELS.sim;
// The simulator reports the same identity string as real hardware, so the
// model cannot be picked by name. Instead every candidate is scored against
// the controller's own reported TCP for the first second of frames and the
// one that measures best wins — the same honesty machinery as the badge.
let candidates = null;              // [{model, sum, n}] while unlocked
let commanding = false;             // one command in flight at a time, on purpose
let lastLimits = null;
let readOnly = false;
let toolOffset = null;
let toolKnown = false;      // false => the drawn tip omits the tool transform
let enabledState = null;            // null = unknown until first command
let leaseExpiresAt = 0;             // epoch seconds, for the local countdown
let leaseTtl = 30;

/* ---------------------------------------------------------------- theme */

const THEMES = ['dark', 'light', 'system'];

function applyTheme(pref) {
  const resolved = pref === 'system'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : pref;
  document.documentElement.dataset.theme = resolved;
  try { localStorage.setItem('fws-theme', pref); } catch { /* private mode */ }
  invalidateChartTheme();
  view.invalidateTheme();
  view.syncTheme?.();
  const label = $('theme-label');
  if (label) label.textContent = pref;
}

function themePref() {
  try { return localStorage.getItem('fws-theme') || 'dark'; } catch { return 'dark'; }
}

matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (themePref() === 'system') applyTheme('system');
});

/* ---------------------------------------------------------------- auth */

// The key lives in this browser only. It is sent as X-API-Key on every
// request by Api.request(); the gateway serves /console itself unauthenticated
// so this page can load in order to ask for it.
function setApiKey(key) {
  api.apiKey = key || null;
  try {
    if (key) localStorage.setItem('fws-api-key', key);
    else localStorage.removeItem('fws-api-key');
  } catch { /* private mode: key lives for this page only */ }
  const label = $('key-label');
  if (label) label.textContent = key ? 'key set' : 'no key';
}

try { api.apiKey = localStorage.getItem('fws-api-key') || null; } catch { /* ignore */ }

/* ---------------------------------------------------------------- toasts */

function toast(msg, kind = '', sticky = false) {
  const host = $('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  el.onclick = () => el.remove();
  host.append(el);
  while (host.childElementCount > 5) host.firstElementChild.remove();
  if (!sticky) setTimeout(() => el.remove(), 6000);
}

/* ---------------------------------------------------------------- log */

function log(msg, kind = '') {
  const el = $('log');
  const line = document.createElement('div');
  const t = document.createElement('time');
  t.textContent = new Date().toLocaleTimeString();
  const body = document.createElement('span');
  body.className = kind;
  body.textContent = msg;
  line.append(t, body);
  el.prepend(line);
  while (el.childElementCount > 300) el.lastElementChild.remove();
}

/** Every command goes through here so no failure is ever silent.
 *
 * Returns RUN_FAILED on any failure instead of rethrowing, so callers that
 * ignore the result do not shower the console with unhandled rejections.
 * `priority` bypasses the single-flight gate: Stop must NEVER be a no-op
 * while a slow jog is still in flight.
 */
const RUN_FAILED = Symbol('run-failed');

async function run(label, fn, { quiet = false, priority = false } = {}) {
  if (commanding && !priority) {
    jogNote('busy — previous command still in flight', 'warn');
    return RUN_FAILED;
  }
  if (!priority) { commanding = true; syncControls(); }
  try {
    const out = await fn();
    log(label);
    return out;
  } catch (e) {
    const kind = e instanceof ApiError && e.isLocked ? 'warn' : 'err';
    log(`failed: ${label} — ${e.message}`, kind);
    if (quiet) jogNote(e.message, kind);
    else toast(`${label} failed: ${e.message}`, kind === 'warn' ? 'warn' : 'err');
    return RUN_FAILED;
  } finally {
    if (!priority) { commanding = false; syncControls(); }
  }
}

/** Inline status line under the jog pad: errors where the operator's eyes
 * are, not only in the distant activity log. */
let jogNoteTimer = 0;
function jogNote(msg, kind = 'warn') {
  const el = $('jog-note');
  if (!el) return;
  el.textContent = msg;
  el.className = `small ${kind === 'err' ? 'dim' : 'dim'}`;
  el.style.color = kind === 'err' ? 'var(--danger)' : 'var(--warn)';
  clearTimeout(jogNoteTimer);
  jogNoteTimer = setTimeout(() => { el.textContent = ''; }, 4500);
}

/* ---------------------------------------------------------------- lease */

const ARC_LEN = 2 * Math.PI * 19;
$('lease-arc').style.strokeDasharray = String(ARC_LEN);
$('lease-arc').style.strokeDashoffset = String(ARC_LEN);

// Local 1 Hz countdown between heartbeats, so the ring visibly drains
// instead of jumping every renewal.
setInterval(() => {
  if (!lease.held) return;
  const left = Math.max(0, leaseExpiresAt - Date.now() / 1000);
  const frac = Math.min(1, left / leaseTtl);
  $('lease-arc').style.strokeDashoffset = String(ARC_LEN * (1 - frac));
  $('lease-sub').textContent = `renews automatically · ${left.toFixed(0)}s`;
}, 1000);

lease.onChange = (state, info) => {
  const ring = $('lease-ring');
  if (state === 'held') {
    if (info) {
      // Anchor on the local clock: gateways on air-gapped cells have skewed
      // wall clocks, and expires_at is the gateway's epoch, not ours.
      leaseTtl = Math.max(5, info.expires_in_s || 30);
      leaseExpiresAt = Date.now() / 1000 + leaseTtl;
    }
    ring.classList.remove('lost');
    $('lease-title').textContent = 'In control';
    $('lease-sub').textContent = 'renews automatically';
    setStatus('sc-lease', 'ok', 'held');
  } else if (state === 'lost') {
    ring.classList.add('lost');
    $('lease-arc').style.strokeDashoffset = String(ARC_LEN);
    $('lease-title').textContent = 'Control LOST';
    $('lease-sub').textContent = 'the gateway watchdog stops motion';
    setStatus('sc-lease', 'bad', 'LOST');
    toast('Control lease lost — the gateway watchdog will stop motion', 'err', true);
    log('control lease lost — the gateway watchdog will stop motion', 'err');
  } else {
    ring.classList.remove('lost');
    $('lease-arc').style.strokeDashoffset = String(ARC_LEN);
    $('lease-title').textContent = 'Observing';
    $('lease-sub').textContent = 'no control held';
    setStatus('sc-lease', '', 'observe');
  }
  syncControls();
};

$('btn-lease').onclick = async () => {
  if (lease.held) {
    await run('released control', () => lease.release());
  } else {
    await run('took control', () => lease.acquire());
  }
};

/* ---------------------------------------------------------------- status */

function setStatus(id, level, text) {
  for (const cell of [$(id), $(`strip-${id}`)]) {
    if (!cell) continue;
    cell.classList.remove('is-ok', 'is-warn', 'is-bad');
    if (level) cell.classList.add(`is-${level}`);
    const t = cell.querySelector('span, b');
    if (text !== undefined && t) t.textContent = text;
  }
}

/** The narrow layout hides the header cluster; mirror it into the strip so
 * a tablet operator is never blind to stream/lease/power state. */
function buildStatusStrip() {
  $('status-strip').innerHTML = ['sc-stream', 'sc-lease', 'sc-enable']
    .map((id) => {
      const src = $(id);
      const clone = src.cloneNode(true);
      clone.id = `strip-${id}`;
      for (const child of clone.querySelectorAll('[id]')) child.removeAttribute('id');
      return clone.outerHTML;
    }).join('');
}

/* ---------------------------------------------------------------- commands */

const enableSwitch = $('switch-enable');

enableSwitch.onclick = () => {
  const next = enableSwitch.getAttribute('aria-checked') !== 'true';
  run(next ? 'enabled arm' : 'disabled arm', () => api.enable(next))
    .then((r) => {
      if (r === RUN_FAILED) return;
      enabledState = next;
      reflectEnable();
    });
};

function reflectEnable() {
  // The gateway reports no arm-power field on any endpoint, so until the
  // operator commands enable/disable the state is genuinely UNKNOWN. Render
  // that as a distinct third position (not a confident "off"), so nobody
  // toggles a switch believing it reflects the arm.
  enableSwitch.setAttribute('aria-checked', String(enabledState === true));
  enableSwitch.classList.toggle('unknown', enabledState === null);
  enableSwitch.title = enabledState === null
    ? 'The gateway does not report arm power; take control and toggle to set it.'
    : '';
  $('enable-label').textContent =
    enabledState === null ? 'Unknown' : enabledState ? 'Enabled' : 'Disabled';
  setStatus('sc-enable',
    enabledState ? 'ok' : enabledState === null ? 'warn' : '',
    enabledState === null ? '?' : enabledState ? 'on' : 'off');
}

$('btn-reset').onclick = () => run('reset faults', () => api.resetErrors());
$('fault-banner-reset').onclick = () => run('reset faults', () => api.resetErrors());
$('btn-stop').onclick = () => run('STOP', () => api.stop(), { priority: true });
$('btn-trail').onclick = () => view.clearTrail();
$('btn-view-fit').onclick = () => view.fit();

// Esc = stop. The one keyboard shortcut, because reaching for a pointing
// device mid-surprise is the slow path. Jogging has no keys, deliberately.
const SHORTCUTS = [
  ['⌘+K', 'Command palette — jump to any panel, endpoint or wire command'],
  ['Ctrl+K', 'Same, on Windows and Linux'],
  ['Esc', 'STOP the robot (with control held) · close the palette'],
  ['g then 1…9', 'Go to the nth panel'],
  ['?', 'This sheet'],
];

let goPrefix = false;

window.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)
    || e.target.isContentEditable;

  // Palette: the one chord every developer tool has.
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    paletteOpen() ? closePalette() : openPalette();
    return;
  }

  if (e.key === 'Escape') {
    if (paletteOpen()) { closePalette(); return; }
    // A modal owns Escape: it must cancel the dialog, never fall through to
    // STOP. Letting it through both blocked <dialog>'s native close (we call
    // preventDefault below) and fired a robot command from a keypress the
    // operator meant as "no".
    if (document.querySelector('dialog[open]')) return;
    if (typing) return;                    // let fields clear themselves
    e.preventDefault();
    if (lease.held && !readOnly) {
      run('STOP (Esc)', () => api.stop(), { priority: true });
    } else if (!readOnly) {
      toast('No control held — take control to stop from here', 'warn');
    }
    return;
  }

  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key === '?') { e.preventDefault(); shortcutsSheet(SHORTCUTS); return; }

  // vim-ish "g then n" jump, the pattern developer tools settled on.
  if (e.key === 'g') { goPrefix = true; setTimeout(() => { goPrefix = false; }, 900); return; }
  if (goPrefix && /^[1-9]$/.test(e.key)) {
    goPrefix = false;
    const t = TABS[Number(e.key) - 1];
    if (t) { e.preventDefault(); selectTab(t[0]); }
  }
});

/* ---------------------------------------------------------------- jog */

let step = 1;
const STEPS = [0.5, 1, 5, 10];

function buildStepSeg() {
  const seg = $('seg-step');
  for (const s of STEPS) {
    const b = document.createElement('button');
    b.textContent = String(s);
    b.setAttribute('aria-pressed', String(s === step));
    b.onclick = () => {
      step = s;
      for (const x of seg.children) {
        x.setAttribute('aria-pressed', String(x === b));
      }
    };
    seg.append(b);
  }
}

$('in-vel').oninput = () => { $('vel-label').textContent = `${$('in-vel').value}%`; };

function vel() { return parseFloat($('in-vel').value) || 10; }

function jogRow(host, axisLabel, valId, onMinus, onPlus) {
  const row = document.createElement('div');
  row.className = 'jog-row';
  row.innerHTML = `
    <span class="axis">${axisLabel}</span>
    <span class="val num" id="${valId}">—</span>
    <span class="jog-pair">
      <button class="btn" data-cmd="1" aria-label="${axisLabel} minus">−</button>
      <button class="btn" data-cmd="1" aria-label="${axisLabel} plus">+</button>
    </span>`;
  const [minus, plus] = row.querySelectorAll('button');
  minus.onclick = onMinus;
  plus.onclick = onPlus;
  host.append(row);
}

function buildJogPads() {
  const pad = $('jogpad');
  pad.innerHTML = '';
  for (let j = 1; j <= 6; j++) {
    // Gateway direction contract is 0/1 (Fairino wire convention), NOT ±1.
    jogRow(pad, `J${j}`, `jog-val-${j}`,
      () => run(`jog J${j} −${step}°`, () => api.jog(j, 0, step, vel()), { quiet: true }),
      () => run(`jog J${j} +${step}°`, () => api.jog(j, 1, step, vel()), { quiet: true }));
  }
  const lin = $('jogpad-lin');
  lin.innerHTML = '';
  ['X', 'Y', 'Z', 'RX', 'RY', 'RZ'].forEach((axis, i) => {
    jogRow(lin, axis, `lin-val-${i}`,
      () => run(`jog ${axis} −${step}`, () => api.jogLinear(i + 1, 0, step, vel()), { quiet: true }),
      () => run(`jog ${axis} +${step}`, () => api.jogLinear(i + 1, 1, step, vel()), { quiet: true }));
  });
}

/**
 * A control that cannot work must look like it cannot work. Without the
 * lease every command 423s, so grey them out rather than let the operator
 * discover it one failed press at a time.
 */
function syncControls() {
  const ready = !readOnly && lease.held && !commanding;
  for (const b of document.querySelectorAll('[data-cmd]')) b.disabled = !ready;
  enableSwitch.disabled = !ready;
  $('btn-reset').disabled = !ready;
  $('fault-banner-reset').disabled = !ready;
  $('btn-stop').disabled = readOnly || !lease.held;
  $('btn-lease').disabled = readOnly || commanding;
  const hint = $('jog-hint');
  if (hint) hint.hidden = ready || readOnly;
  $('btn-lease').innerHTML = lease.held
    ? 'Release'
    : '<svg viewBox="0 0 17 17"><use href="#i-key"/></svg>Take control';
}

/* ---------------------------------------------------------------- stage */

const view = new View3D($('view'));

for (const b of document.querySelectorAll('#seg-view button')) {
  b.onclick = () => {
    view.preset(b.dataset.view);
    for (const x of b.parentElement.children) {
      x.setAttribute('aria-pressed', String(x === b));
    }
  };
}
// A manual drag leaves no preset active: the highlight must not lie.
view.onGrab = () => {
  for (const x of document.querySelectorAll('#seg-view button')) {
    x.setAttribute('aria-pressed', 'false');
  }
};

/* ---------------------------------------------------------------- charts */

const sparks = [];
function buildSparks() {
  const host = $('sparks');
  const scale = new SharedScale();     // comparable tiles: one shared domain
  for (let j = 1; j <= 6; j++) {
    const div = document.createElement('div');
    host.append(div);
    sparks.push(new Spark(div, `J${j}`, scale));
  }
}

/* ---------------------------------------------------------------- frames */

let frames = 0;
let rateAt = performance.now();
let faultShown = false;
let pendingFrame = null;
let renderQueued = false;
const operateSection = document.querySelector('section[data-tab="operate"]');

stream.onStatus = (s) => {
  const map = {
    live: ['ok', 'live'],
    stale: ['warn', 'stale'],
    offline: ['bad', 'gateway offline'],
    'no-robot': ['bad', 'robot link down'],
  };
  const [level, text] = map[s] || ['', s];
  setStatus('sc-stream', level, text);
  // Frozen numbers must never pass for live ones: dim every live value and
  // scrim the stage the moment the stream is not fresh.
  document.body.dataset.stream = s;
  const scrim = $('stage-scrim');
  if (scrim) {
    scrim.hidden = s === 'live';
    scrim.textContent = s === 'stale' ? 'TELEMETRY STALE — values frozen'
      : s === 'no-robot' ? 'ROBOT LINK DOWN — values frozen'
      : 'GATEWAY OFFLINE — values frozen';
  }
};

// Frame handling is split: the WebSocket callback does only the cheap,
// always-required work (state capture, fault detection, chart history,
// model scoring), and everything that paints runs in ONE rAF pass. rAF
// does not fire in hidden browser tabs, so a backgrounded console costs
// nearly nothing; when another panel is selected, the heavy Operate
// rendering is skipped while annunciators and the fault banner stay live.
stream.onFrame = (f) => {
  frames++;
  pendingFrame = f;
  if (f.limits) lastLimits = f.limits;
  // Panels outside this module (the Develop workbench) subscribe to frames
  // through this event rather than the render pipeline; a hidden panel
  // returns immediately, so the cost is one dispatch per frame.
  document.dispatchEvent(new CustomEvent('fws-frame', { detail: f }));
  try { renderFault(f); } catch (e) { /* never let a bad frame break the loop */
    if (!stream._faultWarned) { stream._faultWarned = true; log(`fault render: ${e.message}`, 'err'); }
  }
  if (f.joints && candidates) lockModel(f);
  if (f.joint_torque) {
    for (let i = 0; i < sparks.length && i < f.joint_torque.length; i++) {
      sparks[i].record(f.joint_torque[i]); // history complete even off-screen
    }
  }
  if (!renderQueued) {
    renderQueued = true;
    requestAnimationFrame(renderTick);
  }
};

function renderTick() {
  renderQueued = false;
  const f = pendingFrame;
  if (!f) return;
  try {
    renderTickInner(f);
  } catch (e) {
    // A malformed frame must not freeze the display under a "live" badge —
    // that is the one failure this console exists to prevent. Degrade the
    // stream indicator and say so, once.
    if (!renderTick._broke) {
      renderTick._broke = true;
      log(`render error: ${e.message}`, 'err');
      setStatus('sc-stream', 'bad', 'render error');
      const scrim = $('stage-scrim');
      if (scrim) { scrim.hidden = false; scrim.textContent = 'RENDER ERROR — values may be stale'; }
    }
  }
}

function renderTickInner(f) {

  const now = performance.now();
  if (now - rateAt > 1000) {
    $('stream-rate').textContent = `${(frames * 1000 / (now - rateAt)).toFixed(1)} Hz`;
    frames = 0; rateAt = now;
  }

  if (operateSection.hidden) return;       // another panel is on screen

  renderJoints(f);
  renderTcp(f);
  renderStreamHealth(f);
  for (const sp of sparks) sp.draw();

  if (f.joints) {
    // One FK per frame: frames() feeds the meshes, the skeleton points and
    // the badge comparison alike.
    const fr = model.frames ? model.frames(f.joints) : null;
    const pts = model.points(f.joints, toolOffset, fr);
    view.setPose(pts, model, fr);
    let err = null;
    if (f.tcp) {
      const tip = pts[pts.length - 1];
      err = Math.hypot(tip[0] - f.tcp[0], tip[1] - f.tcp[1], tip[2] - f.tcp[2]);
    }
    const v = toolKnown || err === null || err < 1.0
      ? verdict(err)
      : { level: 'warn',
          text: `tool offset unknown — tip drawn to the flange (${err.toFixed(0)} mm)` };
    const badge = $('model-badge');
    badge.textContent = v.text;
    badge.title = toolKnown ? ''
      : 'The controller refused the tool-frame getter, so the drawn tip omits '
      + 'the tool transform that the reported TCP includes. Clearing the '
      + 'fault usually restores it.';
    badge.className = `tag ${v.level === 'ok' ? 'ok' : v.level === 'warn' ? 'warn' : v.level === 'bad' ? 'bad' : ''}`;
  }
}

let lockAttempts = 0;
function lockModel(f) {
  for (const c of candidates) {
    const e = agreement(c.model, f.joints, f.tcp, toolOffset);
    if (e !== null) { c.sum += e; c.n++; }
  }
  // Frames without a TCP can never score; after ~5 s stop waiting and go
  // with the model the controller named, meshes included.
  if (++lockAttempts > 50 && !candidates.some((c) => c.n > 0)) {
    candidates = null;
    $('model-note').textContent = model.note;
    loadMeshes(model);
    return;
  }
  if (!candidates.some((c) => c.n >= 12)) return;
  const best = candidates.reduce((a, b) =>
    (a.sum / (a.n || 1)) <= (b.sum / (b.n || 1)) ? a : b);
  candidates = null;
  if (best.model !== model) {
    model = best.model;
    view.clearTrail();
    log(`kinematic model: ${model.label} (measured best fit)`);
  }
  $('model-note').textContent = model.note;
  loadMeshes(model);
  // The default camera is a guess; once the model is known and a pose is
  // on screen, frame the arm properly.
  setTimeout(() => view.fit(), 150);
}

function loadMeshes(m) {
  if (!m.meshUrl) return;
  fetch(m.meshUrl).then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (data) { view.setMeshes(data, m.meshLinks); view.fit(); }
    })
    .catch(() => {});
}

let faultCode = '';
function renderFault(f) {
  const faulted = Boolean(f.error_main || f.error_sub);
  const code = `${f.error_main}/${f.error_sub}`;
  if (faulted && (!faultShown || code !== faultCode)) {
    faultCode = code;
    $('fault-banner-text').innerHTML =
      `<b>Controller fault</b> — main ${f.error_main}, sub ${f.error_sub}. ` +
      `<a href="#faults" style="color:inherit">Open the Faults tab</a> for the code table.`;
    $('fault-banner').classList.add('show');
    setStatus('sc-fault', 'bad', code);
    faultShown = true;
  } else if (!faulted && faultShown) {
    $('fault-banner').classList.remove('show');
    setStatus('sc-fault', '', 'none');
    faultShown = false;
    log('fault cleared', 'ok');
    if (!toolKnown) loadToolFrame();      // getters refuse while faulted
  }
}

function renderJoints(f) {
  const body = $('deck-joints');
  const j = f.joints || [];
  if (body.childElementCount !== j.length) {
    body.innerHTML = j.map((_, i) => `
      <div class="deck-row">
        <label>J${i + 1}</label>
        <b id="jt-a-${i}">—</b>
        <div class="bar" id="jt-b-${i}"><i></i></div>
        <span id="jt-h-${i}">—</span>
      </div>`).join('');
  }
  j.forEach((angle, i) => {
    $(`jt-a-${i}`).textContent = angle.toFixed(2);
    const v = $(`jog-val-${i + 1}`);
    if (v) v.textContent = angle.toFixed(2);

    const lim = lastLimits && lastLimits[i];
    if (lim) {
      const [mn, mx] = lim;
      const head = Math.min(angle - mn, mx - angle);
      const span = (mx - mn) / 2;
      $(`jt-h-${i}`).textContent = `${head.toFixed(0)}°`;
      const bar = $(`jt-b-${i}`);
      bar.className = `bar ${head < 5 ? 'bad' : head < 20 ? 'warn' : ''}`;
      bar.firstElementChild.style.width =
        `${Math.max(2, Math.min(100, (head / span) * 100))}%`;
    }
  });
}

const FT_NAMES = ['Fx', 'Fy', 'Fz', 'Tx', 'Ty', 'Tz'];
function renderTcp(f) {
  if (f.tcp) {
    const [x, y, z, rx, ry, rz] = f.tcp;
    $('ro-tcp-pos').textContent =
      `X ${x.toFixed(1).padStart(7)}  Y ${y.toFixed(1).padStart(7)}  Z ${z.toFixed(1).padStart(7)}`;
    $('ro-tcp-rot').textContent =
      `R ${rx.toFixed(1).padStart(7)}  P ${ry.toFixed(1).padStart(7)}  W ${rz.toFixed(1).padStart(7)}`;
    f.tcp.forEach((p, i) => {
      const lv = $(`lin-val-${i}`);
      if (lv) lv.textContent = p.toFixed(1);
    });
  }
  const body = $('deck-ft');
  if (f.ft) {
    if (body.childElementCount !== 6) {
      body.innerHTML = FT_NAMES.map((n, i) => `
        <div class="deck-row ft">
          <label>${n}</label>
          <b id="ft-${i}">—</b>
        </div>`).join('');
    }
    f.ft.forEach((q, i) => { $(`ft-${i}`).textContent = q.toFixed(2); });
  }
}

function renderStreamHealth(f) {
  const el = $('kv-stream-line');
  el.textContent =
    `${f.frames} frames · ${f.bad_checksum} bad · prog ${f.program_state}`;
  el.style.color = f.bad_checksum > 0 ? 'var(--danger)' : '';
}

/** The tool transform is part of the reported TCP, so the drawn tip needs
 * it to be comparable. A faulted controller refuses the getter (error 14),
 * which is why this is retried when a fault clears rather than fetched once. */
async function loadToolFrame() {
  try {
    const t = await api.get('/api/v1/frames/tool');
    if (t && t.offset) {
      toolOffset = t.offset;
      toolKnown = true;
      log(`active tool ${t.active}: offset [${t.offset.slice(0, 3).join(', ')}] mm`);
    }
  } catch (e) {
    toolKnown = false;
    log(`tool frame unavailable: ${e.message}`, 'warn');
  }
}

/* ---------------------------------------------------------------- tabs */

// Operator tabs first, then the developer surface; the rail draws a
// divider between the two groups.
const TABS = [
  ['operate', 'Operate', 'i-operate'],
  ['faults', 'Faults', 'i-fault'],
  ['programs', 'Programs', 'i-program'],
  ['io', 'I/O', 'i-io'],
  ['force', 'Force', 'i-force'],
  ['develop', 'Develop', 'i-develop', 'dev'],
  ['config', 'Config', 'i-config'],
  ['commands', 'Commands', 'i-cmd'],
  ['lua', 'Lua', 'i-lua'],
  ['api', 'API', 'i-api'],
  ['files', 'Files', 'i-files'],
  ['system', 'System', 'i-system'],
  ['capabilities', 'Capabilities', 'i-caps'],
  ['audit', 'Audit', 'i-audit'],
];

const ALL_PANELS = { ...PANELS, ...DEV_PANELS, ...WB_PANELS };

const loaded = new Set(['operate']);
let currentTab = null;

function selectTab(id, push = true) {
  if (!TABS.some(([t]) => t === id)) id = 'operate';
  if (id === currentTab && !push) return;   // hash echo of our own push
  currentTab = id;
  for (const [tid] of TABS) {
    const btn = document.querySelector(`nav button[data-tab="${tid}"]`);
    const sec = document.querySelector(`section[data-tab="${tid}"]`);
    const on = tid === id;
    btn.setAttribute('aria-selected', String(on));
    btn.tabIndex = on ? 0 : -1;
    sec.hidden = !on;
  }
  if (push && location.hash.slice(1) !== id) location.hash = id;
  // The tab title is the browser's own label for this view — it belongs in
  // history entries and in the window switcher, not only on screen.
  const label = (TABS.find(([t]) => t === id) || [])[1];
  document.title = label ? `${label} · FWS Console` : 'FWS Console';
  // Keyboard and screen-reader users must land inside the panel they chose,
  // not stay parked on the rail.
  if (push) {
    const sec = document.querySelector(`section[data-tab="${id}"]`);
    sec.tabIndex = -1;
    sec.focus({ preventScroll: true });
  }
  if (id === 'operate' && pendingFrame && !renderQueued) {
    renderQueued = true;
    requestAnimationFrame(renderTick);
  }
  if (!loaded.has(id) && ALL_PANELS[id]) {
    loaded.add(id);
    ALL_PANELS[id](document.querySelector(`section[data-tab="${id}"]`), api, log, toast);
    syncControls();   // panel buttons carry data-cmd; gate them immediately
  } else if (ALL_PANELS[id] && ALL_PANELS[id].refresh) {
    ALL_PANELS[id].refresh();
  }
}

window.addEventListener('hashchange', () => selectTab(location.hash.slice(1), false));

function buildTabs() {
  const nav = $('tabs');
  for (const [id, label, icon, group] of TABS) {
    if (group === 'dev') {
      const sep = document.createElement('div');
      sep.className = 'rail-sep';
      sep.textContent = 'Developer';
      nav.append(sep);
    }
    const b = document.createElement('button');
    b.innerHTML = `<svg viewBox="0 0 17 17"><use href="#${icon}"/></svg>${label}`;
    b.dataset.tab = id;
    b.id = `tab-${id}`;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-controls', `panel-${id}`);
    b.onclick = () => selectTab(id);
    nav.append(b);
    const sec = document.querySelector(`section[data-tab="${id}"]`);
    sec.id = `panel-${id}`;
    sec.setAttribute('role', 'tabpanel');
    sec.setAttribute('aria-labelledby', `tab-${id}`);
  }
  nav.addEventListener('keydown', (e) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(e.key in keys) && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const ids = TABS.map(([t]) => t);
    let i = ids.indexOf(currentTab);
    i = e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1
      : (i + keys[e.key] + ids.length) % ids.length;
    selectTab(ids[i]);
    document.querySelector(`nav button[data-tab="${ids[i]}"]`).focus();
  });
  const foot = document.createElement('div');
  foot.className = 'rail-foot';
  foot.innerHTML = `
    <button class="btn btn-ghost btn-sm" id="btn-key" title="API key">
      <svg viewBox="0 0 17 17"><use href="#i-lock"/></svg>
      <span id="key-label">no key</span>
    </button>
    <button class="btn btn-ghost btn-sm" id="btn-theme" title="Theme">
      <svg viewBox="0 0 17 17"><use href="#i-theme"/></svg>
      <span id="theme-label"></span>
    </button>`;
  nav.append(foot);
  $('btn-key').onclick = async () => {
    const next = await dialog({
      title: 'API key',
      body: '<p>Sent as <code>X-API-Key</code> on every request. Needed only '
          + 'when the gateway runs with <code>auth.api_keys_file</code> set. '
          + 'Stored in this browser only — clear the field to remove it.</p>',
      input: { value: api.apiKey || '', placeholder: 'paste key', type: 'password' },
      confirmLabel: 'Save',
    });
    if (next === false) return;
    setApiKey(next);
    log(next ? 'API key set' : 'API key cleared', 'ok');
    location.reload();      // re-run boot with the new credential
  };

  $('btn-theme').onclick = () => {
    const next = THEMES[(THEMES.indexOf(themePref()) + 1) % THEMES.length];
    applyTheme(next);
  };
}

/* ---------------------------------------------------------------- boot */

async function boot() {
  buildTabs();
  setApiKey(api.apiKey);
  buildStatusStrip();
  buildStepSeg();
  buildJogPads();
  buildSparks();
  reflectEnable();
  syncControls();
  applyTheme(themePref());

  try {
    const d = await api.get('/');
    if (d && d.read_only) {
      readOnly = true;
      const banner = document.createElement('div');
      banner.className = 'banner warn';
      banner.innerHTML = `
        <svg viewBox="0 0 17 17"><use href="#i-eye"/></svg>
        <span><b>Read-only gateway.</b> Observing a live robot; nothing can be
        commanded from here — not even stop. The physical E-stop is the only
        stop.</span>`;
      const section = document.querySelector('section[data-tab="operate"]');
      section.insertBefore(banner, section.firstChild);
      setStatus('sc-lease', 'warn', 'read-only');
      log('gateway is read-only: commanding is disabled', 'warn');
      syncControls();
    }
  } catch { /* pre-read_only gateway: descriptor lacks the field */ }

  try {
    const r = await api.robot();
    $('sc-robot-name').textContent = r.model || 'unknown robot';
    log(`connected to ${r.model} (${r.software})`);
    const named = modelFor(r.model);
    const set = named === MODELS.sim ? [MODELS.sim] : [named, MODELS.sim];
    candidates = set.map((m) => ({ model: m, sum: 0, n: 0 }));
    model = named;
    $('model-note').textContent = 'identifying kinematic model…';
  } catch (e) {
    $('sc-robot-name').textContent = 'no controller';
    if (e instanceof ApiError && e.status === 401) {
      toast('This gateway requires an API key — set one in the sidebar', 'warn', true);
      log('401: gateway requires an API key (sidebar → key)', 'err');
    } else {
      log(`cannot identify controller: ${e.message}`, 'err');
    }
    $('model-note').textContent = model.note;
  }

  try {
    const l = await api.limits();
    if (l && l.limits) lastLimits = l.limits.map((x) => [x.min, x.max]);
  } catch { /* the stream carries limits too */ }

  await loadToolFrame();

  stream.connect();
  selectTab(location.hash.slice(1) || 'operate', false);

  // No release-on-unload: sendBeacon cannot carry the control-token header,
  // and a closed tab simply stops heartbeating — the lease lapses within its
  // TTL, which is exactly the failure mode the gateway watchdog handles.
}

// Panels rebuild rows after their own fetches; they raise this when their
// commanding controls need gating against the current lease.
document.addEventListener('fws-sync', () => syncControls());

/* ------------------------------------------------------- palette sources */

registerPalette(() => TABS.map(([id, label]) => ({
  group: 'Panel', label, hint: '', run: () => selectTab(id),
})));

registerPalette(() => [
  { group: 'Action', label: lease.held ? 'Release control' : 'Take control',
    run: () => $('btn-lease').click() },
  { group: 'Action', label: 'STOP the robot', hint: 'Esc',
    run: () => $('btn-stop').click() },
  { group: 'Action', label: 'Reset faults', run: () => $('btn-reset').click() },
  { group: 'Action', label: 'Fit the 3D view', run: () => view.fit() },
  { group: 'Action', label: 'Clear the TCP trail', run: () => view.clearTrail() },
  { group: 'Action', label: 'Cycle the theme', run: () => $('btn-theme').click() },
  { group: 'Action', label: 'Set the API key', run: () => $('btn-key').click() },
  { group: 'Action', label: 'Keyboard shortcuts', hint: '?',
    run: () => shortcutsSheet(SHORTCUTS) },
  ...['iso', 'front', 'back', 'left', 'right', 'top'].map((v) => ({
    group: 'View', label: `${v.toUpperCase()} viewpoint`,
    run: () => document.querySelector(`[data-view="${v}"]`)?.click(),
  })),
]);

// Endpoints and wire commands are fetched once, on first palette open.
let specCache = null;
registerPalette(async () => {
  specCache = specCache || await api.get('/openapi.json');
  const out = [];
  for (const [path, item] of Object.entries(specCache.paths)) {
    for (const method of Object.keys(item)) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;
      out.push({
        group: 'Endpoint',
        label: `${method.toUpperCase()} ${path.replace('/api/v1', '')}`,
        hint: '', 
        run: () => {
          selectTab('api');
          // Let the panel build, then filter it down to this operation.
          setTimeout(() => {
            const q = document.getElementById('api-q');
            if (!q) return;
            q.value = path.replace('/api/v1', '');
            q.dispatchEvent(new Event('input'));
            document.querySelector('#api-list .api-op')?.click();
          }, 350);
        },
      });
    }
  }
  return out;
});

let cmdCache = null;
registerPalette(async () => {
  cmdCache = cmdCache || (await api.get('/api/v1/commands?limit=1000')).commands;
  return (cmdCache || []).map((c) => ({
    group: 'Command', label: c.name, hint: c.danger,
    run: () => {
      selectTab('commands');
      setTimeout(() => {
        const q = document.getElementById('cmd-q');
        if (!q) return;
        q.value = c.name;
        q.dispatchEvent(new Event('input'));
        document.querySelector('#cmd-list .api-op')?.click();
      }, 400);
    },
  }));
});

boot();

// Debug handle for driving the console from automation; not a public API.
window.fwsDebug = { view, lease, get model() { return model; } };
