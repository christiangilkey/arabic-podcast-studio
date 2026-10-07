"""Runtime hardware detection and engine/model recommendation."""

from __future__ import annotations

import ctypes
import logging
import os
import platform
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass
from functools import lru_cache
from typing import Any

from . import gpu_libs

log = logging.getLogger(__name__)


@dataclass
class Hardware:
    os: str
    arch: str
    cpu: str
    cpu_cores: int
    ram_gb: float
    apple_silicon: bool
    nvidia_gpu: str | None
    nvidia_vram_gb: float | None
    cuda_libs_ready: bool
    gpu_pack_supported: bool

    @property
    def engine(self) -> str:
        # APS_ENGINE=faster-whisper forces the CTranslate2 engine (e.g. on a Mac where MLX misbehaves).
        if os.environ.get("APS_ENGINE") == "faster-whisper":
            return "faster-whisper"
        return "mlx" if self.apple_silicon else "faster-whisper"

    @property
    def device(self) -> str:
        if self.engine == "mlx":
            return "metal"
        if self.nvidia_gpu and self.cuda_libs_ready:
            return "cuda"
        return "cpu"

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d.update(engine=self.engine, device=self.device, recommended=recommend_model(self),
                 recommendation_reason=recommendation_reason(self))
        return d


def _ram_gb() -> float:
    try:
        if sys.platform == "win32":
            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("sullAvailExtendedVirtual", ctypes.c_ulonglong)]
            stat = MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
            return stat.ullTotalPhys / 2**30
        if sys.platform == "darwin":
            out = subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=5)
            return int(out.stdout.strip()) / 2**30
        with open("/proc/meminfo") as fh:
            for line in fh:
                if line.startswith("MemTotal:"):
                    return int(line.split()[1]) / 2**20
    except Exception:
        log.debug("RAM detection failed", exc_info=True)
    return 0.0


def _cpu_name() -> str:
    try:
        if sys.platform == "darwin":
            out = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True, timeout=5)
            if out.stdout.strip():
                return out.stdout.strip()
        elif sys.platform.startswith("linux"):
            with open("/proc/cpuinfo") as fh:
                for line in fh:
                    if line.startswith("model name"):
                        return line.split(":", 1)[1].strip()
        elif sys.platform == "win32":
            import winreg

            key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0")
            return str(winreg.QueryValueEx(key, "ProcessorNameString")[0]).strip()
    except Exception:
        pass
    return platform.processor() or platform.machine()


def _nvidia() -> tuple[str | None, float | None]:
    """Name and VRAM of the first NVIDIA GPU, via nvidia-smi (installed with the driver)."""
    exe = shutil.which("nvidia-smi")
    if exe is None and sys.platform == "win32":
        candidate = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "nvidia-smi.exe")
        exe = candidate if os.path.exists(candidate) else None
    if exe is None:
        return _nvidia_via_ctranslate2()
    try:
        flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0  # type: ignore[attr-defined]
        out = subprocess.run(
            [exe, "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10, creationflags=flags,
        )
        line = out.stdout.strip().splitlines()[0]
        name, mem = [p.strip() for p in line.split(",")[:2]]
        return name, round(float(mem) / 1024, 1)
    except Exception:
        return _nvidia_via_ctranslate2()


def _nvidia_via_ctranslate2() -> tuple[str | None, float | None]:
    """Fallback when nvidia-smi is missing or fails: ask the CUDA driver through CTranslate2."""
    try:
        import ctranslate2

        if ctranslate2.get_cuda_device_count() > 0:
            return "NVIDIA GPU", None
    except Exception:
        pass
    return None, None


@lru_cache(maxsize=1)
def _static() -> tuple[str, str, int, float, bool, str | None, float | None]:
    apple = sys.platform == "darwin" and platform.machine() == "arm64"
    gpu, vram = (None, None) if sys.platform == "darwin" else _nvidia()
    return _cpu_name(), platform.machine(), os.cpu_count() or 1, round(_ram_gb(), 1), apple, gpu, vram


def detect() -> Hardware:
    cpu, arch, cores, ram, apple, gpu, vram = _static()
    return Hardware(
        os={"win32": "Windows", "darwin": "macOS"}.get(sys.platform, "Linux"),
        arch=arch,
        cpu=cpu,
        cpu_cores=cores,
        ram_gb=ram,
        apple_silicon=apple,
        nvidia_gpu=gpu,
        nvidia_vram_gb=vram,
        cuda_libs_ready=bool(gpu) and gpu_libs.ready(),
        gpu_pack_supported=bool(gpu) and gpu_libs.supported(),
    )


def recommend_model(hw: Hardware) -> str:
    if hw.apple_silicon:
        return "large-v3" if hw.ram_gb >= 16 else "medium" if hw.ram_gb >= 8 else "small"
    if hw.nvidia_gpu and (hw.nvidia_vram_gb or 0) >= 6:
        return "large-v3"
    if hw.nvidia_gpu and (hw.nvidia_vram_gb is None or hw.nvidia_vram_gb >= 3):
        return "medium"  # unknown VRAM: medium fits on almost any CUDA-capable card
    # CPU: large-v3 is accurate but runs at roughly real time; medium is the usual sweet spot.
    if hw.cpu_cores >= 8 and hw.ram_gb >= 12:
        return "medium"
    return "small" if hw.ram_gb < 8 else "medium"


def recommendation_reason(hw: Hardware) -> str:
    rec = recommend_model(hw)
    if hw.apple_silicon:
        return f"Apple Silicon detected. {rec} runs on the Mac's GPU with MLX."
    if hw.nvidia_gpu:
        vram = f" ({hw.nvidia_vram_gb} GB)" if hw.nvidia_vram_gb else ""
        base = f"{hw.nvidia_gpu}{vram} detected."
        if hw.cuda_libs_ready:
            return f"{base} {rec} runs fast on the GPU."
        return f"{base} Install GPU acceleration (below) and {rec} will run many times faster than on the CPU."
    return f"No supported GPU found, so transcription runs on the CPU. {rec} balances accuracy and speed."
