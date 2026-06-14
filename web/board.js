/* tutor-canvas live renderer.
 *
 * Why this stack (see DESIGN.md for the full rationale):
 *   markdown-it + markdown-it-texmath + KaTeX.
 *
 * The prototype's core bug was that marked parsed markdown *before* MathJax,
 * so `_` and `*` inside formulas like `\underbrace{...}_{\text{term 1}}` were
 * eaten as emphasis. markdown-it-texmath registers math as first-class
 * markdown *rules*, so the tokenizer extracts `$...$` / `$$...$$` spans before
 * any inline emphasis processing ever sees them. The math content is handed
 * verbatim to KaTeX. No fragile regex masking, no ordering hazard.
 *
 * KaTeX renders synchronously and entirely offline, which makes updates fast
 * and flicker-free and removes the CDN/async dependency MathJax imposed.
 */

(function () {
  "use strict";

  const POLL_MS = 1000;
  const statusEl = document.getElementById("status");
  const contentEl = document.getElementById("content");

  let md = null;
  let lastRaw = null;
  let mermaidReady = false;
  let mermaidSeq = 0;

  const katexOpts = {
    throwOnError: false,
    errorColor: "#e0564a",
    macros: { "\\RR": "\\mathbb{R}" },
  };
  // Pipe-free, alnum sentinel so math placeholders survive markdown-it (incl.
  // inside table cells) without being mistaken for column separators.
  const mathToken = (i) => "xsbmathx" + i + "xsbmathx";
  const MATH_RE = /xsbmathx(\d+)xsbmathx/g;

  /* Minimal sanitizer for author-supplied inline SVG (```svg fences). The
   * content is local and author-written, but we still strip the obvious script
   * vectors so the skill is safe to ship. */
  function sanitizeSvg(s) {
    return String(s)
      .replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, "")
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      .replace(/(href|xlink:href)\s*=\s*("javascript:[^"]*"|'javascript:[^']*')/gi, "");
  }

  /* ---- ```diagram vector-spec renderer -------------------------------------
   * A compact JSON spec → SVG, so a tutoring session can draw force/vector
   * diagrams from a few lines instead of hand-writing SVG. Coordinates use MATH
   * convention: x right, y UP, origin at bottom-left of the canvas; angles in
   * degrees CCW from +x. See SKILL.md for the authoring contract. */
  const DIAG_COLORS = {
    red: "#e0564a", blue: "#6ea8fe", green: "#3ddc84",
    gray: "#9aa3b2", grey: "#9aa3b2", yellow: "#e6c84a",
    purple: "#b98cff", white: "#e6e8ee",
  };
  function diagColor(c) { return DIAG_COLORS[c] || c || "#e6e8ee"; }
  function esc(s) {
    return String(s).replace(/[<>&"]/g, (c) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
  }
  // Compile a whitelisted arithmetic expression in `x` (for ```diagram curve
  // `fn` plotting) into a JS function. The spec is author-written and local, but
  // we still restrict it to numbers, `x`, the basic operators, and a fixed set
  // of Math functions — no property access, no globals — so a stray spec can't
  // run arbitrary code. Returns null on anything outside the whitelist.
  const FN_NAMES = ["sin", "cos", "tan", "asin", "acos", "atan", "exp", "sqrt",
    "abs", "ln", "log", "pow", "min", "max", "floor", "ceil", "round", "PI", "E"];
  function compileFn(expr) {
    const e = String(expr).replace(/\s+/g, "").replace(/\^/g, "**");
    const stripped = e.replace(new RegExp(FN_NAMES.join("|") + "|x", "g"), "");
    if (/[^0-9.+\-*/%(),]/.test(stripped)) return null; // disallowed token
    try {
      const f = new Function("x", ...FN_NAMES, "return (" + e + ");");
      const M = Math, vals = [M.sin, M.cos, M.tan, M.asin, M.acos, M.atan, M.exp,
        M.sqrt, M.abs, M.log, (v) => M.log(v) / M.LN10, M.pow, M.min, M.max,
        M.floor, M.ceil, M.round, M.PI, M.E];
      f(1, ...vals); // probe once so a malformed body fails here, not mid-render
      return (x) => f(x, ...vals);
    } catch (err) {
      return null;
    }
  }
  // Stable, short hash of a string (djb2). Used to key interactive widgets so
  // the structural patch can recognize "the same quiz" across re-renders and
  // preserve its live state instead of rebuilding it from scratch.
  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  /* Emit a stable-keyed, empty placeholder for an interactive widget fence
   * (quiz / reveal / flashcard). The real DOM is built later by hydrateWidgets;
   * the data-key (hash of the spec) lets patch() preserve a hydrated widget's
   * live state across re-renders, and data-widget selects the builder. */
  function widgetPlaceholder(kind, content) {
    return '<div class="sb-' + kind + '" data-widget="' + kind +
      '" data-key="' + kind + "-" + hashStr(content) +
      '" data-src="' + encodeURIComponent(content) + '"></div>\n';
  }
  function renderDiagram(specText) {
    const spec = JSON.parse(specText);
    const w = spec.w || 420, h = spec.h || 300;
    const Y = (y) => h - y;            // flip to SVG (y-down)
    const parts = [];
    const stroke = (col, sw, dash) =>
      'stroke="' + diagColor(col) + '" stroke-width="' + (sw || 2) + '"' +
      (dash ? ' stroke-dasharray="6 4"' : "");
    // Filled arrowhead at (ex,ey) pointing along unit dir (ux,uy). Shared by
    // vectors and curve arrows; y is flipped via Y like every other primitive.
    const arrowHead = (ex, ey, ux, uy, col) => {
      const ah = 10, aw = 5, px = -uy, py = ux;
      const bx = ex - ah * ux, by = ey - ah * uy;
      return '<polygon points="' + ex + "," + Y(ey) + " " +
        (bx + aw * px) + "," + Y(by + aw * py) + " " +
        (bx - aw * px) + "," + Y(by - aw * py) + '" fill="' + col + '"/>';
    };
    // Catmull-Rom spline through the given knots -> cubic-Bezier path. Authors
    // give points the curve passes THROUGH (not Bezier handles); endpoints are
    // duplicated so the ends aren't clipped. Points are pre-flipped to screen
    // space, which is fine since the conversion is affine.
    function catmullRom(pts) {
      const P = pts.map((p) => [p[0], Y(p[1])]);
      let d = "M " + P[0][0] + " " + P[0][1];
      for (let i = 0; i < P.length - 1; i++) {
        const p0 = P[i - 1] || P[i], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2] || P[i + 1];
        d += " C " + (p1[0] + (p2[0] - p0[0]) / 6) + " " + (p1[1] + (p2[1] - p0[1]) / 6) +
          " " + (p2[0] - (p3[0] - p1[0]) / 6) + " " + (p2[1] - (p3[1] - p1[1]) / 6) +
          " " + p2[0] + " " + p2[1];
      }
      return d;
    }

    // ground line
    if (spec.ground) {
      const gy = spec.ground === true ? h / 2 : spec.ground;
      parts.push('<line x1="0" y1="' + Y(gy) + '" x2="' + w + '" y2="' + Y(gy) +
        '" ' + stroke("#3a4150", 2) + "/>");
    }
    // axes: {origin?:[x,y], x?:{to,label?,arrow?,ticks?}, y?:{...}, grid?, color?}
    //   Ticks/grid are at pixel positions (same space as every other primitive);
    //   tick labels are author-supplied text (data values or names like Q*/P*).
    if (spec.axes) {
      const ax = spec.axes, col = ax.color || "#9aa3b2", dc = diagColor(col);
      const O = ax.origin || [40, 40], ox = O[0], oy = O[1];
      const AX = ax.x || {}, AY = ax.y || {};
      const xEnd = AX.to != null ? AX.to : w - 10;
      const yEnd = AY.to != null ? AY.to : h - 10;
      parts.push('<line x1="' + ox + '" y1="' + Y(oy) + '" x2="' + xEnd +
        '" y2="' + Y(oy) + '" ' + stroke(col, 1.5) + "/>");
      parts.push('<line x1="' + ox + '" y1="' + Y(oy) + '" x2="' + ox +
        '" y2="' + Y(yEnd) + '" ' + stroke(col, 1.5) + "/>");
      if (AX.arrow !== false) parts.push(arrowHead(xEnd, oy, 1, 0, dc));
      if (AY.arrow !== false) parts.push(arrowHead(ox, yEnd, 0, 1, dc));
      if (AX.label) parts.push('<text x="' + xEnd + '" y="' + (Y(oy) + 16) +
        '" fill="' + dc + '" font-size="14" font-style="italic" text-anchor="end">' +
        esc(AX.label) + "</text>");
      if (AY.label) parts.push('<text x="' + (ox - 6) + '" y="' + (Y(yEnd) + 2) +
        '" fill="' + dc + '" font-size="14" font-style="italic" text-anchor="end">' +
        esc(AY.label) + "</text>");
      (AX.ticks || []).forEach((t) => {
        const at = typeof t === "number" ? t : t.at;
        const lab = typeof t === "number" ? null : t.label;
        parts.push('<line x1="' + at + '" y1="' + Y(oy - 4) + '" x2="' + at +
          '" y2="' + Y(oy + 4) + '" ' + stroke(col, 1) + "/>");
        if (ax.grid) parts.push('<line x1="' + at + '" y1="' + Y(oy) + '" x2="' +
          at + '" y2="' + Y(yEnd) + '" ' + stroke(col, 0.75, true) + "/>");
        if (lab != null) parts.push('<text x="' + at + '" y="' + (Y(oy - 8)) +
          '" fill="' + dc + '" font-size="12" text-anchor="middle">' + esc(lab) + "</text>");
      });
      (AY.ticks || []).forEach((t) => {
        const at = typeof t === "number" ? t : t.at;
        const lab = typeof t === "number" ? null : t.label;
        parts.push('<line x1="' + (ox - 4) + '" y1="' + Y(at) + '" x2="' + (ox + 4) +
          '" y2="' + Y(at) + '" ' + stroke(col, 1) + "/>");
        if (ax.grid) parts.push('<line x1="' + ox + '" y1="' + Y(at) + '" x2="' +
          xEnd + '" y2="' + Y(at) + '" ' + stroke(col, 0.75, true) + "/>");
        if (lab != null) parts.push('<text x="' + (ox - 8) + '" y="' + (Y(at) + 4) +
          '" fill="' + dc + '" font-size="12" text-anchor="end">' + esc(lab) + "</text>");
      });
    }
    // free segments: {a:[x,y], b:[x,y], color?, dash?, width?}
    (spec.segments || []).forEach((s) => {
      parts.push('<line x1="' + s.a[0] + '" y1="' + Y(s.a[1]) + '" x2="' +
        s.b[0] + '" y2="' + Y(s.b[1]) + '" ' + stroke(s.color, s.width, s.dash) + "/>");
    });
    // smooth curves: {points:[[x,y],...], type?, shift?, color?, width?, dash?,
    //   arrow?:"end"|"both"|"none", label?, labelAt?:[x,y]}. `points` are knots
    //   the curve passes through; `shift` translates the whole curve.
    //   Alternatively {fn:"100-0.5*x", domain:[x0,x1], samples?} plots f(x) by
    //   sampling the expression into points (pixel space, same as everything).
    (spec.curves || []).forEach((c) => {
      let pts;
      if (c.fn) {
        const f = compileFn(c.fn);
        if (!f) {
          parts.push('<text x="8" y="' + (h - 8) + '" fill="#e0564a" font-size="13">' +
            "bad fn: " + esc(String(c.fn)) + "</text>");
          return;
        }
        const dom = c.domain || [0, w], steps = c.samples || 40;
        pts = [];
        for (let i = 0; i <= steps; i++) {
          const x = dom[0] + (dom[1] - dom[0]) * i / steps, y = f(x);
          if (isFinite(x) && isFinite(y)) pts.push([x, y]); // skip poles/NaN
        }
      } else {
        pts = c.points || [];
      }
      if (c.shift) pts = pts.map((p) => [p[0] + c.shift[0], p[1] + c.shift[1]]);
      if (pts.length < 2) {
        parts.push('<text x="8" y="' + (h - 8) +
          '" fill="#e0564a" font-size="13">curve needs &#8805;2 points</text>');
        return;
      }
      const col = diagColor(c.color || "#9aa3b2");
      // Sampled fn data is already dense -> default to a polyline; hand-authored
      // knots default to a smooth spline. `type` overrides either way.
      const useSpline = c.fn ? c.type === "spline" : c.type !== "line";
      const d = useSpline
        ? catmullRom(pts)
        : "M " + pts.map((p) => p[0] + " " + Y(p[1])).join(" L ");
      parts.push('<path d="' + d + '" fill="none" ' +
        stroke(c.color || "#9aa3b2", c.width, c.dash) + "/>");
      // arrowheads, aligned to the curve's end tangents
      const unit = (i, j) => {
        const dx = pts[j][0] - pts[i][0], dy = pts[j][1] - pts[i][1];
        const L = Math.hypot(dx, dy) || 1;
        return [dx / L, dy / L];
      };
      const n = pts.length;
      if (c.arrow === "end" || c.arrow === "both") {
        const [ux, uy] = unit(n - 2, n - 1);
        parts.push(arrowHead(pts[n - 1][0], pts[n - 1][1], ux, uy, col));
      }
      if (c.arrow === "both") {
        const [ux, uy] = unit(1, 0);
        parts.push(arrowHead(pts[0][0], pts[0][1], ux, uy, col));
      }
      if (c.label) {
        const lp = c.labelAt || [pts[n - 1][0] + 8, pts[n - 1][1] + 8];
        parts.push('<text x="' + lp[0] + '" y="' + Y(lp[1]) + '" fill="' + col +
          '" font-size="15" font-style="italic">' + esc(c.label) + "</text>");
      }
    });
    // angle arcs: {at:[x,y], r?, from:deg, to:deg, label?, color?}
    (spec.arcs || []).forEach((a) => {
      const r = a.r || 26, cx = a.at[0], cy = a.at[1];
      const f = (a.from || 0) * Math.PI / 180, t = (a.to || 0) * Math.PI / 180;
      const x1 = cx + r * Math.cos(f), y1 = cy + r * Math.sin(f);
      const x2 = cx + r * Math.cos(t), y2 = cy + r * Math.sin(t);
      const large = Math.abs((a.to || 0) - (a.from || 0)) > 180 ? 1 : 0;
      parts.push('<path d="M ' + x1 + " " + Y(y1) + " A " + r + " " + r +
        " 0 " + large + ' 0 ' + x2 + " " + Y(y2) + '" fill="none" ' +
        stroke(a.color || "#9aa3b2", 1.5) + "/>");
      if (a.label) {
        const m = (f + t) / 2, lr = r + 12;
        parts.push('<text x="' + (cx + lr * Math.cos(m)) + '" y="' +
          (Y(cy + lr * Math.sin(m)) + 4) + '" fill="' + diagColor(a.color || "#9aa3b2") +
          '" font-size="14" text-anchor="middle">' + esc(a.label) + "</text>");
      }
    });
    // vectors (arrows): {deg, mag, label?, color?, from?:[x,y]}
    const O = spec.origin || [w / 2, h / 2];
    (spec.vectors || []).forEach((v) => {
      const from = v.from || O;
      const a = (v.deg || 0) * Math.PI / 180;
      const ex = from[0] + (v.mag || 60) * Math.cos(a);
      const ey = from[1] + (v.mag || 60) * Math.sin(a);
      const col = diagColor(v.color);
      // shaft
      parts.push('<line x1="' + from[0] + '" y1="' + Y(from[1]) + '" x2="' + ex +
        '" y2="' + Y(ey) + '" ' + stroke(v.color, 2.5) + "/>");
      // arrowhead (filled triangle aligned to the vector)
      parts.push(arrowHead(ex, ey, Math.cos(a), Math.sin(a), col));
      if (v.label) {
        parts.push('<text x="' + (ex + 8 * ux) + '" y="' + (Y(ey + 8 * uy) - 4) +
          '" fill="' + col + '" font-size="15" font-style="italic" text-anchor="middle">' +
          esc(v.label) + "</text>");
      }
    });
    // points: {at:[x,y], label?, color?}
    (spec.points || []).forEach((p) => {
      parts.push('<circle cx="' + p.at[0] + '" cy="' + Y(p.at[1]) + '" r="4" fill="' +
        diagColor(p.color) + '"/>');
      if (p.label) {
        parts.push('<text x="' + (p.at[0] + 8) + '" y="' + (Y(p.at[1]) - 8) +
          '" fill="' + diagColor(p.color) + '" font-size="14">' + esc(p.label) + "</text>");
      }
    });
    // free labels: {at:[x,y], text, color?}
    (spec.labels || []).forEach((l) => {
      parts.push('<text x="' + l.at[0] + '" y="' + Y(l.at[1]) + '" fill="' +
        diagColor(l.color) + '" font-size="14">' + esc(l.text) + "</text>");
    });
    return '<svg viewBox="0 0 ' + w + " " + h + '" width="' + w +
      '" role="img">' + parts.join("") + "</svg>";
  }

  function setStatus(cls, text) {
    statusEl.className = cls;
    statusEl.textContent = text;
  }

  function initMarkdown() {
    md = window.markdownit({
      html: false, // do not allow raw HTML injection from the content file
      linkify: true,
      breaks: false,
      highlight: function (code, lang) {
        if (window.hljs && lang && window.hljs.getLanguage(lang)) {
          try {
            return window.hljs.highlight(code, { language: lang }).value;
          } catch (e) {
            /* fall through */
          }
        }
        if (window.hljs) {
          try {
            return window.hljs.highlightAuto(code).value;
          } catch (e) {
            /* fall through */
          }
        }
        return md.utils.escapeHtml(code);
      },
    });

    // Math is intentionally NOT handled by a markdown-it plugin. texmath
    // tokenizes math at the *inline* level, which runs AFTER the block-level
    // table parser — so a `|` inside a cell's math (e.g. an absolute value
    // $|x|$) gets miscounted as a column separator and silently breaks the
    // whole table. Instead we pre-extract math spans before markdown parsing
    // (see extractMath/render) and render them with KaTeX afterward, so the
    // pipes are gone before tables are parsed.

    // Mark fenced ```mermaid blocks so we can post-process them.
    const defaultFence =
      md.renderer.rules.fence ||
      function (tokens, idx, options, env, self) {
        return self.renderToken(tokens, idx, options);
      };
    md.renderer.rules.fence = function (tokens, idx, options, env, self) {
      const token = tokens[idx];
      const info = (token.info || "").trim().toLowerCase();
      if (info === "mermaid") {
        return (
          '<div class="mermaid" data-src="' +
          encodeURIComponent(token.content) +
          '"></div>\n'
        );
      }
      // ```svg blocks: inline vector/physics diagrams (arrows, angle arcs,
      // proportions) that ASCII can't express. Sanitized since markdown-it has
      // html:false and would otherwise escape the markup entirely.
      if (info === "svg") {
        return '<div class="sb-svg">' + sanitizeSvg(token.content) + "</div>\n";
      }
      // ```diagram blocks: compact JSON vector-spec → rendered SVG.
      if (info === "diagram") {
        try {
          return '<div class="sb-svg">' + renderDiagram(token.content) + "</div>\n";
        } catch (e) {
          return '<div class="sb-error">diagram error: ' +
            md.utils.escapeHtml(String(e)) + "</div>\n";
        }
      }
      // Interactive widget fences: compact JSON → a stateful widget. We can't
      // emit the buttons-with-handlers here (html:false forbids author markup,
      // and inline handlers are an XSS vector). Instead we emit a stable-keyed,
      // empty placeholder; hydrateWidgets() builds the real DOM and attaches
      // listeners afterwards. patch() preserves live state via the data-key.
      //   quiz      — clickable multiple-choice with feedback + score
      //   reveal    — try-then-reveal answer (no grading)
      //   flashcard — flip deck (front/back)
      if (info === "quiz" || info === "reveal" || info === "flashcard") {
        return widgetPlaceholder(info, token.content);
      }
      return defaultFence(tokens, idx, options, env, self);
    };

    if (window.mermaid) {
      try {
        window.mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
          securityLevel: "strict",
        });
        mermaidReady = true;
      } catch (e) {
        mermaidReady = false;
      }
    }
  }

  async function renderMermaid(root) {
    if (!mermaidReady) return;
    const nodes = root.querySelectorAll(".mermaid[data-src]");
    for (const node of nodes) {
      const src = decodeURIComponent(node.getAttribute("data-src") || "");
      node.removeAttribute("data-src");
      const id = "mmd-" + mermaidSeq++;
      try {
        const { svg } = await window.mermaid.render(id, src);
        node.innerHTML = svg;
      } catch (e) {
        node.innerHTML =
          '<div class="sb-error">mermaid error: ' +
          md.utils.escapeHtml(String(e)) +
          "</div>";
      }
    }
  }

  /* ---- interactive widgets (quiz / reveal / flashcard) ---------------------
   * Each is built in JS so click handlers are attached programmatically
   * (html:false stays on; no inline handlers ever touch the markup). Widget
   * state lives in the DOM/closure and is preserved across board re-renders by
   * the data-key check in patch(). hydrateWidgets dispatches by data-widget. */
  const WIDGET_BUILDERS = {
    quiz: buildQuiz,
    reveal: buildReveal,
    flashcard: buildFlashcard,
  };
  function hydrateWidgets(root) {
    root.querySelectorAll("[data-widget][data-src]").forEach((node) => {
      const kind = node.getAttribute("data-widget");
      const src = decodeURIComponent(node.getAttribute("data-src") || "");
      node.removeAttribute("data-src"); // mark hydrated; never rebuilt in place
      const build = WIDGET_BUILDERS[kind];
      try {
        if (!build) throw new Error("unknown widget: " + kind);
        build(node, JSON.parse(src));
      } catch (e) {
        node.innerHTML = '<div class="sb-error">' + kind + " error: " +
          md.utils.escapeHtml(String(e)) + "</div>";
      }
    });
  }

  // Fisher–Yates shuffle in place; shared by quiz/flashcard `shuffle`.
  function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function buildQuiz(node, spec) {
    const questions = (spec.questions || []).slice();
    if (spec.shuffle) shuffleInPlace(questions);
    const total = questions.length;
    const answered = new Array(total).fill(false);
    let correct = 0;

    node.innerHTML = "";
    const head = document.createElement("div");
    head.className = "sb-quiz-head";
    const title = document.createElement("div");
    title.className = "sb-quiz-title";
    title.innerHTML = renderRich(spec.title || "Quiz", true);
    const score = document.createElement("div");
    score.className = "sb-quiz-score";
    head.appendChild(title);
    head.appendChild(score);
    node.appendChild(head);

    // Completion summary; announced to assistive tech via aria-live.
    const summary = document.createElement("div");
    summary.className = "sb-quiz-summary";
    summary.setAttribute("aria-live", "polite");
    summary.hidden = true;

    function updateScore() {
      const done = answered.filter(Boolean).length;
      const finished = done === total;
      score.textContent = correct + " / " + total;
      // Green only at full marks — "finished" alone is not "good".
      score.classList.toggle("perfect", finished && correct === total);
      summary.hidden = !finished;
      if (finished) {
        summary.textContent = correct === total
          ? "Perfect — " + correct + " / " + total + " ✓"
          : "Done — " + correct + " / " + total + " correct";
        summary.classList.toggle("perfect", correct === total);
      }
    }
    updateScore();

    questions.forEach((q, qi) => {
      const card = document.createElement("div");
      card.className = "sb-quiz-q";
      const prompt = document.createElement("div");
      prompt.className = "sb-quiz-prompt";
      prompt.innerHTML = "<span class='sb-quiz-n'>" + (qi + 1) + ".</span> " +
        renderRich(q.q || "", true);
      card.appendChild(prompt);

      const explain = document.createElement("div");
      explain.className = "sb-quiz-explain";
      explain.hidden = true;
      if (q.explain) explain.innerHTML = renderRich(q.explain, true);

      // Permute the choice order so the correct answer is not always in the
      // same slot (authors tend to put it first). Defaults ON; set
      // "shuffleChoices": false on the quiz to keep the authored order.
      // `answer` stays a zero-based index into the ORIGINAL choices array — the
      // remap below keeps it correct regardless of the displayed order.
      const choices = q.choices || [];
      const order = choices.map((_, i) => i);
      if (spec.shuffleChoices !== false) shuffleInPlace(order);
      const correctPos = order.indexOf(q.answer); // displayed slot of the answer

      order.forEach((srcIdx) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "sb-quiz-choice";
        btn.innerHTML = renderRich(String(choices[srcIdx]), true);
        btn.addEventListener("click", () => {
          if (answered[qi]) return; // locked after first answer
          answered[qi] = true;
          const right = srcIdx === q.answer;
          if (right) correct++;
          btn.classList.add(right ? "correct" : "incorrect");
          // Reveal the correct choice (in its displayed slot) when wrong.
          if (!right) {
            const all = card.querySelectorAll(".sb-quiz-choice");
            if (all[correctPos]) all[correctPos].classList.add("correct");
          }
          card.querySelectorAll(".sb-quiz-choice").forEach((b) =>
            b.classList.add("locked"));
          if (q.explain) explain.hidden = false;
          card.classList.add(right ? "answered-right" : "answered-wrong");
          updateScore();
        });
        card.appendChild(btn);
      });

      card.appendChild(explain);
      node.appendChild(card);
    });

    node.appendChild(summary);

    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "sb-quiz-reset";
    reset.textContent = "Reset";
    reset.addEventListener("click", () => buildQuiz(node, spec));
    node.appendChild(reset);
  }

  /* ```reveal — try-then-reveal. Shows a prompt and a button that toggles the
   * answer. No grading: the user thinks/attempts, then reveals to self-check.
   * Spec: { title?, items: [ { q, a } ] }  (a bare { q, a } is also accepted).
   * `q` and `a` render as full blocks so answers can be multi-step derivations
   * with display math, lists, and code. */
  function buildReveal(node, spec) {
    const items = spec.items ||
      (spec.q || spec.a ? [{ q: spec.q, a: spec.a }] : []);
    node.innerHTML = "";
    if (spec.title) {
      const t = document.createElement("div");
      t.className = "sb-quiz-title";
      t.innerHTML = renderRich(spec.title, true);
      node.appendChild(t);
    }
    items.forEach((it) => {
      const card = document.createElement("div");
      card.className = "sb-reveal-item";
      if (it.q != null && it.q !== "") {
        const q = document.createElement("div");
        q.className = "sb-reveal-q";
        q.innerHTML = renderRich(String(it.q), false);
        card.appendChild(q);
      }
      const ans = document.createElement("div");
      ans.className = "sb-reveal-a";
      ans.hidden = true;
      ans.innerHTML = renderRich(String(it.a || ""), false);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sb-reveal-btn";
      const setLabel = () => {
        btn.textContent = ans.hidden ? "Reveal answer" : "Hide answer";
        btn.classList.toggle("open", !ans.hidden);
      };
      setLabel();
      btn.addEventListener("click", () => {
        ans.hidden = !ans.hidden;
        setLabel();
      });
      card.appendChild(btn);
      card.appendChild(ans);
      node.appendChild(card);
    });
  }

  /* ```flashcard — a flip deck for active recall. One card at a time; click the
   * card (or press Enter/Space) to flip front↔back; Prev/Next to navigate.
   * Spec: { title?, shuffle?, cards: [ { front, back } ] }  (a bare
   * { front, back } is also accepted). Faces render as full blocks. */
  function buildFlashcard(node, spec) {
    const cards = (spec.cards ||
      (spec.front || spec.back ? [{ front: spec.front, back: spec.back }] : []))
      .slice();
    if (spec.shuffle) shuffleInPlace(cards);
    if (!cards.length) { node.innerHTML = ""; return; }
    let idx = 0, flipped = false;

    node.innerHTML = "";
    const head = document.createElement("div");
    head.className = "sb-quiz-head";
    const title = document.createElement("div");
    title.className = "sb-quiz-title";
    title.innerHTML = renderRich(spec.title || "Flashcards", true);
    const counter = document.createElement("div");
    counter.className = "sb-quiz-score";
    head.appendChild(title);
    head.appendChild(counter);
    node.appendChild(head);

    const card = document.createElement("button");
    card.type = "button";
    card.className = "sb-flash-card";
    card.setAttribute("aria-live", "polite");

    function show() {
      const c = cards[idx] || {};
      const face = flipped ? c.back : c.front;
      card.innerHTML =
        '<div class="sb-flash-face">' + renderRich(String(face || ""), false) +
        '</div><div class="sb-flash-hint">' +
        (flipped ? "back · click to flip" : "front · click to flip") + "</div>";
      card.classList.toggle("flipped", flipped);
      counter.textContent = (idx + 1) + " / " + cards.length;
    }
    card.addEventListener("click", () => { flipped = !flipped; show(); });
    node.appendChild(card);

    const nav = document.createElement("div");
    nav.className = "sb-flash-nav";
    const mkNav = (label, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "sb-quiz-reset";
      b.textContent = label;
      b.addEventListener("click", fn);
      return b;
    };
    const go = (delta) => {
      idx = (idx + delta + cards.length) % cards.length;
      flipped = false;
      show();
    };
    nav.appendChild(mkNav("‹ Prev", () => go(-1)));
    nav.appendChild(mkNav("Flip", () => { flipped = !flipped; show(); }));
    nav.appendChild(mkNav("Next ›", () => go(1)));
    node.appendChild(nav);

    show();
  }

  /* Block-level patch: replace only the top-level children that actually
   * changed, so the page doesn't flash and scroll position is preserved.
   * This is a pragmatic structural diff, not a full virtual DOM — good enough
   * for monotonically-growing tutoring content. */
  function patch(newHTML) {
    const tpl = document.createElement("template");
    tpl.innerHTML = newHTML;
    const next = Array.from(tpl.content.children);
    const cur = Array.from(contentEl.children);

    let i = 0;
    for (; i < next.length; i++) {
      const n = next[i];
      const c = cur[i];
      if (!c) {
        contentEl.appendChild(n);
        n.classList && n.classList.add("sb-changed");
        renderMermaid(n);
      } else if (
        c.dataset && n.dataset && c.dataset.key &&
        c.dataset.key === n.dataset.key
      ) {
        // Same stateful widget (e.g. a ```quiz): keep the live, hydrated node
        // so the user's answers/score survive re-renders triggered elsewhere.
        // A genuine edit changes the key (hash of the spec) and falls through.
        continue;
      } else if (c.outerHTML !== n.outerHTML) {
        contentEl.replaceChild(n, c);
        n.classList && n.classList.add("sb-changed");
        renderMermaid(n);
      }
    }
    // Remove any trailing nodes that no longer exist.
    while (contentEl.children.length > next.length) {
      contentEl.removeChild(contentEl.lastChild);
    }
  }

  /* Pull math (and protect code) out of the raw markdown BEFORE markdown-it
   * parses it. Code is stashed first so a `$` inside a code block/span is never
   * mistaken for math; it is then restored as text so markdown-it can still
   * highlight it. Math becomes a pipe-free alnum token that survives table
   * parsing; the actual TeX is rendered by KaTeX after markdown-it runs. */
  function extractMath(raw) {
    const code = [];
    const stashCode = (m) => "\u0000C" + (code.push(m) - 1) + "\u0000";
    let t = raw.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, stashCode);
    t = t.replace(/`[^`\n]*`/g, stashCode);

    const math = [];
    const push = (tex, display) => mathToken(math.push({ tex, display }) - 1);
    t = t.replace(/\$\$([\s\S]+?)\$\$/g, (_, x) => push(x, true));
    t = t.replace(/\\\[([\s\S]+?)\\\]/g, (_, x) => push(x, true));
    t = t.replace(/\$([^\n$]+?)\$/g, (_, x) => push(x, false));
    t = t.replace(/\\\(([\s\S]+?)\\\)/g, (_, x) => push(x, false));

    // Restore code text so markdown-it renders/highlights it normally.
    t = t.replace(/\u0000C(\d+)\u0000/g, (_, i) => code[+i]);
    return { text: t, math };
  }

  /* Render a markdown+math string to HTML. `inline` uses renderInline (no
   * wrapping <p>, for quiz prompts/choices); otherwise full block render.
   * Math is pre-extracted (see extractMath) and swapped to KaTeX afterward,
   * exactly as the main board does — so quiz text supports `$..$`, `$$..$$`,
   * `code`, and emphasis with the same fidelity as the board body. */
  function renderRich(src, inline) {
    const { text, math } = extractMath(src);
    const html = inline ? md.renderInline(text) : md.render(text);
    return html.replace(MATH_RE, (_, i) => {
      const m = math[+i];
      if (!m) return "";
      if (window.katex) {
        try {
          return window.katex.renderToString(
            m.tex,
            Object.assign({ displayMode: m.display }, katexOpts),
          );
        } catch (e) {
          return '<span class="sb-error">' + md.utils.escapeHtml(String(e)) + "</span>";
        }
      }
      return md.utils.escapeHtml(m.tex);
    });
  }

  function render(raw) {
    try {
      patch(renderRich(raw, false));
      hydrateWidgets(contentEl);
      return true;
    } catch (e) {
      contentEl.innerHTML =
        '<div class="sb-error">render error: ' +
        (md ? md.utils.escapeHtml(String(e)) : String(e)) +
        "</div>";
      return false;
    }
  }

  /* ---- multi-board tabs ----------------------------------------------------
   * One server serves every board under the project's .tutor-canvas/ dir. We
   * poll /boards for the list (name + mtime), render a tab bar, and by default
   * AUTO-FOLLOW whichever board was most recently updated — the natural flow
   * when a tutoring session is actively pushing to one board. Clicking a tab
   * pins your view to that board (so you can read an older board while pushes
   * continue elsewhere); other boards then show a "updated" dot instead of
   * stealing focus. */
  const boardsEl = document.getElementById("boards");
  let activeBoard = null;       // board whose content is currently shown
  let manualPin = false;        // true once the user clicks a tab
  let boards = [];              // [{name, mtime}] from /boards
  const seenMtime = {};        // last mtime we've shown/acknowledged per board

  function newestBoard() {
    let best = null;
    for (const b of boards) {
      if (!best || b.mtime > best.mtime) best = b;
    }
    return best;
  }

  function renderTabs() {
    if (boards.length <= 1) { boardsEl.hidden = true; boardsEl.innerHTML = ""; return; }
    boardsEl.hidden = false;
    boardsEl.innerHTML = "";
    for (const b of boards) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "sb-tab" + (b.name === activeBoard ? " active" : "");
      tab.textContent = b.name;
      // Dot when a non-active board has changed since we last looked at it.
      if (b.name !== activeBoard && b.mtime > (seenMtime[b.name] || 0)) {
        const dot = document.createElement("span");
        dot.className = "sb-tab-dot";
        tab.appendChild(dot);
      }
      tab.addEventListener("click", () => {
        manualPin = true;
        if (b.name !== activeBoard) setActive(b.name);
      });
      boardsEl.appendChild(tab);
    }
  }

  function setActive(name) {
    activeBoard = name;
    const b = boards.find((x) => x.name === name);
    if (b) seenMtime[name] = b.mtime;
    lastRaw = null; // force a re-render of the new board's content
    renderTabs();
    tick();
  }

  async function pollBoards() {
    try {
      const r = await fetch("/boards?_=" + Date.now());
      if (!r.ok) return;
      const data = await r.json();
      boards = (data.boards || []);
      if (activeBoard === null) {
        // First load: show the most recently updated board (fall back to the
        // server default), so a session resumes the board it was using.
        const start = newestBoard();
        activeBoard = start ? start.name : (data.default || "board");
        const b0 = boards.find((x) => x.name === activeBoard);
        if (b0) seenMtime[activeBoard] = b0.mtime;
      } else if (!manualPin) {
        // Auto-follow: jump to a board that just got newer than what we've seen.
        const newest = newestBoard();
        if (newest && newest.name !== activeBoard &&
            newest.mtime > (seenMtime[newest.name] || 0)) {
          setActive(newest.name);
          return;
        }
      }
      renderTabs();
    } catch (e) { /* leave tabs as-is on a transient error */ }
  }

  async function tick() {
    try {
      const name = activeBoard || "board";
      const r = await fetch("/board.md?name=" + encodeURIComponent(name) +
        "&_=" + Date.now());
      if (!r.ok) throw new Error("HTTP " + r.status);
      const txt = await r.text();
      setStatus("live", "live");
      if (txt !== lastRaw) {
        lastRaw = txt;
        render(txt);
        const b = boards.find((x) => x.name === activeBoard);
        if (b) seenMtime[activeBoard] = b.mtime; // we've now seen this content
      }
    } catch (e) {
      setStatus("stale", "disconnected");
    }
  }

  function boot() {
    if (!window.markdownit) {
      setStatus("error", "assets missing");
      contentEl.innerHTML =
        '<div class="sb-error">Vendored assets failed to load. ' +
        "Run scripts/vendor.sh to populate assets/.</div>";
      return;
    }
    initMarkdown();
    setStatus("connecting", "connecting");
    pollBoards().then(tick);
    setInterval(tick, POLL_MS);
    setInterval(pollBoards, POLL_MS);
  }

  // `defer` scripts run in order before this, but guard anyway.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
