# tutor-canvas — diagram & widget reference

Full field lists for the JSON-spec fences. `SKILL.md` carries the common-case
examples; read this file when you need fields beyond those (all diagram
primitives, curve options, and the `reveal` / `flashcard` widgets). Every spec
shows an inline error on bad JSON, so iterate freely.

## ```diagram — full spec

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
  "segments": [                            // plain STRAIGHT lines (arm, rope, incline)
    {"a": [110,60], "b": [250,200], "color": "red", "dash": true, "width": 2}
  ],
  "curves": [                              // smooth curves (supply/demand, f(x))
    {"points": [[60,90],[210,150],[360,250]], "color": "blue", "label": "AD"},
    {"points": [[60,250],[210,150],[360,90]], "color": "red", "label": "AS",
     "shift": [-40, 0]}                     // shift moves the WHOLE curve (a shock)
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
- `curves` draw a **smooth Catmull-Rom spline through the `points` you give**
  (knots the curve passes through — *not* Bézier handles), so you can author
  "curve through (a,b),(c,d),(e,f)" without solving for control points. Exactly
  2 points degrades to a straight line; `type: "line"` forces a plain polyline.
  - **`shift: [dx, dy]`** translates the whole curve before drawing — so "AS
    shifts left by 40" is `"shift": [-40, 0]` instead of recomputing every knot.
    This is the operation econ diagrams need most (a shock just translates a
    curve), so prefer it over editing coordinates.
  - `arrow`: `"end"` | `"both"` | `"none"` (default none) adds arrowhead(s) at
    the curve's end tangents. `label` sits at the last point unless you pass an
    explicit `labelAt: [x, y]`. `color` defaults gray, `width` to 2.
- Invalid JSON shows an inline error on the board, so iterate freely.
- For anything the spec can't express, a raw ```svg fence is also rendered
  (sanitized) — write SVG directly.

## ```quiz — full notes

Minimal example and the `answer` / `shuffleChoices` rules are in SKILL.md. Full
spec and behavior:

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

## ```reveal — try-then-reveal

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

- `q` and `a` render as **full markdown blocks**, so an answer can be a multi-step
  derivation with `$$display math$$`, lists, and ```code fences```.
- A bare `{ "q": ..., "a": ... }` (no `items`) is accepted for a single reveal.
- The button toggles (Reveal ↔ Hide). Use this liberally in worked problems:
  pose the step, let the user try, then they reveal.

## ```flashcard — flip deck

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

- `front` and `back` render as full markdown blocks (math, code, emphasis).
- A bare `{ "front": ..., "back": ... }` is accepted for a single card.
- `shuffle: true` randomizes the deck order.

All three interactive widgets (```quiz, ```reveal, ```flashcard) keep their live
state — answered questions, revealed answers, current card — even as you `append`
more content to the board. **Don't fall back to a separate HTML page for any of
these; the board renders them natively.**
