from __future__ import annotations

import importlib.util
from pathlib import Path
import sys

import torch
import torch.nn.functional as F


def _load_shared():
    path = Path(__file__).resolve().parent / "element_separation_mask.py"
    name = "_my_element_separation_shared"
    module = sys.modules.get(name)
    if module is not None:
        return module
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


_shared = _load_shared()
_ensure_image = _shared._ensure_image
_match_batches = _shared._match_batches
_match_mask = _shared._match_mask
_resize_nchw = _shared._resize_nchw
_gaussian_blur = _shared._gaussian_blur
_luminance = _shared._luminance
_smoothstep = _shared._smoothstep


def _srgb_to_linear(value: torch.Tensor) -> torch.Tensor:
    return torch.where(
        value <= 0.04045,
        value / 12.92,
        ((value + 0.055) / 1.055).clamp_min(0.0).pow(2.4),
    )


def _analysis_size(height: int, width: int, maximum_edge: int = 1536) -> tuple[int, int]:
    scale = min(1.0, float(maximum_edge) / max(height, width))
    return max(1, int(round(height * scale))), max(1, int(round(width * scale)))


def separate_light_elements(
    original_image: torch.Tensor,
    ai_image: torch.Tensor,
    input_mask: torch.Tensor,
    highlight_strength: float = 1.0,
    weak_light_sensitivity: float = 0.55,
    weak_light_threshold: float = 0.025,
    light_smoothing: float = 3.0,
    mask_feather: float = 1.5,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    original = _ensure_image(original_image, "原图")
    ai = _ensure_image(ai_image, "AI图")
    original, ai = _match_batches(original, ai)
    batch, height, width = ai.shape[:3]
    device = ai.device

    original_rgb = original[..., :3].to(device=device, dtype=torch.float32).clamp(0.0, 1.0)
    ai_rgb = ai[..., :3].to(device=device, dtype=torch.float32).clamp(0.0, 1.0)
    original_nchw = original_rgb.permute(0, 3, 1, 2)
    ai_nchw = ai_rgb.permute(0, 3, 1, 2)
    original_nchw = _resize_nchw(original_nchw, (height, width))
    source_mask = _match_mask(input_mask, batch, height, width, device)

    analysis_height, analysis_width = _analysis_size(height, width)
    analysis_size = (analysis_height, analysis_width)
    original_small = _resize_nchw(original_nchw, analysis_size)
    ai_small = _resize_nchw(ai_nchw, analysis_size)
    mask_small = _resize_nchw(source_mask, analysis_size)

    original_linear = _srgb_to_linear(original_small).clamp(0.0, 1.0)
    ai_linear = _srgb_to_linear(ai_small).clamp(0.0, 1.0)
    original_luma = _luminance(original_linear)
    ai_luma = _luminance(ai_linear)
    original_srgb_luma = _luminance(original_small)
    ai_srgb_luma = _luminance(ai_small)

    sigma_scale = max(analysis_height, analysis_width) / 1536.0
    sigma = max(0.6, float(light_smoothing) * sigma_scale)
    signed_delta = ai_luma - original_luma
    broad_delta = _gaussian_blur(signed_delta, sigma)
    positive_delta = broad_delta.clamp_min(0.0)
    positive_srgb_delta = _gaussian_blur(
        ai_srgb_luma - original_srgb_luma,
        sigma,
    ).clamp_min(0.0)
    relative_gain = _gaussian_blur(
        torch.log(ai_luma + 0.025) - torch.log(original_luma + 0.025),
        sigma,
    ).clamp_min(0.0)

    # 强高光优先：绝对增亮明显，或暗色材质上出现相对增益很高的新增亮边。
    absolute_highlight = _smoothstep(positive_delta, 0.045, 0.15)
    relative_highlight = (
        _smoothstep(relative_gain, 0.16, 0.48)
        * _smoothstep(positive_delta, 0.012, 0.065)
    )
    bright_surface = _smoothstep(ai_luma, 0.38, 0.82)
    strong_score = torch.maximum(absolute_highlight, relative_highlight)
    strong_score = (strong_score * (0.94 + bright_surface * 0.06)).clamp(0.0, 1.0)
    strong_score = (strong_score * max(0.0, min(1.5, float(highlight_strength)))).clamp(0.0, 1.0)

    # 弱光同时参考绝对差异和相对增益；灵敏度越高，越容易保留微弱溶图光照。
    sensitivity = max(0.0, min(1.0, float(weak_light_sensitivity)))
    weak_threshold = max(0.002, min(0.20, float(weak_light_threshold)))
    adaptive_threshold = weak_threshold * (1.35 - sensitivity * 0.70)
    weak_absolute = _smoothstep(
        positive_srgb_delta,
        adaptive_threshold,
        adaptive_threshold + 0.045 + (1.0 - sensitivity) * 0.025,
    )
    weak_relative = (
        _smoothstep(relative_gain, 0.045 + (1.0 - sensitivity) * 0.055, 0.22)
        * _smoothstep(
            positive_srgb_delta,
            adaptive_threshold * 0.45,
            adaptive_threshold + 0.025,
        )
    )
    weak_score = torch.maximum(weak_absolute, weak_relative)
    weak_score = (weak_score * sensitivity).clamp(0.0, 1.0)

    light_score_small = torch.maximum(strong_score, weak_score) * mask_small
    strong_small = strong_score * mask_small
    weak_only_small = (weak_score * (1.0 - strong_score)).clamp(0.0, 1.0) * mask_small

    light_score = _resize_nchw(light_score_small, (height, width)).clamp(0.0, 1.0)
    strong_full = _resize_nchw(strong_small, (height, width)).clamp(0.0, 1.0)
    weak_full = _resize_nchw(weak_only_small, (height, width)).clamp(0.0, 1.0)
    if mask_feather > 0.05:
        feather = max(0.0, float(mask_feather))
        light_score = _gaussian_blur(light_score, feather).clamp(0.0, 1.0)
        strong_full = _gaussian_blur(strong_full, feather).clamp(0.0, 1.0)
        weak_full = _gaussian_blur(weak_full, feather).clamp(0.0, 1.0)

    light_mask = (source_mask * light_score).clamp(0.0, 1.0)
    keep_mask = (source_mask * (1.0 - light_score)).clamp(0.0, 1.0)
    debug = torch.cat(
        (
            torch.maximum(strong_full, weak_full * 0.90),
            weak_full * 0.78,
            strong_full * 0.12,
        ),
        dim=1,
    ).clamp(0.0, 1.0)
    return keep_mask[:, 0], light_mask[:, 0], debug.permute(0, 2, 3, 1)


class MyLightElementSeparationMask:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "原图": ("IMAGE", {"tooltip": "未经过 AI 打光的原始图像"}),
                "AI图": ("IMAGE", {"tooltip": "经过 AI 打光或溶图后的图像，需与原图位置对应"}),
                "输入遮罩": ("MASK", {"tooltip": "人物或目标区域；只有白色区域会检测新增光照"}),
                "高光识别强度": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.5, "step": 0.01, "display": "slider", "tooltip": "加强 AI 新增高光、亮边和明显受光面的识别"}),
                "弱光灵敏度": ("FLOAT", {"default": 0.55, "min": 0.0, "max": 1.0, "step": 0.01, "display": "slider", "tooltip": "越高越容易检测溶图中的微弱提亮；误识别偏多时调低"}),
                "弱光阈值": ("FLOAT", {"default": 0.025, "min": 0.002, "max": 0.20, "step": 0.002, "display": "slider", "tooltip": "弱光与原图至少需要达到的差异；越低越敏感"}),
                "光照平滑范围": ("FLOAT", {"default": 3.0, "min": 0.5, "max": 12.0, "step": 0.5, "display": "slider", "tooltip": "合并零碎亮点并抑制纹理误识别；弱光不连续时适当调高"}),
                "遮罩羽化": ("FLOAT", {"default": 1.5, "min": 0.0, "max": 12.0, "step": 0.5, "display": "slider", "tooltip": "最终光元素遮罩的边缘羽化"}),
            },
        }

    RETURN_TYPES = ("MASK", "MASK", "IMAGE")
    RETURN_NAMES = ("有效细节遮罩", "AI新增光元素遮罩", "光元素参考图")
    FUNCTION = "separate_light"
    CATEGORY = "My-Comfnode/遮罩"
    DESCRIPTION = "对比原图与 AI 打光图，优先识别新增高光，并通过独立参数补充检测微弱光照。"

    def separate_light(self, original_image=None, ai_image=None, input_mask=None,
                       highlight_strength=1.0, weak_light_sensitivity=0.55,
                       weak_light_threshold=0.025, light_smoothing=3.0,
                       mask_feather=1.5, **kwargs):
        original_image = kwargs.get("原图", original_image)
        ai_image = kwargs.get("AI图", ai_image)
        input_mask = kwargs.get("输入遮罩", input_mask)
        highlight_strength = kwargs.get("高光识别强度", highlight_strength)
        weak_light_sensitivity = kwargs.get("弱光灵敏度", weak_light_sensitivity)
        weak_light_threshold = kwargs.get("弱光阈值", weak_light_threshold)
        light_smoothing = kwargs.get("光照平滑范围", light_smoothing)
        mask_feather = kwargs.get("遮罩羽化", mask_feather)
        return separate_light_elements(
            original_image,
            ai_image,
            input_mask,
            highlight_strength,
            weak_light_sensitivity,
            weak_light_threshold,
            light_smoothing,
            mask_feather,
        )


NODE_CLASS_MAPPINGS = {"MyLightElementSeparationMask": MyLightElementSeparationMask}
NODE_DISPLAY_NAME_MAPPINGS = {"MyLightElementSeparationMask": "My光元素分离遮罩"}
