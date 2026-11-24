from __future__ import annotations

import base64
import io
import re

import numpy as np
import torch
from PIL import Image


_HEX_COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")
_DEFAULT_COLOR = "#FFFFFF"


def _normalize_color(value: str) -> str:
    candidate = str(value or "").strip().upper()
    return candidate if _HEX_COLOR.fullmatch(candidate) else _DEFAULT_COLOR


def _color_info(value: str, opacity: float) -> str:
    color = _normalize_color(value)
    alpha = max(0.0, min(1.0, float(opacity)))
    red, green, blue = (int(color[index : index + 2], 16) for index in (1, 3, 5))
    return f"rgba({red}, {green}, {blue}, {alpha:.3f})"


def _decode_render(value: str) -> Image.Image | None:
    if not isinstance(value, str) or not value.startswith("data:image"):
        return None
    try:
        _, payload = value.split(",", 1)
        with Image.open(io.BytesIO(base64.b64decode(payload))) as image:
            return image.convert("RGB").resize((1024, 1024), Image.Resampling.LANCZOS)
    except Exception as exc:
        print(f"[MyCustomLightRender] 渲染图解码失败: {exc}")
        return None


class MyCustomLightRender:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "光源方向": (
                    "FLOAT",
                    {"default": 0.0, "min": -180.0, "max": 180.0, "step": 1.0},
                ),
                "光源高度": (
                    "FLOAT",
                    {"default": 45.0, "min": 5.0, "max": 85.0, "step": 1.0},
                ),
                "光照强度": (
                    "FLOAT",
                    {"default": 1.5, "min": 0.2, "max": 6.0, "step": 0.1},
                ),
                "光源颜色": (
                    "STRING",
                    {"default": _DEFAULT_COLOR, "multiline": False},
                ),
                "颜色透明度": (
                    "FLOAT",
                    {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01},
                ),
                "渲染数据": (
                    "STRING",
                    {"default": "", "multiline": False},
                ),
            }
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("渲染图", "颜色信息")
    FUNCTION = "render"
    CATEGORY = "My-Comfnode/图像处理"
    DESCRIPTION = "实时调整球体光源方向、高度、强度、颜色与透明度，并输出渲染图和颜色文本。"

    def render(
        self,
        光源方向: float,
        光源高度: float,
        光照强度: float,
        光源颜色: str,
        颜色透明度: float,
        渲染数据: str,
    ):
        image = _decode_render(渲染数据)
        if image is None:
            image = Image.new("RGB", (1024, 1024), (255, 255, 255))
        array = np.asarray(image, dtype=np.float32) / 255.0
        return torch.from_numpy(array).unsqueeze(0), _color_info(
            光源颜色, 颜色透明度
        )


NODE_CLASS_MAPPINGS = {
    "MyCustomLightRender": MyCustomLightRender,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MyCustomLightRender": "My自定义光源渲染",
}
