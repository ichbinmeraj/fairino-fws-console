# Security

`fairino-fws-console` is a browser UI served by the FWS gateway. It commands
a physical robot arm, so its security model is the gateway's, plus the
handful of things a browser front-end adds.

## Reporting a vulnerability

Open a private security advisory on the repository, or email the maintainer.
Please do not file a public issue for anything exploitable.

## The console is not a safety device

Nothing in this UI is safety-rated. Its **Stop** button is a *functional*
stop, not an emergency stop — it asks the gateway to halt motion over TCP,
which has no real-time guarantee. Keep a hand on the physical E-stop whenever
the arm is enabled. This is the single most important line in this document.

## Trust model

- **The console runs on the gateway's origin, on purpose.** FWS ships no CORS
  middleware and binds to loopback by default; a page served from any other
  origin cannot call its API. The console is therefore mounted at `/console`
  by the same process — same origin, no CORS exception, no second listener to
  secure. Reach it from another machine by tunnelling the gateway
  (`ssh -L 8000:localhost:8000 …`), not by exposing either.
- **Authentication is the gateway's.** When the gateway runs with
  `auth.api_keys_file` set, the console needs a key. It is entered in the
  sidebar, sent as `X-API-Key` on every request, and stored only in the
  browser's `localStorage` — never transmitted anywhere but the gateway,
  never written to a file. The console's own asset prefix (`/console`) is the
  only path opened without a key, because a page cannot ask for a credential
  it already requires; every `/api/v1` call still needs the key.
- **The control lease is not a permission system.** One client holds motion
  at a time; the console renews it and greys out every commanding control the
  instant the lease is in doubt, because the gateway's watchdog *stops the
  arm* when a lease lapses.

## What the console cannot make safe

Some gateway features are dangerous by nature; the console surfaces them with
confirmation but cannot remove the risk:

- **Programs command unbounded motion.** A Lua program runs on the controller
  and is not bounded by the gateway's jog limits or IK pre-flight. The
  console shows the gateway's own confirmation before running one.
- **The controller shell / qconn are root-equivalent** on this hardware and
  unauthenticated at the daemon. The gateway refuses to expose them without
  an API key file; treat any deployment that enables them as privileged.
- **Shutdown is one-way.** The vendor API has no remote power-on, so a
  confirmed shutdown from the System panel requires someone at the cell to
  restore power.

## Content-security posture

The console ships as plain ES modules with **no external dependencies, no
CDN, no build step** — every byte is in the wheel. There are no third-party
scripts to compromise. All HTML built from gateway responses is escaped
before insertion; error text from the gateway is rendered as text, not
markup.
