---
name: study-board
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

# study-board

A live browser "board" for math-heavy tutoring. You write markdown + LaTeX to a
content file; a local server serves a page that re-renders it about once per
second. LaTeX is rendered with KaTeX, code with highlight.js, diagrams with
Mermaid. Everything is vendored locally and works offline.

## When to use this

Use it **proactively** in any session that produces content the terminal can't
show well: LaTeX math, matrices/vectors, multi-step derivations, tables,
diagrams, or highlighted code — especially exam prep and tutoring. You do not
need the user to ask for "the board"; if you're about to emit `$$...$$`, open
the board and put the math there.

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
folder containing this SKILL.md (typically `~/.claude/skills/study-board`).

## Pushing content (the main loop)

The content lives in a markdown file. Discover its path, then write to it.

```bash
# Where is the content file?
python3 "$SKILL/scripts/board.py" path
# -> /your/project/.study-board/board.md

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

**Replace vs append:** prefer `push` to set/refresh the whole board at the start
of a problem, then `append` each new step as you teach so prior steps stay
visible and scroll position is preserved. Use `clear` to reset.

You can also just write the file directly — `board.py path` tells you where it
is. Either way the browser picks up changes within ~1 second.

### Multiple boards

Pass `--name <board>` to keep several boards for one project (e.g.
`--name physics`, `--name parprog`). Each name is an independent content file;
they share one server.

## Content you can use

- **LaTeX** inline `$...$` / `\(...\)` and display `$$...$$` / `\[...\]`.
  Heavy LaTeX is fully supported: `\frac`, `\sqrt`, `\partial`, `\underbrace`,
  matrices/`pmatrix`/`bmatrix`, vectors, `aligned`, Greek, `\boxed`, etc.
  Because math is tokenized before markdown emphasis, underscores and asterisks
  inside formulas are safe — write `\underbrace{...}_{\text{term 1}}` directly.
- **Markdown**: headings, **bold**, lists, blockquotes, `---` rules.
- **Tables** (GitHub pipe tables).
- **Code** fenced blocks with a language tag get syntax highlighting.
- **Diagrams**: fenced ```mermaid blocks render as SVG (flowcharts, sequence,
  state). For **physics / vector / free-body diagrams** use ```diagram (below).
- **Images**: reference files served from the project; or use absolute URLs.

## Vector / physics diagrams — ```diagram

For force diagrams, free-body diagrams, inclines, and any "arrows + angles"
figure, **use a ```diagram fence containing a JSON spec** — far cheaper than
hand-writing SVG, and it renders real arrows and angle arcs.

**Coordinate contract (read carefully):**
- Coordinates are `[x, y]` in **pixels from the BOTTOM-LEFT**, with **y pointing
  UP** (math convention, not SVG). The renderer flips y for you.
- Angles (`deg`) are **degrees counter-clockwise from the +x axis** (east=0,
  north=90, west=180, south=270). So a force at angle θ above horizontal pointing
  up-right is `deg: θ`; down-left is `deg: 180+θ`; straight down (gravity) is
  `deg: 270`.
- Colors: names (`red blue green gray yellow purple white`) or any CSS color.

**Spec fields (all optional except where noted):**

````
```diagram
{
  "w": 420, "h": 320,                      // canvas size (default 420x300)
  "ground": 60,                            // draw a horizontal ground line at y=60
                                           //   (true = mid-canvas)
  "origin": [250, 200],                    // default start point for vectors (default: center)
  "vectors": [                             // arrows (force diagrams)
    {"deg": 225, "mag": 110, "label": "F_S", "color": "red"},
    {"deg": 80,  "mag": 90,  "label": "F_A", "color": "blue"},
    {"deg": 270, "mag": 95,  "label": "mg",  "color": "gray", "from": [250,200]}
  ],
  "segments": [                            // plain lines (arm, rope, incline, ground)
    {"a": [110,60], "b": [250,200], "color": "red", "dash": true, "width": 2}
  ],
  "arcs": [                                // angle markers
    {"at": [110,60], "from": 0, "to": 45, "label": "β", "r": 26, "color": "gray"}
  ],
  "points": [ {"at": [250,200], "label": "m", "color": "white"} ],
  "labels": [ {"at": [20,300], "text": "crane", "color": "gray"} ]
}
```
````

Notes:
- `mag` is arrow length in px. Keep arrows + labels inside `w`×`h` (content
  outside the canvas is clipped) — bump `h`/`w` or shrink `mag` if a label clips.
- A `vector`'s tail is `from` if given, else `origin`. End = tail +
  `mag·(cos deg, sin deg)`.
- Invalid JSON shows an inline error on the board, so iterate freely.
- For anything the spec can't express, a raw ```svg fence is also rendered
  (sanitized) — write SVG directly.

## Lifecycle commands

```bash
python3 "$SKILL/scripts/board.py" status   # running? url? content path?
python3 "$SKILL/scripts/board.py" url      # just the URL
python3 "$SKILL/scripts/board.py" stop     # stop this project's board
python3 "$SKILL/scripts/board.py" clear    # reset content to empty
```

`start` is idempotent: if a board is already running for this project it just
prints the existing URL. Port conflicts are handled automatically (it scans
upward from 8765). The server survives the launching shell (it runs detached),
and state is tracked in `~/.cache/study-board/` so `status`/`stop` work from any
terminal.

## Notes

- Requires only `python3` (standard library) — no installs, no node runtime.
- Assets are vendored under this skill's `assets/`; the board works offline.
- The per-project content lives in `<project>/.study-board/` (auto-added to the
  project's `.gitignore`).
