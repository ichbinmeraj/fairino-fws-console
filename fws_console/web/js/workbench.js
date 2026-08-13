// The Develop workbench: the edit → compile → load → run → watch loop in ONE
// view, instead of four tabs.
//
//   files | editor | live-state       + an output bar underneath
//
// The editor is deliberately hand-rolled (a transparent <textarea> over a
// highlighted <pre>, scroll-synced): no CodeMirror, no Monaco, no CDN — a
// robot cell may be air-gapped, and every byte ships in the wheel.
//
// Saving is REAL: PUT /programs/{name} uploads to the controller over the
// wire protocol, md5-verified, and a rejected program comes back with the
// controller's own compiler verdict. Check = save + validate. Run keeps the
// gateway's confirm flow. All commanding buttons carry data-cmd and are
// gated by the control lease like every other command in the console.

import { ApiError } from './api.js';
import { confirmGateway, dialog } from './ui.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// --- Lua highlighting -----------------------------------------------------
// One combined tokenizer pass; every slice is escaped before it reaches
// innerHTML. Order matters: comments beat strings beat everything else.

const LUA_KW = new Set(('and break do else elseif end false for function goto '
  + 'if in local nil not or repeat return then true until while').split(' '));

const TOKEN = new RegExp([
  '(--\\[\\[[\\s\\S]*?\\]\\]|--[^\\n]*)',              // 1 comment
  '("(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\')', // 2 string
  '(\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)',        // 3 number
  '(\\b[A-Za-z_]\\w*\\b)',                             // 4 word
].join('|'), 'g');

function highlightLua(src) {
  let out = '';
  let last = 0;
  for (const m of src.matchAll(TOKEN)) {
    out += esc(src.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) out += `<i class="hl-c">${esc(m[1])}</i>`;
    else if (m[2] !== undefined) out += `<i class="hl-s">${esc(m[2])}</i>`;
    else if (m[3] !== undefined) out += `<i class="hl-n">${esc(m[3])}</i>`;
    else {
      const w = m[4];
      if (LUA_KW.has(w)) out += `<i class="hl-k">${esc(w)}</i>`;
      else if (/^[A-Z]/.test(w) && src[last] === '(') {
        out += `<i class="hl-f">${esc(w)}</i>`;   // PTP( Lin( MoveL( …
      } else out += esc(w);
    }
  }
  return out + esc(src.slice(last));
}

// --- The panel ------------------------------------------------------------

export async function develop(root, api, log, toast) {
  root.innerHTML = `
    <div class="wb">
      <div class="wb-files card">
        <h2>Programs
          <span class="spacer"></span>
          <button class="btn btn-sm btn-ghost" id="wb-new" title="New program">+</button>
          <button class="btn btn-sm btn-ghost" id="wb-reload" title="Reload the listing">↻</button>
        </h2>
        <div class="wb-list" id="wb-list" role="listbox" aria-label="Programs"></div>
        <div class="small faint" id="wb-files-note" style="margin-top:8px"></div>
      </div>

      <div class="wb-editor card">
        <h2>
          <span class="mono" id="wb-name">no file open</span>
          <span class="wb-dirty" id="wb-dirty" hidden title="unsaved changes">●</span>
          <span class="spacer"></span>
          <button class="btn btn-sm" id="wb-save" data-cmd="1"
                  title="Upload to the controller (Ctrl+S)">Save</button>
          <button class="btn btn-sm btn-ghost" id="wb-check" data-cmd="1"
                  title="Save, then compile on the controller">Check</button>
          <button class="btn btn-sm btn-ghost" id="wb-sim"
                  title="Animate the program's literal-pose moves as a ghost — the robot does not move">Sim</button>
          <button class="btn btn-sm" id="wb-load" data-cmd="1"
                  title="Make this the controller's loaded program">Load</button>
          <button class="btn btn-sm btn-primary" id="wb-run" data-cmd="1">
            <svg viewBox="0 0 17 17"><use href="#i-run"/></svg>Run</button>
          <button class="btn btn-sm btn-danger" id="wb-stop" data-cmd="1">
            <svg viewBox="0 0 17 17"><use href="#i-stop"/></svg>Stop</button>
        </h2>
        <div class="wb-edwrap" id="wb-edwrap" hidden>
          <div class="wb-gutter" id="wb-gutter" aria-hidden="true"></div>
          <div class="wb-edstack">
            <pre class="wb-hl" id="wb-hl" aria-hidden="true"><code id="wb-hlcode"></code></pre>
            <textarea id="wb-ta" class="wb-ta" spellcheck="false" wrap="off"
                      aria-label="Program source"></textarea>
          </div>
        </div>
        <div class="empty" id="wb-empty">
          <svg viewBox="0 0 17 17"><use href="#i-program"/></svg>
          open a program on the left, or create a new one</div>
      </div>

      <div class="wb-live card">
        <h2>Live</h2>
        <table class="wb-joints"><tbody id="wb-joints"></tbody></table>
        <dl class="kv" style="margin-top:8px">
          <dt>TCP</dt><dd class="mono small" id="wb-tcp">—</dd>
          <dt>|F|</dt><dd id="wb-f">—</dd>
          <dt>Fault</dt><dd id="wb-fault">—</dd>
        </dl>
        <div class="wb-exec" style="margin-top:10px">
          <dl class="kv">
            <dt>State</dt><dd id="wb-exstate">—</dd>
            <dt>Loaded</dt><dd class="mono small" id="wb-exloaded">—</dd>
            <dt>Line</dt><dd id="wb-exline">—</dd>
          </dl>
        </div>
        <div class="small faint" style="margin-top:10px">
          A program commands motion the gateway does not bound. Clear the
          cell before Run; the gateway asks for confirmation.</div>
      </div>

      <div class="wb-out card">
        <h2>Output
          <span class="spacer"></span>
          <button class="btn btn-sm btn-ghost" id="wb-clear">clear</button></h2>
        <div class="wb-outlog mono small" id="wb-outlog"></div>
      </div>
    </div>`;

  const $ = (id) => root.querySelector(id);
  const outlog = $('#wb-outlog');
  const say = (msg, cls = '') => {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    d.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
    outlog.append(d);
    outlog.scrollTop = outlog.scrollHeight;
  };
  $('#wb-clear').onclick = () => { outlog.innerHTML = ''; };

  // --- editor state -------------------------------------------------------
  const ta = $('#wb-ta');
  const hlcode = $('#wb-hlcode');
  const gutter = $('#wb-gutter');
  let openName = null;
  let dirty = false;
  let savedText = '';

  const setDirty = (v) => {
    dirty = v;
    $('#wb-dirty').hidden = !v;
  };

  const paint = () => {
    // Trailing newline keeps the <pre> as tall as the textarea's last line.
    hlcode.innerHTML = highlightLua(ta.value) + '\n';
    const lines = ta.value.split('\n').length;
    if (gutter.childElementCount !== lines) {
      gutter.innerHTML = Array.from({ length: lines },
        (_, i) => `<div>${i + 1}</div>`).join('');
    }
  };
  let paintQueued = false;
  ta.addEventListener('input', () => {
    setDirty(ta.value !== savedText);
    if (!paintQueued) {
      paintQueued = true;
      requestAnimationFrame(() => { paintQueued = false; paint(); });
    }
  });
  ta.addEventListener('scroll', () => {
    $('#wb-hl').scrollTop = ta.scrollTop;
    $('#wb-hl').scrollLeft = ta.scrollLeft;
    gutter.scrollTop = ta.scrollTop;
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {           // insert two spaces, don't leave the field
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en } = ta;
      ta.setRangeText('  ', s, en, 'end');
      ta.dispatchEvent(new Event('input'));
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      $('#wb-save').click();
    }
  });

  const openBuffer = (name, text) => {
    openName = name;
    savedText = text;
    ta.value = text;
    setDirty(false);
    $('#wb-name').textContent = name;
    $('#wb-edwrap').hidden = false;
    $('#wb-empty').hidden = true;
    paint();
    ta.focus();
    for (const el of root.querySelectorAll('.wb-list [role="option"]')) {
      el.setAttribute('aria-selected', String(el.dataset.name === name));
    }
  };

  // --- files --------------------------------------------------------------
  const refreshFiles = async () => {
    const list = $('#wb-list');
    list.innerHTML = '<div class="small dim" style="padding:6px">loading…</div>';
    try {
      const r = await api.get('/api/v1/files/lua?source=controller',
        { timeout: 120000 });
      const files = r.files || [];
      $('#wb-files-note').textContent =
        `${files.length} on the controller`;
      list.innerHTML = files.map((f) => `
        <div role="option" tabindex="0" data-name="${esc(f.name)}"
             aria-selected="${String(f.name === openName)}">
          <span class="mono">${esc(f.name)}</span>
          <span class="small faint">${f.bytes ?? '?'} B</span>
        </div>`).join('')
        || '<div class="small faint" style="padding:6px">none on the controller</div>';
      for (const el of list.querySelectorAll('[role="option"]')) {
        const open = async () => {
          if (dirty && !(await confirmGateway(
            `${openName} has unsaved changes; discard them?`,
            { title: 'Discard changes?', confirmLabel: 'Discard' }))) return;
          try {
            const d = await api.get(
              `/api/v1/files/lua/${encodeURIComponent(el.dataset.name)}`,
              { timeout: 120000 });
            openBuffer(el.dataset.name, d.content ?? '');
            say(`opened ${el.dataset.name} (${d.bytes} B)`);
          } catch (e) { say(`open ${el.dataset.name}: ${e.message}`, 'err'); }
        };
        el.onclick = open;
        el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
      }
    } catch (e) {
      list.innerHTML = `<div class="banner warn"><span class="small">${esc(e.message)}</span></div>`;
    }
  };
  $('#wb-reload').onclick = refreshFiles;

  $('#wb-new').onclick = async () => {
    if (dirty && !(await confirmGateway(
      `${openName} has unsaved changes; discard them?`,
      { title: 'Discard changes?', confirmLabel: 'Discard' }))) return;
    const name = await dialog({
      title: 'New program',
      body: '<p class="small dim">Saved to the controller on first Save.</p>',
      confirmLabel: 'Create',
      input: { value: 'new.lua', placeholder: 'name.lua' },
    });
    if (!name) return;
    const n = name.endsWith('.lua') ? name : `${name}.lua`;
    openBuffer(n, '-- ' + n + '\n');
    setDirty(true);
    say(`new buffer ${n} — Save uploads it to the controller`);
  };

  // --- save / check / load / run / stop ----------------------------------
  const save = async () => {
    if (!openName) return false;
    const put = (overwrite) => api.put(
      `/api/v1/programs/${encodeURIComponent(openName)}`,
      overwrite ? { content: ta.value, overwrite: true } : { content: ta.value });
    try {
      let info;
      try {
        info = await put(false);
      } catch (e) {
        const clash = e instanceof ApiError && e.status === 409;
        if (!clash) throw e;
        info = await put(true);   // it exists — an editor save IS an overwrite
      }
      savedText = ta.value;
      setDirty(false);
      say(`saved ${openName} → controller (${info.bytes} B, md5 ${String(info.md5 || '').slice(0, 8)})`, 'ok');
      log(`saved ${openName}`, 'ok');
      refreshFiles();
      return true;
    } catch (e) {
      say(`save ${openName}: ${e.message}`, 'err');
      log(`save ${openName}: ${e.message}`, 'err');
      return false;
    }
  };
  $('#wb-save').onclick = save;

  $('#wb-check').onclick = async () => {
    if (!openName) return;
    if (dirty && !(await save())) return;
    say(`compiling ${openName} on the controller…`);
    try {
      const r = await api.post(
        `/api/v1/programs/${encodeURIComponent(openName)}/validate`, {});
      const bad = r.ok === false;
      say(`${openName}: ${bad ? 'REJECTED' : 'compiled clean'}`
        + (r.verdict ? ` — ${JSON.stringify(r.verdict)}` : ''), bad ? 'err' : 'ok');
    } catch (e) { say(`check: ${e.message}`, 'err'); }
  };

  // Sim run: extract the literal-pose moves (MoveJ/MoveL carry j1..j6 as
  // their first six args) and animate a ghost through them. Named-point
  // calls (PTP/Lin) resolve inside the controller's point database, which
  // this console cannot read as a whole — they are counted and reported,
  // never silently dropped. No robot command is sent; no lease is needed.
  $('#wb-sim').onclick = () => {
    const src = ta.value;
    const waypoints = [];
    for (const m of src.matchAll(/\b(?:MoveJ|MoveL)\s*\(([^)]*)\)/g)) {
      const args = m[1].split(',').map((s) => parseFloat(s));
      if (args.length >= 6 && args.slice(0, 6).every(Number.isFinite)) {
        waypoints.push(args.slice(0, 6));
      }
    }
    const named = (src.match(/\b(?:PTP|Lin)\s*\(/g) || []).length;
    if (!waypoints.length) {
      say(named
        ? `nothing to simulate: ${named} named-point move(s) resolve on the controller; only literal-pose MoveJ/MoveL can be simulated here`
        : 'nothing to simulate: no literal-pose MoveJ/MoveL in this program', 'err');
      return;
    }
    if (named) {
      say(`simulating ${waypoints.length} literal move(s); ${named} named-point move(s) NOT simulated (they resolve on the controller)`);
    } else {
      say(`simulating ${waypoints.length} move(s) — ghost only, robot untouched`);
    }
    document.dispatchEvent(new CustomEvent('fws-sim-run', {
      detail: { waypoints, speed: 25 },
    }));
  };

  $('#wb-load').onclick = async () => {
    if (!openName) return;
    if (dirty && !(await save())) return;
    try {
      await api.post(`/api/v1/programs/${encodeURIComponent(openName)}/load`, {});
      say(`loaded ${openName}`, 'ok');
      pollExec();
    } catch (e) { say(`load: ${e.message}`, 'err'); }
  };

  $('#wb-run').onclick = async () => {
    try {
      await api.post('/api/v1/execution/run', {});
      say('run', 'ok');
      pollExec();
    } catch (e) {
      // The gateway refuses once without confirm — by design. Surface its
      // own wording, then re-ask with confirmation.
      if (e instanceof ApiError && e.status === 400
          && await confirmGateway(e.message, {
            title: 'Run the loaded program?', confirmLabel: 'Clear — run it',
          })) {
        try {
          await api.post('/api/v1/execution/run', { confirm: true });
          say('run (confirmed)', 'ok');
          pollExec();
        } catch (e2) { say(`run: ${e2.message}`, 'err'); }
        return;
      }
      say(`run: ${e.message}`, 'err');
    }
  };
  $('#wb-stop').onclick = async () => {
    try {
      await api.post('/api/v1/execution/stop', {});
      say('stop', 'ok');
      pollExec();
    } catch (e) { say(`stop: ${e.message}`, 'err'); }
  };

  // --- live state ---------------------------------------------------------
  const jbody = $('#wb-joints');
  jbody.innerHTML = Array.from({ length: 6 }, (_, i) =>
    `<tr><td class="dim">J${i + 1}</td><td class="num" id="wb-j${i}">—</td></tr>`).join('');

  const onFrame = (ev) => {
    if (root.closest('section')?.hidden) return;   // free while not shown
    const f = ev.detail;
    if (f.joints) {
      for (let i = 0; i < 6; i++) {
        const el = $(`#wb-j${i}`);
        if (el && f.joints[i] !== undefined) el.textContent = f.joints[i].toFixed(2) + '°';
      }
    }
    if (f.tcp) {
      $('#wb-tcp').textContent =
        `${f.tcp[0].toFixed(1)} ${f.tcp[1].toFixed(1)} ${f.tcp[2].toFixed(1)}`;
    }
    if (f.ft) {
      const m = Math.hypot(f.ft[0], f.ft[1], f.ft[2]);
      $('#wb-f').textContent = `${m.toFixed(2)} N`;
    }
    const flt = $('#wb-fault');
    if (f.error_main || f.error_sub) {
      flt.innerHTML = `<span class="tag bad">${f.error_main}/${f.error_sub}</span>`;
    } else flt.innerHTML = '<span class="tag ok">none</span>';
  };
  document.addEventListener('fws-frame', onFrame);

  let execTimer = null;
  const pollExec = async () => {
    try {
      const x = await api.get('/api/v1/execution');
      $('#wb-exstate').innerHTML =
        `<span class="tag ${x.state === 'running' ? 'ok' : ''}">${esc(x.state)}</span>`;
      $('#wb-exloaded').textContent = x.loaded || '—';
      $('#wb-exline').textContent = x.current_line ?? '—';
      clearInterval(execTimer);
      // While running, follow the program counter; otherwise stay quiet.
      if (x.state === 'running') {
        execTimer = setInterval(() => {
          if (root.closest('section')?.hidden) return;
          pollExec();
        }, 2000);
      }
    } catch (e) { $('#wb-exstate').textContent = e.message; }
  };

  develop.refresh = () => { refreshFiles(); pollExec(); };
  refreshFiles();
  pollExec();
}

export const WB_PANELS = { develop };
