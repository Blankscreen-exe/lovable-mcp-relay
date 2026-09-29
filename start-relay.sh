#!/usr/bin/env sh
# Starts the Lovable MCP relay and opens its setup page.
# Leave this running while you use Claude Code.
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js is required. Install it from https://nodejs.org"; exit 1; }
exec node src/relay.mjs --open
