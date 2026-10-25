#!/usr/bin/env bash
# Start the OatCycles dev server (opens the app in the browser).
# Extra args go straight to vite, e.g. `./run.sh --no-open` or `./run.sh --port 5174`.
set -euo pipefail

cd "$(dirname "$0")"

# Node comes from Homebrew; make sure it's on PATH even from a bare shell.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if [ ! -d node_modules ]; then
  npm install
fi

exec npm run dev -- "$@"
