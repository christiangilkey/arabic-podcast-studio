# PyInstaller spec for Arabic Podcast Studio (one-folder build on every platform).
#   pyinstaller packaging/app.spec --noconfirm
# Produces dist/ArabicPodcastStudio/ (Windows, Linux) or dist/Arabic Podcast Studio.app (macOS).

import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules

ROOT = Path(SPECPATH).parent  # noqa: F821 (SPECPATH is injected by PyInstaller)
sys.path.insert(0, str(ROOT))
from app.version import APP_ID, APP_NAME, __version__  # noqa: E402

IS_MAC = sys.platform == "darwin"
IS_WIN = sys.platform == "win32"

datas = [
    (str(ROOT / "web"), "web"),
    (str(ROOT / "licenses"), "licenses"),
    (str(ROOT / "tests" / "fixtures" / "arabic-sample.wav"), "tests/fixtures"),
]
datas += collect_data_files("faster_whisper")  # Silero VAD model (assets/*.onnx)
datas += collect_data_files("webview")

binaries = collect_dynamic_libs("ctranslate2")

hiddenimports = (
    collect_submodules("uvicorn")
    + collect_submodules("app")
    + ["webview.platforms.edgechromium" if IS_WIN else "webview.platforms.cocoa" if IS_MAC else "webview.platforms.gtk"]
)
if IS_MAC:
    try:
        hiddenimports += collect_submodules("mlx_whisper") + collect_submodules("mlx")
        datas += collect_data_files("mlx_whisper")
        binaries += collect_dynamic_libs("mlx")
        datas += collect_data_files("mlx")
    except Exception:
        pass

excludes = ["tkinter", "matplotlib", "torch", "tensorflow", "IPython", "pytest", "PIL", "hf_xet"]

a = Analysis(  # noqa: F821
    [str(ROOT / "run.py")],
    pathex=[str(ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=excludes,
    noarchive=False,
)
pyz = PYZ(a.pure)  # noqa: F821

icon = str(ROOT / "packaging" / "icons" / ("icon.icns" if IS_MAC else "icon.ico"))

exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name=APP_ID,
    console=False,
    icon=icon,
    upx=False,
)

coll = COLLECT(  # noqa: F821
    exe,
    a.binaries,
    a.datas,
    name=APP_ID,
    upx=False,
)

if IS_MAC:
    app = BUNDLE(  # noqa: F821
        coll,
        name=f"{APP_NAME}.app",
        icon=icon,
        bundle_identifier="io.github.arabicpodcaststudio",
        version=__version__,
        info_plist={
            "CFBundleShortVersionString": __version__,
            "CFBundleVersion": __version__,
            "NSHighResolutionCapable": True,
            "LSMinimumSystemVersion": "12.0",
            "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
        },
    )
