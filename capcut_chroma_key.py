"""剪映式色度抠图（MyChromaKeyCap）

参数面板与剪映「色度抠图」一一对应（强度/阴影/边缘羽化/边缘清除，0-100 滑条），
底层复用 MyChromaKey 的投影键控引擎（投影法 + 阴影保护 + 反混合修色），
遮罩风格对齐剪映：偏实心、窄过渡带、无灰边。

滑条映射：
- 强度   → 主容差（越大抠得越狠）
- 阴影   → 暗部豁免键控的范围
- 边缘羽化 → 遮罩羽化半径
- 边缘清除 → 遮罩收缩 + 边缘实化 + 反混合修色强度
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import torch


def _load_engine():
    root = Path(__file__).resolve().parent
    existing = sys.modules.get("_my_comfnode_chroma_key")
    if existing is not None:
        return existing
    spec = importlib.util.spec_from_file_location(
        "_capcut_chroma_engine", root / "chroma_key.py"
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules["_capcut_chroma_engine"] = mod
    spec.loader.exec_module(mod)
    return mod


_engine = _load_engine()
_MyChromaKey = _engine.MyChromaKey


class MyChromaKeyCap:
    def __init__(self):
        self._engine = _MyChromaKey()

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "绿幕/蓝幕/纯色背景原图"}),
                "key_color": (
                    "STRING",
                    {"default": "自动", "tooltip": "背景色：填 自动 = 自动检测边缘背景色（推荐）；或填 HEX 如 #00B140"},
                ),
                "strength": (
                    "INT",
                    {"default": 17, "min": 0, "max": 100, "step": 1,
                     "tooltip": "强度：主容差，越大抠得越狠。主体被误伤调小，背景残留调大"},
                ),
                "shadow": (
                    "INT",
                    {"default": 31, "min": 0, "max": 100, "step": 1,
                     "tooltip": "阴影：暗部豁免键控的范围，防止黑毛/深色物体被抠透明"},
                ),
                "feather": (
                    "INT",
                    {"default": 18, "min": 0, "max": 100, "step": 1,
                     "tooltip": "边缘羽化：遮罩羽化半径"},
                ),
                "clean": (
                    "INT",
                    {"default": 33, "min": 0, "max": 100, "step": 1,
                     "tooltip": "边缘清除：遮罩收缩 + 边缘实化 + 去灰边，越大边缘越干净锐利"},
                ),
                "despill": (
                    "BOOLEAN",
                    {"default": True, "tooltip": "反混合修色：利用已知背景色消除边缘灰边/绿边"},
                ),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "key_out"
    CATEGORY = "My-Comfnode/图像"
    DESCRIPTION = (
        "剪映式色度抠图：参数与剪映一一对应（强度/阴影/边缘羽化/边缘清除），"
        "底层为投影键控引擎，遮罩风格偏实心、无灰边，效果对齐剪映。"
    )

    def key_out(self, image, key_color="自动", strength=17, shadow=31,
                feather=18, clean=33, despill=True):
        # 滑条 → 引擎参数映射（对齐剪映行为，高灵敏度）
        tolerance = 0.05 + (strength / 100.0) * 1.6
        # 阴影保护范围随强度收窄：强度拉满时暗背景角落也要抠干净，
        # 但黑毛（Y 更低）仍在保护带内
        shadow_eff = (shadow / 100.0) * (1.0 - 0.55 * strength / 100.0)
        # 边缘羽化（剪映语义：往内收）= 向内侵蚀，2px 平滑
        feather_erode = round((feather / 100.0) * 20)
        # 边缘清除 = choke 切残影 + 边缘实化 + 去溢色量
        clean_choke = round((clean / 100.0) * 10)
        edge_solid = min(1.0, 0.45 + (clean / 100.0) * 0.55)
        despill_amt = min(1.0, (clean / 100.0) * 3.0)
        # 强度高档：RGB 距离侵蚀暗部（剪映高强度连黑毛都吃掉的行为）
        rgb_key = (strength / 100.0) ** 1.2

        kc = (key_color or "").strip()
        auto = kc.lower() in ("", "auto", "自动")

        out, mask = self._engine.key_out(
            image,
            key_mode="自动检测边缘背景色" if auto else "自定义颜色",
            key_color="#00B140" if auto else kc,
            tolerance=tolerance,
            softness=0.25,
            mask_shrink=int(feather_erode + clean_choke),
            mask_blur=2,
            shadow=shadow_eff,
            edge_solid=edge_solid,
            despill=despill,
            despill_strength=despill_amt,
            rgb_key=rgb_key,
            hole_fill=50,
        )

        # 强度 = 总闸门：0 时完全不键控（绿幕原样可见），12% 起全力键控
        s = min(1.0, max(0.0, strength / 100.0))
        t = min(1.0, s / 0.12)
        gate = t * t * (3 - 2 * t)
        mask = 1.0 - (1.0 - mask) * gate
        out = out.clone()
        out[..., 3] = mask
        return (out, mask)


NODE_CLASS_MAPPINGS = {"MyChromaKeyCap": MyChromaKeyCap}
NODE_DISPLAY_NAME_MAPPINGS = {"MyChromaKeyCap": "My剪映式色度抠图"}
