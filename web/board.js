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

    // Math via texmath + KaTeX. texmath is exposed as `window.texmath`.
    if (window.texmath && window.katex) {
      md.use(window.texmath, {
        engine: window.katex,
        delimiters: ["dollars", "brackets"], // $..$, $$..$$, \(..\), \[..\]
        katexOptions: {
          throwOnError: false,
          errorColor: "#e0564a",
          macros: { "\\RR": "\\mathbb{R}" },
        },
      });
    }

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

  function render(raw) {
    try {
      const html = md.render(raw);
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
