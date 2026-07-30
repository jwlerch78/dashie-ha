#!/usr/bin/env bash
# Point git at this repo's tracked hooks (scripts/hooks/) instead of the
# untracked .git/hooks/. Run once per clone:
#
#     ./scripts/install-hooks.sh
#
# Idempotent. Undo with: git config --unset core.hooksPath

set -euo pipefail
cd "$(dirname "$0")/.."

git config core.hooksPath scripts/hooks
chmod +x scripts/hooks/* scripts/check-generated-tree.sh 2>/dev/null || true

echo "✅ hooks installed (core.hooksPath = scripts/hooks)"
echo "   active: pre-commit → check-generated-tree.sh"
echo "           refuses hand-edits to dashie-ha-dev/ and */integration/,"
echo "           which a release rebuilds destructively."
