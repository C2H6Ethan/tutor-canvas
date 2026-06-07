/* study-board live renderer.
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
  function renderDiagram(specText) {
    const spec = JSON.parse(specText);
    const w = spec.w || 420, h = spec.h || 300;
    const Y = (y) => h - y;            // flip to SVG (y-down)
    const parts = [];
    const stroke = (col, sw, dash) =>
      'stroke="' + diagColor(col) + '" stroke-width="' + (sw || 2) + '"' +
      (dash ? ' stroke-dasharray="6 4"' : "");

    // ground line
    if (spec.ground) {
      const gy = spec.ground === true ? h / 2 : spec.ground;
      parts.push('<line x1="0" y1="' + Y(gy) + '" x2="' + w + '" y2="' + Y(gy) +
        '" ' + stroke("#3a4150", 2) + "/>");
    }
    // free segments: {a:[x,y], b:[x,y], color?, dash?, width?}
    (spec.segments || []).forEach((s) => {
      parts.push('<line x1="' + s.a[0] + '" y1="' + Y(s.a[1]) + '" x2="' +
        s.b[0] + '" y2="' + Y(s.b[1]) + '" ' + stroke(s.color, s.width, s.dash) + "/>");
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
      const ah = 10, aw = 5;
      const ux = Math.cos(a), uy = Math.sin(a), px = -uy, py = ux;
      const bx = ex - ah * ux, by = ey - ah * uy;
      const p1 = ex + "," + Y(ey);
      const p2 = (bx + aw * px) + "," + Y(by + aw * py);
      const p3 = (bx - aw * px) + "," + Y(by - aw * py);
      parts.push('<polygon points="' + p1 + " " + p2 + " " + p3 +
        '" fill="' + col + '"/>');
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

  function render(raw) {
    try {
      const { text, math } = extractMath(raw);
      let html = md.render(text);
      html = html.replace(MATH_RE, (_, i) => {
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
      patch(html);
      return true;
    } catch (e) {
      contentEl.innerHTML =
        '<div class="sb-error">render error: ' +
        (md ? md.utils.escapeHtml(String(e)) : String(e)) +
        "</div>";
      return false;
    }
  }

  async function tick() {
    try {
      const r = await fetch("/board.md?_=" + Date.now());
      if (!r.ok) throw new Error("HTTP " + r.status);
      const txt = await r.text();
      setStatus("live", "live");
      if (txt !== lastRaw) {
        lastRaw = txt;
        render(txt);
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
    tick();
    setInterval(tick, POLL_MS);
  }

  // `defer` scripts run in order before this, but guard anyway.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
