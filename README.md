# FWS Console

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

| Panel | What it binds to |
|---|---|
| **Operate** | 10 Hz WebSocket telemetry, 3D arm view, joint/Cartesian jog, per-joint limit headroom |
| **Faults** | live fault state, searchable error-code table with the gateway's own caveat about firmware versions |
| **Programs** | upload with md5 verification, select, run/pause/resume/stop — with the gateway's confirmation flow for unbounded motion |
| **I/O** | digital and analog, read on demand |
| **Force** | wrist force/torque, sensor config, zeroing |
| **Capabilities** | the controller's available / absent / unknown feature matrix |
| **Audit** | who commanded what, when |

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
