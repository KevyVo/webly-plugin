#!/usr/bin/env bash
# Installs the Webly skill for agents that don't use the Claude Code plugin marketplace.
# curl -fsSL https://raw.githubusercontent.com/KevyVo/webly-plugin/main/install.sh | bash
set -euo pipefail

SKILL_DIR="${HOME}/.claude/skills/webly-connect"
REPO_BASE="https://raw.githubusercontent.com/KevyVo/webly-plugin/main/plugins/webly/skills/webly-connect"
MCP_URL="https://api.webly.ai/v1/mcp"

die() {
  echo "error: $1" >&2
  exit 1
}

atomic_download() {
  local tmp
  tmp="$(mktemp "$2.tmp.XXXXXX")"
  curl -fsSL "$1" -o "$tmp" || { rm -f "$tmp"; die "download failed: $1"; }
  mv "$tmp" "$2"
}

echo "Installing Webly skill..."

command -v curl >/dev/null 2>&1 || die "requires curl"
mkdir -p "$SKILL_DIR/scripts"

atomic_download "${REPO_BASE}/SKILL.md" "$SKILL_DIR/SKILL.md"
atomic_download "${REPO_BASE}/scripts/anonymous.mjs" "$SKILL_DIR/scripts/anonymous.mjs"
chmod +x "$SKILL_DIR/scripts/anonymous.mjs"

command -v node >/dev/null 2>&1 || echo "note: deploying without an account needs Node 18+ (not found)"

if command -v claude >/dev/null 2>&1; then
  if claude mcp get webly >/dev/null 2>&1; then
    echo "Webly MCP server already configured"
  else
    claude mcp add --scope user --transport http webly "$MCP_URL"
  fi
else
  echo "Add the MCP server to your agent: ${MCP_URL}"
fi

echo ""
echo "done - Webly skill installed to ${SKILL_DIR}"
echo "restart Claude Code to start using it"
