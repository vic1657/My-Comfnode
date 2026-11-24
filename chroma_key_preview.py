"""实时预览色度抠图（MyChromaKeyPreview）

滑块参数（强度/阴影/边缘羽化/边缘清除）与剪映一致。
JS 前端把抠图算法移植到浏览器内，拖动滑块即时在节点画布重绘预览；
Python 端按当前滑块值执行同样的引擎，输出正式全分辨率结果。

首次执行后，前端会缓存输入图（temp 目录），此后拖滑块即为纯本地实时预览。
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

import folder_paths
import numpy as np
import torch
from PIL import Image

_engine_mod = None


def _load_engine():
    global _engine_mod
    if _engine_mod is None:
        root = Path(__file__).resolve().parent
        spec = importlib.util.spec_from_file_location(
            "_my_comfnode_chroma_key_preview_engine", root / "chroma_key.py"
        )
        mod = importlib.util.module_from_spec(spec)
        sys.modules["_my_comfnode_chroma_key_preview_engine"] = mod
        spec.loader.exec_module(mod)
        _engine_mod = mod
    return _engine_mod


class MyChromaKeyPreview:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "绿幕/纯色背景原图"}),
                "强度": ("INT", {"default": 17, "min": 0, "max": 100, "step": 1,
                                    "display": "slider", "tooltip": "主容差，越大抠得越狠"}),
                "阴影": ("INT", {"default": 31, "min": 0, "max": 100, "step": 1,
                                    "display": "slider", "tooltip": "暗部豁免键控范围，保护黑毛/深色物体"}),
                "边缘羽化": ("INT", {"default": 18, "min": 0, "max": 100, "step": 1,
                                        "display": "slider", "tooltip": "遮罩羽化半径"}),
                "边缘清除": ("INT", {"default": 33, "min": 0, "max": 100, "step": 1,
                                        "display": "slider", "tooltip": "遮罩收缩+边缘实化+去灰边"}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "execute"
    OUTPUT_NODE = True
    CATEGORY = "My-Comfnode/图像"
    DESCRIPTION = (
        "实时预览色度抠图：拖动滑块即可在节点内画布实时预览（浏览器端运算），"
        "执行时按当前滑块值输出正式全分辨率结果。"
    )

    def execute(self, image, 强度=17, 阴影=31, 边缘羽化=18, 边缘清除=33):
        engine = _load_engine()

        # 1. 保存输入图到 temp，供前端 JS 预览加载
        temp_dir = folder_paths.get_temp_directory()
        os.makedirs(temp_dir, exist_ok=True)
        src_name = "my_chroma_preview_src.png"
        arr0 = (image[0].detach().cpu().numpy() * 255.0 + 0.5).clip(0, 255).astype(np.uint8)
        Image.fromarray(arr0[..., :3]).save(os.path.join(temp_dir, src_name))

        # 2. 引擎执行（与前端 JS 使用同一套参数映射）
        key = _MyChromaKeyPreviewParams(强度, 阴影, 边缘羽化, 边缘清除)
        s = min(1.0, max(0.0, 强度 / 100.0))
        t = min(1.0, s / 0.12)
        gate = t * t * (3 - 2 * t)          # 强度总闸门：0=完全不键控
        engine_obj = engine.MyChromaKey()
        out, mask = engine_obj.key_out(
            image,
            key_mode="自动检测边缘背景色",
            key_color="#00B140",
            tolerance=key["tolerance"],
            softness=0.25,
            mask_shrink=key["mask_shrink"],
            mask_blur=key["mask_blur"],
            shadow=key["shadow"],
            edge_solid=key["edge_solid"],
            despill=True,
            despill_strength=key["despill_strength"],
            rgb_key=key["rgb_key"],
            hole_fill=50,
        )
        mask = 1.0 - (1.0 - mask) * gate
        out = out.clone()
        out[..., 3] = mask

        # 3. 保存输出 RGBA 到 temp（前端亦可选用）
        out_arr = (out.detach().cpu().numpy() * 255.0 + 0.5).clip(0, 255).astype(np.uint8)
        out_name = "my_chroma_preview_out.png"
        Image.fromarray(out_arr[0], "RGBA").save(os.path.join(temp_dir, out_name))

        return {
            "ui": {
                "images": [{"filename": out_name, "subfolder": "", "type": "temp"}],
                "src_image": [{"filename": src_name, "subfolder": "", "type": "temp"}],
            },
            "result": (out, mask),
        }


def _MyChromaKeyPreviewParams(强度, 阴影, 边缘羽化, 边缘清除):
    s = 强度 / 100.0
    shadow_eff = (阴影 / 100.0) * (1.0 - 0.55 * s)   # 阴影保护随强度收窄
    return {
        "tolerance": 0.05 + s * 1.6,
        "shadow": shadow_eff,
        "mask_blur": 2,
        # 边缘羽化=向内侵蚀（剪映语义）+ 边缘清除=choke
        "mask_shrink": round((边缘羽化 / 100.0) * 20 + (边缘清除 / 100.0) * 10),
        "edge_solid": min(1.0, 0.45 + (边缘清除 / 100.0) * 0.55),
        "despill_strength": min(1.0, (边缘清除 / 100.0) * 3.0),
        "rgb_key": s ** 1.2,
    }


NODE_CLASS_MAPPINGS = {"MyChromaKeyPreview": MyChromaKeyPreview}
NODE_DISPLAY_NAME_MAPPINGS = {"MyChromaKeyPreview": "My实时预览色度抠图"}
