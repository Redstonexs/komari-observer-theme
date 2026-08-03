#!/usr/bin/env bash
#
# Builds and packages the theme ZIP. Mirrors what CI does, so a package built
# here is byte-for-byte the same shape as a release artifact.
#
# The archive layout is load-bearing: Komari looks for the manifest at the entry
# name "komari-theme.json" exactly, so wrapping the package in a top-level
# folder makes the upload fail with a confusing error.
#
#   theme.zip
#   ├── komari-theme.json
#   ├── preview.png
#   └── dist/...

set -euo pipefail

cd "$(dirname "$0")/.."

NAME="komari-theme-observer"
STAGE="theme-package"
ZIP="${NAME}.zip"

echo "==> Building"
if command -v pnpm >/dev/null 2>&1; then
  pnpm build
else
  npm run build
fi

echo "==> Verifying package contract"
node scripts/verify-dist.mjs

echo "==> Staging"
rm -rf "$STAGE" "$ZIP"
mkdir -p "$STAGE"
cp komari-theme.json "$STAGE/"
cp preview.png "$STAGE/"
cp -r dist "$STAGE/dist"

echo "==> Zipping"
# Zip the staged directory's CONTENTS so the manifest lands at the archive root
# — Komari looks up the entry name "komari-theme.json" exactly.
if command -v zip >/dev/null 2>&1; then
  (cd "$STAGE" && zip -qr "../$ZIP" .)
  echo "$ZIP"
else
  # No `zip` binary: fall back to the bundled writer, which also produces a
  # reproducible archive.
  node scripts/make-zip.mjs "$ZIP" "$STAGE"
fi
rm -rf "$STAGE"

echo
echo "✓ $ZIP  ($(sha256sum "$ZIP" | cut -c1-16)…)"
echo "Upload via the Komari admin panel: Settings → Themes → Upload."
