from __future__ import annotations

import torch
import torch.nn.functional as F


_LUMA = (0.2126, 0.7152, 0.0722)


def _ensure_image(value: torch.Tensor, name: str) -> torch.Tensor:
    if not isinstance(value, torch.Tensor):
        raise TypeError(f"{name} 必须是 ComfyUI IMAGE 张量")
    if value.ndim == 3:
        value = value.unsqueeze(0)
    if value.ndim != 4 or value.shape[-1] < 3:
        raise ValueError(f"{name} 必须是 BHWC 图像，当前形状为 {tuple(value.shape)}")
    return value


def _match_batches(first: torch.Tensor, second: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    if first.shape[0] == second.shape[0]:
        return first, second
    if first.shape[0] == 1:
        return first.expand(second.shape[0], -1, -1, -1), second
    if second.shape[0] == 1:
        return first, second.expand(first.shape[0], -1, -1, -1)
    raise ValueError("背景阴影图和拼接图批次数量必须一致，或其中一侧只有一张图")


def _match_mask(value, batch: int, height: int, width: int, device) -> torch.Tensor:
    if not isinstance(value, torch.Tensor):
        raise TypeError("目标遮罩必须是 ComfyUI MASK 张量")
    if value.ndim == 2:
        value = value.unsqueeze(0)
    elif value.ndim == 4 and value.shape[-1] == 1:
        value = value[..., 0]
    elif value.ndim == 4 and value.shape[1] == 1:
        value = value[:, 0]
    if value.ndim != 3:
        raise ValueError(f"目标遮罩必须是 BHW 张量，当前形状为 {tuple(value.shape)}")
    if value.shape[0] == 1 and batch > 1:
        value = value.expand(batch, -1, -1)
    elif value.shape[0] != batch:
        raise ValueError(f"目标遮罩批次必须为 1 或 {batch}")
    result = value.to(device=device, dtype=torch.float32).unsqueeze(1)
    if result.shape[-2:] != (height, width):
        result = F.interpolate(result, size=(height, width), mode="bilinear", align_corners=False)
    return result.clamp(0.0, 1.0)


def _srgb_to_linear(value: torch.Tensor) -> torch.Tensor:
    return torch.where(value <= 0.04045, value / 12.92, ((value + 0.055) / 1.055).pow(2.4))


def _luminance(rgb: torch.Tensor) -> torch.Tensor:
    weights = rgb.new_tensor(_LUMA).view(1, 3, 1, 1)
    return (rgb * weights).sum(dim=1, keepdim=True)


def _smoothstep(value: torch.Tensor, start: float, end: float) -> torch.Tensor:
    scaled = ((value - float(start)) / max(float(end) - float(start), 1e-6)).clamp(0.0, 1.0)
    return scaled.square() * (3.0 - 2.0 * scaled)


def _gaussian_blur(value: torch.Tensor, sigma: float) -> torch.Tensor:
    sigma = float(sigma)
    if sigma <= 0.08:
        return value
    radius = max(1, int(round(sigma * 3.0)))
    coords = torch.arange(-radius, radius + 1, device=value.device, dtype=value.dtype)
    kernel = torch.exp(-coords.square() / (2.0 * sigma * sigma))
    kernel = kernel / kernel.sum().clamp_min(1e-8)
    channels = value.shape[1]
    horizontal = kernel.view(1, 1, 1, -1).expand(channels, 1, 1, -1)
    vertical = kernel.view(1, 1, -1, 1).expand(channels, 1, -1, 1)
    result = F.conv2d(F.pad(value, (radius, radius, 0, 0), mode="replicate"), horizontal, groups=channels)
    return F.conv2d(F.pad(result, (0, 0, radius, radius), mode="replicate"), vertical, groups=channels)


def _max_filter(value: torch.Tensor, radius: int) -> torch.Tensor:
    radius = max(1, int(radius))
    kernel = radius * 2 + 1
    horizontal = F.max_pool2d(
        F.pad(value, (radius, radius, 0, 0), mode="replicate"),
        kernel_size=(1, kernel),
        stride=1,
    )
    return F.max_pool2d(
        F.pad(horizontal, (0, 0, radius, radius), mode="replicate"),
        kernel_size=(kernel, 1),
        stride=1,
    )


def _closing(value: torch.Tensor, radius: int) -> torch.Tensor:
    dilated = _max_filter(value, radius)
    return -_max_filter(-dilated, radius)


def _auto_target_mask(background: torch.Tensor, composite: torch.Tensor, sensitivity: float) -> torch.Tensor:
    height, width = background.shape[-2:]
    downscale = max(1.0, max(height, width) / 512.0)
    size = (max(1, round(height / downscale)), max(1, round(width / downscale)))
    background_small = F.interpolate(background, size=size, mode="area")
    composite_small = F.interpolate(composite, size=size, mode="area")

    background_flat = background_small.flatten(2)
    composite_flat = composite_small.flatten(2)
    background_median = background_flat.median(dim=2).values.unsqueeze(-1).unsqueeze(-1)
    composite_median = composite_flat.median(dim=2).values.unsqueeze(-1).unsqueeze(-1)
    background_mad = (background_flat - background_median.flatten(2)).abs().median(dim=2).values
    composite_mad = (composite_flat - composite_median.flatten(2)).abs().median(dim=2).values
    color_scale = (composite_mad / background_mad.clamp_min(0.015)).clamp(0.72, 1.38)
    background_aligned = (
        (background_small - background_median) * color_scale.unsqueeze(-1).unsqueeze(-1)
        + composite_median
    ).clamp(0.0, 1.0)

    color_difference = (background_aligned - composite_small).abs().mean(dim=1, keepdim=True)
    luma_difference = (_luminance(background_aligned) - _luminance(composite_small)).abs()
    difference = _gaussian_blur(color_difference * 0.72 + luma_difference * 0.28, 0.9)
    sensitivity = max(0.0, min(1.0, float(sensitivity)))
    threshold = 0.115 - sensitivity * 0.085
    mask = _smoothstep(difference, threshold, threshold + 0.075)
    mask = _closing(mask, 5)
    mask = F.max_pool2d(mask, kernel_size=7, stride=1, padding=3)
    mask = _gaussian_blur(mask, 1.2).clamp(0.0, 1.0)
    return F.interpolate(mask, size=(height, width), mode="bilinear", align_corners=False)


def _shrink_mask(mask: torch.Tensor, pixels: float) -> torch.Tensor:
    radius = max(0, round(float(pixels)))
    if radius == 0:
        return mask
    kernel = radius * 2 + 1
    eroded = -F.max_pool2d(-mask, kernel_size=kernel, stride=1, padding=radius)
    return _gaussian_blur(eroded, max(0.7, radius * 0.65)).clamp(0.0, 1.0)


def _extract_shadow_alpha(
    background_luma: torch.Tensor,
    extraction_scale: float,
    threshold: float,
    contrast: float,
    edge_clarity: float,
) -> torch.Tensor:
    height, width = background_luma.shape[-2:]
    downscale = max(1.0, max(height, width) / 1024.0)
    size = (max(1, round(height / downscale)), max(1, round(width / downscale)))
    small = F.interpolate(background_luma, size=size, mode="area")
    radius = max(2, round(float(extraction_scale) / downscale * 1.5))

    # 单尺度背景闭运算只估计无阴影底图，阴影本身保持原坐标和轮廓。
    illumination = _closing(small, radius)
    illumination = _gaussian_blur(illumination, max(0.55, radius * 0.035)).clamp_min(1e-4)
    shadow_depth = (1.0 - small / illumination).clamp(0.0, 0.80)

    threshold = max(0.0, min(0.50, float(threshold)))
    confidence = _smoothstep(shadow_depth, threshold, threshold + 0.12)
    matte = shadow_depth * confidence
    contrast = max(0.1, min(3.0, float(contrast)))
    matte = (matte * contrast / 0.42).clamp(0.0, 1.0)

    clarity = max(0.0, min(1.0, float(edge_clarity)))
    softened = _gaussian_blur(matte, 1.8)
    matte = (softened + (matte - softened) * clarity).clamp(0.0, 1.0)
    return F.interpolate(matte, size=(height, width), mode="bilinear", align_corners=False)


def _shadow_paint_color(
    mode: str,
    background_srgb: torch.Tensor,
    raw_shadow_alpha: torch.Tensor,
) -> torch.Tensor:
    if mode == "冷灰":
        values = (0.22, 0.25, 0.30)
    elif mode == "暖灰":
        values = (0.30, 0.25, 0.21)
    elif mode == "自动取样":
        weights = raw_shadow_alpha.clamp_min(0.0)
        sampled = (background_srgb * weights).sum(dim=(2, 3), keepdim=True)
        sampled = sampled / weights.sum(dim=(2, 3), keepdim=True).clamp_min(1e-6)
        sampled_luma = _luminance(sampled).clamp_min(1e-4)
        return (sampled * (0.26 / sampled_luma)).clamp(0.16, 0.36)
    else:
        values = (0.25, 0.25, 0.25)
    return background_srgb.new_tensor(values).view(1, 3, 1, 1)


def _blend_shadow(base: torch.Tensor, paint: torch.Tensor, alpha: torch.Tensor, mode: str) -> torch.Tensor:
    if mode == "正片叠底":
        blended = base * paint
    else:
        blended = torch.where(
            paint <= 0.5,
            base - (1.0 - 2.0 * paint) * base * (1.0 - base),
            base,
        )
    return (base + (blended - base) * alpha).clamp(0.0, 1.0)


def composite_ps_shadow_layer(
    background_image: torch.Tensor,
    composite_image: torch.Tensor,
    target_mask: torch.Tensor | None = None,
    blend_mode: str = "柔光",
    layer_opacity: float = 0.32,
    extraction_scale: float = 48.0,
    shadow_threshold: float = 0.035,
    shadow_contrast: float = 1.15,
    edge_clarity: float = 0.82,
    shadow_tone: str = "中性灰",
    auto_region_sensitivity: float = 0.58,
    region_shrink: float = 1.0,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    background = _ensure_image(background_image, "背景阴影图")
    composite = _ensure_image(composite_image, "拼接图")
    background, composite = _match_batches(background, composite)
    batch, height, width = composite.shape[:3]
    device = composite.device
    output_dtype = composite.dtype

    background_rgb = background[..., :3].to(device=device, dtype=torch.float32).clamp(0.0, 1.0)
    composite_rgb = composite[..., :3].to(device=device, dtype=torch.float32).clamp(0.0, 1.0)
    background_nchw = background_rgb.permute(0, 3, 1, 2)
    composite_nchw = composite_rgb.permute(0, 3, 1, 2)
    if background_nchw.shape[-2:] != (height, width):
        background_nchw = F.interpolate(background_nchw, size=(height, width), mode="bilinear", align_corners=False)

    if target_mask is None:
        target = _auto_target_mask(background_nchw, composite_nchw, auto_region_sensitivity)
    else:
        target = _match_mask(target_mask, batch, height, width, device)
    target = _shrink_mask(target, region_shrink)

    background_luma = _luminance(_srgb_to_linear(background_nchw)).clamp_min(1e-4)
    raw_shadow_alpha = _extract_shadow_alpha(
        background_luma,
        extraction_scale,
        shadow_threshold,
        shadow_contrast,
        edge_clarity,
    )
    opacity = max(0.0, min(1.0, float(layer_opacity)))
    layer_alpha = (raw_shadow_alpha * opacity).clamp(0.0, 1.0)
    actual_alpha = (layer_alpha * target).clamp(0.0, 1.0)

    paint = _shadow_paint_color(shadow_tone, background_nchw, raw_shadow_alpha)
    if paint.shape[0] == 1 and batch > 1:
        paint = paint.expand(batch, -1, -1, -1)
    fused = _blend_shadow(composite_nchw, paint, actual_alpha, blend_mode)

    output = composite.clone()
    output[..., :3] = fused.permute(0, 2, 3, 1).to(dtype=output_dtype)

    layer_rgb = paint.expand(-1, -1, height, width)
    transparent_layer = torch.cat((layer_rgb, layer_alpha), dim=1)
    return (
        output,
        transparent_layer.permute(0, 2, 3, 1).to(dtype=output_dtype),
        actual_alpha[:, 0],
    )


class MyPSTransparentShadowLayer:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "背景阴影图": ("IMAGE", {"tooltip": "包含原始光影的背景图，阴影位置会原样保留"}),
                "拼接图": ("IMAGE", {"tooltip": "已经放入服装或商品的图片"}),
                "混合模式": (["柔光", "正片叠底"], {"default": "柔光"}),
                "图层不透明度": ("FLOAT", {"default": 0.32, "min": 0.0, "max": 1.0, "step": 0.01, "display": "slider"}),
                "阴影提取尺度": ("FLOAT", {"default": 48.0, "min": 12.0, "max": 180.0, "step": 2.0, "display": "slider"}),
                "阴影阈值": ("FLOAT", {"default": 0.035, "min": 0.0, "max": 0.35, "step": 0.005, "display": "slider"}),
                "阴影对比度": ("FLOAT", {"default": 1.15, "min": 0.1, "max": 3.0, "step": 0.05, "display": "slider"}),
                "边缘清晰度": ("FLOAT", {"default": 0.82, "min": 0.0, "max": 1.0, "step": 0.01, "display": "slider"}),
                "阴影色调": (["中性灰", "自动取样", "冷灰", "暖灰"], {"default": "中性灰"}),
                "自动区域灵敏度": ("FLOAT", {"default": 0.58, "min": 0.0, "max": 1.0, "step": 0.01, "display": "slider"}),
                "区域内缩": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 12.0, "step": 1.0, "display": "slider"}),
            },
            "optional": {
                "目标遮罩": ("MASK", {"tooltip": "白色区域承接阴影；相当于 PS 的图层蒙版，连接后最稳定"}),
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "MASK")
    RETURN_NAMES = ("融合图", "透明阴影层", "实际叠加遮罩")
    FUNCTION = "composite"
    CATEGORY = "My-Comfnode/图像"
    DESCRIPTION = "按 PS 图层方式提取原位置阴影，生成透明阴影层，并以柔光或正片叠底融合。"

    def composite(
        self,
        background_image=None,
        composite_image=None,
        target_mask=None,
        blend_mode="柔光",
        layer_opacity=0.32,
        extraction_scale=48.0,
        shadow_threshold=0.035,
        shadow_contrast=1.15,
        edge_clarity=0.82,
        shadow_tone="中性灰",
        auto_region_sensitivity=0.58,
        region_shrink=1.0,
        **kwargs,
    ):
        background_image = kwargs.get("背景阴影图", background_image)
        composite_image = kwargs.get("拼接图", composite_image)
        target_mask = kwargs.get("目标遮罩", target_mask)
        blend_mode = kwargs.get("混合模式", blend_mode)
        layer_opacity = kwargs.get("图层不透明度", layer_opacity)
        extraction_scale = kwargs.get("阴影提取尺度", extraction_scale)
        shadow_threshold = kwargs.get("阴影阈值", shadow_threshold)
        shadow_contrast = kwargs.get("阴影对比度", shadow_contrast)
        edge_clarity = kwargs.get("边缘清晰度", edge_clarity)
        shadow_tone = kwargs.get("阴影色调", shadow_tone)
        auto_region_sensitivity = kwargs.get("自动区域灵敏度", auto_region_sensitivity)
        region_shrink = kwargs.get("区域内缩", region_shrink)
        return composite_ps_shadow_layer(
            background_image,
            composite_image,
            target_mask,
            blend_mode,
            layer_opacity,
            extraction_scale,
            shadow_threshold,
            shadow_contrast,
            edge_clarity,
            shadow_tone,
            auto_region_sensitivity,
            region_shrink,
        )


NODE_CLASS_MAPPINGS = {"MyPSTransparentShadowLayer": MyPSTransparentShadowLayer}
NODE_DISPLAY_NAME_MAPPINGS = {"MyPSTransparentShadowLayer": "MyPS透明阴影图层"}
