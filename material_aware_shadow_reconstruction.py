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
        raise TypeError("服装遮罩必须是 ComfyUI MASK 张量")
    if value.ndim == 2:
        value = value.unsqueeze(0)
    elif value.ndim == 4 and value.shape[-1] == 1:
        value = value[..., 0]
    elif value.ndim == 4 and value.shape[1] == 1:
        value = value[:, 0]
    if value.ndim != 3:
        raise ValueError(f"服装遮罩必须是 BHW 张量，当前形状为 {tuple(value.shape)}")
    if value.shape[0] == 1 and batch > 1:
        value = value.expand(batch, -1, -1)
    elif value.shape[0] != batch:
        raise ValueError(f"服装遮罩批次必须为 1 或 {batch}")
    result = value.to(device=device, dtype=torch.float32).unsqueeze(1)
    if result.shape[-2:] != (height, width):
        result = F.interpolate(result, size=(height, width), mode="bilinear", align_corners=False)
    return result.clamp(0.0, 1.0)


def _srgb_to_linear(value: torch.Tensor) -> torch.Tensor:
    return torch.where(value <= 0.04045, value / 12.92, ((value + 0.055) / 1.055).pow(2.4))


def _linear_to_srgb(value: torch.Tensor) -> torch.Tensor:
    value = value.clamp(0.0, 1.0)
    return torch.where(value <= 0.0031308, value * 12.92, 1.055 * value.pow(1.0 / 2.4) - 0.055)


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


def _extract_retinex_shadow(
    luma: torch.Tensor,
    extraction_scale: float,
    edge_preservation: float,
) -> torch.Tensor:
    height, width = luma.shape[-2:]
    downscale = max(1.0, max(height, width) / 768.0)
    small_size = (max(1, round(height / downscale)), max(1, round(width / downscale)))
    small = F.interpolate(luma, size=small_size, mode="area")
    base_radius = max(2, round(float(extraction_scale) / downscale))
    radii = (
        max(1, round(base_radius * 0.55)),
        base_radius,
        max(2, round(base_radius * 1.75)),
    )
    fields = []
    for radius in radii:
        illumination = _closing(small, radius)
        illumination = _gaussian_blur(illumination, max(0.8, radius * 0.08)).clamp_min(1e-4)
        fields.append((torch.log(illumination) - torch.log(small.clamp_min(1e-4))).clamp_min(0.0))
    shadow = fields[0] * 0.20 + fields[1] * 0.50 + fields[2] * 0.30
    # 多尺度一致性低的细碎背景纹理会被压制，真实投影在不同尺度下通常持续存在。
    spread = torch.maximum(torch.maximum(fields[0], fields[1]), fields[2]) - torch.minimum(
        torch.minimum(fields[0], fields[1]), fields[2])
    consistency = torch.exp(-spread * 1.8)
    shadow = (shadow * (0.55 + consistency * 0.45)).clamp(0.0, 1.2)
    edge_sigma = max(0.65, min(4.0, float(extraction_scale) * 0.075 / downscale))
    broad_shadow = _gaussian_blur(shadow, edge_sigma)
    edge_band = shadow - broad_shadow
    edge_mix = max(0.0, min(1.0, float(edge_preservation)))
    shadow = (broad_shadow + edge_band * edge_mix).clamp(0.0, 0.75)
    return F.interpolate(shadow, size=(height, width), mode="bilinear", align_corners=False)


def _auto_target_mask(background: torch.Tensor, composite: torch.Tensor, sensitivity: float) -> torch.Tensor:
    height, width = background.shape[-2:]
    downscale = max(1.0, max(height, width) / 512.0)
    size = (max(1, round(height / downscale)), max(1, round(width / downscale)))
    background_small = F.interpolate(background, size=size, mode="area")
    composite_small = F.interpolate(composite, size=size, mode="area")

    # 以占画面多数的背景估计稳健颜色变换，消除拼接前后的整体曝光和色温偏差。
    background_flat = background_small.flatten(2)
    composite_flat = composite_small.flatten(2)
    background_median = background_flat.median(dim=2).values.unsqueeze(-1).unsqueeze(-1)
    composite_median = composite_flat.median(dim=2).values.unsqueeze(-1).unsqueeze(-1)
    background_mad = (background_flat - background_median.flatten(2)).abs().median(dim=2).values
    composite_mad = (composite_flat - composite_median.flatten(2)).abs().median(dim=2).values
    color_scale = (composite_mad / background_mad.clamp_min(0.015)).clamp(0.72, 1.38)
    color_scale = color_scale.unsqueeze(-1).unsqueeze(-1)
    background_aligned = (
        (background_small - background_median) * color_scale + composite_median
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


def reconstruct_material_aware_shadow(
    background_image: torch.Tensor,
    composite_image: torch.Tensor,
    clothing_mask: torch.Tensor | None = None,
    shadow_strength: float = 0.28,
    shadow_threshold: float = 0.035,
    extraction_scale: float = 48.0,
    edge_preservation: float = 0.90,
    highlight_protection: float = 0.92,
    auto_region_sensitivity: float = 0.58,
    region_shrink: float = 1.0,
    existing_shadow_protection: float = 0.30,
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

    if clothing_mask is None:
        target_mask = _auto_target_mask(background_nchw, composite_nchw, auto_region_sensitivity)
    else:
        target_mask = _match_mask(clothing_mask, batch, height, width, device)
    target_mask = _shrink_mask(target_mask, region_shrink)

    background_linear = _srgb_to_linear(background_nchw).clamp(0.0, 1.0)
    composite_linear = _srgb_to_linear(composite_nchw).clamp(0.0, 1.0)
    background_luma = _luminance(background_linear).clamp_min(1e-4)
    composite_luma = _luminance(composite_linear).clamp_min(1e-4)

    shadow_field = _extract_retinex_shadow(
        background_luma, extraction_scale, edge_preservation)

    # 只重建目标图中缺失的光照衰减。未被替换的背景和服装已有暗部不会被重复压暗。
    existing_shadow_raw = _extract_retinex_shadow(
        composite_luma, extraction_scale, edge_preservation)
    existing_shadow_broad = _gaussian_blur(
        existing_shadow_raw,
        max(1.2, min(5.0, float(extraction_scale) * 0.035)),
    )
    pixel_change = _gaussian_blur(
        (background_nchw - composite_nchw).abs().mean(dim=1, keepdim=True), 0.8)
    unchanged_content = 1.0 - _smoothstep(pixel_change, 0.006, 0.075)
    existing_shadow = (
        existing_shadow_broad
        + (existing_shadow_raw - existing_shadow_broad) * unchanged_content
    ).clamp_min(0.0)
    existing_protection = max(0.0, min(1.0, float(existing_shadow_protection)))
    missing_shadow = (shadow_field - existing_shadow * existing_protection).clamp_min(0.0)

    threshold = max(0.0, min(0.45, float(shadow_threshold)))
    confidence = _smoothstep(missing_shadow, threshold, threshold + 0.085)
    shadow_depth = (missing_shadow * confidence).clamp(0.0, 0.55)

    # 在目标图自身的对数亮度上减去光照衰减，不复制背景颜色和纹理。
    target_log_luma = torch.log(composite_luma)
    detail_downscale = max(1.0, max(height, width) / 1024.0)
    detail_size = (max(1, round(height / detail_downscale)), max(1, round(width / detail_downscale)))
    target_small = F.interpolate(target_log_luma, size=detail_size, mode="area")
    target_base_small = _gaussian_blur(target_small, max(0.7, 2.4 / detail_downscale))
    target_base = F.interpolate(target_base_small, size=(height, width), mode="bilinear", align_corners=False)
    target_detail = target_log_luma - target_base
    bright_detail = _smoothstep(target_detail, 0.018, 0.105)
    absolute_highlight = _smoothstep(composite_luma, 0.42, 0.88)
    specular = (bright_detail * absolute_highlight).clamp(0.0, 1.0)
    protect = max(0.0, min(1.0, float(highlight_protection)))
    protection = 1.0 - specular * protect * 0.92

    strength = max(0.0, min(1.25, float(shadow_strength)))
    effect = (shadow_depth * target_mask * protection * strength).clamp(0.0, 0.60)

    # Photoshop 式柔光阴影层：0.5 为中性灰，只改变光感，不把浅色材质乘成灰色。
    shadow_layer = (0.5 * torch.exp(-effect * 3.0)).clamp(0.0, 0.5)
    fused_srgb = (
        composite_nchw
        - (1.0 - 2.0 * shadow_layer) * composite_nchw * (1.0 - composite_nchw)
    ).clamp(0.0, 1.0)

    output = composite.clone()
    output[..., :3] = fused_srgb.permute(0, 2, 3, 1).to(dtype=output_dtype)
    actual_mask = (effect / 0.55).clamp(0.0, 1.0)
    decomposition = (1.0 - shadow_depth / 0.55).clamp(0.0, 1.0).expand(-1, 3, -1, -1)
    return output, actual_mask[:, 0], decomposition.permute(0, 2, 3, 1).to(dtype=output_dtype)


class MyMaterialAwareShadowReconstruction:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "背景阴影图": ("IMAGE", {"tooltip": "包含需要继承阴影的纯背景图，必须与拼接图位置对应"}),
                "拼接图": ("IMAGE", {"tooltip": "已经放入服装或商品、准备重建阴影的图片"}),
                "阴影强度": ("FLOAT", {"default": 0.28, "min": 0.0, "max": 1.25, "step": 0.01, "display": "slider", "tooltip": "PS 柔光层不透明度；白色丝绸建议 0.18 到 0.35"}),
                "阴影阈值": ("FLOAT", {"default": 0.035, "min": 0.0, "max": 0.30, "step": 0.005, "display": "slider", "tooltip": "过滤浅灰底噪和连续灰带；出现脏斑时调高"}),
                "阴影提取尺度": ("FLOAT", {"default": 48.0, "min": 16.0, "max": 220.0, "step": 2.0, "display": "slider", "tooltip": "Retinex 光照分解的范围；树叶投影建议 36 到 72"}),
                "边缘保留": ("FLOAT", {"default": 0.90, "min": 0.0, "max": 1.0, "step": 0.01, "display": "slider", "tooltip": "保留投影中频边缘的程度；越高轮廓越清晰"}),
                "高光保护": ("FLOAT", {"default": 0.92, "min": 0.0, "max": 1.0, "step": 0.01, "display": "slider", "tooltip": "保护丝绸、金属等材质原有高光，避免出现湿水感"}),
                "已有阴影保护": ("FLOAT", {"default": 0.30, "min": 0.0, "max": 1.0, "step": 0.01, "display": "slider", "tooltip": "扣除拼接图里已经存在的阴影；背景被重复压暗时调高，衣物树影太弱时调低"}),
                "自动区域灵敏度": ("FLOAT", {"default": 0.58, "min": 0.0, "max": 1.0, "step": 0.01, "display": "slider", "tooltip": "未连接服装遮罩时，自动比较背景与拼接图识别目标区域"}),
                "区域内缩": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 12.0, "step": 1.0, "display": "slider", "tooltip": "阴影区域向目标内部收缩，防止边缘漏到背景"}),
            },
            "optional": {
                "服装遮罩": ("MASK", {"tooltip": "白色区域承接阴影；有准确遮罩时建议连接"}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "IMAGE")
    RETURN_NAMES = ("阴影重建图", "实际阴影遮罩", "光照分解图")
    FUNCTION = "reconstruct"
    CATEGORY = "My-Comfnode/图像"
    DESCRIPTION = "材质感知阴影重建：多尺度 Retinex 分离光照，以 Photoshop 柔光阴影层融合，保留目标材质底色、纹理与高光。"

    def reconstruct(self, background_image=None, composite_image=None, clothing_mask=None,
                    shadow_strength=0.28, shadow_threshold=0.035, extraction_scale=48.0,
                    edge_preservation=0.90, highlight_protection=0.92,
                    auto_region_sensitivity=0.58, region_shrink=1.0,
                    existing_shadow_protection=0.30, **kwargs):
        background_image = kwargs.get("背景阴影图", background_image)
        composite_image = kwargs.get("拼接图", composite_image)
        clothing_mask = kwargs.get("服装遮罩", clothing_mask)
        shadow_strength = kwargs.get("阴影强度", shadow_strength)
        shadow_threshold = kwargs.get("阴影阈值", shadow_threshold)
        extraction_scale = kwargs.get("阴影提取尺度", extraction_scale)
        edge_preservation = kwargs.get("边缘保留", edge_preservation)
        highlight_protection = kwargs.get("高光保护", highlight_protection)
        existing_shadow_protection = kwargs.get("已有阴影保护", existing_shadow_protection)
        auto_region_sensitivity = kwargs.get("自动区域灵敏度", auto_region_sensitivity)
        region_shrink = kwargs.get("区域内缩", region_shrink)
        return reconstruct_material_aware_shadow(
            background_image, composite_image, clothing_mask, shadow_strength,
            shadow_threshold, extraction_scale, edge_preservation, highlight_protection,
            auto_region_sensitivity, region_shrink, existing_shadow_protection,
        )


NODE_CLASS_MAPPINGS = {"MyMaterialAwareShadowReconstruction": MyMaterialAwareShadowReconstruction}
NODE_DISPLAY_NAME_MAPPINGS = {"MyMaterialAwareShadowReconstruction": "My材质感知阴影重建"}
