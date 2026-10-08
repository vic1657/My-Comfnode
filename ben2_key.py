"""BEN2 Base 抠图（MIT 许可，可商用）

来源: https://github.com/PramaLLC/BEN2 (MIT，Base 模型开源)
使用本地已有权重 models/RMBG/BEN2/BEN2_Base.pth（约 1.1GB），
模型类来自官方 BEN2.py（本目录 ben2_model.py 副本）。
带 Confidence Guided Matting 精修，毛发边缘好。
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import folder_paths
import numpy as np
import torch
from PIL import Image

_model = None
_device = None


def _get_model():
    global _model, _device
    if _model is None:
        root = Path(__file__).resolve().parent
        spec = importlib.util.spec_from_file_location(
            "_my_comfnode_ben2_model", root / "ben2_model.py"
        )
        mod = importlib.util.module_from_spec(spec)
        sys.modules["_my_comfnode_ben2_model"] = mod
        spec.loader.exec_module(mod)

        ckpt = Path(folder_paths.models_dir) / "RMBG" / "BEN2" / "BEN2_Base.pth"
        if not ckpt.exists():
            raise FileNotFoundError(f"未找到 BEN2 权重: {ckpt}")
        _device = "cuda" if torch.cuda.is_available() else "cpu"
        _model = mod.BEN_Base().to(_device).eval()
        _model.loadcheckpoints(str(ckpt))
    return _model, _device


class MyBEN2Key:
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
        "BEN2 Base AI 抠图（MIT 可商用）：带置信度引导精修，"
        "毛发边缘好。使用本地权重，无需下载。"
    )

    def remove(self, image):
        model, device = _get_model()
        outs = []
        for i in range(image.shape[0]):
            arr = (image[i].detach().cpu().numpy() * 255.0 + 0.5).clip(0, 255).astype(np.uint8)
            pil = Image.fromarray(arr[..., :3]).convert("RGB")
            with torch.no_grad():
                res = model.inference(pil, refine_foreground=False)
            # Easy-Use 分支的 inference 返回 (mask, 带alpha的原图) 元组
            rgba_pil = (res[1] if isinstance(res, tuple) else res).convert("RGBA")
            rgba = np.asarray(rgba_pil.resize(pil.size)).astype(np.float32) / 255.0
            outs.append(rgba)  # 4 通道 RGBA
        out = torch.from_numpy(np.stack(outs)).to(image.device, image.dtype)
        mask = out[..., 3].clamp(0.0, 1.0)
        return (out, mask)


NODE_CLASS_MAPPINGS = {"MyBEN2Key": MyBEN2Key}
NODE_DISPLAY_NAME_MAPPINGS = {"MyBEN2Key": "MyBEN2抠图(AI)"}
