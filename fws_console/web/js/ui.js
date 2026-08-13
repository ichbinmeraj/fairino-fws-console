// Shared UI primitives: modal dialogs, the command palette, skeletons.
//
// Why these exist rather than the browser's own:
//
//   window.confirm/prompt block the event loop (the telemetry socket keeps
//   buffering but nothing renders), cannot be styled, cannot carry a
//   destructive-action treatment, are suppressible by the browser after
//   repeated use — "prevent this page from creating additional dialogs"
//   would silently disable a robot confirmation — and on a tablet they are
//   a system sheet with no relation to the console. A robot console asking
//   "run this program?" must own that moment.

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------- dialog */

let dlg = null;

function ensureDialog() {
  if (dlg) return dlg;
  dlg = document.createElement('dialog');
  dlg.className = 'dlg';
  dlg.innerHTML = `
    <form method="dialog">
      <h3 id="dlg-title"></h3>
      <div id="dlg-body"></div>
      <label id="dlg-input-wrap" hidden>
        <input id="dlg-input" autocomplete="off" spellcheck="false">
      </label>
      <div class="dlg-actions">
        <button value="cancel" class="btn" id="dlg-cancel">Cancel</button>
        <button value="ok" class="btn btn-primary" id="dlg-ok">OK</button>
      </div>
    </form>`;
  document.body.append(dlg);
  return dlg;
}

/**
 * Promise-based replacement for confirm()/prompt().
 * Resolves to false on cancel; true (or the typed string) on confirm.
 * <dialog>.showModal() gives a real focus trap, Esc handling and inert
 * background for free — no hand-rolled focus management to get wrong.
 */
export function dialog({
  title, body = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  danger = false, input = null,
} = {}) {
  const d = ensureDialog();
  $('dlg-title').textContent = title;
  $('dlg-body').innerHTML = body;
  const ok = $('dlg-ok');
  ok.textContent = confirmLabel;
  ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  $('dlg-cancel').textContent = cancelLabel;

  const wrap = $('dlg-input-wrap');
  const field = $('dlg-input');
  wrap.hidden = input === null;
  if (input !== null) {
    field.value = input.value ?? '';
    field.placeholder = input.placeholder ?? '';
    field.type = input.type ?? 'text';
  }

  return new Promise((resolve) => {
    const done = () => {
      d.removeEventListener('close', done);
      const confirmed = d.returnValue === 'ok';
      resolve(confirmed ? (input !== null ? field.value.trim() : true) : false);
    };
    d.addEventListener('close', done);
    d.showModal();
    (input !== null ? field : ok).focus();
    if (input !== null) field.select();
  });
}

/** Confirm shaped for the gateway's own refusal text. */
export function confirmGateway(message, { title = 'Confirm', danger = true,
                                          confirmLabel = 'Send anyway' } = {}) {
  const esc = (s) => String(s).replace(/[&<>]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return dialog({
    title,
    body: `<p class="dlg-quote">${esc(message)}</p>`,
    confirmLabel, danger,
  });
}

/* ------------------------------------------------------------- skeletons */

/** Loading placeholder that occupies the shape the content will take, so
 * the panel does not jump when data lands. */
export function skeleton(rows = 3, { width = '100%' } = {}) {
  return `<div class="skel" aria-busy="true" aria-live="polite">${
    Array.from({ length: rows }, (_, i) =>
      `<div class="skel-row" style="width:${
        i === rows - 1 ? '60%' : width}"></div>`).join('')
  }</div>`;
}

/* --------------------------------------------------------------- palette */

let paletteEl = null;
let providers = [];
let items = [];
let active = 0;

/**
 * Register a source of palette entries.
 * @param {() => Promise<Array<{group,label,hint,run}>>|Array} fn
 */
export function registerPalette(fn) { providers.push(fn); }

function buildPalette() {
  if (paletteEl) return paletteEl;
  paletteEl = document.createElement('div');
  paletteEl.className = 'palette';
  paletteEl.hidden = true;
  paletteEl.innerHTML = `
    <div class="palette-scrim"></div>
    <div class="palette-box" role="dialog" aria-modal="true" aria-label="Command palette">
      <input id="pal-input" placeholder="Jump to a panel, endpoint or command…"
             autocomplete="off" spellcheck="false" aria-controls="pal-list"
             aria-expanded="true" role="combobox">
      <div id="pal-list" role="listbox"></div>
      <div class="palette-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
        <span><kbd>↵</kbd> run</span>
        <span><kbd>esc</kbd> close</span>
      </div>
    </div>`;
  document.body.append(paletteEl);
  paletteEl.querySelector('.palette-scrim').onclick = closePalette;
  const input = paletteEl.querySelector('#pal-input');
  input.oninput = renderPalette;
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); runActive(); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  };
  return paletteEl;
}

function move(d) {
  const rows = paletteEl.querySelectorAll('.pal-item');
  if (!rows.length) return;
  active = (active + d + rows.length) % rows.length;
  rows.forEach((r, i) => {
    r.classList.toggle('sel', i === active);
    r.setAttribute('aria-selected', String(i === active));
  });
  rows[active].scrollIntoView({ block: 'nearest' });
}

function runActive() {
  const rows = paletteEl.querySelectorAll('.pal-item');
  const row = rows[active];
  if (!row) return;
  const item = items[Number(row.dataset.i)];
  closePalette();
  item.run();
}

/** Rank: exact prefix beats word-start beats substring; ties by shortness. */
function score(label, q) {
  const l = label.toLowerCase();
  const i = l.indexOf(q);
  if (i < 0) return -1;
  if (i === 0) return 1000 - label.length;
  if (/[\s/._-]/.test(l[i - 1])) return 500 - label.length;
  return 100 - i;
}

function renderPalette() {
  const q = paletteEl.querySelector('#pal-input').value.trim().toLowerCase();
  const list = paletteEl.querySelector('#pal-list');
  const ranked = (q
    ? items.map((it, i) => ({ it, i, s: score(`${it.group} ${it.label}`, q) }))
        .filter((r) => r.s >= 0).sort((a, b) => b.s - a.s)
    : items.map((it, i) => ({ it, i, s: 0 }))
  ).slice(0, 60);

  active = 0;
  list.innerHTML = ranked.map((r, n) => `
    <div class="pal-item${n === 0 ? ' sel' : ''}" role="option"
         aria-selected="${n === 0}" data-i="${r.i}">
      <span class="pal-group">${r.it.group}</span>
      <span class="pal-label">${r.it.label}</span>
      ${r.it.hint ? `<span class="pal-hint">${r.it.hint}</span>` : ''}
    </div>`).join('')
    || '<div class="empty">nothing matches</div>';

  for (const row of list.querySelectorAll('.pal-item')) {
    row.onclick = () => {
      active = [...list.querySelectorAll('.pal-item')].indexOf(row);
      runActive();
    };
  }
}

export async function openPalette() {
  const el = buildPalette();
  el.hidden = false;
  const input = el.querySelector('#pal-input');
  input.value = '';
  el.querySelector('#pal-list').innerHTML = skeleton(4);
  input.focus();

  const gathered = await Promise.all(providers.map(async (p) => {
    try { return await (typeof p === 'function' ? p() : p); }
    catch { return []; }
  }));
  items = gathered.flat();
  renderPalette();
}

export function closePalette() {
  if (paletteEl) paletteEl.hidden = true;
}

export function paletteOpen() {
  return paletteEl && !paletteEl.hidden;
}

/* ------------------------------------------------------------- shortcuts */

export function shortcutsSheet(rows) {
  return dialog({
    title: 'Keyboard shortcuts',
    body: `<table class="shortcuts">${rows.map(([k, d]) =>
      `<tr><td>${k.split('+').map((x) => `<kbd>${x}</kbd>`).join('')}</td>
       <td>${d}</td></tr>`).join('')}</table>`,
    confirmLabel: 'Close',
    cancelLabel: '',
  });
}
