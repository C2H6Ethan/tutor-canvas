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
