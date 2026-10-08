from __future__ import annotations

import math
import re

import torch
import torch.nn.functional as F


_COLOR_RE = re.compile(r"^#?([0-9a-fA-F]{6})$")

# These values form the fixed post-production preset. They intentionally stay
# internal so the node exposes only strength and color.
_PRESET = {
    "alignment_max_fraction": 0.06,
    "alignment_confidence": 8.0,
    "guided_epsilon": 0.008,
    "global_exposure_keep": 0.35,
    "minimum_activity": 0.018,
    "full_activity": 0.12,
    "shadow_depth": 0.42,
    "screen_amount": 0.22,
}


def _parse_hex_color(value: str) -> tuple[float, float, float]:
    match = _COLOR_RE.fullmatch(str(value).strip())
    if match is None:
        raise ValueError("光影颜色必须是 #RRGGBB 格式，例如 #FFFFFF")
    packed = match.group(1)
    return tuple(int(packed[index : index + 2], 16) / 255.0 for index in (0, 2, 4))


def _ensure_image(value: torch.Tensor, name: str) -> torch.Tensor:
    if not isinstance(value, torch.Tensor):
        raise TypeError(f"{name} 必须是 ComfyUI IMAGE 张量")
    if value.ndim == 3:
        value = value.unsqueeze(0)
    if value.ndim != 4 or value.shape[-1] < 3:
        raise ValueError(f"{name} 必须是 BHWC 图像，当前形状为 {tuple(value.shape)}")
    if value.shape[0] < 1 or value.shape[1] < 1 or value.shape[2] < 1:
        raise ValueError(f"{name} 不能为空")
    return value


def _match_batches(
    original: torch.Tensor, reference: torch.Tensor
) -> tuple[torch.Tensor, torch.Tensor]:
    original_batch = int(original.shape[0])
    reference_batch = int(reference.shape[0])
    if original_batch == reference_batch:
        return original, reference
    if original_batch == 1:
        return original.expand(reference_batch, -1, -1, -1), reference
    if reference_batch == 1:
        return original, reference.expand(original_batch, -1, -1, -1)
    raise ValueError(
        "原图与光影参考图批次数量必须一致，或其中一侧只能有一张图；"
        f"当前为 {original_batch} 与 {reference_batch}"
    )


def _resize_reference(reference: torch.Tensor, height: int, width: int) -> torch.Tensor:
    reference = reference.permute(0, 3, 1, 2)
    source_height, source_width = reference.shape[-2:]
    target_ratio = width / height
    source_ratio = source_width / source_height

    if source_ratio > target_ratio:
        crop_width = max(1, round(source_height * target_ratio))
        left = max(0, (source_width - crop_width) // 2)
        reference = reference[:, :, :, left : left + crop_width]
    elif source_ratio < target_ratio:
        crop_height = max(1, round(source_width / target_ratio))
        top = max(0, (source_height - crop_height) // 2)
        reference = reference[:, :, top : top + crop_height, :]

    if reference.shape[-2:] != (height, width):
        try:
            reference = F.interpolate(
                reference,
                size=(height, width),
                mode="bicubic",
                align_corners=False,
                antialias=True,
            )
        except TypeError:
            reference = F.interpolate(
                reference,
                size=(height, width),
                mode="bicubic",
                align_corners=False,
            )
    return reference.clamp(0.0, 1.0)


def _srgb_to_linear(value: torch.Tensor) -> torch.Tensor:
    return torch.where(
        value <= 0.04045,
        value / 12.92,
        ((value + 0.055) / 1.055).pow(2.4),
    )


def _luminance(rgb: torch.Tensor) -> torch.Tensor:
    weights = rgb.new_tensor((0.2126, 0.7152, 0.0722)).view(1, 3, 1, 1)
    return (_srgb_to_linear(rgb[:, :3]) * weights).sum(dim=1, keepdim=True)


def _pad_mode(height: int, width: int, amount: int) -> str:
    return "reflect" if amount < height and amount < width else "replicate"


def _gaussian_blur(value: torch.Tensor, sigma: float) -> torch.Tensor:
    if sigma <= 0.0:
        return value
    height, width = value.shape[-2:]
    radius = min(max(1, math.ceil(sigma * 3.0)), max(1, (min(height, width) - 1) // 2))
    if min(height, width) <= 2:
        return value

    coordinates = torch.arange(-radius, radius + 1, device=value.device, dtype=value.dtype)
    kernel = torch.exp(-(coordinates.square()) / (2.0 * sigma * sigma))
    kernel = kernel / kernel.sum()
    channels = value.shape[1]
    horizontal = kernel.view(1, 1, 1, -1).expand(channels, 1, 1, -1)
    vertical = kernel.view(1, 1, -1, 1).expand(channels, 1, -1, 1)
    mode = _pad_mode(height, width, radius)

    value = F.pad(value, (radius, radius, 0, 0), mode=mode)
    value = F.conv2d(value, horizontal, groups=channels)
    value = F.pad(value, (0, 0, radius, radius), mode=mode)
    return F.conv2d(value, vertical, groups=channels)


def _box_mean(value: torch.Tensor, radius: int) -> torch.Tensor:
    height, width = value.shape[-2:]
    radius = min(radius, max(0, (min(height, width) - 1) // 2))
    if radius <= 0:
        return value
    kernel = radius * 2 + 1
    padded = F.pad(value, (radius, radius, radius, radius), mode=_pad_mode(height, width, radius))
    return F.avg_pool2d(padded, kernel_size=kernel, stride=1)


def _guided_filter(
    guide: torch.Tensor,
    value: torch.Tensor,
    radius: int,
    epsilon: float,
) -> torch.Tensor:
    mean_guide = _box_mean(guide, radius)
    mean_value = _box_mean(value, radius)
    correlation = _box_mean(guide * value, radius)
    variance = _box_mean(guide * guide, radius) - mean_guide.square()
    coefficient = (correlation - mean_guide * mean_value) / (variance + epsilon)
    intercept = mean_value - coefficient * mean_guide
    return _box_mean(coefficient, radius) * guide + _box_mean(intercept, radius)


def _edge_map(value: torch.Tensor) -> torch.Tensor:
    sobel_x = value.new_tensor(
        ((-1.0, 0.0, 1.0), (-2.0, 0.0, 2.0), (-1.0, 0.0, 1.0))
    ).view(1, 1, 3, 3)
    sobel_y = sobel_x.transpose(-1, -2)
    padded = F.pad(value, (1, 1, 1, 1), mode=_pad_mode(value.shape[-2], value.shape[-1], 1))
    grad_x = F.conv2d(padded, sobel_x)
    grad_y = F.conv2d(padded, sobel_y)
    return torch.sqrt(grad_x.square() + grad_y.square() + 1e-8)


def _estimate_translation(
    original_luma: torch.Tensor, reference_luma: torch.Tensor
) -> list[tuple[int, int]]:
    height, width = original_luma.shape[-2:]
    scale = min(1.0, 128.0 / max(height, width))
    small_height = max(16, round(height * scale))
    small_width = max(16, round(width * scale))
    size = (small_height, small_width)
    original_edges = F.interpolate(_edge_map(original_luma), size=size, mode="area")
    reference_edges = F.interpolate(_edge_map(reference_luma), size=size, mode="area")

    def normalize(value: torch.Tensor) -> torch.Tensor:
        value = value - value.mean(dim=(-2, -1), keepdim=True)
        return value / value.square().mean(dim=(-2, -1), keepdim=True).sqrt().clamp_min(1e-6)

    original_edges = normalize(original_edges)
    reference_edges = normalize(reference_edges)
    window_y = torch.hann_window(small_height, device=original_luma.device, dtype=original_luma.dtype)
    window_x = torch.hann_window(small_width, device=original_luma.device, dtype=original_luma.dtype)
    window = (window_y[:, None] * window_x[None, :]).view(1, 1, small_height, small_width)
    original_fft = torch.fft.rfft2(original_edges * window)
    reference_fft = torch.fft.rfft2(reference_edges * window)
    cross_power = original_fft * reference_fft.conj()
    cross_power = cross_power / cross_power.abs().clamp_min(1e-8)
    correlation = torch.fft.irfft2(cross_power, s=size).real[:, 0]

    shifts: list[tuple[int, int]] = []
    maximum_y = height * _PRESET["alignment_max_fraction"]
    maximum_x = width * _PRESET["alignment_max_fraction"]
    for index in range(correlation.shape[0]):
        surface = correlation[index]
        flat_index = int(surface.argmax().item())
        peak_y, peak_x = divmod(flat_index, small_width)
        if peak_y > small_height // 2:
            peak_y -= small_height
        if peak_x > small_width // 2:
            peak_x -= small_width
        confidence = float(
            ((surface.max() - surface.mean()) / surface.std(unbiased=False).clamp_min(1e-6)).item()
        )
        shift_y = round(peak_y * height / small_height)
        shift_x = round(peak_x * width / small_width)
        if (
            confidence < _PRESET["alignment_confidence"]
            or abs(shift_y) > maximum_y
            or abs(shift_x) > maximum_x
        ):
            shifts.append((0, 0))
        else:
            shifts.append((shift_y, shift_x))
    return shifts


def _translate_replicate(value: torch.Tensor, shifts: list[tuple[int, int]]) -> torch.Tensor:
    maximum = max((max(abs(y), abs(x)) for y, x in shifts), default=0)
    if maximum == 0:
        return value
    height, width = value.shape[-2:]
    padded = F.pad(value, (maximum, maximum, maximum, maximum), mode="replicate")
    aligned = []
    for index, (shift_y, shift_x) in enumerate(shifts):
        top = maximum - shift_y
        left = maximum - shift_x
        aligned.append(padded[index : index + 1, :, top : top + height, left : left + width])
    return torch.cat(aligned, dim=0)


def _align_reference(original_luma: torch.Tensor, reference: torch.Tensor) -> torch.Tensor:
    reference_luma = _luminance(reference)
    shifts = _estimate_translation(original_luma, reference_luma)
    return _translate_replicate(reference, shifts)


def _extract_lighting_mask(
    original_luma: torch.Tensor, reference_luma: torch.Tensor
) -> torch.Tensor:
    height, width = original_luma.shape[-2:]
    minimum_side = min(height, width)
    small_sigma = min(12.0, max(1.25, minimum_side / 180.0))
    large_sigma = min(28.0, max(3.0, minimum_side / 56.0))
    small_radius = max(1, round(small_sigma * 1.5))
    large_radius = max(small_radius + 1, round(large_sigma * 1.2))
    epsilon = _PRESET["guided_epsilon"]

    original_small = _gaussian_blur(original_luma, small_sigma)
    original_large = _gaussian_blur(original_luma, large_sigma)
    reference_small = _gaussian_blur(reference_luma, small_sigma)
    reference_large = _gaussian_blur(reference_luma, large_sigma)

    original_illumination = (
        0.68 * _guided_filter(original_luma, original_small, small_radius, epsilon)
        + 0.32 * original_large
    ).clamp_min(1e-4)
    reference_illumination = (
        0.68 * _guided_filter(original_luma, reference_small, small_radius, epsilon)
        + 0.32 * _guided_filter(original_luma, reference_large, large_radius, epsilon * 1.75)
    ).clamp_min(1e-4)

    delta = torch.log(reference_illumination + 0.02) - torch.log(original_illumination + 0.02)
    flat = delta.flatten(1)
    median = torch.quantile(flat, 0.5, dim=1).view(-1, 1, 1, 1)
    centered = delta - median * (1.0 - _PRESET["global_exposure_keep"])
    spread = torch.quantile(centered.abs().flatten(1), 0.95, dim=1).view(-1, 1, 1, 1)
    normalized = torch.tanh(centered / (spread * 1.25).clamp_min(0.04))

    activity = (
        (spread - _PRESET["minimum_activity"])
        / (_PRESET["full_activity"] - _PRESET["minimum_activity"])
    ).clamp(0.0, 1.0)
    activity = activity.square() * (3.0 - 2.0 * activity)
    signed_mask = normalized * activity
    signed_mask = _guided_filter(
        original_luma,
        signed_mask,
        small_radius,
        epsilon * 0.75,
    ).clamp(-1.0, 1.0)
    return signed_mask


def _soft_light(base: torch.Tensor, blend: torch.Tensor) -> torch.Tensor:
    low = base - (1.0 - 2.0 * blend) * base * (1.0 - base)
    curve = torch.where(
        base <= 0.25,
        ((16.0 * base - 12.0) * base + 4.0) * base,
        torch.sqrt(base.clamp_min(0.0)),
    )
    high = base + (2.0 * blend - 1.0) * (curve - base)
    return torch.where(blend <= 0.5, low, high)


def _composite(
    original_rgb: torch.Tensor,
    signed_mask: torch.Tensor,
    strength: float,
    color: tuple[float, float, float],
) -> torch.Tensor:
    if strength <= 0.0:
        return original_rgb

    positive = signed_mask.clamp_min(0.0)
    negative = (-signed_mask).clamp_min(0.0)
    color_tensor = original_rgb.new_tensor(color).view(1, 3, 1, 1)
    blend = (0.5 + 0.5 * positive * color_tensor - 0.5 * negative).clamp(0.0, 1.0)
    soft = _soft_light(original_rgb, blend)

    source_luma = _luminance(original_rgb).clamp(0.0, 1.0)
    screened = original_rgb + (1.0 - original_rgb) * positive * color_tensor
    screen_weight = positive * (1.0 - source_luma).square() * _PRESET["screen_amount"]
    processed = torch.lerp(soft, screened, screen_weight)

    multiplied = original_rgb * (1.0 - negative * _PRESET["shadow_depth"])
    shadow_weight = negative * source_luma.sqrt() * 0.14
    processed = torch.lerp(processed, multiplied, shadow_weight)
    return torch.lerp(original_rgb, processed, float(strength)).clamp(0.0, 1.0)


class MyLighting:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "original_image": ("IMAGE", {"tooltip": "需要保留纹理与画质的原图"}),
                "lighting_reference": (
                    "IMAGE",
                    {"tooltip": "由基础模型与 LoRA 生成的光影参考图"},
                ),
                "light_strength": (
                    "FLOAT",
                    {
                        "default": 0.65,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display": "slider",
                        "tooltip": "控制光影图层的整体不透明度",
                    },
                ),
                "light_color": (
                    "MY_LIGHT_COLOR",
                    {
                        "default": "#FFFFFF",
                        "tooltip": "点击色块选择光线颜色",
                    },
                ),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("成片", "光影遮罩")
    FUNCTION = "apply_lighting"
    CATEGORY = "My-Comfnode/图像"
    DESCRIPTION = (
        "从 AI 光影参考图自动提取光照结构，并以固定后期预设叠加到原图；"
        "不复制参考图纹理。遮罩以 50% 灰为无变化，亮部代表加光，暗部代表压暗。"
    )

    @classmethod
    def VALIDATE_INPUTS(cls, light_color: str, **kwargs):
        try:
            _parse_hex_color(light_color)
        except ValueError as exc:
            return str(exc)
        return True

    def apply_lighting(
        self,
        original_image: torch.Tensor,
        lighting_reference: torch.Tensor,
        light_strength: float,
        light_color: str,
    ):
        original = _ensure_image(original_image, "原图")
        reference = _ensure_image(lighting_reference, "光影参考图")
        original, reference = _match_batches(original, reference)
        color = _parse_hex_color(light_color)

        output_dtype = original.dtype
        compute_dtype = torch.float32
        original_compute = original.to(dtype=compute_dtype).clamp(0.0, 1.0)
        height, width = original_compute.shape[1:3]
        original_rgb = original_compute[..., :3].permute(0, 3, 1, 2)
        reference = reference.to(device=original.device, dtype=compute_dtype).clamp(0.0, 1.0)
        reference_rgb = _resize_reference(reference[..., :3], height, width)

        original_luma = _luminance(original_rgb)
        reference_rgb = _align_reference(original_luma, reference_rgb)
        reference_luma = _luminance(reference_rgb)
        signed_mask = _extract_lighting_mask(original_luma, reference_luma)
        clamped_strength = max(0.0, min(1.0, float(light_strength)))
        composited_rgb = _composite(
            original_rgb,
            signed_mask,
            clamped_strength,
            color,
        )

        output = original.clone()
        if clamped_strength > 0.0:
            output[..., :3] = composited_rgb.permute(0, 2, 3, 1).to(dtype=output_dtype)
        neutral_mask = (signed_mask[:, 0] * 0.5 + 0.5).clamp(0.0, 1.0)
        return (output, neutral_mask)


NODE_CLASS_MAPPINGS = {
    "MyComfnodeLighting": MyLighting,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MyComfnodeLighting": "My打光",
}
