---
name: tutor-canvas
description: >-
  Render rich tutoring/explanation content in a live-updating browser board so
  the user can actually read LaTeX math, matrices, tables, syntax-highlighted
  code, and Mermaid diagrams that the terminal cannot display. Use this skill
  proactively whenever a session involves heavy math (fractions, integrals,
  partial derivatives, vectors/matrices, aligned equations, \underbrace, Greek
  letters), step-by-step derivations, exam/homework tutoring, or any answer that
  would be clearer with rendered formulas, tables, diagrams, or highlighted
  code, or physics force/free-body/vector diagrams (arrows + angles). Triggers
  include exam prep, physics, math, engineering, algorithms, worked solutions,
  "explain/derive/show the steps", or any request where the user is reading along
  in a browser. Start the board, then push markdown+LaTeX (and ```diagram specs)
  to its content file as you teach.
---

# tutor-canvas

A live browser "board" for math-heavy tutoring. You write markdown + LaTeX to a
content file; a local server serves a page that re-renders it about once per
second. LaTeX is rendered with KaTeX, code with highlight.js, diagrams with
Mermaid. Everything is vendored locally and works offline.

## When to use this

Use it **proactively** whenever content won't read well in the terminal — LaTeX
math, matrices, multi-step derivations, tables, diagrams, highlighted code
(especially exam prep and tutoring). Don't wait to be asked: if you're about to
emit `$$...$$`, open the board and put the math there.

## Quick start (do this once per session)

The CLI is `scripts/board.py` inside this skill directory. All commands accept
`--project <dir>` (defaults to the current working directory) which determines
*which* board you're talking to — each project gets its own independent board
and port, so concurrent sessions never collide.

```bash
# Start (idempotent — reuses a running board) and print the URL:
python3 "$SKILL/scripts/board.py" start
```

Tell the user to open the printed URL (e.g. http://127.0.0.1:8765/). On macOS
you can open it for them with `board.py open` instead of `start`.

`$SKILL` here means this skill's directory. If you don't know it, it's the
folder containing this SKILL.md (typically `~/.claude/skills/tutor-canvas`).

## Pushing content (the main loop)

The content lives in a markdown file. Discover its path, then write to it.

```bash
# Where is the content file?
python3 "$SKILL/scripts/board.py" path
# -> /your/project/.tutor-canvas/board.md

# Replace the whole board:
python3 "$SKILL/scripts/board.py" push --file solution.md
python3 "$SKILL/scripts/board.py" push --text '# Step 1\n$$E=mc^2$$'
cat <<'MD' | python3 "$SKILL/scripts/board.py" push
# Step 1
$$m = \frac{F_H}{g\,\sin\alpha}$$
MD

# Append the next step (keeps prior steps; good for live derivations):
cat <<'MD' | python3 "$SKILL/scripts/board.py" append
## Step 2
$$m = \frac{10.0}{4.905} = 2.04\ \text{kg}$$
MD
```

**Default to `append`; treat `push`/`clear` as a reset the user asked for.**
The board is something the user reads and scrolls back through, so do **not**
overwrite it just to add the next step — a `push` wipes everything above and can
destroy earlier work the user wanted to keep. Use `push` only once at the very
start of a fresh problem (or when the user explicitly wants to start over), then
`append` for everything after. `clear` empties the board — only on request.

You can also just write the file directly — `board.py path` tells you where it
is. Either way the browser picks up changes within ~1 second.

### Multiple boards

Pass `--name <board>` to keep several boards for one project (e.g.
`--name physics`, `--name parprog`). Each name is an independent content file.
The single project server serves **all** of them, and the page shows a **tab
bar** to switch between boards. When you push to a board, the page auto-switches
to it (live-teaching flow); the user can click another tab to pin their view to
an older board while you keep pushing — that board then shows an "updated" dot
instead of stealing focus.

**Before creating a new named board, run `list` and continue an existing one if
it fits** — otherwise a new session will keep spawning fresh boards (or
overwrite `board.md`) instead of resuming the one the user was reading:

```bash
python3 "$SKILL/scripts/board.py" list   # -> board, atomics, vwl
# resume the existing 'vwl' board rather than making a new file:
cat <<'MD' | python3 "$SKILL/scripts/board.py" append --name vwl
## Next point
...
MD
```

`push`/`append` print where the content went and warn if no server is running
for the project, so a write never disappears silently.

## What you can render

Push markdown with:
- **LaTeX** inline `$...$` / `\(...\)` and display `$$...$$` / `\[...\]` — full
  KaTeX (`\frac`, `\sqrt`, `\partial`, `\underbrace`, `pmatrix`/`bmatrix`,
  vectors, `aligned`, Greek, `\boxed`, …). Math is tokenized before markdown
  emphasis, so `_`/`*` inside formulas are safe — write
  `\underbrace{...}_{\text{term 1}}` directly.
- **Markdown** headings/**bold**/lists/blockquotes/`---`, **tables** (GitHub
  pipe), **code** fences (syntax-highlighted by language tag), **```mermaid**
  diagrams (flowchart/sequence/state), and **images** (project files or URLs).

## Diagrams & interactive widgets

These render **natively on the board** — never fall back to a separate HTML page.
Each takes a JSON spec in a fenced block; bad JSON shows an inline error, so
iterate freely. The two common cases are inline below; **for the full field list,
curve options, and the `reveal` / `flashcard` widgets, read
`$SKILL/REFERENCE.md`.**

**` ```diagram `** — force/free-body/vector figures and smooth curves
(supply/demand, `f(x)`). Coordinates are `[x,y]` in **pixels from the
BOTTOM-LEFT, y UP** (renderer flips y); angles are **degrees CCW from +x**
(east=0, north=90, west=180, south=270; gravity `deg:270`):

````
```diagram
{
  "ground": 60,
  "vectors": [
    {"deg": 80,  "mag": 90, "label": "F_A", "color": "blue", "from": [250,200]},
    {"deg": 270, "mag": 95, "label": "mg",  "color": "gray", "from": [250,200]}
  ],
  "curves": [                                // Catmull-Rom spline through the points
    {"points": [[60,90],[210,150],[360,250]], "color": "blue", "label": "AD"},
    {"points": [[60,250],[210,150],[360,90]], "color": "red",  "label": "AS",
     "shift": [-40, 0]}                       // shift translates the WHOLE curve (a shock)
  ]
}
```
````
Also available (see `REFERENCE.md`): `segments`, `arcs`, `points`, `labels`,
`w`/`h`, `origin`, curve `arrow`/`type`/`labelAt`, and a raw ` ```svg ` fence.

**` ```quiz `** — clickable multiple-choice with instant feedback + live score.
`q`, choices, and `explain` render markdown+LaTeX. `answer` is the **0-based
index into `choices` as written**; **`shuffleChoices` is ON by default** (the
board randomizes choice positions and remaps `answer`), so you needn't scatter
the correct option:

````
```quiz
{
  "questions": [
    {"q": "Given `int x = 5;`, `x` is a(n)…",
     "choices": ["lvalue", "rvalue", "neither"], "answer": 0,
     "explain": "`x` names an object with an address → lvalue."}
  ]
}
```
````

**` ```reveal `** (try-then-reveal, no grading) and **` ```flashcard `** (flip
deck) — for attempt-first prompts and active-recall drilling; specs in
`REFERENCE.md`. All widgets keep their live state (answers/score/card) across
`append`.

## Lifecycle commands

```bash
python3 "$SKILL/scripts/board.py" status   # running? url? content path?
python3 "$SKILL/scripts/board.py" url      # just the URL
python3 "$SKILL/scripts/board.py" list     # boards that exist for this project
python3 "$SKILL/scripts/board.py" stop     # stop this project's board
python3 "$SKILL/scripts/board.py" clear    # reset content to empty
```

`start` is idempotent: if a board is already running for this project it just
prints the existing URL. Port conflicts are handled automatically (it scans
upward from 8765). The server survives the launching shell (it runs detached),
and state is tracked in `~/.cache/tutor-canvas/` so `status`/`stop` work from any
terminal.

## Notes

- Requires only `python3` (standard library) — no installs, no node runtime.
- Assets are vendored under this skill's `assets/`; the board works offline.
- The per-project content lives in `<project>/.tutor-canvas/` (auto-added to the
  project's `.gitignore`).
