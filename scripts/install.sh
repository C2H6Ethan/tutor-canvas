#!/usr/bin/env bash
# Install study-board as a user-level Claude Code skill.
#
#   1. Vendor web assets if assets/ is empty (needs network once).
#   2. Ensure ~/.claude/skills/ exists.
#   3. Symlink ~/.claude/skills/study-board -> this repo.
#
# Refuses to clobber a pre-existing, non-symlink skill of the same name.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILLS_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
LINK="$SKILLS_DIR/study-board"

echo "study-board repo: $REPO"

# 1. Assets ----------------------------------------------------------------
if [ -z "$(ls -A "$REPO/assets" 2>/dev/null | grep -v MANIFEST.json || true)" ]; then
  echo "assets/ empty -> vendoring (needs network)…"
  bash "$REPO/scripts/vendor.sh"
else
  echo "assets/ already populated -> skipping vendor."
fi

# 2. Skills dir ------------------------------------------------------------
mkdir -p "$SKILLS_DIR"

# 3. Symlink ---------------------------------------------------------------
if [ -L "$LINK" ]; then
  cur="$(readlink "$LINK")"
  if [ "$cur" = "$REPO" ]; then
    echo "Already installed: $LINK -> $REPO"
    exit 0
  fi
  echo "Updating existing symlink ($cur -> $REPO)"
  ln -sfn "$REPO" "$LINK"
elif [ -e "$LINK" ]; then
  echo "ERROR: $LINK exists and is not a symlink to this repo."
  echo "Refusing to overwrite an unrelated skill. Resolve manually."
  exit 1
else
  ln -s "$REPO" "$LINK"
  echo "Installed: $LINK -> $REPO"
fi

echo "Done. Verify with:"
echo "  python3 \"$LINK/scripts/board.py\" start"
