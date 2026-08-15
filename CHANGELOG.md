# Changelog

All notable changes to `fairino-fws-console` are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/); the project follows
[Semantic Versioning](https://semver.org/) once it reaches 1.0.

## [0.1.0a1] — 2026-08-15

### Changed

- **Taught points live on the gateway now**, not in this browser. A taught
  point is production data; in `localStorage` it died with a browser
  profile, could not be reviewed or backed up, and no API client or CI job
  could see it. The Teach panel reads and writes `/api/v1/poses`, and
  migrates anything a previous version left behind on first load — clearing
  the local copy only once every point is safely elsewhere.

  Capture is the gateway's job too: it takes one telemetry frame, so a
  pose's joint and Cartesian halves cannot disagree, and it refuses a stale
  frame rather than recording where the arm used to be.

- Whole-program generation moved to `POST /api/v1/poses/program`, which owns
  the MoveJ prototype and asserts its probed arity. The console's own
  generator is gone: two copies of that knowledge is how they drift.

- Requires `fairino-fws>=0.1.0a5`.

### Added

- Teach panel: a **Reset to base** button on the work object card — one
  click returns the frame to the identity (all-zero offset in ref 0),
  through the same gateway confirm flow as defining it. Previously the only
  way back was hand-typing six zeros.

## [0.1.0a0] — 2026-08-15

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

### Added

- **Sim run — dry-run motion in the 3D view, robot untouched.** Teach's
  *Sim run* animates a translucent dashed ghost (labelled SIM) through the
  taught points; Develop's *Sim* does the same for a program's literal-pose
  MoveJ/MoveL lines (named-point moves are counted and reported as
  not-simulated — they resolve inside the controller). The ghost is driven
  by the same measured kinematic model as the live arm, over the live arm;
  the whole sim path is API-free by construction and a test pins that it
  can never send a robot command. (Full-stack simulation without hardware
  is unchanged: `fws-console --simulator`.)
- **Teach — points, frames and work objects, as this gateway actually
  supports them.** Capture the live pose into a console-side point store
  (this firmware has no per-point write: no RPC exists and the Lua path is a
  confirmed silent no-op — the panel says so instead of pretending);
  generate a program from taught points using literal-pose MoveJ/MoveL
  (manual prototypes, arity-verified on this firmware — literal poses keep
  the gateway's path pre-flight working); read named points from the
  controller's own teaching database (`GetRobotTeachingPoint`,
  hardware-verified; 143 = no such point); move whole point tables
  (download / readback-verified restore / switch); define tool frames
  (1–15) and work object frames (0–14) with a "use current TCP" capture;
  and an experimental, honestly-labelled drag-teach toggle with true-state
  polling. The console lease now also holds the `config` domain so frame
  and table writes work under the same Take control.
- **Stage fullscreen.** The expand button now does what its icon promises:
  true fullscreen of the 3D stage (it previously re-framed an already
  framed arm — a visible no-op). The icon swaps to a compress glyph,
  Escape exits natively — and a guard keeps that Escape from reaching the
  Esc=STOP shortcut, so leaving fullscreen can never halt a running
  program.
- **3D view, product-grade.** Contact shadows anchor the arm to the floor;
  the ground grid gained hierarchy (axis lines, edge fade, close-zoom
  minors); the TCP trail fades with age, tapers, and carries a head dot; a
  dashed plumb line and a flange triad make height and orientation legible;
  a screen-fixed corner gizmo replaces the occluding in-scene axis labels;
  the key light is camera-locked so the arm never goes flat when orbited;
  view presets fly (250 ms ease, cancelled instantly by a grab — the drag
  mapping itself is untouched) and solve their framing at the target
  orbit; hovering a jog row rings and tints the joint it drives; a
  near-plane clamp removes mirrored-line artifacts at close zoom; worker
  render errors now actually reach the page (the old channel was dead);
  HiDPI screens get full-resolution GL and line layers.

- **Develop — a workbench for writing and testing programs.** The
  edit → compile → load → run → watch loop lived across four tabs and the
  console could not edit at all; now one view holds the controller's program
  directory, a hand-rolled Lua editor (highlight overlay, line numbers,
  Tab-inserts-spaces, Ctrl+S), Save that uploads to the controller with md5
  verification, Check that compiles on the controller, Load/Run/Stop with
  the gateway's confirm flow, and a live strip — joints, TCP, |F|, fault,
  execution state — beside the code. No editor dependency ships: the
  highlighter is a single escaped-token pass, in keeping with the no-CDN
  air-gap rule.
- **Programs — browse and download what is already on the controller.** The
  panel now defaults to the controller's real `.lua` directory (read over FTP;
  the controller's own listing RPC is quarantined because it can wedge the
  channel), with a toggle back to the gateway's own upload index. Every
  program has a **download** button that saves the file locally — previously
  the panel showed only files uploaded through this gateway, so programs put
  on the controller by the teach pendant were invisible.

### Robustness

Hardening found by driving every panel against a live FR5 (firmware
v3.8.5.1), not only the simulator:

- **I/O** — a whole read family that answers the same error for every channel
  (a faulted controller returns `error 14` for all of `GetDI`) now collapses
  to one line stating the reason, instead of a wall of red `DI? …DI?` tags
  that read as a hardware fault. A family the firmware genuinely lacks says so
  once; partial results still show one tag per channel.
- **Force** — the payload card renders the mismatch object and its prose
  (consequence, how-to-fix) as wrapped text in a bordered block, instead of a
  single `JSON.stringify` line that ran off the card's right edge.
- **Capabilities** — long RPC method names wrap and the available/absent tag
  is pinned to an always-visible column; previously a long name shoved the tag
  off the card and clipped it.
- **Requests** — a request that times out is reported as "the gateway did not
  answer within Ns" (it may be a slow FTP transfer or service probe), no
  longer as the misleading "cannot reach gateway"; a caller-cancelled request
  is not surfaced as an error at all. FTP- and shell-backed calls are given
  timeouts that reach the gateway's own, so a slow-but-fine controller call no
  longer aborts client-side.

### Accessibility

- Every text token meets WCAG AA 4.5:1 against both surfaces in both themes,
  verified by a test that re-derives the ratios from the stylesheet.
- Skip link, per-panel document titles, focus moved into the selected panel,
  reduced-motion support.

### Requires

- `fairino-fws >= 0.1.0a1` — the first gateway release with the
  `configure_app` hook and `register_open_path`.
