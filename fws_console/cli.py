"""`fws-console` -- the gateway, plus an operator UI mounted on it.

This package deliberately owns none of the gateway's behaviour. It calls
`fws.cli.main()` with a `configure_app` hook, so every flag, every
configuration path and every startup safety check is the gateway's own. All
this module adds is a static mount.

Serving the UI from the gateway's own origin is not a convenience. FWS ships
no CORS middleware, on purpose, so a page served from anywhere else could not
call the API at all. Same origin, same process, no exception to make.
"""
from __future__ import annotations

import pathlib
import sys

WEB = pathlib.Path(__file__).parent / "web"
MOUNT = "/console"


def configure_app(app, settings) -> None:
    """Mount the console onto an already-built gateway application.

    Mounted at /console rather than /, because the gateway answers GET / with
    a JSON service descriptor and a static mount there would shadow it.
    """
    from fastapi.staticfiles import StaticFiles

    if not WEB.is_dir():  # pragma: no cover - a broken install, not a state
        raise RuntimeError(f"console assets missing at {WEB}")

    app.mount(MOUNT, StaticFiles(directory=WEB, html=True), name="console")

    port = settings.server.port
    print(f"  console          http://localhost:{port}{MOUNT}/", flush=True)


def main(argv: list[str] | None = None) -> int:
    from fws.cli import main as gateway_main

    return gateway_main(argv, configure_app=configure_app)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
