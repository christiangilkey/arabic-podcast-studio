#!/usr/bin/env bash
# Build a Linux AppImage from the PyInstaller one-folder build.
#   packaging/linux/make_appimage.sh 0.1.0
# The native window uses the system's WebKitGTK (libwebkit2gtk-4.1, present on most GNOME/KDE
# desktops). Without it, the app opens in the default browser instead.
set -euo pipefail
VERSION="${1:?version required}"
SRC="dist/ArabicPodcastStudio"
APPDIR="dist/AppDir"
OUT="dist/ArabicPodcastStudio-${VERSION}-Linux-x86_64.AppImage"

[ -d "$SRC" ] || { echo "Missing $SRC. Run pyinstaller first." >&2; exit 1; }

rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/lib" "$APPDIR/usr/share/icons/hicolor/256x256/apps" "$APPDIR/usr/share/applications"
cp -R "$SRC" "$APPDIR/usr/lib/ArabicPodcastStudio"
cp packaging/icons/icon-256.png "$APPDIR/usr/share/icons/hicolor/256x256/apps/arabic-podcast-studio.png"
cp packaging/icons/icon-256.png "$APPDIR/arabic-podcast-studio.png"

cat > "$APPDIR/arabic-podcast-studio.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Arabic Podcast Studio
Comment=Study Arabic podcasts with word-level transcripts
Exec=ArabicPodcastStudio
Icon=arabic-podcast-studio
Categories=Education;Languages;AudioVideo;
Terminal=false
EOF
cp "$APPDIR/arabic-podcast-studio.desktop" "$APPDIR/usr/share/applications/"

cat > "$APPDIR/AppRun" <<'EOF'
#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/usr/lib/ArabicPodcastStudio/ArabicPodcastStudio" "$@"
EOF
chmod +x "$APPDIR/AppRun"

TOOL="dist/appimagetool"
if [ ! -x "$TOOL" ]; then
  curl -fsSL -o "$TOOL" "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage"
  chmod +x "$TOOL"
fi
# --appimage-extract-and-run avoids needing FUSE on the build machine.
ARCH=x86_64 "$TOOL" --appimage-extract-and-run "$APPDIR" "$OUT"
echo "Built $OUT"
