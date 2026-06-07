# tutor-canvas — Design & Architecture Decisions

This document records the architectural decisions for the `tutor-canvas` skill
and the tradeoffs behind each. It is the design deliverable; `README.md` is the
user-facing doc and `SKILL.md` is the agent-facing instruction set.

## Problem

Claude Code is used as a 1-on-1 tutor for math-heavy subjects. The terminal
cannot render LaTeX, so `$$\frac{...}{...}$$` is unreadable. A working prototype
(a polling `index.html` + `board.md` served by `python3 -m http.server`) proved
the concept but was fragile. This skill turns it into a robust, reusable,
distributable Claude Code skill.

## Decision 1 — Rendering stack: markdown-it + pre-extracted KaTeX

**Chosen.** Math is pre-extracted from the raw markdown and rendered with KaTeX
*after* markdown-it runs. Plus highlight.js (code) and Mermaid (diagrams).

> **Revision (math handling).** This originally used `markdown-it-texmath` (math
> as inline markdown rules). That fixed the emphasis bug but had a worse failure:
> texmath tokenizes at the **inline** level, which runs *after* the block-level
> **table** parser. A `|` inside a cell's math (e.g. an absolute value `$|x|$`,
> common in exam tables) was therefore counted as a column separator, the column
> count stopped matching the `|---|` row, and markdown-it silently rendered the
> whole table as raw text. The fix below pre-extracts math (incl. its pipes)
> *before* any markdown parsing, so tables — and the emphasis case — both work.

### How it works now (`board.js` → `extractMath` + `render`)

1. Stash fenced/inline **code** to sentinels first, so a `$` inside code is never
   treated as math; restore the code text before `md.render` so highlight.js
   still runs on it.
2. Replace each math span (`$$..$$`, `\[..\]`, `$..$`, `\(..\)`) with a
   **pipe-free alnum placeholder** (`xsbmathx<i>xsbmathx`) and stash its TeX.
   Because the placeholder has no `|`, `_`, or `*`, it survives table parsing and
   emphasis untouched.
3. `md.render()` the placeholder'd text → correct tables, lists, emphasis, code.
4. Swap each placeholder for `katex.renderToString(tex, {displayMode})` in the
   resulting HTML.

This is a *full-string* pre-extraction done at the right layer (before any
parsing), not the prototype's brittle post-hoc masking — it has a single,
well-defined ordering and no nesting/escaping ambiguity for the delimiters used.

### The bug we had to fix

The prototype used **marked** for markdown and **MathJax** for math, running
marked *first*. Markdown parsing therefore saw `_` and `*` inside formulas
(e.g. `\underbrace{...}_{\text{term 1}}`) and turned them into `<em>`/`<strong>`,
corrupting the LaTeX before MathJax ran. The stopgap (regex-extract math spans,
restore after) is brittle: it must perfectly model every math delimiter
(`$`, `$$`, `\(`, `\[`), handle escaping, nesting, and `$` used as literal
currency, and it silently corrupts anything it gets wrong.

### Why markdown-it + texmath

`markdown-it` is a pluggable markdown parser whose tokenizer can be extended
with **rules**. `markdown-it-texmath` registers math as first-class inline/block
rules, so `$...$` and `$$...$$` are extracted by the tokenizer **before** any
emphasis processing runs. The math payload is passed verbatim to KaTeX. There is
no ordering hazard and no regex masking — the bug is eliminated at the root, not
patched. This directly satisfies the requirement to reliably render
`\underbrace{\frac{\partial m}{\partial F_H}}_{\text{term 1}}`, matrices,
vectors, `\frac`, `\sqrt`, `\partial`, and `aligned` environments.

### Why KaTeX over MathJax

- **Synchronous + fast:** KaTeX renders inline during `md.render()`, so updates
  are instant and flicker-free. MathJax's async typeset pass caused reflow.
- **Offline-friendly:** KaTeX is a single JS + CSS + a fonts folder; trivial to
  vendor. (MathJax's SVG output also works but is heavier.)
- **Deterministic:** no global mutable `MathJax` config object, no race between
  DOM replacement and typesetting.

KaTeX covers the full LaTeX subset needed for exam math. The handful of MathJax
exclusives (e.g. `\require`, some physics packages) are not needed here.

### Code & diagrams

- **highlight.js** — wired into markdown-it's `highlight` callback; language-tag
  aware with auto-detect fallback. Dark theme to match the board.
- **Mermaid** — fenced ` ```mermaid ` blocks are intercepted by a custom fence
  renderer and rendered to SVG asynchronously after each DOM patch, with
  `securityLevel: "strict"`.

## Decision 2 — Assets bundled in the skill; content per-project

**Chosen: hybrid (option c from the planning prompt).**

- **Assets** (board HTML/CSS/JS + vendored libs) live in the **skill directory**
  (`web/` + `assets/`). They are read-only, shared across all projects, and ship
  with the skill — ideal for a distributable artifact and for offline use. No
  scaffolding into the user's project, no per-project copies to drift.
- **Content** lives **per project**: `<project>/.tutor-canvas/<name>.md`.
  - Keyed to the project so multiple projects / concurrent sessions get
    independent boards on independent ports and never clobber each other.
  - Inside a dotdir (not the project root) so it doesn't pollute the workspace;
    auto-added to the project's `.gitignore`.
  - In the project (not `/tmp`) so the board content travels with the work and
    is trivially discoverable via `board.py path`.

The server decouples the two: it serves the skill's `web/` at `/` and routes
`/board.md` to the active per-project content file, wherever it is on disk. So
the web root is constant and read-only while content can live anywhere.

### Why not the alternatives

- **(a) Everything in skill dir** — would force all sessions to share one
  content file; concurrent projects collide.
- **(b) Scaffold assets into each project** — pollutes the project, duplicates
  ~a few hundred KB per project, and reintroduces version drift.

## Decision 3 — Server lifecycle

A small `server.py` (stdlib `http.server`, threaded) plus a `board.py` CLI that
owns lifecycle:

- **Idempotent `start`:** checks a per-project state file
  (`~/.cache/tutor-canvas/<key>.json`) and a live PID; if already running, prints
  the existing URL instead of starting a second server.
- **Port-in-use handling:** scans upward from `8765` for a free port.
- **Survives the shell:** the server is spawned detached
  (`start_new_session=True`) so closing the terminal doesn't kill the board.
- **Cross-terminal control:** state lives in `~/.cache`, so `status`/`stop`
  work from any session.
- **Liveness wait:** `start` polls the port before reporting success.

`stop` kills the process group; `status` reports running/url/content; `clear`
resets content.

## Decision 4 — Live update without flashing

The renderer does a **block-level structural patch**: it parses the new HTML and
replaces only the top-level children whose `outerHTML` changed, appends new
trailing blocks, and removes deleted ones. This means:

- The page doesn't fully re-render, so there's no flash and **scroll position is
  preserved** — important during long derivations where the user is reading.
- Only changed/added blocks get a subtle 1s highlight (`.sb-changed`).
- Combined with the `append` CLI verb, live step-by-step teaching is smooth.

It's a pragmatic diff (not a full virtual DOM), which is sufficient for the
monotonically-growing content typical of tutoring. KaTeX rendering happens during
markdown render (synchronous); Mermaid is rendered per changed block afterwards.

## Decision 5 — Agent ergonomics

The `SKILL.md` `description` is written to auto-invoke on math/diagram/tutoring
cues. The push mechanism is dead simple and discoverable:

- `board.py path` returns the exact content-file path; the agent can write it
  directly or via `push`/`append`.
- `push` (replace) for setting/refreshing a problem; `append` for live steps.
- `--name` supports multiple named boards per project.

All commands are pure `python3` stdlib — no node runtime, no pip installs.

## Decision 6 — Scope & install

User-level skill (`~/.claude/skills/tutor-canvas/`) because it's useful across
all of Ethan's projects. Installed as a **symlink** to the git repo at
`/Users/ethan/Code/tutor-canvas` so edits in the repo are live immediately. The
installer refuses to overwrite a pre-existing non-symlink `tutor-canvas` skill.

## Vendoring & offline

`scripts/vendor.sh` downloads pinned versions of all libraries (and KaTeX fonts)
into `assets/` and writes `assets/MANIFEST.json`. The vendored files are
committed to the repo, so end users never need network access or `npm`. Versions
are pinned to avoid CDN drift.

## Open questions / risks

- **Vendored asset size:** Mermaid is the largest dependency (~1 MB+). If size
  matters, Mermaid could be made optional (lazy-loaded only when a ```mermaid
  block appears). Currently it's always loaded for simplicity.
- **texmath UMD global name:** `markdown-it-texmath`'s UMD build exposes
  `window.texmath`; if a future version changes this, `board.js` init must be
  updated. Pinned version mitigates this.
- **Single-user assumption:** the server binds `127.0.0.1` only (no remote
  access), which is the right default for a local tutor but means no sharing.
- **No auth on content route:** anything on localhost can read the board; fine
  for a single-user dev machine.
