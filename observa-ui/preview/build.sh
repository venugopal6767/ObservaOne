#!/bin/sh
# Builds a single-file, server-less preview of the UI (role dashboards work fully, sample data).
# Output: preview/dist/observaone-preview.html
# Needs esbuild:  npm i -g esbuild   (or set ESBUILD=/path/to/esbuild)
set -e
cd "$(dirname "$0")/.."
ESBUILD=${ESBUILD:-esbuild}
OUT=preview/dist
rm -rf "$OUT" && mkdir -p "$OUT"
"$ESBUILD" public/js/app.js --bundle --format=iife --target=es2020 --minify --log-level=warning \
  --define:location.pathname=__ooNav.pathname --define:location.search=__ooNav.search --define:location.origin=__ooNav.origin \
  --define:history.pushState=__ooNav.pushState --define:history.replaceState=__ooNav.replaceState \
  --define:history.back=__ooNav.back --define:history.length=__ooNav.length \
  --outfile="$OUT/app.bundle.js"
{
  echo '<title>ObservaOne Preview</title>'
  echo '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
  echo '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">'
  printf '<style>\n'; cat public/css/app.css; printf '\n</style>\n'
  printf '<div id="app"></div>\n'
  printf '<script>\n'; cat preview/shim.js; printf '\n</script>\n'
  printf '<script>\n'; cat node_modules/chart.js/dist/chart.umd.min.js; printf '\n</script>\n'
  printf '<script>\n'; sed 's#</script#<\\/script#g' "$OUT/app.bundle.js"; printf '\n</script>\n'
} > "$OUT/observaone-preview.html"
rm "$OUT/app.bundle.js"
echo "built $OUT/observaone-preview.html ($(du -h "$OUT/observaone-preview.html" | cut -f1))"
