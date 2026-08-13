# FWS Console

[![CI](https://github.com/ichbinmeraj/fws-console/actions/workflows/ci.yml/badge.svg)](https://github.com/ichbinmeraj/fws-console/actions/workflows/ci.yml)

**An operator console for [FWS](https://github.com/ichbinmeraj/fairino-fws),
the REST + WebSocket gateway for Fairino collaborative robots.**

Live telemetry, a 3D arm view, jogging, programs, I/O, force readout, fault
decoding and the audit trail — served by the gateway itself, in any browser.

> ⚠️ **This console is not a safety device.** Its Stop button is a functional
> stop, not an emergency stop. Read the gateway's
> [SAFETY.md](https://github.com/ichbinmeraj/fairino-fws/blob/master/SAFETY.md)
> before connecting anything to a robot.

## Install

The console is an optional add-on. The gateway works without it; installing
the console adds a UI, uninstalling it leaves the gateway exactly as it was.

```bash
pip install fairino-fws-console      # pulls in fairino-fws
fws-console --simulator              # no hardware needed
```

Open <http://localhost:8000/console/>. Every gateway flag works unchanged —
`fws-console` *is* `fws` plus a mounted UI:

```bash
fws-console                          # robot at 192.168.57.2
fws-console --robot-ip 192.168.58.2  # teach port
fws-console --check                  # validate configuration and exit
```

## Why serving from the gateway matters

FWS deliberately ships no CORS middleware and binds to loopback only. A page
served from anywhere else cannot call its API — and that is a feature, not a
gap. The console therefore lives at the gateway's own origin: same process,
same port, no CORS exception, no extra listener, nothing new to secure.

To use it from another machine, tunnel — as with the gateway itself:

```bash
ssh -L 8000:localhost:8000 user@<gateway-host>
```

## What the panels show

### Operator panels

| Panel | What it binds to |
|---|---|
| **Operate** | 10 Hz WebSocket telemetry, 3D arm view, joint/Cartesian jog, per-joint limit headroom |
| **Faults** | live fault state, searchable error-code table with the gateway's own caveat about firmware versions |
| **Programs** | the programs already on the controller — list and download each — plus upload with md5 verification, load, select, validate against the controller's own Lua compiler, run/pause/resume/stop |
| **I/O** | digital, tool digital and analog, read on demand |
| **Force** | wrist force/torque, sensor config, zeroing, activation, and the strategy boundary |
| **Capabilities** | the controller's available / absent / unknown feature matrix, with re-probe |
| **Audit** | who commanded what, when |

### Developer panels

The gateway exposes 100 operations across 22 domains; the console reaches
all of them.

| Panel | What it gives you |
|---|---|
| **Develop** | the whole edit → compile → run → watch loop in one view: the controller's program directory, a Lua editor (syntax highlighting, line numbers, Ctrl+S saves to the controller with md5 verification), compile-check, load, run/stop with the gateway's confirm flow, and a live strip — joints, TCP, force, fault — beside the code |
| **Teach** | capture live poses into a point store, generate literal-pose programs the gateway can pre-flight, read the controller's own taught points, move point tables whole, define tool and work object frames with current-TCP capture, and an honestly-labelled experimental drag-teach |
| **Config** | robot state, velocity, flange pose, tool and work frames, active frames, joint torques, gripper, payload, global speed, motion queue, IK pre-flight, point tables |
| **Commands** | the 594-command wire registry — filter by danger class and kind, read each command's wire arguments, arity, evidence basis and hazards, and invoke it with the policy matrix beside you |
| **Lua** | the 282-function controller catalogue, manual sections, the RPC↔Lua bridge, the argument-order conflicts, what this firmware is missing, and a box that compiles a snippet on the controller itself |
| **API** | every operation, **generated from the gateway's own `/openapi.json`** — filter, fill parameters, edit a JSON body built from the schema, send, read the response with timing, or copy the request as `curl` |
| **Files** | file kinds and their limits, controller filesystem browse/read, Lua compile verdicts, program version history, backup downloads |
| **System** | health warnings, boot/recovery layers with port state, versions, controller services, processes, qconn, the controller shell, and the guarded restart / reboot / shutdown paths |

The API panel is generated, not hand-written: an endpoint added to a future
gateway release appears in this console without a change here.

### The 3D view does not guess silently

There is no published, verified link geometry for these arms, and FWS never
hardcodes robot constants. So the console draws the arm from a declared
kinematic model and **checks itself on every frame**: it compares its own
forward kinematics against the TCP the controller reports and shows the
disagreement in millimetres. Against `--simulator` it reads 0.00 mm — the
model reproduces the simulator's kinematics exactly. Against real hardware it
will tell you honestly how approximate the picture is.

## Development

No build step, no bundler, no CDN, no JavaScript dependencies. The UI is
plain ES modules in `fws_console/web/`, served by the gateway. Edit a file,
refresh the browser.

```bash
git clone https://github.com/ichbinmeraj/fws-console && cd fws-console
python3 -m venv .venv && .venv/bin/pip install -e .[dev]
.venv/bin/fws-console --simulator
```

That is deliberate: robot cells are often air-gapped, so every byte the
console needs ships in the wheel.

## Licence

Apache-2.0. An independent project, not affiliated with or endorsed by FAIR
Innovation.
