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
- **Interactive quizzes**: fenced ```quiz blocks render as a clickable
  multiple-choice widget with instant feedback and a live score (below).
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

## Interactive quizzes — ```quiz

For **clickable multiple-choice quizzes** (instant right/wrong feedback, live
score, per-question explanations), use a ```quiz fence containing a JSON spec.
The board builds a real interactive widget — **do not** fall back to a separate
HTML page; the board renders this natively and keeps it live.

````
```quiz
{
  "title": "lvalues vs rvalues in C++",   // optional
  "shuffle": false,                         // optional: randomize question order
  "shuffleChoices": true,                   // optional, DEFAULT TRUE: randomize
                                            //   choice order per question
  "questions": [
    {
      "q": "Given `int x = 5;`, the expression `x` is a(n)…",
      "choices": ["lvalue", "rvalue", "neither"],
      "answer": 0,                          // index into choices of the correct one
      "explain": "`x` names an object with an address, so it is an lvalue."
    },
    {
      "q": "What category is the literal `5` in `int x = 5;`?",
      "choices": ["lvalue", "prvalue", "xvalue"],
      "answer": 1,
      "explain": "Literals like `5` are prvalues — they have no address you can take."
    }
  ]
}
```
````

Notes:
- `q`, each `choices` entry, and `explain` are **rendered as inline markdown +
  LaTeX**, so you can write `` `code` ``, `$T\&$`, `$$...$$`, **bold**, etc.
  inside them — ideal for "which type is `std::move(x)`?" or math questions.
- `answer` is the **zero-based index** of the correct choice **in the `choices`
  array as you wrote it**. You do *not* need to vary where you place the correct
  choice: `shuffleChoices` is **on by default**, so the board permutes the
  choices at render time and remaps `answer` — the displayed position is
  randomized per question even if you always write the answer first. (Set
  `"shuffleChoices": false` only when order is meaningful, e.g. "put these steps
  in order" or numeric ranges that should stay sorted.) Note `shuffle` controls
  *question* order only and does **not** affect choice positions.
- Clicking a choice locks the question, marks it correct/incorrect, reveals the
  correct answer (if the pick was wrong) and the explanation, and updates the
  running score. A **Reset** button restarts the quiz.
- A quiz keeps its answered/score state even as you `append` more content to the
  board, so you can teach, then drop a quiz, then keep teaching without wiping it.
- Invalid JSON shows an inline error, so iterate freely — same as ```diagram.

## Try-then-reveal — ```reveal

For open questions where there are no neat multiple-choice options (derivations,
"what's the next step?", "name the theorem"), use ```reveal. It shows the prompt
and a **Reveal answer** button so the user can *think and attempt first*, then
self-check. There is intentionally **no grading or input box** — if the user
wants to know why their attempt was wrong, they just ask you.

````
```reveal
{
  "title": "Try it first",                  // optional
  "items": [
    {
      "q": "Solve for $m$: $F_H = m\\,g\\,\\sin\\alpha$.",
      "a": "$$m = \\frac{F_H}{g\\,\\sin\\alpha}$$ With $F_H=10.0$, $\\alpha=30°$: $m = 2.04$ kg."
    }
  ]
}
```
````

Notes:
- `q` and `a` render as **full markdown blocks**, so an answer can be a multi-step
  derivation with `$$display math$$`, lists, and ```code fences```.
- A bare `{ "q": ..., "a": ... }` (no `items`) is accepted for a single reveal.
- The button toggles (Reveal ↔ Hide). Use this liberally in worked problems:
  pose the step, let the user try, then they reveal.

## Flashcards — ```flashcard

For active-recall drilling of definitions/formulas (e.g. C++ value categories,
big-O of operations), use ```flashcard — a flip deck. One card at a time; click
the card (or Enter/Space) to flip front↔back; **Prev / Flip / Next** to navigate.

````
```flashcard
{
  "title": "C++ value categories",           // optional
  "shuffle": false,                            // optional
  "cards": [
    { "front": "What is an **xvalue**?",
      "back": "An *eXpiring* value — e.g. the result of `std::move(x)`; it can be moved from." },
    { "front": "Category of a string literal `\"hi\"`?",
      "back": "An **lvalue** (it has static storage and an address)." }
  ]
}
```
````

Notes:
- `front` and `back` render as full markdown blocks (math, code, emphasis).
- A bare `{ "front": ..., "back": ... }` is accepted for a single card.
- `shuffle: true` randomizes the deck order.

All three interactive widgets (```quiz, ```reveal, ```flashcard) keep their live
state — answered questions, revealed answers, current card — even as you `append`
more content to the board. **Don't fall back to a separate HTML page for any of
these; the board renders them natively.**

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
