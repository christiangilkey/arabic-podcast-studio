"""Start Arabic Podcast Studio.

    python run.py              # native window
    python run.py --browser    # open in your default browser instead
    python run.py --server --port 8790   # server only (development)
    python run.py --smoke-test # headless self-test (used by CI on packaged builds)
"""

from __future__ import annotations

import argparse
import multiprocessing
import sys


def main() -> int:
    multiprocessing.freeze_support()
    parser = argparse.ArgumentParser(description="Arabic Podcast Studio")
    parser.add_argument("--browser", action="store_true", help="open in the default browser instead of a window")
    parser.add_argument("--server", action="store_true", help="run only the local server (no window or browser)")
    parser.add_argument("--port", type=int, default=None, help="fixed port (default: a free one)")
    parser.add_argument("--smoke-test", action="store_true", help="run a headless self-test and exit")
    parser.add_argument("--smoke-audio", default=None, help="audio file for the smoke test")
    args = parser.parse_args()

    if args.smoke_test:
        from app.smoke import run_smoke_test

        return run_smoke_test(args.smoke_audio)

    from app.audio import check_ffmpeg

    ok, message = check_ffmpeg()
    if not ok:
        if sys.stderr is not None:
            print("\n" + "=" * 70 + "\nCannot start: " + message + "\n" + "=" * 70, file=sys.stderr)
        if not getattr(sys, "frozen", False):
            return 1
        # Packaged app: keep going; the UI shows the error banner from /api/status.

    from app.desktop import run

    run(browser=args.browser, port=args.port, headless=args.server)
    return 0


if __name__ == "__main__":
    sys.exit(main())
