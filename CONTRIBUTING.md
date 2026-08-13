# Contributing

Thanks for looking. This is the operator + developer console for
[FWS](https://github.com/ichbinmeraj/fairino-fws); the gateway lives in its
own repository.

## The one architectural rule

**No build step, no framework, no CDN, no runtime dependencies.** The browser
code is plain ES modules under `fws_console/web/`, served directly by the
gateway. A robot cell is often air-gapped, so every byte the console needs
ships inside the Python wheel. A pull request that adds npm, a bundler, or a
`<script src="https://…">` will not be merged — the constraint is the point.

If a future feature genuinely needs a build (a Monaco-based Lua editor is the
likely first case), that is a deliberate, discussed change to this rule, not
a default.

## Getting set up

```bash
git clone https://github.com/ichbinmeraj/fws-console && cd fws-console
python3 -m venv .venv && .venv/bin/pip install -e .[dev]
.venv/bin/fws-console --simulator
```

`--simulator` starts the gateway's built-in fake controller, so you need no
robot. Open <http://localhost:8000/console/>. Edit a file under
`fws_console/web/`, refresh the browser — the gateway serves it `no-cache`,
so a plain refresh always gets your change.

## Working on the UI

- `js/main.js` — the shell: telemetry binding, lease, jog, tabs, palette,
  keyboard model.
- `js/panels.js` / `js/devpanels.js` — operator and developer panels. Each is
  a function that renders into its `<section>` and gets `(root, api, log,
  toast)`.
- `js/view3d.js` + `js/stage-worker.js` — the 3D arm. The **drag feel is
  frozen**: it turns as a turntable about the base and was settled over many
  iterations. Optimize the renderer freely, but do not change how a drag
  behaves.
- `js/ui.js` — dialogs, command palette, skeletons. Use `dialog()` /
  `confirmGateway()`, never `window.confirm`/`prompt` (a test enforces this).
- `css/app.css` — one design system. Sizes come from the `--fs-*` tokens;
  text colours are **measured** against both themes (a test re-derives the
  WCAG ratios, so a colour edit that dips below AA fails the build).

Any value from a gateway response that goes into `innerHTML` must pass
through `esc()`. Free text belongs in `log()`/`toast()`, which use
`textContent`.

## Tests

```bash
.venv/bin/python -m pytest -q      # packaging + interface-quality checks
.venv/bin/ruff check fws_console tests
```

The Python tests pin the mount contract, the no-CORS asset serving, coverage
of every gateway domain, and the interface-quality invariants (no native
dialogs, tokenised type scale, AA contrast). Behaviour that only a real DOM
can show — the 3D stage, click hit-testing — is verified by driving a
headless browser, not in the pytest suite; describe such changes in the PR.

## Commits

Small, focused commits with a message that says *why*. End the trailer with
`Co-Authored-By:` if a tool helped.
