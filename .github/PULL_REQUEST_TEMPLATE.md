## What & why

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] `pytest -q` and `ruff check fws_console tests` pass.
- [ ] No build step, framework, CDN, or runtime dependency added (see
      CONTRIBUTING) — the CI `guards` job enforces this.
- [ ] Any gateway response rendered into `innerHTML` goes through `esc()`;
      free text uses `log()`/`toast()`.
- [ ] If this touches the 3D stage: the **drag feel is frozen** (turntable
      about the base) — describe any renderer change, but do not alter how a
      drag behaves.
- [ ] If this touches a confirmation: it uses `dialog()`/`confirmGateway()`
      from `ui.js`, never `window.confirm`/`prompt`.
- [ ] Behaviour only a real DOM shows (3D, hit-testing) — describe how you
      verified it in a browser.
