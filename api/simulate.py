"""Vercel serverless endpoint for one simulator run."""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
for path in (ROOT / "scripts", ROOT / "src"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from serve_web_simulator import simulate_from_payload  # noqa: E402


class handler(BaseHTTPRequestHandler):  # noqa: N801
    def do_POST(self):  # noqa: N802
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            response = {"ok": True, **simulate_from_payload(payload)}
        except ValueError as exc:
            self._send_json({"ok": False, "error": str(exc)}, status=400)
            return
        except Exception as exc:  # pragma: no cover - serverless boundary
            self._send_json({"ok": False, "error": f"Simulation failed: {exc}"}, status=500)
            return
        self._send_json(response)

    def do_OPTIONS(self):  # noqa: N802
        self._send_json({})

    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
