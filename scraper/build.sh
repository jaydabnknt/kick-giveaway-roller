#!/bin/sh
# Builds the Chrome and Firefox versions of the one-time slot scraper into ../
set -e
cd "$(dirname "$0")"
rm -rf /tmp/tbscr && mkdir -p /tmp/tbscr/chrome /tmp/tbscr/firefox
FILES="main.js scrape.js popup.html popup.js export.html export.js icon.png seed.js"
cp $FILES manifest.json /tmp/tbscr/chrome/
cp $FILES /tmp/tbscr/firefox/
python3 - <<'PY'
import json
m = json.load(open("manifest.json"))
m["browser_specific_settings"] = {"gecko": {"id": "toolbot-scraper@toolbott.pages.dev", "strict_min_version": "128.0"}}
json.dump(m, open("/tmp/tbscr/firefox/manifest.json", "w"), indent=2)
PY
here=$(pwd)
rm -f ../toolbot-scraper-chrome.zip ../toolbot-scraper-firefox.zip
(cd /tmp/tbscr/chrome && zip -qr "$here/../toolbot-scraper-chrome.zip" .)
(cd /tmp/tbscr/firefox && zip -qr "$here/../toolbot-scraper-firefox.zip" .)
echo built
