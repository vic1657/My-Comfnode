"""InSPyReNet 显著目标检测抠图（MIT 许可，可商用）

来源: https://github.com/plemeri/InSPyReNet (MIT)
通过官方 transparent-background 包加载（本环境已安装 1.3.4）。
高分辨率显著目标检测，毛发软边表现优秀。
"""

from __future__ import annotations

import sys

import numpy as np
import torch
from PIL import Image

_remover = None


def _get_remover():
    global _remover
    if _remover is None:
        # 本环境 cupy 的 nvrtc DLL 损坏且抛 RuntimeError 不被 ImportError 兜底，
        # 屏蔽掉强制走 pyopencl/pymatting CPU 后端
        try:
            import pymatting.foreground  # noqa: F401
            sys.modules["pymatting.foreground.estimate_foreground_ml_cupy"] = None
        except Exception:
            pass
        from transparent_background import Remover
        device = "cuda" if torch.cuda.is_available() else "cpu"
        _remover = Remover(device=device)
    return _remover


class MyInSPyReKey:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "待抠图图像"}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "remove"
    CATEGORY = "My-Comfnode/图像"
    DESCRIPTION = (
        "InSPyReNet AI 抠图（MIT 可商用）：高分辨率显著目标检测，"
        "毛发软边表现优秀。首次运行会自动下载模型权重。"
    )

    def remove(self, image):
        remover = _get_remover()
        outs = []
        for i in range(image.shape[0]):
            arr = (image[i].detach().cpu().numpy() * 255.0 + 0.5).clip(0, 255).astype(np.uint8)
            pil = Image.fromarray(arr[..., :3])
            rgba = np.asarray(remover.process(pil, type="rgba")).astype(np.float32) / 255.0
            outs.append(rgba)  # 4 通道 RGBA
        out = torch.from_numpy(np.stack(outs)).to(image.device, image.dtype)
        mask = out[..., 3].clamp(0.0, 1.0)
        return (out, mask)


NODE_CLASS_MAPPINGS = {"MyInSPyReKey": MyInSPyReKey}
NODE_DISPLAY_NAME_MAPPINGS = {"MyInSPyReKey": "MyInSPyRe抠图(AI)"}
