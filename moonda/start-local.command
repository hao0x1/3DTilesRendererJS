#!/bin/zsh
set -eu
cd "$(dirname "$0")"
if ! command -v npm >/dev/null 2>&1; then
  print "Install a current Node.js release first, then run this launcher again."
  read "?Press Enter to close."
  exit 1
fi
if [[ ! -d node_modules ]]; then npm ci; fi
npm run build
print "MOONDA will be available at http://127.0.0.1:5183/"
npm run preview -- --port 5183 --strictPort
