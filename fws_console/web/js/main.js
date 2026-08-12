// Console shell: telemetry binding, control lease, jogging, tab routing.

import { Api, ApiError, Lease } from './api.js';
import { Stream } from './stream.js';
import { View3D } from './view3d.js';
import { MODELS, agreement, modelFor, verdict } from './kin.js';
import { PANELS } from './panels.js';

const api = new Api('');            // same origin: the gateway serves this page
const lease = new Lease(api);
const stream = new Stream(api.wsOrigin);
const $ = (id) => document.getElementById(id);

let model = MODELS.sim;
let commanding = false;             // a jog is in flight
let lastLimits = null;
let readOnly = false;               // gateway-declared, from GET /
let toolOffset = null;              // active tool frame offset, from /frames/tool

// --- activity log --------------------------------------------------------

function log(msg, kind = '') {
  const el = $('log');
  const line = document.createElement('div');
  line.className = kind;
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  el.prepend(line);
  while (el.childElementCount > 300) el.lastElementChild.remove();
}

/** Every command goes through here so no failure is ever silent. */
async function run(label, fn) {
  if (commanding) return;
  commanding = true;
  syncControls();
  try {
    const out = await fn();
    log(label, 'ok');
    return out;
  } catch (e) {
    if (e instanceof ApiError && e.isLocked) {
      log(`${label} refused — ${e.message}`, 'warn');
    } else {
      log(`${label} failed — ${e.message}`, 'err');
    }
    throw e;
  } finally {
    commanding = false;
    syncControls();
  }
}

// --- control lease -------------------------------------------------------

lease.onChange = (state, info) => {
  const t = $('lease-text');
  if (state === 'held') {
    const s = info && info.expires_in_s;
    t.textContent = s ? `held · ${s.toFixed(0)}s` : 'held';
    t.style.color = 'var(--ok)';
  } else if (state === 'lost') {
    t.textContent = 'LOST';
    t.style.color = 'var(--danger)';
    // The gateway's watchdog stops motion on a lapsed lease. Say so — the
    // arm may already be stopping and the operator needs to know why.
    log('control lease lost — the gateway watchdog will stop motion', 'err');
  } else {
    t.textContent = 'none';
    t.style.color = '';
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

// --- commanding ----------------------------------------------------------

$('btn-enable').onclick = () => run('enabled', () => api.enable(true));
$('btn-disable').onclick = () => run('disabled', () => api.enable(false));
$('btn-reset').onclick = () => run('reset faults', () => api.resetErrors());
$('btn-stop').onclick = () => run('STOP', () => api.stop());
$('btn-trail').onclick = () => view.clearTrail();

function jogArgs() {
  return {
    step: parseFloat($('in-step').value) || 1,
    vel: parseFloat($('in-vel').value) || 20,
  };
}

function buildJogPads() {
  const pad = $('jogpad');
  pad.innerHTML = '';
  for (let j = 1; j <= 6; j++) {
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `J${j}`;
    const val = document.createElement('span');
    val.className = 'val';
    val.id = `jog-val-${j}`;
    val.textContent = '—';
    // Gateway direction contract is 0/1 (Fairino wire convention), NOT ±1:
    // the handler is truthy, so -1 would silently jog POSITIVE.
    pad.append(name, val, jogBtn('−', j, 0), jogBtn('+', j, 1));
  }

  const lin = $('jogpad-lin');
  lin.innerHTML = '';
  ['X', 'Y', 'Z', 'RX', 'RY', 'RZ'].forEach((axis, i) => {
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = axis;
    const val = document.createElement('span');
    val.className = 'val';
    val.id = `lin-val-${i}`;
    val.textContent = '—';
    lin.append(name, val, linBtn('−', i + 1, 0), linBtn('+', i + 1, 1));
  });
}

function jogBtn(label, joint, dir) {
  const b = document.createElement('button');
  b.textContent = label;
  b.dataset.cmd = '1';
  b.onclick = () => {
    const { step, vel } = jogArgs();
    run(`jog J${joint} ${dir > 0 ? '+' : '−'}${step}°`,
        () => api.jog(joint, dir, step, vel));
  };
  return b;
}

function linBtn(label, axis, dir) {
  const b = document.createElement('button');
  b.textContent = label;
  b.dataset.cmd = '1';
  b.onclick = () => {
    const { step, vel } = jogArgs();
    run(`jog axis ${axis} ${dir > 0 ? '+' : '−'}${step}`,
        () => api.jogLinear(axis, dir, step, vel));
  };
  return b;
}

/**
 * A control that cannot work must look like it cannot work. Without the
 * lease every command returns 423, so the honest thing is to grey them out
 * rather than let the operator discover it one failed press at a time.
 */
function syncControls() {
  const ready = !readOnly && lease.held && !commanding;
  for (const b of document.querySelectorAll('[data-cmd]')) b.disabled = !ready;
  $('btn-enable').disabled = !ready;
  $('btn-disable').disabled = !ready;
  $('btn-reset').disabled = !ready;
  $('btn-stop').disabled = readOnly || !lease.held;
  $('btn-lease').disabled = readOnly;
  $('btn-lease').textContent = readOnly ? 'Read-only'
    : lease.held ? 'Release control' : 'Take control';
}

// --- telemetry rendering -------------------------------------------------

const view = new View3D($('view'));

let frames = 0;
let rateAt = performance.now();

stream.onStatus = (s) => {
  $('stream-dot').className = `dot ${s}`;
  $('stream-text').textContent = {
    live: 'live', stale: 'stale', offline: 'gateway offline',
    'no-robot': 'robot link down',
  }[s] || s;
};

stream.onFrame = (f) => {
  frames++;
  const now = performance.now();
  if (now - rateAt > 1000) {
    $('stream-rate').textContent = `${(frames * 1000 / (now - rateAt)).toFixed(1)} Hz`;
    frames = 0; rateAt = now;
  }

  if (f.limits) lastLimits = f.limits;
  renderJoints(f);
  renderTcp(f);
  renderStream(f);

  if (f.joints) {
    const frames = model.frames ? model.frames(f.joints) : null;
    view.setPose(model.points(f.joints, toolOffset), model, frames);
    const err = agreement(model, f.joints, f.tcp, toolOffset);
    const v = verdict(err);
    const badge = $('model-badge');
    badge.textContent = v.text;
    badge.className = `tag ${v.level === 'ok' ? 'ok' : v.level === 'warn' ? 'warn' : v.level === 'bad' ? 'bad' : ''}`;
  }
};

function renderJoints(f) {
  const body = $('tbl-joints');
  const j = f.joints || [];
  if (body.childElementCount !== j.length) {
    body.innerHTML = j.map((_, i) =>
      `<tr><td>J${i + 1}</td><td id="jt-a-${i}"></td><td id="jt-mn-${i}" class="muted"></td>
       <td id="jt-mx-${i}" class="muted"></td><td id="jt-h-${i}"></td><td id="jt-t-${i}"></td></tr>`
    ).join('');
  }
  j.forEach((angle, i) => {
    $(`jt-a-${i}`).textContent = angle.toFixed(2);
    const v = $(`jog-val-${i + 1}`);
    if (v) v.textContent = angle.toFixed(2);

    const lim = lastLimits && lastLimits[i];
    if (lim) {
      const [mn, mx] = lim;
      $(`jt-mn-${i}`).textContent = mn.toFixed(0);
      $(`jt-mx-${i}`).textContent = mx.toFixed(0);
      const head = Math.min(angle - mn, mx - angle);
      const cell = $(`jt-h-${i}`);
      cell.textContent = `${head.toFixed(1)}°`;
      // Colour is the whole point: it turns a number into a warning.
      cell.style.color = head < 5 ? 'var(--danger)'
        : head < 20 ? 'var(--warn)' : '';
    }
    const tq = f.joint_torque && f.joint_torque[i];
    if (tq !== undefined) $(`jt-t-${i}`).textContent = tq.toFixed(3);
  });
}

function renderTcp(f) {
  const body = $('tbl-tcp');
  const names = ['X', 'Y', 'Z', 'RX', 'RY', 'RZ'];
  if (body.childElementCount !== 6) {
    body.innerHTML = names.map((n, i) =>
      `<tr><td>${n}</td><td id="tc-${i}"></td><td id="ft-${i}"></td></tr>`).join('');
  }
  names.forEach((_, i) => {
    const p = f.tcp && f.tcp[i];
    if (p !== undefined) {
      $(`tc-${i}`).textContent = p.toFixed(2);
      const lv = $(`lin-val-${i}`);
      if (lv) lv.textContent = p.toFixed(1);
    }
    const q = f.ft && f.ft[i];
    if (q !== undefined) $(`ft-${i}`).textContent = q.toFixed(2);
  });
}

function renderStream(f) {
  const rows = [
    ['robot link', f.connected ? 'up' : 'DOWN'],
    ['frames', f.frames],
    ['bad checksum', f.bad_checksum],
    ['frame counter', f.counter],
    ['program state', f.program_state],
    ['fault', f.error_main || f.error_sub ? `main ${f.error_main}, sub ${f.error_sub}` : 'none'],
  ];
  $('tbl-stream').innerHTML = rows.map(([k, v]) => {
    const bad = (k === 'robot link' && !f.connected)
      || (k === 'bad checksum' && v > 0)
      || (k === 'fault' && v !== 'none');
    return `<tr><td class="muted">${k}</td><td${bad ? ' style="color:var(--danger)"' : ''}>${v}</td></tr>`;
  }).join('');
}

// --- tabs ----------------------------------------------------------------

const TABS = [
  ['operate', 'Operate'],
  ['faults', 'Faults'],
  ['programs', 'Programs'],
  ['io', 'I/O'],
  ['force', 'Force'],
  ['capabilities', 'Capabilities'],
  ['audit', 'Audit'],
];

const loaded = new Set(['operate']);

function selectTab(id) {
  for (const [tid] of TABS) {
    const btn = document.querySelector(`nav button[data-tab="${tid}"]`);
    const sec = document.querySelector(`section[data-tab="${tid}"]`);
    const on = tid === id;
    btn.setAttribute('aria-selected', String(on));
    sec.hidden = !on;
  }
  location.hash = id;
  if (!loaded.has(id) && PANELS[id]) {
    loaded.add(id);
    PANELS[id](document.querySelector(`section[data-tab="${id}"]`), api, log);
  } else if (PANELS[id] && PANELS[id].refresh) {
    PANELS[id].refresh();
  }
}

function buildTabs() {
  const nav = $('tabs');
  for (const [id, label] of TABS) {
    const b = document.createElement('button');
    b.textContent = label;
    b.dataset.tab = id;
    b.setAttribute('role', 'tab');
    b.onclick = () => selectTab(id);
    nav.append(b);
  }
}

// --- boot ----------------------------------------------------------------

async function boot() {
  buildTabs();
  buildJogPads();
  syncControls();

  try {
    const d = await api.get('/');
    if (d && d.read_only) {
      readOnly = true;
      const banner = document.createElement('div');
      banner.className = 'notice';
      banner.style.marginBottom = '14px';
      banner.innerHTML = '<b>Read-only gateway.</b> This console is '
        + 'observing a live robot and cannot command it — not even stop. '
        + 'The physical E-stop is the only stop.';
      const section = document.querySelector('section[data-tab="operate"]');
      section.insertBefore(banner, section.firstChild);
      log('gateway is read-only: commanding is disabled', 'warn');
      syncControls();
    }
  } catch { /* pre-read_only gateway: descriptor lacks the field */ }

  try {
    const r = await api.robot();
    $('robot-model').textContent = r.model || 'unknown';
    $('robot-sw').textContent = r.software ? ` · ${r.software}` : '';
    model = modelFor(r.model);
    $('model-note').textContent = `${model.label} — ${model.note}`;
    log(`connected to ${r.model} (${r.software})`, 'ok');

    if (model.meshUrl) {
      // Vendor link meshes (frcobot_description, Apache 2.0), served from
      // this package. Failure is cosmetic: the skeleton draws instead.
      fetch(model.meshUrl).then((res) => res.ok ? res.json() : null)
        .then((data) => {
          if (data) view.setMeshes(data, model.meshLinks);
        })
        .catch(() => {});
    }
  } catch (e) {
    log(`cannot identify controller: ${e.message}`, 'err');
    $('model-note').textContent = `${model.label} — ${model.note}`;
  }

  try {
    const l = await api.limits();
    if (l && l.limits) lastLimits = l.limits.map((x) => [x.min, x.max]);
  } catch { /* the stream carries limits too */ }

  try {
    // The controller's reported TCP includes the active tool transform; the
    // drawn tip must include it too or the agreement badge blames the model
    // for the tool.
    const t = await api.get('/api/v1/frames/tool');
    if (t && t.offset) {
      toolOffset = t.offset;
      log(`active tool ${t.active}: offset [${t.offset.slice(0, 3).join(', ')}] mm`, 'ok');
    }
  } catch { /* no tool info: draw to the flange */ }

  stream.connect();
  selectTab(location.hash.slice(1) || 'operate');

  // No release-on-unload: sendBeacon cannot carry the X-FWS-Control-Token
  // header, and an async DELETE from a closing page is not guaranteed to
  // arrive. A closed tab simply stops heartbeating and the lease lapses
  // within its TTL -- which is exactly the failure mode the gateway's
  // watchdog exists to handle.
}

boot();
