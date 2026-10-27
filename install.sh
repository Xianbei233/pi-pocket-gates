#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="${PI_POCKET_EXTENSIONS:-$HOME/.pi-pocket/extensions}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$DEST"

if [ -f "$DEST/pi-pocket-gates.ts" ]; then
  cp -a "$DEST/pi-pocket-gates.ts" "$DEST/pi-pocket-gates.ts.bak.$STAMP"
fi
if [ -d "$DEST/pi-pocket-gates" ]; then
  cp -a "$DEST/pi-pocket-gates" "$DEST/pi-pocket-gates.bak.$STAMP"
fi

cp -a "$HERE/pi-pocket-gates.ts" "$DEST/pi-pocket-gates.ts"
mkdir -p "$DEST/pi-pocket-gates"
cp -a "$HERE/pi-pocket-gates/index.js" "$DEST/pi-pocket-gates/index.js"
cp -a "$HERE/pi-pocket-gates/style.css" "$DEST/pi-pocket-gates/style.css"

echo "装好了：$DEST/pi-pocket-gates.ts"
echo "下一步：在 Pocket 扩展页启用它，或重启 pocket 服务。"
