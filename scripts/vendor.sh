#!/usr/bin/env bash
# Vendor all third-party web assets into assets/ so the board works fully
# offline with no CDN dependency or version drift.
#
# Pinned versions live in assets/MANIFEST.json (kept in sync with this file).
# Re-run this whenever you bump a version. The downloaded files are committed
# to the repo so end users never need to run it.
#
# Usage:  scripts/vendor.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSETS="$(cd "$HERE/.." && pwd)/assets"
mkdir -p "$ASSETS"

# Pinned versions ----------------------------------------------------------
MARKDOWNIT_VER="14.1.0"
KATEX_VER="0.16.11"
TEXMATH_VER="1.0.0"
HLJS_VER="11.10.0"
MERMAID_VER="11.4.1"

JSD="https://cdn.jsdelivr.net/npm"

fetch() {
  local url="$1" dest="$2"
  echo "  -> $dest"
  curl -fsSL "$url" -o "$ASSETS/$dest"
}

echo "Vendoring tutor-canvas assets into $ASSETS"

# markdown-it (UMD build exposes window.markdownit)
fetch "$JSD/markdown-it@${MARKDOWNIT_VER}/dist/markdown-it.min.js" "markdown-it.min.js"

# KaTeX: JS + CSS + fonts
fetch "$JSD/katex@${KATEX_VER}/dist/katex.min.js" "katex.min.js"
fetch "$JSD/katex@${KATEX_VER}/dist/katex.min.css" "katex.min.css"

# KaTeX fonts referenced by katex.min.css (url(fonts/...)).
mkdir -p "$ASSETS/fonts"
FONTS=$(curl -fsSL "$JSD/katex@${KATEX_VER}/dist/katex.min.css" \
  | grep -oE 'fonts/[A-Za-z0-9_.-]+\.(woff2|woff|ttf)' | sort -u)
for f in $FONTS; do
  echo "  -> $f"
  curl -fsSL "$JSD/katex@${KATEX_VER}/dist/$f" -o "$ASSETS/$f"
done

# markdown-it-texmath (UMD build exposes window.texmath)
fetch "$JSD/markdown-it-texmath@${TEXMATH_VER}/texmath.js" "texmath.min.js"

# highlight.js core + a dark theme
fetch "$JSD/@highlightjs/cdn-assets@${HLJS_VER}/highlight.min.js" "highlight.min.js"
fetch "$JSD/@highlightjs/cdn-assets@${HLJS_VER}/styles/github-dark.min.css" "highlight-github-dark.min.css"

# Mermaid (UMD build exposes window.mermaid)
fetch "$JSD/mermaid@${MERMAID_VER}/dist/mermaid.min.js" "mermaid.min.js"

# Write the manifest.
cat > "$ASSETS/MANIFEST.json" <<JSON
{
  "markdown-it": "${MARKDOWNIT_VER}",
  "katex": "${KATEX_VER}",
  "markdown-it-texmath": "${TEXMATH_VER}",
  "highlight.js": "${HLJS_VER}",
  "mermaid": "${MERMAID_VER}",
  "source": "cdn.jsdelivr.net/npm",
  "note": "Vendored for offline use; committed to the repo so end users need no network."
}
JSON

echo "Done. Assets vendored. Total size:"
du -sh "$ASSETS"
