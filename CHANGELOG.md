# Changelog

All notable changes to `fairino-fws-console` are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/); the project follows
[Semantic Versioning](https://semver.org/) once it reaches 1.0.

## [0.1.0a0] — unreleased

First release: an optional operator + developer console for
[FWS](https://github.com/ichbinmeraj/fairino-fws), served by the gateway
itself at `/console`.

### Operator surface

- Live telemetry at 10 Hz over the gateway WebSocket: joints, TCP pose,
  force/torque, joint torques, fault and program state.
- A 3D arm view rendered on the GPU (WebGL2 in a Web Worker) with a
  full-2D-canvas fallback for browsers without OffscreenCanvas. Turntable
  orbit about the base, six fixed viewpoints, wheel/pinch zoom.
- The kinematic model is **measured**, not assumed: fitted against the
  controller's own `GetForwardKin` (0.00 mm RMS over 59 poses) and
  re-checked against the reported TCP every frame; the badge states the
  disagreement in millimetres and names the cause when it cannot compare.
- Joint and Cartesian jogging with per-joint limit headroom, gated by the
  control lease with an auto-renewing countdown.
- Faults with a searchable error-code table, programs (upload, load, select,
  validate against the controller's own Lua compiler, run/pause/resume/stop),
  I/O, force, capabilities with re-probe, and the audit trail.

### Developer surface

- **API** — an explorer generated from the gateway's `/openapi.json`, so it
  reaches every operation the gateway exposes and picks up new ones without
  a console change. Fill parameters and a schema-built body, send, read the
  response with timing, or copy the call as `curl`.
- **Commands** — the wire-command registry, filterable by danger class and
  kind, with wire arguments, hazards and the invoke policy matrix; invoke
  directly.
- **Lua** — the function catalogue, manual sections, the RPC↔Lua bridge, the
  argument-order conflicts, this firmware's absent functions, and an
  on-controller compile box.
- **Files**, **System**, **Config** — controller filesystem, compile
  verdicts, backups; health, boot/recovery, services, processes, shell,
  guarded lifecycle; and every robot setting.
- A command palette (Cmd/Ctrl-K) over panels, actions, endpoints and
  commands; a keyboard model (`?` sheet, `g`+`n` jumps); styled modal
  dialogs replacing native `confirm`/`prompt`.

### Accessibility

- Every text token meets WCAG AA 4.5:1 against both surfaces in both themes,
  verified by a test that re-derives the ratios from the stylesheet.
- Skip link, per-panel document titles, focus moved into the selected panel,
  reduced-motion support.

### Requires

- `fairino-fws >= 0.1.0a1` — the first gateway release with the
  `configure_app` hook and `register_open_path`.
