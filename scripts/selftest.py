#!/usr/bin/env python3
"""Offline self-test for study-board.

Verifies the parts that don't need a browser:
  * the server starts, serves the UI at /, and routes /board.md to the active
    content file (200 + correct bytes);
  * push/append/clear/path/status/stop behave correctly;
  * the served index.html references the vendored assets;
  * the vendored assets exist (if vendored) and the math delimiters in the
    torture test survive untouched in the served bytes (the markdown/math
    tokenization itself runs in the browser via markdown-it+texmath, but we
    confirm the raw LaTeX is delivered verbatim so the browser can render it).

Run:  python3 scripts/selftest.py
Exit code 0 = pass.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
SKILL = HERE.parent
BOARD = HERE / "board.py"
TORTURE = HERE / "torture-test.md"

PASS, FAIL = 0, 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    mark = "PASS" if ok else "FAIL"
    if ok:
        PASS += 1
    else:
        FAIL += 1
    print(f"  [{mark}] {name}{(' — ' + detail) if detail and not ok else ''}")


def run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(BOARD), *args],
        capture_output=True,
        text=True,
    )


def get(url: str) -> tuple[int, bytes]:
    try:
        with urllib.request.urlopen(url, timeout=2) as r:
            return r.status, r.read()
    except Exception as e:  # noqa: BLE001
        return 0, str(e).encode()


def main() -> int:
    proj = Path(tempfile.mkdtemp(prefix="sb-selftest-"))
    print(f"project: {proj}")

    try:
        # path
        cp = run("--project", str(proj), "path")
        content_path = Path(cp.stdout.strip())
        check("path resolves under project/.study-board", ".study-board" in str(content_path))

        # start
        cp = run("--project", str(proj), "start", "--quiet")
        url = cp.stdout.strip()
        check("start prints a URL", url.startswith("http://127.0.0.1:"), cp.stderr)
        time.sleep(0.3)

        # idempotent start
        cp2 = run("--project", str(proj), "start", "--quiet")
        check("start is idempotent (same URL)", cp2.stdout.strip() == url, cp2.stdout)

        # status
        cp = run("--project", str(proj), "status")
        check("status reports running", "running" in cp.stdout, cp.stdout)

        # index served
        st, body = get(url)
        check("GET / -> 200", st == 200, f"status {st}")
        check("index references vendored katex", b"/assets/katex.min.css" in body)
        check("index references markdown-it", b"/assets/markdown-it.min.js" in body)
        check("index references board.js", b"/board.js" in body)

        # board.js + css served
        st_js, js = get(url + "board.js")
        check("GET /board.js -> 200", st_js == 200)
        check("board.js uses markdown-it + texmath", b"markdownit" in js and b"texmath" in js)
        st_css, _ = get(url + "board.css")
        check("GET /board.css -> 200", st_css == 200)

        # push the torture test
        run("--project", str(proj), "push", "--file", str(TORTURE))
        st_md, md = get(url + "board.md")
        check("GET /board.md -> 200", st_md == 200, f"status {st_md}")
        text = md.decode()
        # The hard LaTeX must be delivered verbatim (underscores intact).
        check(
            "underbrace+subscript delivered verbatim",
            r"\underbrace{\left|\frac{\partial m}{\partial F_H}\right|\Delta F_H}_{\text{term 1}}"
            in text,
        )
        check("matrix delivered", r"\begin{pmatrix}" in text)
        check("aligned env delivered", r"\begin{aligned}" in text)
        check("table delivered", "| term | derivative" in text)
        check("code fence delivered", "```python" in text)
        check("mermaid fence delivered", "```mermaid" in text)

        # append
        run("--project", str(proj), "append", "--text", "## Appended\n$$x=1$$")
        _, md2 = get(url + "board.md")
        check("append keeps prior content", r"\underbrace" in md2.decode())
        check("append adds new content", "## Appended" in md2.decode())

        # vendored assets (only if vendored)
        katex = SKILL / "assets" / "katex.min.js"
        if katex.exists():
            st_k, _ = get(url + "assets/katex.min.js")
            check("GET /assets/katex.min.js -> 200", st_k == 200)
        else:
            print("  [SKIP] assets not vendored yet (run scripts/vendor.sh)")

        # clear
        run("--project", str(proj), "clear")
        _, md3 = get(url + "board.md")
        check("clear resets content", r"\underbrace" not in md3.decode())

    finally:
        run("--project", str(proj), "stop")

    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
