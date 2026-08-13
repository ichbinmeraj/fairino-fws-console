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
        for tab in ("develop", "config", "commands", "lua", "api", "files",
                    "system"):
            assert f"'{tab}'" in main, f"tab {tab} is not registered"

    def test_the_workbench_ships_and_its_editor_escapes(self):
        """The Develop workbench is the edit→compile→run→watch loop in one
        view. Its highlighter feeds innerHTML from program source that came
        off the controller, so every token path must escape."""
        js = WEB / "js"
        wb = (js / "workbench.js").read_text()
        assert "workbench.js" in (js / "main.js").read_text()
        assert (WEB / "index.html").read_text().count('data-tab="develop"')
        # every branch of the tokenizer wraps its slice in esc()
        import re
        for m in re.finditer(r"out \+= [^;]+;", wb):
            assert "esc(" in m.group(0), f"unescaped highlighter output: {m.group(0)}"
        # saving goes through the real upload path, run keeps the confirm flow
        assert "/api/v1/programs/" in wb
        assert "confirmGateway" in wb

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


class TestInterfaceQuality:
    """UX properties that are cheap to regress and expensive to notice."""

    def test_no_native_blocking_dialogs(self):
        """window.confirm/prompt/alert block the event loop, cannot be
        styled or given a destructive treatment, and browsers offer to
        suppress them after repeated use — which would silently disable a
        robot confirmation. ui.js provides styled <dialog> replacements."""
        import re
        offenders = []
        for f in (WEB / "js").glob("*.js"):
            if f.name == "ui.js":
                continue          # defines the replacements, names them in docs
            pattern = r"(?<![\w.])(confirm|prompt|alert)\s*\("
            for m in re.finditer(pattern, f.read_text()):
                offenders.append(f"{f.name}: {m.group(1)}()")
        assert not offenders, offenders

    def test_the_type_scale_is_tokenised(self):
        """Twelve ad-hoc sizes, several half a pixel apart, blurred the
        vertical rhythm wherever two components met."""
        import re
        css = (WEB / "css" / "app.css").read_text()
        literals = set(re.findall(r"font-size:\s*([0-9.]+)px", css))
        assert not literals, f"un-tokenised font sizes: {sorted(literals)}"
        for step in ("--fs-2xs", "--fs-xs", "--fs-sm", "--fs-md", "--fs-lg"):
            assert step in css, f"missing type step {step}"

    def test_escape_cannot_reach_stop_from_a_modal(self):
        """Escape inside a confirmation means 'no' — it must cancel the
        dialog, never fall through to the STOP shortcut."""
        main = (WEB / "js" / "main.js").read_text()
        assert "dialog[open]" in main, \
            "the Escape handler does not yield to an open modal"

    def test_the_palette_is_registered_from_several_sources(self):
        main = (WEB / "js" / "main.js").read_text()
        assert main.count("registerPalette") >= 4, \
            "palette should offer panels, actions, endpoints and commands"

    # NOTE: there is deliberately no static test for "`${...}` used inside a
    # quoted string" — the bug that shipped "${skeleton(3)}" as visible text
    # in the System panel. Detecting it in source requires distinguishing JS
    # string delimiters from regex literals AND from HTML attribute quotes
    # inside template literals; three attempts produced only false alarms.
    # The reliable check is rendering: a browser pass over all 13 panels
    # asserting no panel's textContent contains "${". That is run against the
    # live gateway, not here, because it needs a real DOM.

    def test_text_tokens_meet_wcag_aa_on_both_grounds(self):
        """Contrast is measured, not eyeballed: dark --faint once sat at
        2.95:1, under even the 3.0 UI floor, while carrying real words."""
        import re

        def lum(hex_):
            v = [int(hex_[i:i + 2], 16) / 255 for i in (1, 3, 5)]
            f = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
                 for c in v]
            return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]

        def ratio(a, b):
            hi, lo = sorted((lum(a), lum(b)), reverse=True)
            return (hi + 0.05) / (lo + 0.05)

        css = (WEB / "css" / "app.css").read_text()
        blocks = {
            "dark": css.split(":root {")[1].split("}")[0],
            "light": css.split(':root[data-theme="light"] {')[1].split("}")[0],
        }
        bad = []
        for theme, block in blocks.items():
            tok = dict(re.findall(r"--([\w-]+):\s*(#[0-9a-fA-F]{6});", block))
            for name in ("text", "dim", "faint", "accent", "ok", "warn", "danger"):
                worst = min(ratio(tok[name], tok["surface"]),
                            ratio(tok[name], tok["bg"]))
                if worst < 4.5:
                    bad.append(f"{theme}/--{name} {worst:.2f}:1")
        assert not bad, f"below WCAG AA 4.5:1 — {bad}"

    def test_stage_controls_are_clickable_by_role_and_contained(self):
        """The stage overlay covers the whole canvas with pointer-events:none
        and re-enables its controls. Two bugs shipped here: the view-preset
        segment was omitted from a class allowlist (unclickable), and the
        tool row overflowed the stage sideways and landed under the Master
        panel. Guard both: re-enable by ROLE, and let the top bar WRAP so it
        can never spill past the stage edge."""
        css = (WEB / "css" / "app.css").read_text()
        # role-based re-enable, not a brittle class list
        assert ":is(button, a, input" in css, \
            "stage controls should be re-enabled by role, not by class name"
        # the segment is not singled out, which is what regressed
        assert ".stage-overlay .seg button { pointer-events: auto; }" not in css
        # the top bar wraps so wide toolbars stay inside the stage
        assert "flex-wrap: wrap" in css.split(".stage-top")[1].split("}")[0]

    def test_dialog_module_guards_reuse_and_escape(self):
        """The shared <dialog> is reused for every confirmation. Two bugs
        that could shut the controller down came from that: a stale
        returnValue making Escape read as 'ok', and re-opening an open dialog
        (InvalidStateError → unhandled rejection). Both are guarded in ui.js."""
        ui = (WEB / "js" / "ui.js").read_text()
        assert "d.returnValue = ''" in ui, "returnValue is not reset per dialog"
        assert "if (d.open) d.close('cancel')" in ui, "no re-entrancy guard"
        # OK before Cancel in DOM so implicit submit (Enter) confirms
        ok = ui.index('id="dlg-ok"')
        cancel = ui.index('id="dlg-cancel"')
        assert ok < cancel, "OK must precede Cancel so Enter confirms, not cancels"

    def test_palette_escapes_server_strings(self):
        """The palette lists command names and OpenAPI paths — server data —
        in innerHTML. Every other renderer escapes; this one must too."""
        ui = (WEB / "js" / "ui.js").read_text()
        assert "export const esc" in ui, "ui.js has no escape helper"
        assert "esc(r.it.label)" in ui and "esc(r.it.group)" in ui
