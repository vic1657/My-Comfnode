# -*- coding: utf-8 -*-
"""
RHGPT2.5（RunningHub GPT Image 2.5 图生图节点）
================================================
调用 RunningHub 标准模型 API 的 GPT Image 2.5 模型：
- 端点：/openapi/v2/rhart-image-g-2.5/flare/image-to-image
- 复用 RH大香蕉 的完整 API 链路（图片上传重试/任务提交/轮询/结果下载）
- 最多 10 张参考图，输出 image / image_url / response
"""

from __future__ import annotations

import json
import os
import sys

import torch

# ---- 复用已加载的 rh_big_banana 模块（RunningHub API 链路）----
_rh = sys.modules.get("_my_comfnode_rh_big_banana")
if _rh is None:
    import importlib.util
    _rh_path = os.path.join(os.path.dirname(__file__), "rh_big_banana.py")
    if os.path.isfile(_rh_path):
        _spec = importlib.util.spec_from_file_location(
            "_my_comfnode_rh_big_banana", _rh_path)
        _rh = importlib.util.module_from_spec(_spec)
        sys.modules["_my_comfnode_rh_big_banana"] = _rh
        _spec.loader.exec_module(_rh)

if _rh is not None:
    # 注册 GPT Image 2.5 端点（运行时注入，不改动原节点文件）
    _rh.CHANNEL_ENDPOINTS["GPT-Image-2.5"] = "rhart-image-g-2.5/flare/image-to-image"

# GPT Image 2.5 支持的宽高比（官方文档枚举）
ASPECT_RATIOS = [
    "auto", "1:1", "2:3", "3:2", "4:5", "5:4", "4:3", "3:4",
    "16:9", "9:16", "21:9", "9:21", "2:1", "1:2", "3:1", "1:3",
]
RESOLUTIONS = ["1k", "2k", "4k"]
GPT25_CHANNEL = "GPT-Image-2.5"


class RHGPT25:
    @classmethod
    def INPUT_TYPES(cls):
        optional = {"images": ("IMAGE", {"tooltip": "第1张参考图"})}
        optional.update(
            {f"image{index}": ("IMAGE", {"tooltip": f"第{index + 1}张参考图"})
             for index in range(1, 10)}
        )
        return {
            "required": {
                "prompt": ("STRING", {"default": "", "multiline": True,
                                       "tooltip": "文本长度 1-20000"}),
                "seed": ("INT", {"default": 0, "min": 0,
                                  "max": 0xFFFFFFFFFFFFFFFF,
                                  "control_after_generate": True}),
                "aspectRatio": (ASPECT_RATIOS, {"default": "auto"}),
                "resolution": (RESOLUTIONS, {"default": "2k"}),
                "skip_error": ("BOOLEAN", {"default": False}),
                "API_KEY": ("STRING", {"default": "", "password": True}),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("IMAGE", "STRING", "STRING")
    RETURN_NAMES = ("image", "image_url", "response")
    FUNCTION = "generate"
    OUTPUT_NODE = True
    CATEGORY = "My-Comfnode/API"
    DESCRIPTION = (
        "调用 RunningHub 标准模型 API 的 GPT Image 2.5 图生图，"
        "最多 10 张参考图，原图长边不限制。需要企业级-共享 API Key。"
    )

    async def generate(
        self,
        prompt,
        seed,
        aspectRatio,
        resolution,
        skip_error,
        API_KEY,
        **kwargs,
    ):
        del seed
        values = [kwargs.get("images")] + [kwargs.get(f"image{index}") for index in range(1, 10)]
        try:
            image_bytes = _rh._collect_images(values)
            return await _rh._run_runninghub(
                str(API_KEY or "").strip(),
                prompt,
                aspectRatio,
                resolution,
                image_bytes,
                GPT25_CHANNEL,
            )
        except Exception as exc:
            if not skip_error:
                raise
            fallback = torch.zeros((1, 64, 64, 3), dtype=torch.float32)
            response = json.dumps(
                {"status": "ERROR", "errorMessage": str(exc)},
                ensure_ascii=False, indent=2,
            )
            return fallback, "", response


NODE_CLASS_MAPPINGS = {
    "RHGPT25": RHGPT25,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "RHGPT25": "RHGPT2.5",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
