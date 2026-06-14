#!/usr/bin/env python3
"""tutor-canvas CLI — lifecycle + content management for the live tutor canvas.

Subcommands
-----------
    start    Start (or reuse) the board server and print its URL.
    stop     Stop the running board server.
    status   Print whether a board is running, its URL and content path.
    push     Replace the board content with stdin / a file / a string.
    append   Append to the board content.
    clear    Reset the board to an empty state.
    list     List the boards that already exist for this project.
    path     Print the absolute path of the active content file.
    url      Print the board URL.
    open     Start if needed, then open the board in the default browser.

Architecture (see DESIGN.md)
----------------------------
*Assets* (the board UI + vendored JS/CSS) live in the **skill directory** and
are read-only and shared. *Content* lives **per project**: by default a board
is keyed to the current working directory, so two projects/sessions get two
independent boards on two ports and never clobber each other's content.

State for every running board is recorded under ``~/.cache/tutor-canvas`` so
``status``/``stop`` work from any terminal, even after the launching shell has
closed.
"""

from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

# --- paths ----------------------------------------------------------------

SKILL_DIR = Path(__file__).resolve().parent.parent
WEB_ROOT = SKILL_DIR / "web"

STATE_DIR = Path(os.environ.get("TUTOR_CANVAS_STATE", Path.home() / ".cache" / "tutor-canvas"))
DEFAULT_PORT = 8765
PORT_RANGE = 50  # scan DEFAULT_PORT .. DEFAULT_PORT+PORT_RANGE for a free port


# --- board identity / content location ------------------------------------

def _board_key(project: Path) -> str:
    """A short stable id for a project directory (keeps boards independent)."""
    h = hashlib.sha1(str(project.resolve()).encode()).hexdigest()[:10]
    return f"{project.name}-{h}"


def content_path_for(project: Path, name: str = "board") -> Path:
    """Where the markdown content for a board lives.

    Default: ``<project>/.tutor-canvas/<name>.md``. Kept inside the project so
    it travels with the work and is easy for the agent to find, but in a
    dedicated dotdir so it doesn't pollute the project root. Add
    ``.tutor-canvas/`` to the project's .gitignore (the skill does this on
    first start).
    """
    return project.resolve() / ".tutor-canvas" / f"{name}.md"


def _state_file(key: str) -> Path:
    return STATE_DIR / f"{key}.json"


# --- low-level helpers ----------------------------------------------------

def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError as e:
        return e.errno == errno.EPERM
    return True


def _port_free(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


def _find_port(preferred: int) -> int:
    if _port_free(preferred):
        return preferred
    for p in range(preferred, preferred + PORT_RANGE + 1):
        if _port_free(p):
            return p
    raise RuntimeError(f"no free port in {preferred}..{preferred + PORT_RANGE}")


def _read_state(key: str) -> dict | None:
    f = _state_file(key)
    if not f.exists():
        return None
    try:
        return json.loads(f.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def _write_state(key: str, state: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    _state_file(key).write_text(json.dumps(state, indent=2))


def _running(state: dict | None) -> bool:
    return bool(state and _pid_alive(state.get("pid", -1)))


def _ensure_gitignore(project: Path) -> None:
    """Best-effort: keep the content dotdir out of the user's git history."""
    gi = project / ".gitignore"
    line = ".tutor-canvas/"
    try:
        existing = gi.read_text() if gi.exists() else ""
        if line not in existing.split():
            with gi.open("a") as fh:
                if existing and not existing.endswith("\n"):
                    fh.write("\n")
                fh.write(line + "\n")
    except OSError:
        pass  # not a git project / not writable — non-fatal


# --- commands -------------------------------------------------------------

def cmd_start(args) -> int:
    project = Path(args.project).resolve()
    key = _board_key(project)
    content = content_path_for(project, args.name)
    content.parent.mkdir(parents=True, exist_ok=True)
    if not content.exists():
        content.write_text(_WELCOME)
    _ensure_gitignore(project)

    state = _read_state(key)
    if _running(state):
        url = state["url"]
        print(url)
        if not args.quiet:
            print(f"(already running, pid {state['pid']})", file=sys.stderr)
        return 0

    port = _find_port(args.port)
    log = STATE_DIR / f"{key}.log"
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    server = SKILL_DIR / "scripts" / "server.py"
    with log.open("ab") as lf:
        proc = subprocess.Popen(
            [
                sys.executable,
                str(server),
                "--web-root",
                str(WEB_ROOT),
                "--content",
                str(content),
                "--port",
                str(port),
            ],
            stdout=lf,
            stderr=lf,
            start_new_session=True,  # survive the launching shell
        )

    url = f"http://127.0.0.1:{port}/"
    # Wait briefly for liveness.
    for _ in range(30):
        if _http_alive(port):
            break
        if proc.poll() is not None:
            print(f"server exited early; see {log}", file=sys.stderr)
            return 1
        time.sleep(0.1)

    _write_state(
        key,
        {
            "pid": proc.pid,
            "port": port,
            "url": url,
            "project": str(project),
            "content": str(content),
            "name": args.name,
            "started": time.time(),
        },
    )
    print(url)
    if not args.quiet:
        print(f"board content file: {content}", file=sys.stderr)
    return 0


def _http_alive(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.3):
            return True
    except OSError:
        return False


def cmd_stop(args) -> int:
    key = _board_key(Path(args.project))
    state = _read_state(key)
    if not _running(state):
        print("not running", file=sys.stderr)
        if state:
            _state_file(key).unlink(missing_ok=True)
        return 0
    pid = state["pid"]
    try:
        os.killpg(os.getpgid(pid), signal.SIGTERM)
    except OSError:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    _state_file(key).unlink(missing_ok=True)
    print("stopped", file=sys.stderr)
    return 0


def cmd_status(args) -> int:
    key = _board_key(Path(args.project))
    state = _read_state(key)
    if _running(state):
        print(f"running  pid={state['pid']}  {state['url']}  content={state['content']}")
        return 0
    print("stopped")
    return 1


def cmd_path(args) -> int:
    print(content_path_for(Path(args.project), args.name))
    return 0


def cmd_url(args) -> int:
    state = _read_state(_board_key(Path(args.project)))
    if _running(state):
        print(state["url"])
        return 0
    print("not running", file=sys.stderr)
    return 1


def _resolve_content(args) -> Path:
    content = content_path_for(Path(args.project), args.name)
    content.parent.mkdir(parents=True, exist_ok=True)
    return content


def _write_hint(args) -> None:
    """Tell the caller where the content went — and warn if nothing serves it.

    Closes the "silent write into the void" gap: a push/append to a board whose
    project has no running server used to succeed with no feedback at all.
    """
    state = _read_state(_board_key(Path(args.project)))
    if _running(state):
        print(f"board '{args.name}' updated — {state['url']}", file=sys.stderr)
    else:
        print(
            f"warning: no board server running for this project; "
            f"run 'start' to view board '{args.name}'",
            file=sys.stderr,
        )


def cmd_list(args) -> int:
    """List the boards (``.tutor-canvas/*.md``) that exist for this project.

    Run this before creating a new named board so you continue an existing one
    instead of spawning a duplicate.
    """
    d = Path(args.project).resolve() / ".tutor-canvas"
    if d.exists():
        for f in sorted(d.glob("*.md")):
            print(f.stem)
    return 0


def _input_text(args) -> str:
    if args.file:
        return Path(args.file).read_text()
    if args.text is not None:
        return args.text
    return sys.stdin.read()


def cmd_push(args) -> int:
    content = _resolve_content(args)
    content.write_text(_input_text(args))
    _write_hint(args)
    return 0


def cmd_append(args) -> int:
    content = _resolve_content(args)
    text = _input_text(args)
    with content.open("a") as fh:
        if content.stat().st_size > 0 and not text.startswith("\n"):
            fh.write("\n")
        fh.write(text)
        if not text.endswith("\n"):
            fh.write("\n")
    _write_hint(args)
    return 0


def cmd_clear(args) -> int:
    content = _resolve_content(args)
    content.write_text(_WELCOME)
    return 0


def cmd_open(args) -> int:
    rc = cmd_start(args)
    if rc != 0:
        return rc
    state = _read_state(_board_key(Path(args.project)))
    if state:
        try:
            subprocess.run(["open", state["url"]], check=False)
        except FileNotFoundError:
            pass
    return 0


_WELCOME = """# Live Tutor Canvas

Waiting for content. The board updates automatically about once per second.
"""


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="board", description=__doc__)
    p.add_argument("--project", default=os.getcwd(), help="project dir (board identity)")
    sub = p.add_subparsers(dest="cmd", required=True)

    # `--name` selects which board within the project. It belongs on the
    # subparsers (via a shared parent) so the natural `push --name vwl` form —
    # the one the docs use — parses; argparse only accepts a top-level option
    # *before* the subcommand, which is an easy footgun.
    name_parent = argparse.ArgumentParser(add_help=False)
    name_parent.add_argument(
        "--name", default="board", help="board name (for multiple boards)"
    )

    s = sub.add_parser("start", parents=[name_parent])
    s.add_argument("--port", type=int, default=DEFAULT_PORT)
    s.add_argument("--quiet", action="store_true")
    s.set_defaults(func=cmd_start)

    o = sub.add_parser("open", parents=[name_parent])
    o.add_argument("--port", type=int, default=DEFAULT_PORT)
    o.add_argument("--quiet", action="store_true")
    o.set_defaults(func=cmd_open)

    sub.add_parser("stop").set_defaults(func=cmd_stop)
    sub.add_parser("status").set_defaults(func=cmd_status)
    sub.add_parser("list").set_defaults(func=cmd_list)
    sub.add_parser("path", parents=[name_parent]).set_defaults(func=cmd_path)
    sub.add_parser("url").set_defaults(func=cmd_url)
    sub.add_parser("clear", parents=[name_parent]).set_defaults(func=cmd_clear)

    for name, fn in (("push", cmd_push), ("append", cmd_append)):
        c = sub.add_parser(name, parents=[name_parent])
        c.add_argument("--file", help="read content from this file")
        c.add_argument("--text", help="literal content string")
        c.set_defaults(func=fn)

    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
