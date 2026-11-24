from __future__ import annotations

import numpy as np
import torch
import torch.nn.functional as F

try:
    import cv2
except ImportError:  # pragma: no cover - ComfyUI runtime provides OpenCV
    cv2 = None


ALGORITHM_VERSION = "V5"
_EPSILON = 1e-6
_ANALYSIS_MAX = 1536
_LUMA_WEIGHTS = np.array((0.2126, 0.7152, 0.0722), np.float32)


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


def _prepare_mask(
    value: torch.Tensor | None,
    batch: int,
    height: int,
    width: int,
    device: torch.device,
) -> torch.Tensor | None:
    if value is None:
        return None
    if not isinstance(value, torch.Tensor):
        raise TypeError("光影范围遮罩必须是 ComfyUI MASK 张量")
    if value.ndim == 2:
        value = value.unsqueeze(0)
    if value.ndim == 4 and value.shape[-1] == 1:
        value = value[..., 0]
    if value.ndim != 3 or min(value.shape) < 1:
        raise ValueError(f"光影范围遮罩必须是 BHW 张量，当前形状为 {tuple(value.shape)}")
    if value.shape[0] == 1 and batch > 1:
        value = value.expand(batch, -1, -1)
    elif value.shape[0] != batch:
        raise ValueError(
            "光影范围遮罩批次数量必须与输出一致，或遮罩只能有一张；"
            f"当前为 {value.shape[0]} 与 {batch}"
        )
    value = value.to(device=device, dtype=torch.float32).unsqueeze(1)
    if value.shape[-2:] != (height, width):
        value = F.interpolate(value, size=(height, width), mode="bilinear", align_corners=False)
    return value[:, 0].clamp(0.0, 1.0)


def _smoothstep(value: np.ndarray, start: float, end: float) -> np.ndarray:
    scaled = np.clip((value - start) / max(end - start, _EPSILON), 0.0, 1.0)
    return scaled * scaled * (3.0 - 2.0 * scaled)


def _srgb_to_linear(value: np.ndarray) -> np.ndarray:
    return np.where(
        value <= 0.04045,
        value / 12.92,
        ((value + 0.055) / 1.055) ** 2.4,
    ).astype(np.float32)


def _linear_to_srgb(value: np.ndarray) -> np.ndarray:
    return np.where(
        value <= 0.0031308,
        value * 12.92,
        1.055 * np.maximum(value, 0.0) ** (1.0 / 2.4) - 0.055,
    ).astype(np.float32)


def _luminance(linear_rgb: np.ndarray) -> np.ndarray:
    return (linear_rgb[..., :3] @ _LUMA_WEIGHTS).astype(np.float32)


def _resize_cover(source: np.ndarray, height: int, width: int) -> np.ndarray:
    source_height, source_width = source.shape[:2]
    source_ratio = source_width / source_height
    target_ratio = width / height
    if source_ratio > target_ratio:
        crop_width = max(1, round(source_height * target_ratio))
        left = max(0, (source_width - crop_width) // 2)
        source = source[:, left : left + crop_width]
    elif source_ratio < target_ratio:
        crop_height = max(1, round(source_width / target_ratio))
        top = max(0, (source_height - crop_height) // 2)
        source = source[top : top + crop_height]
    if source.shape[:2] == (height, width):
        return source.astype(np.float32, copy=True)
    interpolation = cv2.INTER_AREA if source.shape[0] > height else cv2.INTER_LANCZOS4
    return cv2.resize(source, (width, height), interpolation=interpolation).astype(np.float32)


def _flow_gray(rgb: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(
        (np.clip(rgb, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8),
        cv2.COLOR_RGB2GRAY,
    )
    return cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)


def _new_dis():
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    dis.setUseSpatialPropagation(True)
    return dis


def _global_smooth(guide: np.ndarray, value: np.ndarray, strength: float, sigma: float):
    if hasattr(cv2, "ximgproc") and hasattr(cv2.ximgproc, "fastGlobalSmootherFilter"):
        return cv2.ximgproc.fastGlobalSmootherFilter(
            guide,
            value.astype(np.float32),
            strength,
            sigma,
            lambda_attenuation=0.25,
            num_iter=3,
        )
    return cv2.GaussianBlur(value.astype(np.float32), (0, 0), max(4.0, sigma))


def _guided_refine(guide: np.ndarray, value: np.ndarray, radius: int) -> np.ndarray:
    if hasattr(cv2, "ximgproc") and hasattr(cv2.ximgproc, "guidedFilter"):
        return cv2.ximgproc.guidedFilter(
            guide.astype(np.float32),
            value.astype(np.float32),
            radius=max(1, int(radius)),
            eps=2e-4,
        )
    return cv2.bilateralFilter(value.astype(np.float32), 0, 0.10, max(2.0, radius))


def _extract_light_fields(
    original: np.ndarray, relit: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict[str, float]]:
    height, width = original.shape[:2]
    reference = _resize_cover(relit, height, width)
    scale = min(1.0, _ANALYSIS_MAX / max(height, width))
    small_width = max(48, round(width * scale))
    small_height = max(48, round(height * scale))
    size = (small_width, small_height)
    original_small = cv2.resize(original, size, interpolation=cv2.INTER_AREA)
    reference_small = cv2.resize(reference, size, interpolation=cv2.INTER_AREA)

    if min(height, width) < 48:
        aligned_reference = reference_small
        flow_confidence = np.ones((small_height, small_width), np.float32)
    else:
        original_gray = _flow_gray(original_small)
        reference_gray = _flow_gray(reference_small)
        forward = _new_dis().calc(original_gray, reference_gray, None)
        backward = _new_dis().calc(reference_gray, original_gray, None)
        grid_x, grid_y = np.meshgrid(
            np.arange(small_width, dtype=np.float32),
            np.arange(small_height, dtype=np.float32),
        )
        map_x = grid_x + forward[..., 0]
        map_y = grid_y + forward[..., 1]
        aligned_reference = cv2.remap(
            reference_small,
            map_x,
            map_y,
            interpolation=cv2.INTER_CUBIC,
            borderMode=cv2.BORDER_REFLECT101,
        )
        backward_at_forward = cv2.remap(
            backward,
            map_x,
            map_y,
            interpolation=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT,
        )
        consistency_error = np.linalg.norm(forward + backward_at_forward, axis=2)
        flow_confidence = 1.0 - _smoothstep(consistency_error, 0.75, 4.5)
        valid = (
            (map_x >= 1.0)
            & (map_y >= 1.0)
            & (map_x <= small_width - 2.0)
            & (map_y <= small_height - 2.0)
        )
        flow_confidence *= valid.astype(np.float32)
        flow_confidence = cv2.GaussianBlur(flow_confidence.astype(np.float32), (0, 0), 1.0)

    original_linear = _srgb_to_linear(original_small)
    reference_linear = _srgb_to_linear(np.clip(aligned_reference, 0.0, 1.0))
    original_luma = _luminance(original_linear)
    reference_luma = _luminance(reference_linear)
    raw = np.log(np.maximum(reference_luma, 1e-5)) - np.log(
        np.maximum(original_luma, 1e-5)
    )
    raw = cv2.medianBlur(np.clip(raw, -1.5, 2.5).astype(np.float32), 5)

    guide = (np.clip(original_small, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
    base = _global_smooth(guide, raw, 2600.0, 10.0)
    residual = raw - base
    highlight = (
        _smoothstep(raw, 0.18, 0.75)
        * _smoothstep(residual, 0.07, 0.35)
        * _smoothstep(reference_luma, 0.04, 0.22)
    )
    shadow = (
        _smoothstep(-raw, 0.18, 0.70)
        * _smoothstep(-residual, 0.06, 0.30)
        * _smoothstep(original_luma, 0.03, 0.18)
    )
    sharp_light = highlight + shadow - highlight * shadow
    sharp_light *= 0.20 + 0.80 * flow_confidence
    sharp_light = cv2.GaussianBlur(sharp_light.astype(np.float32), (0, 0), 0.8)
    light_field_small = np.clip(base + residual * sharp_light, -1.5, 2.5)

    # Relit RGB is never copied. Only a heavily smoothed and bounded color
    # illumination field is retained, preventing dirty skin and color speckles.
    rgb_ratio = np.log(np.maximum(reference_linear, 0.006)) - np.log(
        np.maximum(original_linear, 0.006)
    )
    color_field = rgb_ratio - raw[..., None]
    color_field = np.stack(
        [_global_smooth(guide, color_field[..., channel], 9000.0, 16.0) for channel in range(3)],
        axis=2,
    )
    color_field = np.clip(color_field, -0.22, 0.22)
    color_field -= np.sum(
        color_field * _LUMA_WEIGHTS[None, None, :], axis=2, keepdims=True
    )

    light_field = cv2.resize(light_field_small, (width, height), interpolation=cv2.INTER_CUBIC)
    original_full_linear = _srgb_to_linear(original)
    original_full_luma = _luminance(original_full_linear)
    radius = max(4, round(max(height, width) / 700))
    light_field = _guided_refine(original_full_luma, light_field, radius)
    color_field = cv2.resize(color_field, (width, height), interpolation=cv2.INTER_CUBIC)
    color_field = cv2.GaussianBlur(color_field, (0, 0), max(1.2, radius * 0.8))
    sharp_mask = cv2.resize(sharp_light, (width, height), interpolation=cv2.INTER_CUBIC)
    metrics = {
        "flow_confidence": float(np.mean(flow_confidence)),
        "sharp_light_fraction": float(np.mean(sharp_light > 0.10)),
    }
    return light_field, color_field, np.clip(sharp_mask, 0.0, 1.0), metrics


def _apply_light_fields(
    original: np.ndarray,
    light_field: np.ndarray,
    color_field: np.ndarray,
    strength: float,
    user_mask: np.ndarray | None,
) -> tuple[np.ndarray, np.ndarray]:
    amount = float(np.clip(strength, 0.0, 1.0))
    spatial = np.ones(original.shape[:2], np.float32)
    if user_mask is not None:
        spatial = np.clip(user_mask, 0.0, 1.0)
    amount_map = spatial * amount
    original_linear = _srgb_to_linear(original)
    original_luma = _luminance(original_linear)
    colored = original_linear * np.exp(color_field * (0.50 * amount_map[..., None]))
    colored_luma = np.maximum(_luminance(colored), 1e-6)
    desired_luma = np.clip(
        original_luma * np.exp(light_field * amount_map),
        0.0,
        1.0,
    )
    scaled = colored * (desired_luma / colored_luma)[..., None]
    neutral = np.repeat(desired_luma[..., None], 3, axis=2)
    chroma = scaled - neutral
    positive_limit = (1.0 - neutral) / np.maximum(chroma, 1e-6)
    negative_limit = neutral / np.maximum(-chroma, 1e-6)
    channel_limit = np.where(
        chroma > 1e-6,
        positive_limit,
        np.where(chroma < -1e-6, negative_limit, 1.0),
    )
    chroma_scale = np.clip(channel_limit.min(axis=2, keepdims=True), 0.0, 1.0)
    output_linear = np.clip(neutral + chroma * chroma_scale, 0.0, 1.0)
    output = np.clip(_linear_to_srgb(output_linear), 0.0, 1.0)
    if user_mask is not None:
        output = np.where(user_mask[..., None] <= 0.0, original, output)
    change = np.maximum(
        _smoothstep(np.abs(light_field), 0.005, 0.12),
        _smoothstep(np.linalg.norm(color_field, axis=2), 0.005, 0.08),
    )
    return output.astype(np.float32), (change * spatial).astype(np.float32)


def _restore_one(
    original: np.ndarray,
    relit: np.ndarray,
    strength: float,
    user_mask: np.ndarray | None,
) -> tuple[np.ndarray, np.ndarray, dict[str, float]]:
    light_field, color_field, _, metrics = _extract_light_fields(original, relit)
    output, mask = _apply_light_fields(
        original,
        light_field,
        color_field,
        strength,
        user_mask,
    )
    original_log = np.log(np.maximum(_luminance(_srgb_to_linear(original)), 1e-4))
    output_log = np.log(np.maximum(_luminance(_srgb_to_linear(output)), 1e-4))
    sigma = max(2.0, min(original.shape[:2]) / 300.0)
    original_detail = original_log - cv2.GaussianBlur(original_log, (0, 0), sigma)
    output_detail = output_log - cv2.GaussianBlur(output_log, (0, 0), sigma)
    metrics["detail_correlation"] = float(
        np.corrcoef(original_detail.ravel(), output_detail.ravel())[0, 1]
    )
    return output, mask, metrics


class MyHighFidelityDetailRestore:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "original_image": (
                    "IMAGE",
                    {"tooltip": "最终底片；五官、肤色、发丝、衣料和输出尺寸全部来自原图"},
                ),
                "relit_image": (
                    "IMAGE",
                    {"tooltip": "只提供对齐后的明暗、平滑光色和光线边界，不复制人物像素"},
                ),
                "detail_restore_strength": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display": "slider",
                        "tooltip": "0 逐像素返回原图，1 在原图质量上应用完整光影",
                    },
                ),
            },
            "optional": {
                "detail_restore_mask": (
                    "MASK",
                    {"tooltip": "白色应用光影，黑色逐像素保持原图"},
                ),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("原图质量光影成片", "光影应用区域")
    FUNCTION = "restore_detail"
    CATEGORY = "My-Comfnode/图像"
    DESCRIPTION = (
        "以原图为最终底片，只从打光图提取明暗、平滑光色和可信锐光边界；"
        "不复制打光图人物像素，保持原图五官、肤色和真实细节。"
    )

    def restore_detail(
        self,
        original_image: torch.Tensor,
        relit_image: torch.Tensor,
        detail_restore_strength: float = 1.0,
        detail_restore_mask: torch.Tensor | None = None,
    ):
        if cv2 is None:
            raise RuntimeError("My光影高保真细节还原需要 OpenCV（cv2）")
        original = _ensure_image(original_image, "原图")
        relit = _ensure_image(relit_image, "打光图")
        original, relit = _match_batches(original, relit)
        strength = float(np.clip(detail_restore_strength, 0.0, 1.0))
        if strength == 0.0:
            mask = torch.zeros(original.shape[:3], device=original.device, dtype=torch.float32)
            return original.clone(), mask

        output_dtype = original.dtype
        original_compute = original.to(dtype=torch.float32).clamp(0.0, 1.0)
        relit_compute = relit.to(dtype=torch.float32).clamp(0.0, 1.0)
        batch, height, width = original_compute.shape[:3]
        user_mask = _prepare_mask(
            detail_restore_mask,
            int(batch),
            int(height),
            int(width),
            original.device,
        )
        if user_mask is not None and not bool(torch.any(user_mask > 0.0)):
            mask = torch.zeros(original.shape[:3], device=original.device, dtype=torch.float32)
            return original.clone(), mask

        outputs = []
        masks = []
        for index in range(int(batch)):
            original_np = original_compute[index, ..., :3].detach().cpu().numpy()
            relit_np = relit_compute[index, ..., :3].detach().cpu().numpy()
            mask_np = None if user_mask is None else user_mask[index].detach().cpu().numpy()
            output_np, output_mask, _ = _restore_one(
                original_np,
                relit_np,
                strength,
                mask_np,
            )
            outputs.append(torch.from_numpy(output_np))
            masks.append(torch.from_numpy(output_mask))

        restored_rgb = torch.stack(outputs).to(device=original.device, dtype=output_dtype)
        output_mask = torch.stack(masks).to(device=original.device, dtype=torch.float32)
        output = original.clone()
        output[..., :3] = restored_rgb
        return output, output_mask


NODE_CLASS_MAPPINGS = {
    "MyHighFidelityDetailRestore": MyHighFidelityDetailRestore,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MyHighFidelityDetailRestore": "My光影高保真细节还原",
}
