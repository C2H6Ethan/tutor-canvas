# tutor-canvas

A live, browser-based **tutor canvas** for Claude Code tutoring sessions. Claude
writes markdown + LaTeX to a content file; a local page re-renders it about once
a second so you can actually *read* the math the terminal can't show.

- **LaTeX** via KaTeX (matrices, `\frac`, `\partial`, `\underbrace`, `aligned`, …)
- **Tables**, **syntax-highlighted code**, **Mermaid diagrams**, images
- **Vector / physics diagrams** from a compact JSON spec (` ```diagram `)
- **Interactive widgets** — clickable multiple-choice quizzes with a live score
  (` ```quiz `), try-then-reveal answers (` ```reveal `), and flip flashcards
  (` ```flashcard `)
- **Offline** — all assets vendored, no CDN
- **Zero install** — pure `python3` standard library
- **Live updates** with no page flash and preserved scroll position

It exists because the terminal cannot render LaTeX, which makes math tutoring in
Claude Code unreadable.

## Install

This is a **user-level** Claude Code skill. Install it by symlinking the repo
into your skills directory:

```bash
git clone https://github.com/C2H6Ethan/tutor-canvas.git
tutor-canvas/scripts/install.sh   # vendors assets + symlinks the skill
```

`install.sh`:
1. runs `scripts/vendor.sh` if `assets/` is empty (needs network once),
2. creates `~/.claude/skills/` if missing,
3. symlinks `~/.claude/skills/tutor-canvas -> <repo>` (refusing to clobber an
   existing unrelated skill).

After that the skill is available in every Claude Code session.

> Assets are committed to the repo, so if you cloned a populated repo you can
> skip vendoring entirely — `install.sh` will detect that.

## How Claude uses it

The `SKILL.md` description auto-invokes the skill for math/diagram-heavy
tutoring. In a session Claude will:

```bash
SKILL=~/.claude/skills/tutor-canvas
python3 "$SKILL/scripts/board.py" start    # idempotent; prints the URL
```

Then push content as it teaches:

```bash
# replace the whole board
python3 "$SKILL/scripts/board.py" push --file solution.md
# or append the next step (keeps prior steps + scroll position)
cat <<'MD' | python3 "$SKILL/scripts/board.py" append
## Step 2
$$m = \frac{10.0}{4.905} = 2.04\ \text{kg}$$
MD
```

You open the printed `http://127.0.0.1:8765/` URL once and watch it update.

### Interactive widgets

Beyond static content, Claude can drop a **clickable quiz** on the board with a
` ```quiz ` fence containing a JSON spec — useful for active recall during
tutoring. Click a choice for instant right/wrong feedback, the correct answer
revealed, an explanation, and a running score.

````markdown
```quiz
{
  "title": "lvalues vs rvalues in C++",
  "questions": [
    {
      "q": "Given `int x = 5;`, the expression `x` is a(n)…",
      "choices": ["lvalue", "rvalue", "neither"],
      "answer": 0,
      "explain": "`x` names an object with an address, so it is an lvalue."
    }
  ]
}
```
````

`q`, every choice, and `explain` render inline markdown + LaTeX, so `` `code` ``
and `$math$` work inside them. The widget keeps its score/answers even as Claude
appends more content. It renders natively on the board — no separate HTML page.

Two sibling widgets share the same JSON-fence pattern:

- **` ```reveal `** — a *try-then-reveal* prompt: think/attempt the answer, then
  click **Reveal** to self-check. No grading box; ideal for derivation steps.
- **` ```flashcard `** — a flip deck (click or Enter/Space to flip front↔back,
  Prev / Next to navigate) for active-recall drilling.

See `SKILL.md` for the full authoring contract of all three.

### Manual use

You can use it without Claude too:

```bash
B="python3 ~/.claude/skills/tutor-canvas/scripts/board.py"
$B open                      # start + open in browser (macOS)
$B path                      # where the content file lives
echo '# Hi $\sqrt{2}$' | $B push
$B status
$B stop
```

## Commands

| Command | Description |
|---|---|
| `start` | Start (or reuse) the board; print its URL. Idempotent. |
| `open` | `start` then open in the default browser (macOS). |
| `push` | Replace board content (`--file`, `--text`, or stdin). |
| `append` | Append to board content. |
| `clear` | Reset the board to empty. |
| `status` | Running? URL? content path? |
| `url` | Print the board URL. |
| `path` | Print the active content file path. |
| `stop` | Stop this project's board. |

Global flags: `--project <dir>` (board identity, defaults to cwd),
`--name <board>` (multiple boards per project).

## How it works

- **Assets** (the board UI + vendored KaTeX/markdown-it/highlight.js/mermaid)
  live in this skill dir and are read-only and shared.
- **Content** lives per-project in `<project>/.tutor-canvas/<name>.md` so
  concurrent projects/sessions get independent boards on independent ports.
- A tiny `http.server` serves the UI at `/` and routes `/board.md` to the active
  content file. The page polls `/board.md` ~1×/sec and patches only the changed
  blocks.

See [`DESIGN.md`](DESIGN.md) for the full architecture and the rationale behind
the rendering stack (the original prototype's marked-vs-MathJax bug and how
markdown-it + pre-extracted KaTeX fixes it at the root).

## Develop / contribute

```
tutor-canvas/
├── SKILL.md            # agent-facing instructions + auto-invoke description
├── README.md           # this file
├── DESIGN.md           # architecture decisions & tradeoffs
├── LICENSE             # MIT
├── web/                # board UI (served at /)
│   ├── index.html
│   ├── board.css
│   └── board.js        # markdown-it + KaTeX + hljs + mermaid + quiz/diagram
├── assets/             # vendored libraries (committed; offline)
│   └── MANIFEST.json   # pinned versions
└── scripts/
    ├── board.py        # CLI: start/stop/status/push/append/...
    ├── server.py       # static server (web root + /board.md route)
    ├── vendor.sh       # (re)download + pin assets
    ├── install.sh      # vendor + symlink into ~/.claude/skills
    └── selftest.py     # offline pipeline sanity check
```

To change a vendored version, edit `scripts/vendor.sh`, re-run it, and commit
the updated `assets/`.

## License

MIT — see [`LICENSE`](LICENSE).
