from __future__ import annotations

import numpy as np
import torch
import torch.nn.functional as F

try:
    import cv2
except ImportError:  # pragma: no cover - ComfyUI runtime provides OpenCV
    cv2 = None


ALGORITHM_VERSION = "V1"
_EPSILON = 1e-5
_LUMA_WEIGHTS = np.array((0.2126, 0.7152, 0.0722), dtype=np.float32)


def _ensure_image(value: torch.Tensor, name: str) -> torch.Tensor:
    if not isinstance(value, torch.Tensor):
        raise TypeError(f"{name}必须是 ComfyUI IMAGE 张量")
    if value.ndim == 3:
        value = value.unsqueeze(0)
    if value.ndim != 4 or value.shape[-1] < 3:
        raise ValueError(f"{name}必须是 BHWC 图像，当前形状为 {tuple(value.shape)}")
    if min(value.shape[:3]) < 1:
        raise ValueError(f"{name}不能为空")
    return value


def _match_batches(original: torch.Tensor, relit: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    if original.shape[0] == relit.shape[0]:
        return original, relit
    if original.shape[0] == 1:
        return original.expand(relit.shape[0], -1, -1, -1), relit
    if relit.shape[0] == 1:
        return original, relit.expand(original.shape[0], -1, -1, -1)
    raise ValueError(
        "原图与 AI 打光图的批次数必须一致，或其中一侧只能有一张图；"
        f"当前为 {original.shape[0]} 与 {relit.shape[0]}"
    )


def _srgb_to_linear(value: np.ndarray) -> np.ndarray:
    return np.where(
        value <= 0.04045,
        value / 12.92,
        ((value + 0.055) / 1.055) ** 2.4,
    ).astype(np.float32)


def _linear_to_srgb(value: np.ndarray) -> np.ndarray:
    value = np.maximum(value, 0.0)
    return np.where(
        value <= 0.0031308,
        value * 12.92,
        1.055 * np.power(value, 1.0 / 2.4) - 0.055,
    ).astype(np.float32)


def _gaussian(value: np.ndarray, sigma: float) -> np.ndarray:
    if sigma <= 0.05:
        return value.astype(np.float32, copy=True)
    return cv2.GaussianBlur(
        value.astype(np.float32),
        (0, 0),
        sigmaX=float(sigma),
        sigmaY=float(sigma),
        borderType=cv2.BORDER_REFLECT101,
    )


def _luminance(value: np.ndarray) -> np.ndarray:
    return np.sum(value[..., :3] * _LUMA_WEIGHTS, axis=2).astype(np.float32)


def _robust_weighted_mean(value: np.ndarray, weight: np.ndarray) -> float:
    valid = np.isfinite(value) & np.isfinite(weight) & (weight > 1e-4)
    if not np.any(valid):
        return 0.0
    samples = value[valid].astype(np.float32)
    weights = weight[valid].astype(np.float32)
    if samples.size > 250_000:
        step = int(np.ceil(samples.size / 250_000))
        samples = samples[::step]
        weights = weights[::step]
    low, high = np.quantile(samples, (0.08, 0.92))
    samples = np.clip(samples, low, high)
    return float(np.sum(samples * weights) / max(float(np.sum(weights)), _EPSILON))


def _weighted_gaussian(value: np.ndarray, weight: np.ndarray, sigma: float) -> np.ndarray:
    numerator = _gaussian(value * weight, sigma)
    denominator = _gaussian(weight, sigma)
    global_value = _robust_weighted_mean(value, weight)
    local_value = numerator / np.maximum(denominator, 0.02)
    local_confidence = np.clip(denominator / 0.12, 0.0, 1.0)
    return local_value * local_confidence + global_value * (1.0 - local_confidence)


def _prepare_mask(
    value: torch.Tensor | None,
    batch: int,
    height: int,
    width: int,
) -> np.ndarray | None:
    if value is None:
        return None
    if not isinstance(value, torch.Tensor):
        raise TypeError("作用遮罩必须是 ComfyUI MASK 张量")
    if value.ndim == 2:
        value = value.unsqueeze(0)
    if value.ndim == 4 and value.shape[-1] == 1:
        value = value[..., 0]
    if value.ndim != 3:
        raise ValueError(f"作用遮罩必须是 BHW 张量，当前形状为 {tuple(value.shape)}")
    if value.shape[0] == 1 and batch > 1:
        value = value.expand(batch, -1, -1)
    elif value.shape[0] != batch:
        raise ValueError("作用遮罩批次数必须与输出一致，或遮罩只能有一张")
    value = F.interpolate(
        value.float().unsqueeze(1),
        size=(height, width),
        mode="bilinear",
        align_corners=False,
    )[:, 0]
    return value.clamp(0.0, 1.0).cpu().numpy().astype(np.float32)


def _estimate_light_fields(
    original_srgb: np.ndarray,
    relit_srgb: np.ndarray,
    detail: float,
    color_strength: float,
    edge_cleanliness: float,
    closure: float,
) -> tuple[np.ndarray, np.ndarray]:
    height, width = relit_srgb.shape[:2]
    original_small = cv2.resize(original_srgb, (width, height), interpolation=cv2.INTER_AREA)
    original_linear = _srgb_to_linear(np.clip(original_small, 0.0, 1.0))
    relit_linear = _srgb_to_linear(np.clip(relit_srgb, 0.0, 1.0))

    original_luma = np.maximum(_luminance(original_linear), 0.003)
    relit_luma = np.maximum(_luminance(relit_linear), 0.003)
    raw_exposure = np.log(relit_luma) - np.log(original_luma)

    scale = float(max(height, width))
    broad_sigma = max(12.0, scale / 58.0)
    medium_sigma = max(2.0, scale / 430.0)
    fine_sigma = max(0.8, scale / 1450.0)
    broad = _gaussian(raw_exposure, broad_sigma)
    medium = _gaussian(raw_exposure, medium_sigma)
    fine = _gaussian(raw_exposure, fine_sigma)

    detail = float(np.clip(detail, 0.0, 1.0))
    exposure = broad + detail * (medium - broad)
    fine_amount = np.clip((detail - 0.55) / 0.45, 0.0, 1.0)

    # Very fine AI redraw differences are rejected, while coherent hard-light edges survive.
    original_texture = np.log(original_luma) - _gaussian(np.log(original_luma), fine_sigma * 1.7)
    relit_texture = np.log(relit_luma) - _gaussian(np.log(relit_luma), fine_sigma * 1.7)
    mismatch = _gaussian(np.abs(original_texture - relit_texture), fine_sigma)
    reliability = np.exp(-mismatch / (0.055 + 0.16 * (1.0 - edge_cleanliness)))
    exposure += fine_amount * reliability * (fine - medium)

    sigma_space = max(3.0, medium_sigma * 1.6)
    sigma_color = 0.08 + 0.28 * (1.0 - float(np.clip(edge_cleanliness, 0.0, 1.0)))
    exposure = cv2.bilateralFilter(
        exposure.astype(np.float32),
        d=0,
        sigmaColor=sigma_color,
        sigmaSpace=sigma_space,
        borderType=cv2.BORDER_REFLECT101,
    )

    original_max = np.max(original_linear, axis=2)
    original_min = np.min(original_linear, axis=2)
    relit_max = np.max(relit_linear, axis=2)
    relit_min = np.min(relit_linear, axis=2)
    original_saturation = (original_max - original_min) / np.maximum(original_max, 0.025)
    relit_saturation = (relit_max - relit_min) / np.maximum(relit_max, 0.025)
    saturation_agreement = np.exp(-np.abs(relit_saturation - original_saturation) / 0.24)
    neutral_surface = np.exp(-original_saturation / 0.20)
    brightness_confidence = np.clip((np.minimum(original_luma, relit_luma) - 0.008) / 0.055, 0.0, 1.0)
    clipping_confidence = np.clip((0.985 - np.maximum(original_max, relit_max)) / 0.08, 0.0, 1.0)
    clipping_confidence = np.maximum(clipping_confidence, 0.22)
    color_reliability = (
        reliability
        * saturation_agreement
        * neutral_surface
        * brightness_confidence
        * clipping_confidence
    )

    original_lab = cv2.cvtColor(original_small.astype(np.float32), cv2.COLOR_RGB2LAB)
    relit_lab = cv2.cvtColor(relit_srgb.astype(np.float32), cv2.COLOR_RGB2LAB)
    raw_lab_delta = np.clip(relit_lab[..., 1:3] - original_lab[..., 1:3], -42.0, 42.0)

    color_sigma = max(28.0, scale / 24.0)
    highlight_samples = np.clip((raw_exposure - 0.07) / 0.24, 0.0, 1.0)
    ambient_samples = 1.0 - np.clip((raw_exposure - 0.02) / 0.18, 0.0, 1.0)

    highlight_color = np.stack(
        [
            _weighted_gaussian(
                raw_lab_delta[..., channel],
                color_reliability * highlight_samples,
                color_sigma,
            )
            for channel in range(2)
        ],
        axis=2,
    )
    ambient_color = np.stack(
        [
            _weighted_gaussian(
                raw_lab_delta[..., channel],
                color_reliability * ambient_samples,
                color_sigma,
            )
            for channel in range(2)
        ],
        axis=2,
    )
    highlight_gate = np.clip((exposure - 0.035) / 0.30, 0.0, 1.0)
    highlight_gate = highlight_gate * highlight_gate * (3.0 - 2.0 * highlight_gate)
    color_delta = (
        ambient_color * (1.0 - highlight_gate[..., None])
        + highlight_color * highlight_gate[..., None]
    )
    color_delta *= float(np.clip(color_strength, 0.0, 1.5))

    if closure > 0.0:
        simulated = original_linear * np.exp(np.clip(exposure[..., None], -2.4, 1.7))
        simulated_luma = np.maximum(_luminance(simulated), 0.003)
        residual = np.log(relit_luma) - np.log(simulated_luma)
        exposure += float(closure) * _gaussian(residual, medium_sigma)

    return np.clip(exposure, -2.25, 1.55), np.clip(color_delta, -30.0, 30.0)


def _redeem_one(
    original: np.ndarray,
    relit: np.ndarray,
    strength: float,
    detail: float,
    color_strength: float,
    edge_cleanliness: float,
    closure: float,
    mask: np.ndarray | None,
) -> tuple[np.ndarray, np.ndarray]:
    original_rgb = np.clip(original[..., :3].astype(np.float32), 0.0, 1.0)
    relit_rgb = np.clip(relit[..., :3].astype(np.float32), 0.0, 1.0)
    if float(strength) <= 0.0:
        preview = np.full_like(original_rgb, 0.5, dtype=np.float32)
        return original.astype(np.float32, copy=True), preview
    exposure, color_delta = _estimate_light_fields(
        original_rgb,
        relit_rgb,
        detail,
        color_strength,
        edge_cleanliness,
        closure,
    )

    height, width = original_rgb.shape[:2]
    exposure_full = cv2.resize(exposure, (width, height), interpolation=cv2.INTER_CUBIC)
    if mask is not None:
        exposure_full *= mask

    original_linear = _srgb_to_linear(original_rgb)
    strength = float(np.clip(strength, 0.0, 1.5))
    gain = np.exp(np.clip(strength * exposure_full, -2.5, 1.8))[..., None]
    output_linear = original_linear * gain
    output_rgb = np.clip(_linear_to_srgb(output_linear), 0.0, 1.0)

    output_lab = cv2.cvtColor(output_rgb.astype(np.float32), cv2.COLOR_RGB2LAB)
    for channel in range(2):
        delta_full = cv2.resize(
            color_delta[..., channel], (width, height), interpolation=cv2.INTER_CUBIC
        )
        if mask is not None:
            delta_full *= mask
        output_lab[..., channel + 1] += strength * delta_full
    output_rgb = np.clip(cv2.cvtColor(output_lab, cv2.COLOR_LAB2RGB), 0.0, 1.0)
    if mask is not None:
        output_rgb = output_rgb * mask[..., None] + original_rgb * (1.0 - mask[..., None])
    if original.shape[2] > 3:
        output = np.concatenate((output_rgb, original[..., 3:]), axis=2)
    else:
        output = output_rgb

    preview_exposure = cv2.resize(exposure, (width, height), interpolation=cv2.INTER_CUBIC)
    preview_delta = np.stack(
        [
            cv2.resize(color_delta[..., channel], (width, height), interpolation=cv2.INTER_CUBIC)
            for channel in range(2)
        ],
        axis=2,
    )
    preview_lab = np.empty((height, width, 3), dtype=np.float32)
    preview_lab[..., 0] = np.clip(52.0 + 18.0 * preview_exposure, 0.0, 100.0)
    preview_lab[..., 1:] = preview_delta
    preview = np.clip(cv2.cvtColor(preview_lab, cv2.COLOR_LAB2RGB), 0.0, 1.0)
    return output.astype(np.float32), preview.astype(np.float32)


class MyLightRedemption:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "原图": ("IMAGE", {"tooltip": "提供最终尺寸、真实结构和全部高分辨率纹理"}),
                "AI打光图": ("IMAGE", {"tooltip": "只用于反求光照、阴影、高光和色温，不直接复制其像素"}),
                "光影强度": (
                    "FLOAT",
                    {"default": 1.0, "min": 0.0, "max": 1.5, "step": 0.01, "display": "slider"},
                ),
                "光影细节": (
                    "FLOAT",
                    {"default": 0.82, "min": 0.0, "max": 1.0, "step": 0.01, "display": "slider"},
                ),
                "光色保留": (
                    "FLOAT",
                    {"default": 1.0, "min": 0.0, "max": 1.5, "step": 0.01, "display": "slider"},
                ),
                "杂边抑制": (
                    "FLOAT",
                    {"default": 0.78, "min": 0.0, "max": 1.0, "step": 0.01, "display": "slider"},
                ),
                "闭环校准": (
                    "FLOAT",
                    {"default": 0.65, "min": 0.0, "max": 1.0, "step": 0.01, "display": "slider"},
                ),
            },
            "optional": {
                "作用遮罩": ("MASK", {"tooltip": "白色应用 AI 光影，黑色保持原图不变"}),
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("4K保光成片", "光照场预览")
    FUNCTION = "redeem_light"
    CATEGORY = "My-Comfnode/图像"
    DESCRIPTION = (
        "以原图作为高分辨率底片，从低分辨率 AI 打光图反求多尺度光照场并闭环校准。"
        "不放大或迁移 AI 图细节，不调用旧式细节还原方案。"
    )

    def redeem_light(
        self,
        原图,
        AI打光图,
        光影强度,
        光影细节,
        光色保留,
        杂边抑制,
        闭环校准,
        作用遮罩=None,
    ):
        if cv2 is None:
            raise RuntimeError("My光的救赎需要 OpenCV（cv2）")
        original = _ensure_image(原图, "原图")
        relit = _ensure_image(AI打光图, "AI打光图")
        original, relit = _match_batches(original, relit)
        batch, height, width = original.shape[:3]
        original_ratio = width / max(height, 1)
        relit_ratio = relit.shape[2] / max(relit.shape[1], 1)
        ratio_error = abs(original_ratio - relit_ratio) / max(original_ratio, _EPSILON)
        if ratio_error > 0.015:
            raise ValueError(
                "原图与 AI 打光图的宽高比不一致，无法可靠还原同一位置的光影；"
                f"当前原图为 {width}×{height}，AI 图为 {relit.shape[2]}×{relit.shape[1]}。"
                "请先使用同画幅、同构图的两张图。"
            )
        masks = _prepare_mask(作用遮罩, batch, height, width)

        outputs = []
        previews = []
        original_cpu = original.detach().cpu().float().numpy()
        relit_cpu = relit.detach().cpu().float().numpy()
        for index in range(batch):
            output, preview = _redeem_one(
                original_cpu[index],
                relit_cpu[index],
                光影强度,
                光影细节,
                光色保留,
                杂边抑制,
                闭环校准,
                None if masks is None else masks[index],
            )
            outputs.append(torch.from_numpy(output))
            previews.append(torch.from_numpy(preview))

        result = torch.stack(outputs).to(device=original.device, dtype=original.dtype)
        preview = torch.stack(previews).to(device=original.device, dtype=original.dtype)
        return result, preview


NODE_CLASS_MAPPINGS = {"MyLightRedemption": MyLightRedemption}
NODE_DISPLAY_NAME_MAPPINGS = {"MyLightRedemption": "My光的救赎"}
