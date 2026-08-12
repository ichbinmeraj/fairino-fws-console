// Secondary panels, built lazily on first visit. Each entry renders into its
// <section> and gets the shared Api instance and activity logger.
//
// Response shapes here are bound to what the gateway actually returns (probed
// against fws --simulator, v0.1.0a0), not to what one might wish it returned.

import { ApiError } from './api.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function card(title, bodyHtml, extra = '') {
  return `<div class="card"><h2>${esc(title)}${extra}</h2>${bodyHtml}</div>`;
}

// --- Faults --------------------------------------------------------------

async function faults(root, api, log) {
  root.innerHTML = `
    <div class="grid">
      ${card('Current fault', '<div id="fault-now" class="mono small">loading…</div>')}
      ${card('Error code lookup', `
        <div class="row" style="margin-bottom:10px">
          <input id="code-q" placeholder="search code or text…" style="flex:1">
        </div>
        <div class="scroll" style="max-height:420px"><table>
          <thead><tr><th>Code</th><th style="text-align:left">Meaning</th><th style="text-align:left">What to do</th></tr></thead>
          <tbody id="code-rows"></tbody>
        </table></div>
        <div class="small muted" id="code-caveat" style="margin-top:8px"></div>`)}
    </div>`;

  const now = root.querySelector('#fault-now');
  try {
    const e = await api.errors();
    now.innerHTML = e.faulted
      ? `<span style="color:var(--danger)">FAULTED — main ${e.raw.main}, sub ${e.raw.sub}</span>`
      : `<span style="color:var(--ok)">no fault</span> <span class="muted">(raw ${e.raw.main}/${e.raw.sub})</span>`;
  } catch (err) { now.textContent = err.message; }

  let codes = [];
  try {
    const r = await api.get('/api/v1/errors/codes?limit=300');
    codes = r.codes || [];
    root.querySelector('#code-caveat').textContent = r.caveat || '';
  } catch (err) { log(`error table: ${err.message}`, 'err'); }

  const rows = root.querySelector('#code-rows');
  const render = (q = '') => {
    const needle = q.trim().toLowerCase();
    const hit = needle
      ? codes.filter((c) => String(c.code).includes(needle)
          || (c.description || '').toLowerCase().includes(needle))
      : codes;
    rows.innerHTML = hit.slice(0, 200).map((c) => `
      <tr><td>${c.code}</td>
      <td style="text-align:left">${esc(c.description)}</td>
      <td style="text-align:left" class="muted small">${esc(c.process || '')}</td></tr>`).join('');
  };
  render();
  root.querySelector('#code-q').oninput = (e) => render(e.target.value);
}

// --- Programs ------------------------------------------------------------

async function programs(root, api, log) {
  root.innerHTML = `
    <div class="grid wide">
      ${card('Programs on this gateway', `
        <div class="scroll"><table>
          <thead><tr><th style="text-align:left">Name</th><th>Bytes</th><th>md5</th><th style="text-align:left"></th></tr></thead>
          <tbody id="prog-rows"></tbody></table></div>
        <div class="small muted" id="prog-note" style="margin-top:8px"></div>`)}
      <div>
        ${card('Upload', `
          <div class="row"><input type="file" id="prog-file" accept=".lua"></div>
          <div class="small muted" style="margin-top:8px">
            Uploaded with md5 verification. Validation runs against the
            controller's own Lua compiler, not an imitation of it.</div>`)}
        ${card('Execution', `
          <div class="mono small" id="exec-state" style="margin-bottom:10px">—</div>
          <div class="row">
            <button id="ex-run" class="btn-primary">Run</button>
            <button id="ex-pause">Pause</button>
            <button id="ex-resume">Resume</button>
            <button id="ex-stop" class="btn-danger">Stop</button>
          </div>
          <div class="notice danger" style="margin-top:10px">
            Running a program commands motion the gateway does not bound —
            jog limits and kinematics pre-flight do not apply. Clear the cell
            first. The gateway will ask for confirmation.
          </div>`)}
      </div>
    </div>`;

  const refresh = async () => {
    try {
      const r = await api.get('/api/v1/programs');
      root.querySelector('#prog-note').textContent = r.note || '';
      root.querySelector('#prog-rows').innerHTML = (r.programs || []).map((p) => `
        <tr><td style="text-align:left" class="mono">${esc(p.name)}</td>
        <td>${p.bytes}</td><td class="muted small">${esc((p.md5 || '').slice(0, 10))}…</td>
        <td style="text-align:left">
          <button data-sel="${esc(p.name)}">select</button>
          <button data-del="${esc(p.name)}">delete</button>
        </td></tr>`).join('')
        || '<tr><td colspan="4" class="muted">none uploaded through this gateway yet</td></tr>';

      for (const b of root.querySelectorAll('[data-sel]')) {
        b.onclick = () => api.post(`/api/v1/programs/${encodeURIComponent(b.dataset.sel)}/select`, {})
          .then(() => log(`selected ${b.dataset.sel}`, 'ok'), (e) => log(e.message, 'err'));
      }
      for (const b of root.querySelectorAll('[data-del]')) {
        b.onclick = () => api.del(`/api/v1/programs/${encodeURIComponent(b.dataset.del)}`)
          .then(() => { log(`deleted ${b.dataset.del}`, 'ok'); refresh(); },
                (e) => log(e.message, 'err'));
      }
    } catch (e) { log(`programs: ${e.message}`, 'err'); }

    try {
      const x = await api.get('/api/v1/execution');
      root.querySelector('#exec-state').textContent =
        `state: ${x.state} · loaded: ${x.loaded || 'nothing'} · line ${x.current_line}`;
    } catch (e) { root.querySelector('#exec-state').textContent = e.message; }
  };

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
        if (!(e instanceof ApiError && e.status === 409
              && confirm(`${e.message}\n\nOverwrite?`))) throw e;
        await put(true);
      }
      log(`uploaded ${f.name} (${f.size} bytes)`, 'ok');
      refresh();
    } catch (e) { log(`upload ${f.name}: ${e.message}`, 'err'); }
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
          && confirm(`${e.message}\n\nSend again with confirm=true?`)) {
        try {
          await api.post(path, { confirm: true });
          log('run (confirmed)', 'ok');
          refresh();
          return;
        } catch (e2) { log(`run: ${e2.message}`, 'err'); return; }
      }
      log(`${label}: ${e.message}`, 'err');
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

async function io(root, api, log) {
  const N = 8;   // panel width; the gateway validates real board bounds
  root.innerHTML = `
    <div class="grid">
      ${card('Digital inputs', `<div class="row tight" id="di"></div>
        <div class="small muted" style="margin-top:6px">read on demand — the 433-byte frame does not carry I/O</div>`,
        '<span class="spacer"></span><button id="di-refresh" style="padding:3px 9px" class="small">refresh</button>')}
      ${card('Digital outputs', '<div id="do"></div>')}
      ${card('Analog', `
        <div class="row" style="margin-bottom:8px">
          <label class="field" style="flex:1">AI index
            <input id="ai-idx" type="number" value="0" min="0"></label>
          <button id="ai-read" style="align-self:flex-end">read</button>
          <span class="mono" id="ai-val" style="align-self:flex-end">—</span>
        </div>
        <div class="row">
          <label class="field" style="flex:1">AO index
            <input id="ao-idx" type="number" value="0" min="0"></label>
          <label class="field" style="flex:1">value
            <input id="ao-val" type="number" value="0" step="0.1"></label>
          <button id="ao-write" style="align-self:flex-end">write</button>
        </div>`)}
    </div>`;

  const di = root.querySelector('#di');
  const readInputs = async () => {
    di.innerHTML = '';
    for (let i = 0; i < N; i++) {
      const el = document.createElement('span');
      el.className = 'tag';
      el.textContent = `DI${i} …`;
      di.append(el);
      api.get(`/api/v1/io/digital/inputs/${i}`).then(
        (r) => { el.textContent = `DI${i} ${r.value}`; el.className = `tag ${r.value ? 'ok' : ''}`; },
        () => { el.textContent = `DI${i} ?`; el.className = 'tag bad'; },
      );
    }
  };
  root.querySelector('#di-refresh').onclick = readInputs;
  readInputs();

  const doDiv = root.querySelector('#do');
  doDiv.innerHTML = Array.from({ length: N }, (_, i) => `
    <div class="row tight" style="margin-bottom:5px">
      <span class="mono small" style="width:38px">DO${i}</span>
      <button data-do="${i}" data-v="1">on</button>
      <button data-do="${i}" data-v="0">off</button>
    </div>`).join('');
  // Outputs carry confirm=true: the gateway requires it because an output
  // can actuate a gripper or a tool, and here the operator's click on a
  // button labelled with that exact output IS the confirmation.
  for (const b of doDiv.querySelectorAll('[data-do]')) {
    b.onclick = () => api.put(`/api/v1/io/digital/outputs/${b.dataset.do}`,
      { value: Number(b.dataset.v), confirm: true })
      .then(() => log(`DO${b.dataset.do} ← ${b.dataset.v}`, 'ok'),
            (e) => log(`DO${b.dataset.do}: ${e.message}`, 'err'));
  }

  root.querySelector('#ai-read').onclick = async () => {
    const i = root.querySelector('#ai-idx').value;
    try {
      const r = await api.get(`/api/v1/io/analog/inputs/${i}`);
      root.querySelector('#ai-val').textContent = r.value ?? JSON.stringify(r);
    } catch (e) { log(`AI${i}: ${e.message}`, 'err'); }
  };
  root.querySelector('#ao-write').onclick = () => {
    const i = root.querySelector('#ao-idx').value;
    const v = parseFloat(root.querySelector('#ao-val').value);
    api.put(`/api/v1/io/analog/outputs/${i}`, { value: v, confirm: true })
      .then(() => log(`AO${i} ← ${v}`, 'ok'), (e) => log(`AO${i}: ${e.message}`, 'err'));
  };
}

// --- Force ---------------------------------------------------------------

async function force(root, api, log) {
  root.innerHTML = `
    <div class="grid">
      ${card('Wrist force / torque', `<table><tbody id="f-now"></tbody></table>
        <div class="small muted" id="f-what" style="margin-top:8px"></div>`)}
      ${card('Sensor', `<div class="mono small" id="f-cfg">loading…</div>
        <div class="row" style="margin-top:10px">
          <button id="f-zero">Zero sensor</button>
        </div>
        <div class="small muted" style="margin-top:8px">
          Zeroing takes the current load as the new reference. Do it with the
          tool unloaded, or the reading will lie by exactly that much.</div>`)}
      ${card('Payload', `<div class="mono small" id="f-pay">loading…</div>
        <div class="small muted" style="margin-top:8px" id="f-pay-note"></div>`)}
    </div>`;

  try {
    const s = await api.get('/api/v1/sensors/force');
    const f = s.force_n, t = s.torque_nm;
    root.querySelector('#f-now').innerHTML = `
      <tr><td class="muted">force N</td><td>${f.fx.toFixed(2)}</td><td>${f.fy.toFixed(2)}</td><td>${f.fz.toFixed(2)}</td></tr>
      <tr><td class="muted">torque Nm</td><td>${t.tx.toFixed(2)}</td><td>${t.ty.toFixed(2)}</td><td>${t.tz.toFixed(2)}</td></tr>
      <tr><td class="muted">|F|</td><td colspan="3">${s.magnitude_n.toFixed(2)} N</td></tr>`;
    root.querySelector('#f-what').textContent = s.what_this_is || '';
  } catch (e) { root.querySelector('#f-now').innerHTML = `<tr><td>${esc(e.message)}</td></tr>`; }

  try {
    const c = await api.get('/api/v1/force/config');
    root.querySelector('#f-cfg').textContent =
      `sensor ${JSON.stringify(c.sensor)} · fields ${c.sensor_fields.join(', ')}`;
  } catch (e) { root.querySelector('#f-cfg').textContent = e.message; }

  try {
    const p = await api.get('/api/v1/force/payload');
    root.querySelector('#f-pay').textContent = JSON.stringify(p, null, 1);
  } catch (e) { root.querySelector('#f-pay').textContent = e.message; }

  root.querySelector('#f-zero').onclick = () =>
    api.post('/api/v1/force/zero', {})
      .then(() => log('force sensor zeroed', 'ok'), (e) => log(e.message, 'err'));
}

// --- Capabilities --------------------------------------------------------

async function capabilities(root, api, log) {
  root.innerHTML = card('Controller capabilities',
    '<div id="cap-body" class="muted">probing…</div>',
    '<span class="spacer"></span><span class="small muted" id="cap-sum"></span>');
  try {
    const c = await api.capabilities();
    root.querySelector('#cap-sum').textContent =
      `${c.available}/${c.total} available · ${c.absent} absent · ${c.unknown} unknown`;
    const body = root.querySelector('#cap-body');
    body.className = 'grid';
    body.innerHTML = Object.entries(c.groups).map(([group, feats]) => card(group,
      `<table><tbody>${Object.entries(feats).map(([name, f]) => {
        const cls = f.state === 'available' ? 'ok' : f.state === 'absent' ? 'bad' : 'warn';
        return `<tr><td style="text-align:left">${esc(name)}</td>
          <td class="muted small" style="text-align:left">${esc(f.method || '')}</td>
          <td><span class="tag ${cls}">${f.state}</span></td></tr>`;
      }).join('')}</tbody></table>`)).join('');

    // The gateway's own vocabulary for the three states is worth repeating
    // verbatim: 'unknown' is NOT evidence a feature is missing.
    const note = document.createElement('div');
    note.className = 'notice';
    note.style.marginTop = '14px';
    note.innerHTML = Object.entries(c.states)
      .map(([k, v]) => `<b>${esc(k)}</b> — ${esc(v)}`).join('<br>');
    root.append(note);
  } catch (e) {
    root.querySelector('#cap-body').textContent = e.message;
    log(`capabilities: ${e.message}`, 'err');
  }
}

// --- Audit ---------------------------------------------------------------

async function audit(root, api, log) {
  root.innerHTML = card('Audit trail',
    `<div class="scroll" style="max-height:520px"><table>
      <thead><tr><th style="text-align:left">Time</th><th style="text-align:left">Action</th><th style="text-align:left">Detail</th></tr></thead>
      <tbody id="audit-rows"></tbody></table></div>`,
    '<span class="spacer"></span><button id="audit-refresh" class="small" style="padding:3px 9px">refresh</button>');

  const refresh = async () => {
    try {
      const r = await api.events(200);
      root.querySelector('#audit-rows').innerHTML = (r.events || []).map((e) => {
        // Events are flat: {seq, ts, action, actor, ...detail}. Show the
        // detail keys only; the envelope has its own columns.
        const { seq, ts, action, actor, ...detail } = e;
        return `
        <tr><td class="mono small">${esc(new Date((ts || 0) * 1000).toLocaleTimeString())}</td>
        <td class="mono small">${esc(action || '')}<div class="muted">${esc(actor || '')}</div></td>
        <td class="small muted">${esc(JSON.stringify(detail))}</td></tr>`;
      }).join('')
        || '<tr><td colspan="3" class="muted">no events recorded yet</td></tr>';
    } catch (e) { log(`audit: ${e.message}`, 'err'); }
  };
  root.querySelector('#audit-refresh').onclick = refresh;
  refresh();
  audit.refresh = refresh;
}

export const PANELS = { faults, programs, io, force, capabilities, audit };
