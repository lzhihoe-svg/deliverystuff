#!/bin/bash
# UI test: runs Index.html in headless Chromium against a mocked Apps Script backend.
# Needs: npm i playwright (with a chromium available), python3.
set -e
cd "$(dirname "$0")"
{ echo '<!doctype html><meta charset="utf-8"><script src="mock.js"></script>'; cat ../../Index.html; echo '<script src="hooks.js"></script>'; } > test.html
python3 -m http.server 8899 >/dev/null 2>&1 &
SERVER=$!
trap "kill $SERVER" EXIT
sleep 1
node uitest.js
