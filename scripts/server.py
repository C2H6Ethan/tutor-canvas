#!/usr/bin/env python3
"""study-board static server.

A tiny, dependency-free HTTP server that backs the live study board.

Design goals:
  * Serve the bundled board UI (``web/`` inside the skill dir) at ``/``.
  * Serve the *active content file* (which lives wherever the session put it,
    typically inside the project) at ``/board.md`` — decoupling the web root
    from the content location so projects never collide and the skill dir
    stays read-only.
  * Be idempotent and lifecycle-aware: a small state file records the pid,
    port and content path so ``study-board status``/``stop`` work across
    terminals and after the launching shell has exited.

This module is normally invoked by ``board.py`` (the CLI), but can be run
directly:

    python3 server.py --web-root /path/to/web --content /path/to/board.md \
        --port 8765
"""

from __future__ import annotations

import argparse
import mimetypes
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class BoardHandler(SimpleHTTPRequestHandler):
    """Serve the web root, but route ``/board.md`` to the active content file.

    ``content_path`` is injected via ``functools.partial`` so each server
    instance can point at a different content file.
    """

    content_path: Path  # set on the partial
    assets_path: Path  # skill assets dir (sibling of web root), set on the partial

    # Silence the default noisy per-request logging.
    def log_message(self, *args, **kwargs):  # noqa: D401, ANN001
        pass

    def _send_text(self, status: int, body: bytes, ctype: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # No caching: the board polls this file ~1x/sec and must see fresh bytes.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path in ("/board.md", "/board"):
            try:
                data = self.content_path.read_bytes()
            except FileNotFoundError:
                data = (
                    b"# Waiting for content\n\n"
                    b"No content has been pushed to this board yet.\n"
                )
            self._send_text(200, data, "text/markdown; charset=utf-8")
            return
        if path == "/__alive":
            self._send_text(200, b"ok", "text/plain")
            return
        # Vendored assets live in the skill's assets/ dir (sibling of web root).
        if path.startswith("/assets/"):
            rel = path[len("/assets/"):]
            target = (self.assets_path / rel).resolve()
            # Path-traversal guard: must stay inside assets_path.
            if self.assets_path.resolve() in target.parents and target.is_file():
                ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
                self._send_text(200, target.read_bytes(), ctype)
            else:
                self._send_text(404, b"not found", "text/plain")
            return
        # Everything else is a normal static file from the web root.
        super().do_GET()


def serve(web_root: Path, content_path: Path, port: int, host: str = "127.0.0.1") -> None:
    web_root = web_root.resolve()
    content_path = content_path.resolve()
    os.chdir(web_root)
    assets_path = (web_root.parent / "assets").resolve()
    handler = partial(BoardHandler, directory=str(web_root))
    # Attach content_path onto the partial's resulting instances via a subclass
    # trick: bind it as a class attribute on a per-call subclass.
    handler_cls = type(
        "BoundBoardHandler",
        (BoardHandler,),
        {"content_path": content_path, "assets_path": assets_path},
    )
    bound = partial(handler_cls, directory=str(web_root))
    httpd = ThreadingHTTPServer((host, port), bound)
    httpd.serve_forever()


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="study-board static server")
    p.add_argument("--web-root", required=True, type=Path)
    p.add_argument("--content", required=True, type=Path)
    p.add_argument("--port", required=True, type=int)
    p.add_argument("--host", default="127.0.0.1")
    args = p.parse_args(argv)
    try:
        serve(args.web_root, args.content, args.port, args.host)
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
