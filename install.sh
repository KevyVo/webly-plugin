#!/usr/bin/env bash
# Installs the Webly agent skill for Claude Code (~/.claude/skills) and Codex and
# other agents (~/.agents/skills). It does not register the MCP server: the skill
# does that when the person signs in to keep a site.
set -euo pipefail

REPO_BASE="https://raw.githubusercontent.com/Webly-AI/webly-plugin/main/skills/webly"
TARGETS=("${CLAUDE_CONFIG_DIR:-${HOME}/.claude}/skills/webly" "${HOME}/.agents/skills/webly")

die() { echo "error: $1" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || die "requires curl"
command -v node >/dev/null 2>&1 || echo "warning: node (20+) is required to run the skill's helper; install it before publishing" >&2

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/scripts"
curl -fsSL "${REPO_BASE}/SKILL.md" -o "$stage/SKILL.md"
curl -fsSL "${REPO_BASE}/scripts/webly.mjs" -o "$stage/scripts/webly.mjs"
chmod +x "$stage/scripts/webly.mjs"

for target in "${TARGETS[@]}"; do
  # A symlink here belongs to `npx skills`; replace it with a real copy.
  rm -rf "$target"
  mkdir -p "$target"
  cp -R "$stage/." "$target/"
  echo "installed ${target}"
done

echo ""
echo "done - Webly skill installed."
echo "Claude Code picks it up right away (or run /reload-skills); Codex and others load it in a new session."
