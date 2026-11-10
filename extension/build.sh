#!/bin/sh
# Builds the Chrome and Firefox versions of the extension into ../ (served at toolbott.pages.dev).
set -e
cd "$(dirname "$0")"
rm -rf /tmp/tbext && mkdir -p /tmp/tbext/chrome /tmp/tbext/firefox
FILES="background.js stake-main.js stake.js site.js popup.html popup.js icon.png"
cp $FILES manifest.json /tmp/tbext/chrome/
cp $FILES /tmp/tbext/firefox/
python3 - <<'PY'
import json
m = json.load(open("manifest.json"))
m["background"] = {"scripts": ["background.js"]}
m["browser_specific_settings"] = {"gecko": {"id": "toolbot-stake@toolbott.pages.dev", "strict_min_version": "128.0"}}
json.dump(m, open("/tmp/tbext/firefox/manifest.json", "w"), indent=2)
PY
rm -f ../toolbot-stake-chrome.zip ../toolbot-stake-firefox.zip
(cd /tmp/tbext/chrome && zip -qr "$OLDPWD/../toolbot-stake-chrome.zip" .)
(cd /tmp/tbext/firefox && zip -qr "$OLDPWD/../toolbot-stake-firefox.zip" .)
echo built
