#!/usr/bin/env sh
# Copies the guide resources served by tenbin into reference/ so the
# skill carries the same text when no MCP server is connected. Run after editing
# tenbin/resources/*.md.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
src="$here/../../../tenbin/resources"
dst="$here/../reference"
for f in primitives patterns confidence jaggedness cookbooks suggestions; do
  cp "$src/$f.md" "$dst/$f.md"
  echo "synced $f.md"
done
