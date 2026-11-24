from __future__ import annotations

import math

import torch
import torch.nn.functional as F


_EPSILON = 1e-6
_LUMA_WEIGHTS = (0.2126, 0.7152, 0.0722)

# Fixed restoration preset. These are deliberately not exposed as widgets:
# the node only needs one user-facing decision, how much detail to restore.
_PRESET = {
    "maximum_log_detail": 0.42,
    "lighting_edge_start": 0.11,
    "lighting_edge_end": 0.48,
    "source_only_edge_start": 0.34,
    "source_only_edge_end": 1.20,
    "correlation_safe_start": 0.05,
    "correlation_safe_end": 0.72,
}


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


def _prepare_restore_mask(
    value: torch.Tensor | None,
    batch: int,
    size: tuple[int, int],
    device: torch.device,
) -> torch.Tensor | None:
    if value is None:
        return None
    if not isinstance(value, torch.Tensor):
        raise TypeError("细节恢复遮罩必须是 ComfyUI MASK 张量")
    if value.ndim == 2:
        value = value.unsqueeze(0)
    if value.ndim == 4 and value.shape[-1] == 1:
        value = value[..., 0]
    if value.ndim != 3 or min(value.shape) < 1:
        raise ValueError(f"细节恢复遮罩必须是 BHW 张量，当前形状为 {tuple(value.shape)}")
    if value.shape[0] == 1 and batch > 1:
        value = value.expand(batch, -1, -1)
    elif value.shape[0] != batch:
        raise ValueError(
            "细节恢复遮罩批次数量必须与输出一致，或遮罩只能有一张；"
            f"当前为 {value.shape[0]} 与 {batch}"
        )
    value = value.to(device=device, dtype=torch.float32).unsqueeze(1)
    if value.shape[-2:] != size:
        value = F.interpolate(value, size=size, mode="bilinear", align_corners=False)
    return value.clamp(0.0, 1.0)


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


def _pad_mode(height: int, width: int, amount: int) -> str:
    return "reflect" if amount < height and amount < width else "replicate"


def _gaussian_blur(value: torch.Tensor, sigma: float) -> torch.Tensor:
    if sigma <= 0.0 or min(value.shape[-2:]) <= 2:
        return value
    height, width = value.shape[-2:]
    radius = min(
        max(1, math.ceil(sigma * 3.0)),
        max(1, (min(height, width) - 1) // 2),
    )
    coordinates = torch.arange(-radius, radius + 1, device=value.device, dtype=value.dtype)
    kernel = torch.exp(-coordinates.square() / (2.0 * sigma * sigma))
    kernel = kernel / kernel.sum()
    channels = value.shape[1]
    horizontal = kernel.view(1, 1, 1, -1).expand(channels, 1, 1, -1)
    vertical = kernel.view(1, 1, -1, 1).expand(channels, 1, -1, 1)
    mode = _pad_mode(height, width, radius)
    value = F.pad(value, (radius, radius, 0, 0), mode=mode)
    value = F.conv2d(value, horizontal, groups=channels)
    value = F.pad(value, (0, 0, radius, radius), mode=mode)
    return F.conv2d(value, vertical, groups=channels)


def _gradient_magnitude(value: torch.Tensor) -> torch.Tensor:
    sobel_x = value.new_tensor(
        ((-1.0, 0.0, 1.0), (-2.0, 0.0, 2.0), (-1.0, 0.0, 1.0))
    ).view(1, 1, 3, 3)
    sobel_y = sobel_x.transpose(-1, -2)
    padded = F.pad(
        value,
        (1, 1, 1, 1),
        mode=_pad_mode(value.shape[-2], value.shape[-1], 1),
    )
    grad_x = F.conv2d(padded, sobel_x)
    grad_y = F.conv2d(padded, sobel_y)
    return torch.sqrt(grad_x.square() + grad_y.square() + 1e-8)


def _smoothstep(value: torch.Tensor, start: float, end: float) -> torch.Tensor:
    value = ((value - start) / max(end - start, _EPSILON)).clamp(0.0, 1.0)
    return value.square() * (3.0 - 2.0 * value)


def _detail_sigma(height: int, width: int) -> float:
    # Restore both fine and medium-fine detail. At the 2752px sample width
    # this is about 5.5px, large enough to recover real hair/skin/cloth detail
    # rather than behaving like a weak one-pixel sharpening filter.
    return max(2.00, min(6.00, min(height, width) / 500.0))


def _restore_micro_detail(
    original_rgb: torch.Tensor,
    relit_rgb: torch.Tensor,
    detail_strength: float,
    user_mask: torch.Tensor | None = None,
) -> tuple[torch.Tensor, torch.Tensor]:
    original_linear = _srgb_to_linear(original_rgb).clamp(0.0, 1.0)
    relit_linear = _srgb_to_linear(relit_rgb).clamp(0.0, 1.0)
    original_log_luma = torch.log(_luminance(original_linear).clamp_min(1e-4))
    relit_log_luma = torch.log(_luminance(relit_linear).clamp_min(1e-4))

    height, width = original_log_luma.shape[-2:]
    sigma = _detail_sigma(height, width)
    original_detail = original_log_luma - _gaussian_blur(original_log_luma, sigma)
    relit_detail = relit_log_luma - _gaussian_blur(relit_log_luma, sigma)

    # Structural comparison is used only to find proven conflicts. A missing
    # relit texture is not treated as a conflict: source detail remains trusted
    # by default so the node performs restoration instead of mild sharpening.
    structure_sigma = sigma * 2.4
    original_structure = original_log_luma - _gaussian_blur(
        original_log_luma, structure_sigma
    )
    relit_structure = relit_log_luma - _gaussian_blur(relit_log_luma, structure_sigma)
    correlation_sigma = sigma * 1.8
    cross = _gaussian_blur(original_structure * relit_structure, correlation_sigma)
    original_energy = _gaussian_blur(original_structure.square(), correlation_sigma)
    relit_energy = _gaussian_blur(relit_structure.square(), correlation_sigma)
    correlation = cross / torch.sqrt(original_energy * relit_energy + 1e-7)
    shared_structure = _smoothstep(
        torch.sqrt(torch.minimum(original_energy, relit_energy) + 1e-8),
        0.045,
        0.180,
    )
    correlation_safe = _smoothstep(
        correlation,
        _PRESET["correlation_safe_start"],
        _PRESET["correlation_safe_end"],
    )
    structure_conflict = (1.0 - correlation_safe) * shared_structure

    # Separate the local exposure difference before finding its edge. This
    # directly protects crisp new rim-light and shadow boundaries rather than
    # suppressing every normal source edge throughout the image.
    original_base = _gaussian_blur(original_log_luma, sigma * 0.85)
    relit_base = _gaussian_blur(relit_log_luma, sigma * 0.85)
    original_edge = _gradient_magnitude(original_base)
    relit_edge = _gradient_magnitude(relit_base)
    lighting_delta = _gaussian_blur(relit_log_luma - original_log_luma, sigma * 1.2)
    lighting_edge = _gradient_magnitude(lighting_delta)
    lighting_boundary = _smoothstep(
        lighting_edge,
        _PRESET["lighting_edge_start"],
        _PRESET["lighting_edge_end"],
    )

    # A large source-only contour is likely a shifted silhouette, not texture.
    # Fine source-only content is intentionally left alone and restored.
    source_only_edge = (original_edge - relit_edge * 1.15).clamp_min(0.0)
    source_boundary = _smoothstep(
        source_only_edge,
        _PRESET["source_only_edge_start"],
        _PRESET["source_only_edge_end"],
    )

    # Expand confirmed danger zones by a few pixels, then feather the switch.
    # Everything outside these zones receives the full original detail band.
    protection = torch.maximum(
        lighting_boundary,
        torch.maximum(structure_conflict, source_boundary),
    )
    radius = max(1, round(sigma * 0.9))
    kernel = radius * 2 + 1
    protection = F.max_pool2d(protection, kernel_size=kernel, stride=1, padding=radius)
    protection = _gaussian_blur(protection, sigma * 0.9).clamp(0.0, 1.0)
    restore_gate = 1.0 - protection
    if user_mask is not None:
        restore_gate = restore_gate * user_mask

    # Replace the complete high and medium-high frequency band with the source
    # band. This is the central behavior change from the conservative first
    # version, which only added a small amount of missing micro-contrast.
    detail_delta = (original_detail - relit_detail).clamp(
        -_PRESET["maximum_log_detail"], _PRESET["maximum_log_detail"]
    )
    delta = detail_delta * restore_gate * max(0.0, min(1.0, float(detail_strength)))

    # A shared linear-RGB gain changes only micro luminance contrast. The relit
    # image remains the source of color, low-frequency light, and every edge
    # that the confidence mask protected.
    gain = torch.exp(delta).clamp(0.66, 1.50)
    restored_linear = (relit_linear * gain).clamp(0.0, 1.0)
    restored = _linear_to_srgb(restored_linear).clamp(0.0, 1.0)
    if user_mask is not None:
        restored = torch.where(user_mask <= 0.0, relit_rgb, restored)
    restoration_mask = restore_gate * _smoothstep(detail_delta.abs(), 0.001, 0.035)
    return restored, restoration_mask[:, 0]


class MyDetailLightPreserve:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "original_image": (
                    "IMAGE",
                    {"tooltip": "已与打光图对齐，仅用于提供原图微纹理"},
                ),
                "relit_image": (
                    "IMAGE",
                    {"tooltip": "最终底片；颜色、光影、结构和输出尺寸均以此图为准"},
                ),
                "detail_restore_strength": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display": "slider",
                        "tooltip": "0 完全保持打光图，1 自动补回可信的原图微纹理",
                    },
                ),
            },
            "optional": {
                "detail_restore_mask": (
                    "MASK",
                    {
                        "tooltip": "白色恢复原图细节，黑色保留打光图，灰色按比例过渡",
                    },
                ),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("细节保光成片", "细节恢复区域")
    FUNCTION = "restore_detail"
    CATEGORY = "My-Comfnode/图像"
    DESCRIPTION = (
        "以打光图为底片，仅恢复两图结构一致区域的原图微纹理；"
        "自动保护轮廓光、投影边缘和错位轮廓，避免灰边、双边与割裂。"
    )

    def restore_detail(
        self,
        original_image: torch.Tensor,
        relit_image: torch.Tensor,
        detail_restore_strength: float = 1.0,
        detail_restore_mask: torch.Tensor | None = None,
    ):
        original = _ensure_image(original_image, "原图")
        relit = _ensure_image(relit_image, "打光图")
        original, relit = _match_batches(original, relit)
        strength = max(0.0, min(1.0, float(detail_restore_strength)))
        if strength == 0.0:
            mask = torch.zeros(relit.shape[:3], device=relit.device, dtype=torch.float32)
            return relit.clone(), mask

        output_dtype = relit.dtype
        relit_compute = relit.to(dtype=torch.float32).clamp(0.0, 1.0)
        original_compute = original.to(device=relit.device, dtype=torch.float32).clamp(0.0, 1.0)
        height, width = relit_compute.shape[1:3]
        relit_rgb = relit_compute[..., :3].permute(0, 3, 1, 2)
        original_rgb = original_compute[..., :3].permute(0, 3, 1, 2)
        original_rgb = _resize_nchw(original_rgb, (height, width)).clamp(0.0, 1.0)
        restore_mask = _prepare_restore_mask(
            detail_restore_mask,
            int(relit_compute.shape[0]),
            (height, width),
            relit.device,
        )
        if restore_mask is not None and not bool(torch.any(restore_mask > 0.0)):
            mask = torch.zeros(relit.shape[:3], device=relit.device, dtype=torch.float32)
            return relit.clone(), mask

        restored_rgb, restoration_mask = _restore_micro_detail(
            original_rgb,
            relit_rgb,
            strength,
            restore_mask,
        )
        output = relit.clone()
        output[..., :3] = restored_rgb.permute(0, 2, 3, 1).to(dtype=output_dtype)
        return output, restoration_mask


NODE_CLASS_MAPPINGS = {
    "MyDetailLightPreserve": MyDetailLightPreserve,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MyDetailLightPreserve": "My细节光影保留",
}
