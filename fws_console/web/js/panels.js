// Secondary panels, built lazily on first visit. Each entry renders into its
// <section> and gets the shared Api instance and activity logger.
//
// Response shapes here are bound to what the gateway actually returns (probed
// against fws --simulator and a live FR5, v0.1.0a1), not to what one might
// wish it returned.

import { ApiError } from './api.js';
import { confirmGateway, skeleton } from './ui.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function card(title, bodyHtml, extra = '') {
  return `<div class="card"><h2>${esc(title)}${extra}</h2>${bodyHtml}</div>`;
}

function fail(log, toast, msg) {
  log(`failed: ${msg}`, 'err');
  if (toast) toast(msg, 'err');
}

function empty(icon, text) {
  return `<div class="empty">
    <svg viewBox="0 0 17 17"><use href="#${icon}"/></svg>${esc(text)}</div>`;
}

// Hand the browser a file to save. The console is served by the gateway (a
// real page, not a sandboxed frame), so an object-URL download works. Used
// for program text the gateway returns as JSON, which a plain <a download>
// cannot save directly.
function saveText(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- Faults --------------------------------------------------------------

async function faults(root, api, log, toast) {
  root.innerHTML = `
    <div class="grid cols-3">
      ${card('Current fault', `<div id="fault-now" class="mono">${skeleton(2)}</div>`)}
      <div class="card" style="grid-column:span 2">
        <h2>Error code lookup
          <span class="spacer"></span>
          <span class="small dim" id="code-count"></span></h2>
        <input id="code-q" type="search" placeholder="Search code or text…"
               style="width:100%;margin-bottom:10px">
        <div class="scroll" style="max-height:430px"><table>
          <thead><tr><th>Code</th><th style="text-align:left">Meaning</th>
          <th style="text-align:left">What to do</th></tr></thead>
          <tbody id="code-rows"></tbody>
        </table></div>
        <div class="small faint" id="code-caveat" style="margin-top:8px"></div>
      </div>
    </div>`;

  const now = root.querySelector('#fault-now');
  const refreshNow = async () => {
    try {
      const e = await api.errors();
      now.innerHTML = e.faulted
        ? `<span class="tag bad">FAULTED — main ${e.raw.main}, sub ${e.raw.sub}</span>`
        : `<span class="tag ok">no fault</span>
           <div class="small dim" style="margin-top:8px">raw ${e.raw.main} / ${e.raw.sub}</div>`;
    } catch (err) { now.textContent = err.message; }
  };
  await refreshNow();
  faults.refresh = refreshNow;

  let codes = [];
  try {
    const r = await api.get('/api/v1/errors/codes?limit=300');
    codes = r.codes || [];
    root.querySelector('#code-caveat').textContent = r.caveat || '';
  } catch (err) { log(`error table: ${err.message}`, 'err'); }

  const rows = root.querySelector('#code-rows');
  const count = root.querySelector('#code-count');
  const render = (q = '') => {
    const needle = q.trim().toLowerCase();
    const hit = needle
      ? codes.filter((c) => String(c.code).includes(needle)
          || (c.description || '').toLowerCase().includes(needle))
      : codes;
    count.textContent = `${hit.length} of ${codes.length}`;
    rows.innerHTML = hit.slice(0, 200).map((c) => `
      <tr><td>${c.code}</td>
      <td style="text-align:left">${esc(c.description)}</td>
      <td style="text-align:left" class="small dim">${esc(c.process || '')}</td></tr>`).join('')
      || `<tr><td colspan="3">${empty('i-inbox', 'nothing matches')}</td></tr>`;
  };
  render();
  root.querySelector('#code-q').oninput = (e) => render(e.target.value);
}

// --- Programs ------------------------------------------------------------

async function programs(root, api, log, toast) {
  root.innerHTML = `
    <div class="grid" style="grid-template-columns:minmax(0,1.4fr) minmax(280px,1fr)">
      <div class="card">
        <h2>Programs
          <span class="seg" id="prog-src" style="margin-left:10px">
            <button data-src="controller" aria-pressed="true">On controller</button>
            <button data-src="gateway" aria-pressed="false">Uploaded here</button>
          </span>
          <span class="spacer"></span>
          <label class="btn btn-sm">
            <svg viewBox="0 0 17 17"><use href="#i-upload"/></svg>Upload .lua
            <input type="file" id="prog-file" accept=".lua" class="sr-only"
                   data-cmd="1">
          </label></h2>
        <div class="scroll"><table>
          <thead><tr><th style="text-align:left">Name</th><th>Bytes</th>
          <th>md5</th><th style="text-align:right"></th></tr></thead>
          <tbody id="prog-rows"></tbody></table></div>
        <div class="small faint" id="prog-note" style="margin-top:10px"></div>
        <div id="prog-validate" style="margin-top:10px"></div>
      </div>
      <div class="card">
        <h2>Execution</h2>
        <dl class="kv" id="exec-state" style="margin-bottom:12px"></dl>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-primary" id="ex-run" data-cmd="1">
            <svg viewBox="0 0 17 17"><use href="#i-run"/></svg>Run</button>
          <button class="btn" id="ex-pause" data-cmd="1">
            <svg viewBox="0 0 17 17"><use href="#i-pause"/></svg>Pause</button>
          <button class="btn" id="ex-resume" data-cmd="1">Resume</button>
          <button class="btn btn-danger" id="ex-stop" data-cmd="1">
            <svg viewBox="0 0 17 17"><use href="#i-stop"/></svg>Stop</button>
        </div>
        <div class="banner warn" style="margin:12px 0 0">
          <svg viewBox="0 0 17 17"><use href="#i-fault"/></svg>
          <span class="small">A program commands motion the gateway does not
          bound — jog limits and IK pre-flight do not apply. Clear the cell;
          the gateway will ask for confirmation.</span>
        </div>
      </div>
    </div>`;

  // Two listings: what is actually ON the controller (the real directory,
  // read over FTP -- the controller's own GetLuaList RPC is quarantined
  // because it can wedge the channel) versus the gateway's own upload index.
  // Default to the controller, because that is what an operator came to see.
  let source = 'controller';

  const refresh = async () => {
    const rows = root.querySelector('#prog-rows');
    rows.innerHTML = '<tr><td colspan="4"><span class="small dim">loading…</span></td></tr>';
    try {
      let list = [];
      let note = '';
      if (source === 'controller') {
        const r = await api.get('/api/v1/files/lua?source=controller',
          { timeout: 120000 });
        list = r.files || [];
        note = r.note || '';
      } else {
        const r = await api.get('/api/v1/programs');
        list = r.programs || [];
        note = r.note || '';
      }
      root.querySelector('#prog-note').textContent = note;
      rows.innerHTML = list.map((p) => {
        const md5 = (p.md5 || '').slice(0, 10);
        return `
        <tr><td style="text-align:left" class="mono">${esc(p.name)}</td>
        <td>${p.bytes ?? '?'}</td>
        <td class="small faint mono">${esc(md5)}${md5 ? '…' : ''}</td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn btn-sm btn-ghost" data-dl="${esc(p.name)}">download</button>
          <button class="btn btn-sm" data-cmd="1" data-load="${esc(p.name)}">load</button>
          <button class="btn btn-sm" data-cmd="1" data-sel="${esc(p.name)}">select</button>
          ${source === 'gateway' ? `
          <button class="btn btn-sm btn-ghost" data-val="${esc(p.name)}">validate</button>
          <button class="btn btn-sm btn-ghost" data-cmd="1" data-del="${esc(p.name)}">delete</button>`
            : ''}
        </td></tr>`;
      }).join('')
        || `<tr><td colspan="4">${empty('i-inbox', source === 'controller'
            ? 'no .lua files on the controller (or FTP is not enabled)'
            : 'none uploaded through this gateway yet')}</td></tr>`;

      for (const b of root.querySelectorAll('[data-dl]')) {
        b.onclick = async () => {
          const name = b.dataset.dl;
          b.disabled = true;
          try {
            const r = await api.get(`/api/v1/files/lua/${encodeURIComponent(name)}`,
              { timeout: 120000 });
            saveText(name, r.content ?? '');
            log(`downloaded ${name} (${r.bytes ?? (r.content || '').length} bytes)`, 'ok');
          } catch (e) { fail(log, toast, `download ${name}: ${e.message}`); }
          finally { b.disabled = false; }
        };
      }
      for (const b of root.querySelectorAll('[data-sel]')) {
        b.onclick = () => api.post(`/api/v1/programs/${encodeURIComponent(b.dataset.sel)}/select`, {})
          .then(() => log(`selected ${b.dataset.sel}`, 'ok'), (e) => fail(log, toast, e.message));
      }
      for (const b of root.querySelectorAll('[data-load]')) {
        b.onclick = () => api.post(`/api/v1/programs/${encodeURIComponent(b.dataset.load)}/load`, {})
          .then(() => { log(`loaded ${b.dataset.load}`, 'ok'); refresh(); },
                (e) => fail(log, toast, e.message));
      }
      for (const b of root.querySelectorAll('[data-val]')) {
        b.onclick = async () => {
          const out = root.querySelector('#prog-validate');
          out.innerHTML = '<div class="small dim">validating against the controller\u2019s own Lua compiler…</div>';
          try {
            const r = await api.post(
              `/api/v1/programs/${encodeURIComponent(b.dataset.val)}/validate`, {});
            out.innerHTML = `<span class="tag ${r.ok === false ? 'bad' : 'ok'}">`
              + `${esc(b.dataset.val)}</span><pre class="jsonview">${
                esc(JSON.stringify(r, null, 2))}</pre>`;
          } catch (e) {
            out.innerHTML = `<div class="banner warn"><span class="small">${esc(e.message)}</span></div>`;
          }
        };
      }
      for (const b of root.querySelectorAll('[data-del]')) {
        b.onclick = () => api.del(`/api/v1/programs/${encodeURIComponent(b.dataset.del)}`)
          .then(() => { log(`deleted ${b.dataset.del}`, 'ok'); refresh(); },
                (e) => fail(log, toast, e.message));
      }
      document.dispatchEvent(new CustomEvent('fws-sync'));
    } catch (e) {
      rows.innerHTML = `<tr><td colspan="4"><div class="banner warn">`
        + `<span class="small">${esc(e.message)}</span></div></td></tr>`;
      log(`programs: ${e.message}`, 'err');
    }

    try {
      const x = await api.get('/api/v1/execution');
      root.querySelector('#exec-state').innerHTML = `
        <dt>State</dt><dd><span class="tag ${x.state === 'running' ? 'ok' : ''}">${esc(x.state)}</span></dd>
        <dt>Loaded</dt><dd class="mono">${esc(x.loaded || '—')}</dd>
        <dt>Line</dt><dd>${x.current_line}</dd>`;
    } catch (e) {
      root.querySelector('#exec-state').innerHTML = `<dt>State</dt><dd>${esc(e.message)}</dd>`;
    }
  };

  // The listing toggle: the controller's real directory vs the gateway index.
  for (const b of root.querySelectorAll('#prog-src button')) {
    b.onclick = () => {
      if (source === b.dataset.src) return;
      source = b.dataset.src;
      for (const x of b.parentElement.children) {
        x.setAttribute('aria-pressed', String(x === b));
      }
      root.querySelector('#prog-validate').innerHTML = '';
      refresh();
    };
  }

  root.querySelector('#prog-file').onchange = async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      const put = (overwrite) => api.put(
        `/api/v1/programs/${encodeURIComponent(f.name)}`,
        overwrite ? { content: text, overwrite: true } : { content: text });
      try {
        await put(false);
      } catch (e) {
        const clash = e instanceof ApiError && e.status === 409;
        if (!clash || !(await confirmGateway(e.message, {
          title: 'Overwrite this program?', confirmLabel: 'Overwrite',
        }))) throw e;
        await put(true);
      }
      log(`uploaded ${f.name} (${f.size} bytes)`, 'ok');
      refresh();
    } catch (e) { fail(log, toast, `upload ${f.name}: ${e.message}`); }
    ev.target.value = '';
  };

  const exec = (label, path, body = {}) => async () => {
    try {
      await api.post(path, body);
      log(label, 'ok');
      refresh();
    } catch (e) {
      // The run endpoint refuses once without confirm -- by design. Surface
      // the gateway's own wording, then re-ask with confirmation.
      if (label === 'run' && e instanceof ApiError && e.status === 400
          && await confirmGateway(e.message, {
            title: 'Run the loaded program?',
            confirmLabel: 'Clear — run it',
          })) {
        try {
          await api.post(path, { confirm: true });
          log('run (confirmed)', 'ok');
          refresh();
          return;
        } catch (e2) { fail(log, toast, `run: ${e2.message}`); return; }
      }
      fail(log, toast, `${label}: ${e.message}`);
    }
  };
  root.querySelector('#ex-run').onclick = exec('run', '/api/v1/execution/run');
  root.querySelector('#ex-pause').onclick = exec('pause', '/api/v1/execution/pause');
  root.querySelector('#ex-resume').onclick = exec('resume', '/api/v1/execution/resume');
  root.querySelector('#ex-stop').onclick = exec('stop', '/api/v1/execution/stop');

  refresh();
  programs.refresh = refresh;
}

// --- I/O -----------------------------------------------------------------

async function io(root, api, log, toast) {
  const N = 8;   // panel width; the gateway validates real board bounds
  root.innerHTML = `
    <div class="grid cols-3">
      <div class="card">
        <h2>Digital inputs
          <span class="spacer"></span>
          <button class="btn btn-sm btn-ghost" id="di-refresh">
            <svg viewBox="0 0 17 17"><use href="#i-reset"/></svg>refresh</button></h2>
        <div style="display:flex;gap:6px;flex-wrap:wrap" id="di"></div>
        <div class="small faint" style="margin-top:10px">
          read on demand — live telemetry does not include I/O</div>
        <h2 style="margin-top:14px">Tool digital inputs</h2>
        <div style="display:flex;gap:6px;flex-wrap:wrap" id="tdi"></div>
      </div>
      ${card('Digital outputs', '<div id="do"></div>')}
      ${card('Analog', `
        <div class="field-row" style="margin-top:0">
          <label>AI index</label>
          <input id="ai-idx" type="number" value="0" min="0" style="width:70px">
          <button class="btn btn-sm" id="ai-read">read</button>
          <b class="num" id="ai-val">—</b>
        </div>
        <div class="field-row">
          <label>AO index</label>
          <input id="ao-idx" type="number" value="0" min="0" style="width:70px">
          <label>value</label>
          <input id="ao-val" type="number" value="0" step="0.1" style="width:84px">
          <button class="btn btn-sm" id="ao-write" data-cmd="1">write</button>
        </div>`)}
    </div>`;

  // A whole read family can be unavailable for two different reasons, and the
  // panel must not paint N identical red "?" tags — a wall of red reads as a
  // hardware fault. The two cases:
  //   1. the firmware genuinely lacks it (capabilities says 'absent'), or
  //   2. the controller returns the same error for every channel right now —
  //      e.g. GetDI answers "error 14" for all of them while the controller is
  //      faulted, even though the reads work once the fault clears.
  // Both collapse to ONE line stating the reason, not eight red tags.
  let ioCaps = {};
  try { ioCaps = (await api.capabilities())?.groups?.io || {}; } catch { /* probe anyway */ }
  const absent = (f) => (ioCaps[f] && ioCaps[f].state === 'absent') ? ioCaps[f] : null;
  const oneLine = (msg) => `<span class="small faint">${esc(msg)}</span>`;

  // Read `count` channels together; render one tag each, but if EVERY channel
  // fails the same way, show a single reason instead of a row of red tags.
  const readFamily = async (el, feat, label, count, path) => {
    const gone = absent(feat);
    if (gone) {
      el.innerHTML = oneLine(`not on this firmware — ${gone.method}: ${gone.detail || 'absent'}`);
      return;
    }
    el.innerHTML = '<span class="small dim">reading…</span>';
    const res = await Promise.all(Array.from({ length: count }, (_, i) =>
      api.get(path(i)).then(
        (r) => ({ i, ok: true, v: r.value }),
        (e) => ({ i, ok: false, msg: e.message }))));
    if (res.every((r) => !r.ok)) {
      el.innerHTML = oneLine(`unavailable — ${res[0].msg}`);
      return;
    }
    el.innerHTML = res.map((r) => r.ok
      ? `<span class="tag ${r.v ? 'ok' : ''}">${label}${r.i} ${r.v}</span>`
      : `<span class="tag bad">${label}${r.i} ?</span>`).join(' ');
  };

  const di = root.querySelector('#di');
  const tdi = root.querySelector('#tdi');
  const readInputs = () => readFamily(di, 'digital_in', 'DI', N,
    (i) => `/api/v1/io/digital/inputs/${i}`);
  const readTool = () => readFamily(tdi, 'tool_digital_in', 'TDI', 4,
    (i) => `/api/v1/io/tool/digital/inputs/${i}`);

  root.querySelector('#di-refresh').onclick = () => { readInputs(); readTool(); };
  readInputs();
  readTool();

  // Outputs carry confirm=true: the gateway requires it because an output
  // can actuate a gripper or a tool, and here the operator's click on a
  // button labelled with that exact output IS the confirmation.
  const doDiv = root.querySelector('#do');
  doDiv.innerHTML = Array.from({ length: N }, (_, i) => `
    <div class="jog-row" style="grid-template-columns:44px 1fr auto">
      <span class="axis">DO${i}</span><span></span>
      <span class="seg">
        <button data-cmd="1" data-do="${i}" data-v="1" aria-pressed="false">on</button>
        <button data-cmd="1" data-do="${i}" data-v="0" aria-pressed="false">off</button>
      </span>
    </div>`).join('')
    + `<div class="small faint" style="margin-top:8px">shows the last command
       from this console — the controller does not report output state</div>`;
  for (const b of doDiv.querySelectorAll('[data-do]')) {
    b.onclick = () => api.put(`/api/v1/io/digital/outputs/${b.dataset.do}`,
      { value: Number(b.dataset.v), confirm: true })
      .then(() => {
        log(`DO${b.dataset.do} ← ${b.dataset.v}`, 'ok');
        for (const x of b.parentElement.children) {
          x.setAttribute('aria-pressed', String(x === b));
        }
      }, (e) => fail(log, toast, `DO${b.dataset.do}: ${e.message}`));
  }

  root.querySelector('#ai-read').onclick = async () => {
    const val = root.querySelector('#ai-val');
    const gone = absent('analog_in');
    if (gone) {
      val.textContent = 'n/a';
      log(`analog in (${gone.method}): not on this firmware`, 'warn');
      return;
    }
    const i = root.querySelector('#ai-idx').value;
    try {
      const r = await api.get(`/api/v1/io/analog/inputs/${i}`);
      val.textContent = r.value ?? JSON.stringify(r);
    } catch (e) { val.textContent = 'n/a'; log(`AI${i}: ${e.message}`, 'err'); }
  };
  root.querySelector('#ao-write').onclick = () => {
    const i = root.querySelector('#ao-idx').value;
    const v = parseFloat(root.querySelector('#ao-val').value);
    api.put(`/api/v1/io/analog/outputs/${i}`, { value: v, confirm: true })
      .then(() => log(`AO${i} ← ${v}`, 'ok'), (e) => fail(log, toast, `AO${i}: ${e.message}`));
  };
}

// --- Force ---------------------------------------------------------------

async function force(root, api, log, toast) {
  root.innerHTML = `
    <div class="grid cols-3">
      ${card('Wrist force / torque', `<table><tbody id="f-now"></tbody></table>
        <div class="small faint" id="f-what" style="margin-top:10px"></div>`)}
      ${card('Sensor', `<div class="mono" id="f-cfg">loading…</div>
        <div class="row" style="margin-top:12px">
          <button class="btn" id="f-zero" data-cmd="1">Zero sensor</button>
          <button class="btn btn-sm" id="f-on" data-cmd="1">Activate</button>
          <button class="btn btn-sm" id="f-off" data-cmd="1">Deactivate</button>
        </div>
        <div class="small faint" style="margin-top:10px">
          Zeroing takes the current load as the new reference. Do it with the
          tool unloaded, or the reading will lie by exactly that much.</div>`)}
      ${card('Payload', `<div id="f-pay"></div>`)}
      <div class="card" style="grid-column:1/-1">
        <h2>Force strategies
          <span class="spacer"></span>
          <span class="small faint">why these have no endpoint</span></h2>
        <div id="f-strat" class="small dim">${skeleton(3)}</div>
      </div>
    </div>`;

  const refreshFt = async () => {
    try {
      const s = await api.get('/api/v1/sensors/force');
      const f = s.force_n, t = s.torque_nm;
      root.querySelector('#f-now').innerHTML = `
        <tr><td class="dim">force N</td><td>${f.fx.toFixed(2)}</td><td>${f.fy.toFixed(2)}</td><td>${f.fz.toFixed(2)}</td></tr>
        <tr><td class="dim">torque Nm</td><td>${t.tx.toFixed(2)}</td><td>${t.ty.toFixed(2)}</td><td>${t.tz.toFixed(2)}</td></tr>
        <tr><td class="dim">|F|</td><td colspan="3">${s.magnitude_n.toFixed(2)} N</td></tr>
        <tr><td class="dim">as of</td><td colspan="3">${new Date().toLocaleTimeString()}</td></tr>`;
      root.querySelector('#f-what').textContent = s.what_this_is || '';
    } catch (e) { root.querySelector('#f-now').innerHTML = `<tr><td>${esc(e.message)}</td></tr>`; }
  };
  await refreshFt();
  force.refresh = refreshFt;

  try {
    const c = await api.get('/api/v1/force/config');
    root.querySelector('#f-cfg').textContent =
      `sensor ${JSON.stringify(c.sensor)} · fields ${c.sensor_fields.join(', ')}`;
  } catch (e) { root.querySelector('#f-cfg').textContent = e.message; }

  try {
    const p = await api.get('/api/v1/force/payload');
    // The mismatch object and the notes are prose, not numbers: render them as
    // wrapped text, not a single JSON.stringify line that runs off the card.
    const kg = (x) => (typeof x === 'number' ? `${x.toFixed(3)} kg` : esc(String(x ?? '—')));
    const m = p.mismatch || {};
    const big = Math.abs(m.difference_kg || 0) > 0.05;
    root.querySelector('#f-pay').innerHTML = `
      <dl class="kv">
        <dt>sensor</dt><dd>${kg(p.sensor_payload_kg)}</dd>
        <dt>sensor CoG</dt><dd>${(p.sensor_payload_cog_mm || []).join(', ') || '—'} mm</dd>
        <dt>robot</dt><dd>${kg(p.robot_payload_kg)}</dd>
      </dl>
      ${m.difference_kg !== undefined ? `
        <div class="pay-mismatch">
          <div class="small">sensor − robot =
            <span class="tag ${big ? 'warn' : 'ok'}">${kg(m.difference_kg)}</span></div>
          ${m.consequence ? `<div class="small dim" style="margin-top:6px">${esc(m.consequence)}</div>` : ''}
          ${m.how_to_fix ? `<div class="small faint" style="margin-top:6px"><b>fix:</b> ${esc(m.how_to_fix)}</div>` : ''}
        </div>` : ''}
      ${p.note ? `<div class="small faint" style="margin-top:10px">${esc(p.note)}</div>` : ''}`;
  } catch (e) { root.querySelector('#f-pay').innerHTML = `<div class="small">${esc(e.message)}</div>`; }

  try {
    const st = await api.get('/api/v1/force/strategies');
    root.querySelector('#f-strat').innerHTML =
      `<pre class="jsonview">${esc(JSON.stringify(st, null, 2))}</pre>`;
  } catch (e) { root.querySelector('#f-strat').textContent = e.message; }

  const activate = (on) => api.post('/api/v1/force/activate', { enable: on, confirm: true })
    .then(() => { log(`force sensor ${on ? 'activated' : 'deactivated'}`, 'ok'); refreshFt(); },
          (e) => fail(log, toast, `activate: ${e.message}`));
  root.querySelector('#f-on').onclick = () => activate(true);
  root.querySelector('#f-off').onclick = () => activate(false);

  root.querySelector('#f-zero').onclick = () =>
    api.post('/api/v1/force/zero', {})
      .then(() => { log('force sensor zeroed', 'ok'); refreshFt(); },
            (e) => fail(log, toast, e.message));
}

// --- Capabilities --------------------------------------------------------

async function capabilities(root, api, log, toast) {
  root.innerHTML = card('Controller capabilities',
    '<div id="cap-body" class="dim">probing…</div>',
    '<span class="spacer"></span><span class="small dim" id="cap-sum"></span>'
    + '<button class="btn btn-sm btn-ghost" id="cap-refresh" data-cmd="1">re-probe</button>');
  try {
    const c = await api.capabilities();
    root.querySelector('#cap-sum').textContent =
      `${c.available}/${c.total} available · ${c.absent} absent · ${c.unknown} unknown`;
    const body = root.querySelector('#cap-body');
    body.className = 'grid cols-3';
    body.innerHTML = Object.entries(c.groups).map(([group, feats]) => card(group,
      `<table class="cap-table"><tbody>${Object.entries(feats).map(([name, f]) => {
        const cls = f.state === 'available' ? 'ok' : f.state === 'absent' ? 'bad' : 'warn';
        return `<tr><td style="text-align:left">${esc(name)}</td>
          <td class="small faint mono" style="text-align:left">${esc(f.method || '')}</td>
          <td><span class="tag ${cls}">${f.state}</span></td></tr>`;
      }).join('')}</tbody></table>`)).join('');

    // The gateway's own vocabulary for the three states is worth repeating
    // verbatim: 'unknown' is NOT evidence a feature is missing.
    const note = document.createElement('div');
    note.className = 'banner warn';
    note.style.marginTop = '14px';
    note.innerHTML = `<svg viewBox="0 0 17 17"><use href="#i-caps"/></svg><span class="small">`
      + Object.entries(c.states)
        .map(([k, v]) => `<b>${esc(k)}</b> — ${esc(v)}`).join('<br>') + '</span>';
    root.append(note);
    root.querySelector('#cap-refresh').onclick = async () => {
      try {
        await api.post('/api/v1/capabilities/refresh', {});
        log('capabilities re-probed', 'ok');
        capabilities(root, api, log, toast);
      } catch (e) { fail(log, toast, `re-probe: ${e.message}`); }
    };
    document.dispatchEvent(new CustomEvent('fws-sync'));
  } catch (e) {
    root.querySelector('#cap-body').textContent = e.message;
    log(`capabilities: ${e.message}`, 'err');
  }
}

// --- Audit ---------------------------------------------------------------

async function audit(root, api, log, toast) {
  root.innerHTML = card('Audit trail',
    `<div class="scroll" style="max-height:540px"><table>
      <thead><tr><th style="text-align:left">Time</th><th style="text-align:left">Action</th>
      <th style="text-align:left">Detail</th></tr></thead>
      <tbody id="audit-rows"></tbody></table></div>`,
    `<span class="spacer"></span><button class="btn btn-sm btn-ghost" id="audit-refresh">
      <svg viewBox="0 0 17 17"><use href="#i-reset"/></svg>refresh</button>`);

  const refresh = async () => {
    try {
      const r = await api.events(200);
      root.querySelector('#audit-rows').innerHTML = (r.events || []).map((e) => {
        // Events are flat: {seq, ts, action, actor, ...detail}. Show the
        // detail keys only; the envelope has its own columns.
        const { seq, ts, action, actor, ...detail } = e;
        return `
        <tr><td class="mono small">${esc(new Date((ts || 0) * 1000).toLocaleTimeString())}</td>
        <td class="mono small">${esc(action || '')}<div class="faint">${esc(actor || '')}</div></td>
        <td class="small dim mono">${esc(JSON.stringify(detail))}</td></tr>`;
      }).join('')
        || `<tr><td colspan="3">${empty('i-inbox', 'no events recorded yet')}</td></tr>`;
    } catch (e) { log(`audit: ${e.message}`, 'err'); }
  };
  root.querySelector('#audit-refresh').onclick = refresh;
  refresh();
  audit.refresh = refresh;
}

export const PANELS = { faults, programs, io, force, capabilities, audit };
