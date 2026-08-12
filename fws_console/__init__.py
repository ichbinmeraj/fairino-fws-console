"""Operator console for FWS.

An optional companion to `fairino-fws`. Installing it adds a UI; uninstalling
it leaves an API-only gateway behind, unchanged.
"""
from __future__ import annotations

__all__ = ["MOUNT", "WEB", "configure_app"]

from .cli import MOUNT, WEB, configure_app
