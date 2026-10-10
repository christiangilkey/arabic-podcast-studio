#!/usr/bin/env bash
# Build the macOS .dmg from the PyInstaller .app bundle.
#   packaging/macos/make_dmg.sh 0.1.0
set -euo pipefail
VERSION="${1:?version required}"
APP="dist/Tamkeen.app"
STAGE="dist/dmg"
OUT="dist/Tamkeen-${VERSION}-macOS-AppleSilicon.dmg"

[ -d "$APP" ] || { echo "Missing $APP. Run pyinstaller first." >&2; exit 1; }

# Ad-hoc signature: Apple Silicon refuses to run completely unsigned code. This is NOT a
# Developer ID signature, so Gatekeeper still warns on first launch (see README).
codesign --force --deep --sign - "$APP"

rm -rf "$STAGE" "$OUT"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
cp README.md "$STAGE/Read Me.md" 2>/dev/null || true
hdiutil create -volname "Tamkeen" -srcfolder "$STAGE" -ov -format UDZO "$OUT"
rm -rf "$STAGE"
echo "Built $OUT"
