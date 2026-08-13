"""The console is a mount, and only a mount.

These tests pin the whole contract this package has with the gateway: given
an application and settings, configure_app adds a static mount at /console
and changes nothing else.
"""
from __future__ import annotations

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fws_console import MOUNT, WEB, configure_app


def make_app() -> TestClient:
    app = FastAPI()

    @app.get("/")
    def index():
        return {"service": "fws"}

    settings = SimpleNamespace(server=SimpleNamespace(port=8000))
    configure_app(app, settings)
    return TestClient(app)


class TestMount:
    def test_serves_the_console_at_slash_console(self):
        r = make_app().get(f"{MOUNT}/")
        assert r.status_code == 200
        assert "FWS Console" in r.text

    def test_serves_every_asset_the_page_references(self):
        """Every src/href in index.html resolves. A page that references a
        missing module dies at import time with a blank screen."""
        client = make_app()
        html = (WEB / "index.html").read_text()
        import re
        refs = re.findall(r'(?:src|href)="([^"]+)"', html)
        assert refs, "index.html references no assets at all?"
        for ref in refs:
            assert client.get(f"{MOUNT}/{ref}").status_code == 200, ref

    def test_es_module_imports_resolve(self):
        """Same, one level down: every import in every JS module exists."""
        import re
        js_dir = WEB / "js"
        for mod in js_dir.glob("*.js"):
            for target in re.findall(r"from\s+'\./([\w.]+)'", mod.read_text()):
                missing = f"{mod.name} imports missing {target}"
                assert (js_dir / target).is_file(), missing

    def test_does_not_shadow_the_root(self):
        r = make_app().get("/")
        assert r.json() == {"service": "fws"}

    def test_mounts_nothing_outside_console(self):
        client = make_app()
        assert client.get("/index.html").status_code == 404
        assert client.get("/js/main.js").status_code == 404


class TestAssets:
    def test_no_external_urls_anywhere(self):
        """No CDN, no fonts, no analytics. A robot cell may be air-gapped,
        and every byte the console needs must ship in the wheel."""
        import re
        offenders = []
        for f in WEB.rglob("*"):
            if f.suffix not in (".html", ".css", ".js"):
                continue
            for hit in re.findall(r'https?://[^\s"\')<>]+', f.read_text()):
                offenders.append(f"{f.name}: {hit}")
        assert not offenders, offenders


class TestCaching:
    def test_console_assets_demand_revalidation(self):
        """no-cache on everything under the mount: a stale ES module against
        fresh HTML is a broken console, and browsers cache heuristically
        without it. Unchanged files still answer 304, so this stays cheap."""
        client = make_app()
        for path in (f"{MOUNT}/", f"{MOUNT}/js/main.js", f"{MOUNT}/css/app.css"):
            r = client.get(path)
            assert r.headers.get("cache-control") == "no-cache", path

    def test_the_api_is_not_touched(self):
        r = make_app().get("/")
        assert "cache-control" not in r.headers or \
            r.headers["cache-control"] != "no-cache"


class TestDeveloperPanels:
    """The console claims to expose the whole gateway surface. These pin the
    two halves of that claim: the generic explorer, and the hand-built
    panels for the surfaces where raw JSON is not the useful view."""

    def test_devpanels_ship_and_are_imported(self):
        js = WEB / "js"
        assert (js / "devpanels.js").is_file()
        main = (js / "main.js").read_text()
        assert "devpanels.js" in main, "main.js does not import the dev panels"
        for tab in ("config", "commands", "lua", "api", "files", "system"):
            assert f"'{tab}'" in main, f"tab {tab} is not registered"

    def test_the_api_explorer_is_generated_from_the_spec(self):
        """Not a hand-listed set of endpoints: it reads /openapi.json, so a
        route added to the gateway later shows up without a console change."""
        src = (WEB / "js" / "devpanels.js").read_text()
        assert "/openapi.json" in src
        assert "spec.paths" in src

    def test_every_gateway_domain_has_a_panel_reference(self):
        """Every top-level /api/v1 domain the gateway serves is named
        somewhere in the console, so no whole area is invisible."""
        src = "".join((WEB / "js" / f).read_text() for f in
                      ("panels.js", "devpanels.js", "main.js", "api.js"))
        domains = [
            "backup", "capabilities", "commands", "control", "controller",
            "errors", "events", "execution", "files", "force", "frames",
            "gripper", "invoke", "io", "lua", "motion", "points", "programs",
            "robot", "sensors", "state", "system",
        ]
        missing = [d for d in domains if f"/api/v1/{d}" not in src]
        assert not missing, f"no panel touches these domains: {missing}"
