from __future__ import annotations

import torch
import torch.nn.functional as F


_LUMA_WEIGHTS = (0.2126, 0.7152, 0.0722)
_EPSILON = 1e-6


def _ensure_image(value: torch.Tensor, name: str) -> torch.Tensor:
    if not isinstance(value, torch.Tensor):
        raise TypeError(f"{name} 必须是 ComfyUI IMAGE 张量")
    if value.ndim == 3:
        value = value.unsqueeze(0)
    if value.ndim != 4 or value.shape[-1] < 3:
        raise ValueError(f"{name} 必须是 BHWC 图像，当前形状为 {tuple(value.shape)}")
    if min(value.shape[:3]) < 1:
        raise ValueError(f"{name} 不能为空")
    return value


def _match_batches(
    original: torch.Tensor, relit: torch.Tensor
) -> tuple[torch.Tensor, torch.Tensor]:
    original_batch = int(original.shape[0])
    relit_batch = int(relit.shape[0])
    if original_batch == relit_batch:
        return original, relit
    if original_batch == 1:
        return original.expand(relit_batch, -1, -1, -1), relit
    if relit_batch == 1:
        return original, relit.expand(original_batch, -1, -1, -1)
    raise ValueError(
        "原图与打光图批次数量必须一致，或其中一侧只能有一张图；"
        f"当前为 {original_batch} 与 {relit_batch}"
    )


def _resize_nchw(value: torch.Tensor, size: tuple[int, int]) -> torch.Tensor:
    if value.shape[-2:] == size:
        return value
    try:
        return F.interpolate(
            value,
            size=size,
            mode="bicubic",
            align_corners=False,
            antialias=True,
        )
    except TypeError:
        return F.interpolate(value, size=size, mode="bicubic", align_corners=False)


def _srgb_to_linear(value: torch.Tensor) -> torch.Tensor:
    return torch.where(
        value <= 0.04045,
        value / 12.92,
        ((value + 0.055) / 1.055).pow(2.4),
    )


def _linear_to_srgb(value: torch.Tensor) -> torch.Tensor:
    return torch.where(
        value <= 0.0031308,
        value * 12.92,
        1.055 * value.clamp_min(0.0).pow(1.0 / 2.4) - 0.055,
    )


def _luminance(linear_rgb: torch.Tensor) -> torch.Tensor:
    weights = linear_rgb.new_tensor(_LUMA_WEIGHTS).view(1, 3, 1, 1)
    return (linear_rgb[:, :3] * weights).sum(dim=1, keepdim=True)


def _gamut_map_at_fixed_luminance(
    target_rgb: torch.Tensor, target_luma: torch.Tensor
) -> torch.Tensor:
    """Reduce chroma only; target linear luminance remains unchanged."""
    neutral = target_luma.expand_as(target_rgb)
    chroma = target_rgb - neutral
    positive_limit = (1.0 - neutral) / chroma.clamp_min(_EPSILON)
    negative_limit = neutral / (-chroma).clamp_min(_EPSILON)
    channel_limit = torch.where(
        chroma > _EPSILON,
        positive_limit,
        torch.where(chroma < -_EPSILON, negative_limit, torch.ones_like(chroma)),
    )
    chroma_scale = channel_limit.amin(dim=1, keepdim=True).clamp(0.0, 1.0)
    return (neutral + chroma * chroma_scale).clamp(0.0, 1.0)


def _restore_color_only(
    original_rgb: torch.Tensor,
    relit_rgb: torch.Tensor,
    restore_strength: float,
    color_saturation: float,
) -> tuple[torch.Tensor, torch.Tensor]:
    original_linear = _srgb_to_linear(original_rgb)
    relit_linear = _srgb_to_linear(relit_rgb)
    original_luma = _luminance(original_linear).clamp_min(_EPSILON)
    relit_luma = _luminance(relit_linear).clamp(0.0, 1.0)

    # Scale the original RGB ratios to the relit luminance. This transfers
    # color per pixel while the relit image remains the sole source of light.
    original_at_relit_luma = original_linear * (relit_luma / original_luma)
    strength = max(0.0, min(1.0, float(restore_strength)))

    # Near-black source colors are unreliable. Fade only those pixels toward
    # the relit chroma without changing their target luminance.
    source_color_confidence = ((original_luma - 0.0015) / 0.018).clamp(0.0, 1.0)
    source_color_confidence = source_color_confidence.square() * (
        3.0 - 2.0 * source_color_confidence
    )
    effective_strength = strength * source_color_confidence
    target_rgb = torch.lerp(relit_linear, original_at_relit_luma, effective_strength)

    neutral = relit_luma.expand_as(target_rgb)
    saturation = max(0.0, min(2.0, float(color_saturation)))
    target_rgb = neutral + (target_rgb - neutral) * saturation
    output_linear = _gamut_map_at_fixed_luminance(target_rgb, relit_luma)

    original_chroma = original_linear / original_luma
    relit_chroma = relit_linear / relit_luma.clamp_min(_EPSILON)
    chroma_difference = (original_chroma - relit_chroma).abs().mean(dim=1)
    color_difference_mask = torch.tanh(chroma_difference * 0.6).clamp(0.0, 1.0)
    return _linear_to_srgb(output_linear).clamp(0.0, 1.0), color_difference_mask


class MyOriginalColorRelight:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "original_image": (
                    "IMAGE",
                    {"tooltip": "已与打光图对齐，仅用于提供逐像素原始颜色"},
                ),
                "relit_image": (
                    "IMAGE",
                    {"tooltip": "最终底片；光影、纹理、清晰度和输出尺寸全部来自此图"},
                ),
                "color_restore_strength": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display": "slider",
                        "tooltip": "0 保持打光图颜色，1 使用原图颜色",
                    },
                ),
                "color_saturation": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 2.0,
                        "step": 0.01,
                        "display": "slider",
                        "tooltip": "调整还原颜色的浓度，不改变打光图亮度",
                    },
                ),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("原色打光成片", "色差预览")
    FUNCTION = "restore_original_color"
    CATEGORY = "My-Comfnode/图像"
    DESCRIPTION = (
        "以打光图作为最终底片，逐像素保持其亮度、光影、纹理和清晰度，"
        "仅将已对齐原图的颜色恢复到打光图。"
    )

    def restore_original_color(
        self,
        original_image: torch.Tensor,
        relit_image: torch.Tensor,
        color_restore_strength: float = 1.0,
        color_saturation: float = 1.0,
    ):
        original = _ensure_image(original_image, "原图")
        relit = _ensure_image(relit_image, "打光图")
        original, relit = _match_batches(original, relit)

        strength = max(0.0, min(1.0, float(color_restore_strength)))
        saturation = max(0.0, min(2.0, float(color_saturation)))
        if strength == 0.0 and saturation == 1.0:
            mask = torch.zeros(relit.shape[:3], device=relit.device, dtype=torch.float32)
            return relit.clone(), mask

        output_dtype = relit.dtype
        relit_compute = relit.to(dtype=torch.float32).clamp(0.0, 1.0)
        original_compute = original.to(device=relit.device, dtype=torch.float32).clamp(0.0, 1.0)
        height, width = relit_compute.shape[1:3]
        relit_rgb = relit_compute[..., :3].permute(0, 3, 1, 2)
        original_rgb = original_compute[..., :3].permute(0, 3, 1, 2)
        original_rgb = _resize_nchw(original_rgb, (height, width)).clamp(0.0, 1.0)

        restored_rgb, color_difference = _restore_color_only(
            original_rgb,
            relit_rgb,
            strength,
            saturation,
        )
        output = relit.clone()
        output[..., :3] = restored_rgb.permute(0, 2, 3, 1).to(dtype=output_dtype)
        return output, color_difference


NODE_CLASS_MAPPINGS = {
    "MyOriginalColorRelight": MyOriginalColorRelight,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MyOriginalColorRelight": "My原色保光",
}
