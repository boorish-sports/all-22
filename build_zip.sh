#!/bin/sh
# Package extension/ for the Chrome Web Store and as the self-hosted fallback.
# One script, one artifact: whatever is uploaded to the store is byte-for-byte
# what goes on the GitHub Release.
set -e
cd "$(dirname "$0")"
V=$(python3 -c "import json;print(json.load(open('extension/manifest.json'))['version'])")
mkdir -p dist
OUT="dist/all-22-film-search-$V.zip"
rm -f "$OUT"
(cd extension && zip -qr -X "../$OUT" . -x '.DS_Store' -x '*/.DS_Store')
python3 -c "import json;json.load(open('extension/manifest.json'))"
node --check extension/panel.js && node --check extension/iso.js && node --check extension/sw.js
echo "$OUT  $(du -h "$OUT" | cut -f1)"
unzip -l "$OUT" | tail -1
