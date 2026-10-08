from __future__ import annotations

import base64
import io
import json
import math
from typing import Any

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFilter

import nodes


MAX_RESOLUTION = nodes.MAX_RESOLUTION

BLEND_MODES = [
    "正常",
    "正片叠底",
    "滤色",
    "叠加",
    "柔光",
    "强光",
    "变暗",
    "变亮",
]

SIZE_MODES = ["按背景宽度百分比", "保持贴图原尺寸"]
RESAMPLE_MODES = ["高质量", "较快"]
MASK_MODES = ["白色透明(适合LoadImage透明PNG)", "白色可见"]


def _as_batch_index(tensor: torch.Tensor, index: int) -> torch.Tensor:
    return tensor[min(index, max(0, tensor.shape[0] - 1))]


def _image_to_rgba_array(image: torch.Tensor) -> np.ndarray:
    array = image.detach().cpu().float().numpy()
    if array.ndim != 3 or array.shape[-1] < 3:
        raise ValueError(f"图像必须是 HWC RGB/RGBA，当前形状是 {tuple(array.shape)}")
    array = np.clip(array, 0.0, 1.0)
    if array.shape[-1] >= 4:
        rgba = array[..., :4]
    else:
        alpha = np.ones(array.shape[:2] + (1,), dtype=np.float32)
        rgba = np.concatenate([array[..., :3], alpha], axis=-1)
    return rgba.astype(np.float32, copy=False)


def _mask_to_array(mask: torch.Tensor, width: int, height: int) -> np.ndarray:
    array = mask.detach().cpu().float().numpy()
    if array.ndim == 3:
        array = array[0] if array.shape[0] == 1 else array
    if array.ndim != 2:
        raise ValueError(f"贴图遮罩必须是 HW，当前形状是 {tuple(array.shape)}")
    array = np.clip(array, 0.0, 1.0)
    if array.shape != (height, width):
        pil = Image.fromarray((array * 255.0 + 0.5).astype(np.uint8))
        pil = pil.resize((width, height), Image.Resampling.BILINEAR)
        array = np.asarray(pil, dtype=np.float32) / 255.0
    return array


def _rgba_to_pil(rgba: np.ndarray) -> Image.Image:
    return Image.fromarray((np.clip(rgba, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8))


def _pil_to_rgba_array(image: Image.Image) -> np.ndarray:
    return np.asarray(image.convert("RGBA"), dtype=np.float32) / 255.0


def _resize_and_rotate_overlay(
    texture: np.ndarray,
    background_width: int,
    size_mode: str,
    width_percent: float,
    scale_percent: float,
    rotation: float,
    resample_mode: str,
) -> np.ndarray:
    tex_h, tex_w = texture.shape[:2]
    if tex_w <= 0 or tex_h <= 0:
        raise ValueError("贴图尺寸无效")

    if size_mode == "保持贴图原尺寸":
        base_scale = 1.0
    else:
        base_scale = max(0.001, background_width * max(width_percent, 0.01) / 100.0 / tex_w)
    scale = base_scale * max(scale_percent, 0.01) / 100.0
    target_w = max(1, int(round(tex_w * scale)))
    target_h = max(1, int(round(tex_h * scale)))

    resample = Image.Resampling.LANCZOS if resample_mode == "高质量" else Image.Resampling.BILINEAR
    pil = _rgba_to_pil(texture)
    if (target_w, target_h) != pil.size:
        pil = pil.resize((target_w, target_h), resample)
    if abs(float(rotation)) > 0.0001:
        pil = pil.rotate(float(rotation), resample=Image.Resampling.BICUBIC, expand=True)
    return _pil_to_rgba_array(pil)


def _soft_light(base: np.ndarray, top: np.ndarray) -> np.ndarray:
    low = base - (1.0 - 2.0 * top) * base * (1.0 - base)
    high = base + (2.0 * top - 1.0) * (np.sqrt(np.maximum(base, 0.0)) - base)
    return np.where(top <= 0.5, low, high)


def _blend_rgb(base: np.ndarray, top: np.ndarray, mode: str) -> np.ndarray:
    if mode == "正片叠底":
        return base * top
    if mode == "滤色":
        return 1.0 - (1.0 - base) * (1.0 - top)
    if mode == "叠加":
        return np.where(base <= 0.5, 2.0 * base * top, 1.0 - 2.0 * (1.0 - base) * (1.0 - top))
    if mode == "柔光":
        return _soft_light(base, top)
    if mode == "强光":
        return np.where(top <= 0.5, 2.0 * base * top, 1.0 - 2.0 * (1.0 - base) * (1.0 - top))
    if mode == "变暗":
        return np.minimum(base, top)
    if mode == "变亮":
        return np.maximum(base, top)
    return top


def _composite_one(
    background: torch.Tensor,
    texture: torch.Tensor,
    texture_mask: torch.Tensor | None,
    background_mask: torch.Tensor | None,
    center_x: int,
    center_y: int,
    size_mode: str,
    width_percent: float,
    scale_percent: float,
    rotation: float,
    opacity_percent: float,
    blend_mode: str,
    edge_feather: float,
    resample_mode: str,
    mask_mode: str,
) -> tuple[torch.Tensor, torch.Tensor]:
    bg = _image_to_rgba_array(background)
    tex = _image_to_rgba_array(texture)
    bg_h, bg_w = bg.shape[:2]
    tex_h, tex_w = tex.shape[:2]

    if texture_mask is not None:
        mask_alpha = _mask_to_array(texture_mask, tex_w, tex_h)
        if mask_mode == "白色可见":
            tex[..., 3] *= mask_alpha
        else:
            tex[..., 3] *= 1.0 - mask_alpha

    overlay = _resize_and_rotate_overlay(
        tex,
        bg_w,
        size_mode,
        width_percent,
        scale_percent,
        rotation,
        resample_mode,
    )
    alpha = overlay[..., 3]
    if edge_feather > 0:
        alpha_pil = Image.fromarray((alpha * 255.0 + 0.5).astype(np.uint8))
        alpha = np.asarray(alpha_pil.filter(ImageFilter.GaussianBlur(radius=float(edge_feather))), dtype=np.float32) / 255.0

    alpha = np.clip(alpha * (max(0.0, min(100.0, opacity_percent)) / 100.0), 0.0, 1.0)
    out = bg[..., :3].copy()
    full_mask = np.zeros((bg_h, bg_w), dtype=np.float32)

    place_center_x = bg_w / 2.0 + float(center_x)
    place_center_y = bg_h / 2.0 + float(center_y)
    left = int(round(place_center_x - overlay.shape[1] / 2.0))
    top = int(round(place_center_y - overlay.shape[0] / 2.0))
    right = left + overlay.shape[1]
    bottom = top + overlay.shape[0]

    dst_x0 = max(left, 0)
    dst_y0 = max(top, 0)
    dst_x1 = min(right, bg_w)
    dst_y1 = min(bottom, bg_h)
    if dst_x1 <= dst_x0 or dst_y1 <= dst_y0:
        return (
            torch.from_numpy(out).to(device=background.device, dtype=background.dtype),
            torch.from_numpy(full_mask).to(device=background.device, dtype=background.dtype),
        )

    src_x0 = dst_x0 - left
    src_y0 = dst_y0 - top
    src_x1 = src_x0 + (dst_x1 - dst_x0)
    src_y1 = src_y0 + (dst_y1 - dst_y0)

    base_crop = out[dst_y0:dst_y1, dst_x0:dst_x1, :]
    top_crop = overlay[src_y0:src_y1, src_x0:src_x1, :3]
    alpha_crop = alpha[src_y0:src_y1, src_x0:src_x1][..., None]
    if background_mask is not None:
        target_mask = _mask_to_array(background_mask, bg_w, bg_h)
        alpha_crop = alpha_crop * target_mask[dst_y0:dst_y1, dst_x0:dst_x1, None]
    blended = _blend_rgb(base_crop, top_crop, blend_mode)
    out[dst_y0:dst_y1, dst_x0:dst_x1, :] = base_crop * (1.0 - alpha_crop) + blended * alpha_crop
    full_mask[dst_y0:dst_y1, dst_x0:dst_x1] = np.maximum(
        full_mask[dst_y0:dst_y1, dst_x0:dst_x1],
        alpha_crop[..., 0],
    )

    return (
        torch.from_numpy(np.clip(out, 0.0, 1.0)).to(device=background.device, dtype=background.dtype),
        torch.from_numpy(np.clip(full_mask, 0.0, 1.0)).to(device=background.device, dtype=background.dtype),
    )


def _preview_data_url(image: torch.Tensor, max_edge: int = 1280, format_name: str = "JPEG") -> str:
    array = _image_to_rgba_array(image)
    pil = _rgba_to_pil(array)
    pil.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    if format_name == "PNG" or "A" in pil.getbands() and pil.getchannel("A").getextrema() != (255, 255):
        pil.save(buffer, format="PNG", compress_level=4)
        mime = "image/png"
    else:
        pil.convert("RGB").save(buffer, format="JPEG", quality=88, subsampling=1, optimize=True)
        mime = "image/jpeg"
    return f"data:{mime};base64,{base64.b64encode(buffer.getvalue()).decode('ascii')}"


def _parse_transform_data(value: Any, background_width: int, background_height: int) -> dict[str, Any]:
    data: Any = value
    if isinstance(value, str):
        text = value.strip()
        if text:
            try:
                data = json.loads(text)
            except json.JSONDecodeError:
                data = {}
        else:
            data = {}
    if not isinstance(data, dict):
        data = {}

    layer = data.get("currentLayer_1") if isinstance(data.get("currentLayer_1"), dict) else data
    offset = layer.get("offset", [0.3, 0.3])
    scale = layer.get("scale", [0.4, 0.4])
    rotation = layer.get("rotation", 0.0)
    raw_corners = layer.get("corners")
    corners: list[list[float]] | None = None
    if isinstance(raw_corners, (list, tuple)) and len(raw_corners) == 4:
        try:
            candidate = [
                [max(0.0, min(1.0, float(point[0]))), max(0.0, min(1.0, float(point[1])))]
                for point in raw_corners
                if isinstance(point, (list, tuple)) and len(point) >= 2
            ]
            if len(candidate) == 4:
                corners = candidate
        except (TypeError, ValueError):
            corners = None
    if not isinstance(offset, (list, tuple)) or len(offset) < 2:
        offset = [0.3, 0.3]
    if not isinstance(scale, (list, tuple)) or len(scale) < 2:
        scale = [0.4, 0.4]
    try:
        offset = [float(offset[0]), float(offset[1])]
        scale = [max(0.001, abs(float(scale[0]))), max(0.001, abs(float(scale[1])))]
        rotation = float(rotation)
    except (TypeError, ValueError):
        offset, scale, rotation = [0.3, 0.3], [0.4, 0.4], 0.0
    return {
        "offset": offset,
        "scale": scale,
        "rotation": rotation,
        "free_transform": bool(layer.get("free_transform", False) and corners),
        "corners": corners,
        "depth_strength": float(data.get("depth_strength", data.get("depthStrength", 0.08)) or 0.08),
    }


def _layer_transform(value: Any, layer_index: int, background_width: int, background_height: int) -> dict[str, Any]:
    state = _parse_transform_data(value, background_width, background_height)
    if isinstance(value, str):
        try:
            value = json.loads(value) if value.strip() else {}
        except json.JSONDecodeError:
            value = {}
    if isinstance(value, dict):
        candidate = value.get(f"currentLayer_{layer_index}")
        if isinstance(candidate, dict):
            state.update(_parse_transform_data(candidate, background_width, background_height))
    return state


def _surface_crop(
    surface: np.ndarray | None,
    left: int,
    top: int,
    width: int,
    height: int,
    background_width: int,
    background_height: int,
) -> np.ndarray | None:
    """Sample the background-space surface under the placed overlay."""
    if surface is None:
        return None
    source = np.asarray(surface, dtype=np.float32)
    if source.shape != (background_height, background_width):
        pil = Image.fromarray(np.clip(source * 255.0, 0, 255).astype(np.uint8))
        pil = pil.resize((background_width, background_height), Image.Resampling.BILINEAR)
        source = np.asarray(pil, dtype=np.float32) / 255.0
    xs = np.clip(np.arange(left, left + width), 0, background_width - 1)
    ys = np.clip(np.arange(top, top + height), 0, background_height - 1)
    return source[np.ix_(ys, xs)]


def _depth_warp_overlay(overlay: np.ndarray, depth: np.ndarray | None, strength: float) -> np.ndarray:
    if depth is None or overlay.shape[0] < 2 or overlay.shape[1] < 2:
        return overlay
    height, width = overlay.shape[:2]
    amount_strength = max(0.0, min(1.0, float(strength)))
    if amount_strength <= 0.0001:
        return overlay
    depth_image = Image.fromarray(np.clip(depth * 255.0, 0, 255).astype(np.uint8))
    if depth_image.size != (width, height):
        depth_image = depth_image.resize((width, height), Image.Resampling.BILINEAR)
    # Use a low-frequency depth field as a continuous radial scale field.
    # Unlike a raw gradient displacement this cannot make individual logo
    # strokes jump in different directions, so transparent anti-aliased
    # artwork stays intact while broad torso curvature is retained.
    blur_radius = max(2.0, min(width, height) * 0.035)
    local_depth = np.asarray(depth_image.filter(ImageFilter.GaussianBlur(radius=blur_radius)), dtype=np.float32) / 255.0
    visible_depth = local_depth[np.isfinite(local_depth)]
    low, high = np.percentile(visible_depth, [10, 90]) if visible_depth.size else (0.0, 1.0)
    depth_range = max(float(high - low), 0.05)
    depth_field = np.clip((local_depth - (low + high) * 0.5) / depth_range, -1.0, 1.0)
    gain = amount_strength * 0.18
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
    center_x = (width - 1.0) * 0.5
    center_y = (height - 1.0) * 0.5
    scale_x = np.clip(1.0 + gain * depth_field, 0.82, 1.18)
    scale_y = np.clip(1.0 + gain * 0.45 * depth_field, 0.90, 1.10)
    source_x_raw = center_x + (xx - center_x) / scale_x
    source_y_raw = center_y + (yy - center_y) / scale_y
    source_x = np.clip(source_x_raw, 0, width - 1)
    source_y = np.clip(source_y_raw, 0, height - 1)
    x0 = np.floor(source_x).astype(np.int32)
    y0 = np.floor(source_y).astype(np.int32)
    x1 = np.minimum(x0 + 1, width - 1)
    y1 = np.minimum(y0 + 1, height - 1)
    wx = source_x - x0
    wy = source_y - y0
    alpha = np.clip(overlay[..., 3:4], 0.0, 1.0)
    premultiplied = np.concatenate([overlay[..., :3] * alpha, alpha], axis=2)
    warped = (
        premultiplied[y0, x0] * (1 - wx)[..., None] * (1 - wy)[..., None]
        + premultiplied[y0, x1] * wx[..., None] * (1 - wy)[..., None]
        + premultiplied[y1, x0] * (1 - wx)[..., None] * wy[..., None]
        + premultiplied[y1, x1] * wx[..., None] * wy[..., None]
    )
    visible = warped[..., 3:4]
    warped[..., :3] = np.where(visible > 1e-5, warped[..., :3] / np.maximum(visible, 1e-5), 0.0)
    return np.clip(warped, 0.0, 1.0).astype(np.float32)


def _defringe_rgba(overlay: np.ndarray, iterations: int = 3) -> np.ndarray:
    """Remove bright RGB hidden under translucent edge pixels.

    Transparent PNGs often carry white RGB outside the artwork.  Resampling
    keeps that RGB beneath a small alpha value, which appears as a bright halo
    on dark or colored garments.  Propagate the nearest stronger-alpha color
    into the translucent fringe while preserving alpha itself.
    """
    if overlay.size == 0 or overlay.shape[-1] < 4:
        return overlay
    result = overlay.copy()
    alpha = np.clip(result[..., 3], 0.0, 1.0)
    for _ in range(max(1, int(iterations))):
        best_alpha = alpha.copy()
        best_rgb = result[..., :3].copy()
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            padded_alpha = np.pad(alpha, ((1, 1), (1, 1)), mode="constant")
            padded_rgb = np.pad(result[..., :3], ((1, 1), (1, 1), (0, 0)), mode="constant")
            y0 = 1 + dy
            x0 = 1 + dx
            neighbor_alpha = padded_alpha[y0:y0 + alpha.shape[0], x0:x0 + alpha.shape[1]]
            neighbor_rgb = padded_rgb[y0:y0 + alpha.shape[0], x0:x0 + alpha.shape[1]]
            replace = neighbor_alpha > best_alpha + 1e-4
            best_alpha[replace] = neighbor_alpha[replace]
            best_rgb[replace] = neighbor_rgb[replace]
        result[..., :3] = np.where((alpha < 0.75)[..., None], best_rgb, result[..., :3])
    return np.clip(result, 0.0, 1.0).astype(np.float32)


def _apply_surface_shading(
    overlay: np.ndarray,
    surface_luminance: np.ndarray | None,
    strength: float,
) -> np.ndarray:
    """Transfer garment lighting without moving or resampling sticker pixels.

    A broad luminance normalization alone makes a print look pasted on and can
    over-darken one side of the artwork.  Split the signal into a softly
    blurred base light and a local fold-detail ratio.  Both are multiplicative
    RGB adjustments; alpha and geometry remain byte-for-byte aligned.
    """
    if surface_luminance is None or overlay.size == 0:
        return overlay
    height, width = overlay.shape[:2]
    if surface_luminance.shape != (height, width):
        pil = Image.fromarray(np.clip(surface_luminance * 255.0, 0, 255).astype(np.uint8))
        pil = pil.resize((width, height), Image.Resampling.BILINEAR)
        surface_luminance = np.asarray(pil, dtype=np.float32) / 255.0
    visible = overlay[..., 3] > 0.01
    samples = surface_luminance[visible] if np.any(visible) else surface_luminance.reshape(-1)
    low, high = np.percentile(samples, [5, 95])
    if high - low < 0.005:
        return overlay

    # A radius around 2.5% of the shorter sticker side removes broad garment
    # illumination while keeping seams and fabric folds in the detail layer.
    blur_radius = max(2.0, min(height, width) * 0.025)
    luminance_image = Image.fromarray(
        np.clip(surface_luminance * 255.0, 0, 255).astype(np.uint8)
    )
    blurred = np.asarray(
        luminance_image.filter(ImageFilter.GaussianBlur(radius=blur_radius)),
        dtype=np.float32,
    ) / 255.0

    amount = max(0.0, min(1.0, float(strength)))
    base_normalized = np.clip((blurred - low) / max(high - low, 0.005), 0.0, 1.0)
    # Log-ratio is symmetric for highlights and shadows and does not create
    # row discontinuities.  Limit it so hard mask/background edges cannot
    # punch holes into the print.
    fold_detail = np.clip(
        np.log((surface_luminance + 0.04) / (blurred + 0.04)),
        -0.30,
        0.24,
    )
    # Keep broad garment volume and the local fold detail visible through the
    # print.  The previous gain was too conservative for a white shirt, so
    # the logo looked like a flat sticker even when the depth/luminance map
    # contained clear creases.
    base_light = 1.0 + (base_normalized - 0.55) * (0.22 * amount)
    fold_light = np.exp(fold_detail * (2.85 * amount))
    shade = np.clip(base_light * fold_light, 0.62, 1.32)
    result = overlay.copy()
    result[..., :3] = np.clip(result[..., :3] * shade[..., None], 0.0, 1.0)
    return result


def _skew_overlay(overlay: np.ndarray, skew_x: float, skew_y: float) -> np.ndarray:
    skew_x = max(-1.0, min(1.0, float(skew_x)))
    skew_y = max(-1.0, min(1.0, float(skew_y)))
    if abs(skew_x) < 0.0001 and abs(skew_y) < 0.0001:
        return overlay
    height, width = overlay.shape[:2]
    inverse = np.linalg.pinv(np.array([[1.0, skew_x], [skew_y, 1.0]], dtype=np.float32))
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
    centered = np.stack([xx - (width - 1) / 2.0, yy - (height - 1) / 2.0], axis=-1)
    source = centered @ inverse.T
    source_x = source[..., 0] + (width - 1) / 2.0
    source_y = source[..., 1] + (height - 1) / 2.0
    valid = (source_x >= 0) & (source_x <= width - 1) & (source_y >= 0) & (source_y <= height - 1)
    source_x = np.clip(source_x, 0, width - 1)
    source_y = np.clip(source_y, 0, height - 1)
    x0, y0 = np.floor(source_x).astype(np.int32), np.floor(source_y).astype(np.int32)
    x1, y1 = np.minimum(x0 + 1, width - 1), np.minimum(y0 + 1, height - 1)
    wx, wy = source_x - x0, source_y - y0
    warped = (
        overlay[y0, x0] * (1 - wx)[..., None] * (1 - wy)[..., None]
        + overlay[y0, x1] * wx[..., None] * (1 - wy)[..., None]
        + overlay[y1, x0] * (1 - wx)[..., None] * wy[..., None]
        + overlay[y1, x1] * wx[..., None] * wy[..., None]
    )
    warped[~valid] = 0.0
    return np.clip(warped, 0.0, 1.0).astype(np.float32)


def _resize_overlay(texture: np.ndarray, width: int, height: int, rotation: float, resample_mode: str) -> np.ndarray:
    pil = _rgba_to_pil(texture).resize(
        (max(1, int(width)), max(1, int(height))),
        Image.Resampling.LANCZOS if resample_mode == "高质量" else Image.Resampling.BILINEAR,
    )
    if abs(rotation) > 0.0001:
        pil = pil.rotate(float(rotation), resample=Image.Resampling.BICUBIC, expand=True)
    return _pil_to_rgba_array(pil)


def _quad_is_usable(corners: np.ndarray) -> bool:
    if corners.shape != (4, 2) or not np.all(np.isfinite(corners)):
        return False
    signs: list[float] = []
    area = 0.0
    for index in range(4):
        current = corners[index]
        next_point = corners[(index + 1) % 4]
        after = corners[(index + 2) % 4]
        if float(np.linalg.norm(next_point - current)) < 2.0:
            return False
        edge = next_point - current
        following = after - next_point
        cross = float(edge[0] * following[1] - edge[1] * following[0])
        if abs(cross) < 1e-3:
            return False
        signs.append(math.copysign(1.0, cross))
        area += float(current[0] * next_point[1] - next_point[0] * current[1])
    return all(sign == signs[0] for sign in signs) and abs(area) > 4.0


def _warp_overlay_to_quad(
    texture: np.ndarray,
    normalized_corners: list[list[float]],
    background_width: int,
    background_height: int,
) -> tuple[np.ndarray, int, int]:
    """Project an RGBA texture into a convex four-point quadrilateral."""
    corners = np.asarray(normalized_corners, dtype=np.float64)
    corners[:, 0] *= float(background_width)
    corners[:, 1] *= float(background_height)
    if not _quad_is_usable(corners):
        raise ValueError("自由变换的四个角点必须组成有效的凸四边形")

    left = int(math.floor(float(corners[:, 0].min())))
    top = int(math.floor(float(corners[:, 1].min())))
    right = int(math.ceil(float(corners[:, 0].max())))
    bottom = int(math.ceil(float(corners[:, 1].max())))
    out_width = max(1, right - left)
    out_height = max(1, bottom - top)
    local = corners - np.array([left, top], dtype=np.float64)

    source_height, source_width = texture.shape[:2]
    source = np.array(
        [[0.0, 0.0], [source_width - 1.0, 0.0], [source_width - 1.0, source_height - 1.0], [0.0, source_height - 1.0]],
        dtype=np.float64,
    )
    # Render the projective warp at a supersampled size, then reduce with
    # Lanczos.  A single BICUBIC pass loses the narrow side of a strongly
    # angled quad and shows up as blocky pixels in the distance.
    render_scale = 2 if max(out_width, out_height) < 1800 else 1
    render_width = out_width * render_scale
    render_height = out_height * render_scale
    render_local = local * float(render_scale)
    matrix: list[list[float]] = []
    values: list[float] = []
    for (x, y), (u, v) in zip(render_local, source):
        matrix.append([x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y])
        values.append(float(u))
        matrix.append([0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y])
        values.append(float(v))
    coefficients = np.linalg.solve(np.asarray(matrix, dtype=np.float64), np.asarray(values, dtype=np.float64))

    # Warp premultiplied RGB to avoid dark fringes around transparent artwork.
    alpha = np.clip(texture[..., 3:4], 0.0, 1.0)
    premultiplied = np.concatenate([np.clip(texture[..., :3], 0.0, 1.0) * alpha, alpha], axis=2)
    pil = Image.fromarray((premultiplied * 255.0 + 0.5).astype(np.uint8))
    warped_pil = pil.transform(
        (render_width, render_height),
        Image.Transform.PERSPECTIVE,
        data=tuple(float(item) for item in coefficients),
        # Pillow's projective transformer supports BICUBIC (not LANCZOS);
        # the supersampled reduction below supplies the final Lanczos pass.
        resample=Image.Resampling.BICUBIC,
        fillcolor=(0, 0, 0, 0),
    )
    polygon_mask = Image.new("L", (render_width, render_height), 0)
    ImageDraw.Draw(polygon_mask).polygon([tuple(point) for point in render_local], fill=255)
    warped = np.asarray(warped_pil, dtype=np.float32) / 255.0
    if render_scale > 1:
        warped_pil = warped_pil.resize((out_width, out_height), Image.Resampling.LANCZOS)
        polygon_mask = polygon_mask.resize((out_width, out_height), Image.Resampling.LANCZOS)
        warped = np.asarray(warped_pil, dtype=np.float32) / 255.0
    warped[..., 3] *= np.asarray(polygon_mask, dtype=np.float32) / 255.0
    visible = warped[..., 3:4]
    warped[..., :3] = np.where(visible > 1e-5, warped[..., :3] / np.maximum(visible, 1e-5), 0.0)
    return np.clip(warped, 0.0, 1.0).astype(np.float32), left, top


def _apply_standard_alpha_mask(texture: np.ndarray, transparent_mask: torch.Tensor | None) -> np.ndarray:
    """Apply the MASK emitted by ComfyUI Load Image to an RGBA texture.

    Core Load Image represents transparent pixels as white in its MASK output
    (MASK = 1 - source alpha).  IMAGE itself is RGB-only, so without this
    input a transparent PNG would otherwise be composited as an opaque
    rectangle.
    """
    if transparent_mask is None:
        return texture
    height, width = texture.shape[:2]
    visible_alpha = 1.0 - _mask_to_array(transparent_mask, width, height)
    result = texture.copy()
    result[..., 3] *= np.clip(visible_alpha, 0.0, 1.0)
    return result


def _paste_overlay(
    background: torch.Tensor,
    overlay: np.ndarray,
    background_mask: torch.Tensor | None,
    left: int,
    top: int,
    opacity: float = 1.0,
    blend_mode: str = "normal",
) -> tuple[torch.Tensor, torch.Tensor]:
    base = np.clip(background.detach().cpu().float().numpy(), 0.0, 1.0)
    height, width = base.shape[:2]
    out_mask = np.zeros((height, width), dtype=np.float32)
    right = left + overlay.shape[1]
    bottom = top + overlay.shape[0]
    dst_x0, dst_y0 = max(left, 0), max(top, 0)
    dst_x1, dst_y1 = min(right, width), min(bottom, height)
    if dst_x1 <= dst_x0 or dst_y1 <= dst_y0:
        return background, torch.zeros((height, width), device=background.device, dtype=background.dtype)

    src_x0, src_y0 = dst_x0 - left, dst_y0 - top
    src_x1, src_y1 = src_x0 + dst_x1 - dst_x0, src_y0 + dst_y1 - dst_y0
    alpha = overlay[src_y0:src_y1, src_x0:src_x1, 3:4] * max(0.0, min(1.0, float(opacity)))
    if background_mask is not None:
        mask = _mask_to_array(background_mask, width, height)
        # Preserve RMBG's full antialiased silhouette. The previous inward
        # threshold visibly exposed a strip of the sleeve/torso at the edge.
        # Reject only the faintest outside halo, matching the browser preview.
        mask = np.clip((mask - 0.08) / 0.84, 0.0, 1.0)
        mask = mask * mask * (3.0 - 2.0 * mask)
        alpha = alpha * mask[dst_y0:dst_y1, dst_x0:dst_x1, None]
    base_crop = base[dst_y0:dst_y1, dst_x0:dst_x1, :3]
    top_crop = overlay[src_y0:src_y1, src_x0:src_x1, :3]
    mode_map = {
        "normal": "正常", "multiply": "正片叠底", "screen": "滤色", "overlay": "叠加",
        "darken": "变暗", "lighten": "变亮", "soft-light": "柔光", "hard-light": "强光",
    }
    blended = _blend_rgb(base_crop, top_crop, mode_map.get(blend_mode, "正常"))
    if blend_mode == "color-dodge":
        blended = np.minimum(1.0, base_crop / np.maximum(1.0 - top_crop, 0.001))
    elif blend_mode == "color-burn":
        blended = 1.0 - np.minimum(1.0, (1.0 - base_crop) / np.maximum(top_crop, 0.001))
    elif blend_mode == "hologram":
        screen = 1.0 - (1.0 - base_crop) * (1.0 - top_crop)
        blended = np.clip(screen * 0.7 + _soft_light(base_crop, top_crop) * 0.3, 0.0, 1.0)
    base[dst_y0:dst_y1, dst_x0:dst_x1, :3] = base_crop * (1.0 - alpha) + blended * alpha
    out_mask[dst_y0:dst_y1, dst_x0:dst_x1] = alpha[..., 0]
    return (
        torch.from_numpy(np.clip(base[..., :3], 0.0, 1.0)).to(background.device, background.dtype),
        torch.from_numpy(out_mask).to(background.device, background.dtype),
    )


def _apply_texture_erase_strokes(
    texture: np.ndarray,
    strokes: list[dict[str, Any]],
) -> np.ndarray:
    """Erase the source texture alpha in texture-local UV coordinates.

    The modified alpha is transformed together with the sticker, so moving or
    changing perspective cannot reveal pixels that were already erased.
    """
    if not strokes:
        return texture
    height, width = texture.shape[:2]
    combined = np.zeros((height, width), dtype=np.float32)

    def draw_path(target: Image.Image, points: list[tuple[float, float]], line_width: int, fill: int) -> None:
        draw = ImageDraw.Draw(target)
        radius = max(0.5, line_width / 2.0)
        if len(points) > 1:
            draw.line(points, fill=fill, width=max(1, line_width), joint="curve")
        for x, y in points:
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=fill)

    for stroke in strokes:
        raw_points = stroke.get("points") if isinstance(stroke, dict) else None
        if not isinstance(raw_points, list) or not raw_points:
            continue
        points: list[tuple[float, float]] = []
        for point in raw_points:
            if not isinstance(point, (list, tuple)) or len(point) < 2:
                continue
            points.append((
                max(0.0, min(1.0, float(point[0]))) * width,
                max(0.0, min(1.0, float(point[1]))) * height,
            ))
        if not points:
            continue
        radius = max(0.75, float(stroke.get("size", 0.01)) * width / 2.0)
        hardness = max(0.0, min(1.0, float(stroke.get("hardness", 100.0)) / 100.0))
        core_radius = radius * (0.08 + hardness ** 1.55 * 0.78)
        soft = Image.new("L", (width, height), 0)
        draw_path(soft, points, max(1, int(round(radius * 2.0))), 255)
        soft = soft.filter(ImageFilter.GaussianBlur(max(0.35, radius - core_radius)))
        core = Image.new("L", (width, height), 0)
        draw_path(core, points, max(1, int(round(core_radius * 2.0))), 255)
        stroke_mask = np.maximum(
            np.asarray(soft, dtype=np.float32) / 255.0,
            np.asarray(core, dtype=np.float32) / 255.0,
        )
        combined = 1.0 - (1.0 - combined) * (1.0 - stroke_mask)

    result = texture.copy()
    result[..., 3] *= np.clip(1.0 - combined, 0.0, 1.0)
    return result


def _apply_screen_erase_strokes(
    overlay: np.ndarray,
    strokes: list[dict[str, Any]],
    left: int,
    top: int,
    background_width: int,
    background_height: int,
) -> np.ndarray:
    """Erase after depth projection in background coordinates.

    Keeping eraser points in screen space makes the cursor land on the same
    pixels before and after perspective/depth deformation.
    """
    if not strokes:
        return overlay
    width, height = overlay.shape[1], overlay.shape[0]
    combined = np.zeros((height, width), dtype=np.float32)

    def draw_path(target: Image.Image, points: list[tuple[float, float]], line_width: int, fill: int) -> None:
        draw = ImageDraw.Draw(target)
        radius = max(0.5, line_width / 2.0)
        if len(points) > 1:
            draw.line(points, fill=fill, width=max(1, line_width), joint="curve")
        for x, y in points:
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=fill)

    for stroke in strokes:
        raw_points = stroke.get("points") if isinstance(stroke, dict) else None
        if not isinstance(raw_points, list) or not raw_points:
            continue
        points: list[tuple[float, float]] = []
        for point in raw_points:
            if not isinstance(point, (list, tuple)) or len(point) < 2:
                continue
            points.append((
                float(point[0]) * background_width - left,
                float(point[1]) * background_height - top,
            ))
        if not points:
            continue
        radius = max(0.5, float(stroke.get("size", 0.01)) * background_width / 2.0)
        hardness = max(0.0, min(1.0, float(stroke.get("hardness", 100.0)) / 100.0))
        if hardness >= 0.96:
            hard = Image.new("L", (width, height), 0)
            draw_path(hard, points, int(round(radius * 2.0)), 255)
            combined = np.maximum(combined, np.asarray(hard, dtype=np.float32) / 255.0)
            continue

        center_strength = 0.34 + hardness * 0.66
        core_radius = radius * (0.06 + hardness ** 1.7 * 0.70)
        mid_radius = radius * (0.48 + hardness * 0.18)
        soft = Image.new("L", (width, height), 0)
        draw_path(soft, points, max(1, int(round(mid_radius * 2.0))), int(round(center_strength * 0.32 * 255)))
        soft = soft.filter(ImageFilter.GaussianBlur(max(0.5, radius - mid_radius)))
        core = Image.new("L", (width, height), 0)
        draw_path(core, points, max(1, int(round(core_radius * 2.0))), int(round(center_strength * 255)))
        stroke_mask = np.maximum(
            np.asarray(soft, dtype=np.float32) / 255.0,
            np.asarray(core, dtype=np.float32) / 255.0,
        )
        combined = 1.0 - (1.0 - combined) * (1.0 - stroke_mask)

    result = overlay.copy()
    result[..., 3] *= np.clip(1.0 - combined, 0.0, 1.0)
    return result


class MyTexture:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "bg_img": ("IMAGE",),
                "bg_depth_map": ("IMAGE",),
                "bg_mask": ("MASK",),
                "fg_img_1": ("IMAGE",),
                "形变强度": ("FLOAT", {"default": 0.3, "min": 0.0, "max": 1.0, "step": 0.01}),
                "透明度": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "水平倾斜": ("FLOAT", {"default": 0.0, "min": -1.0, "max": 1.0, "step": 0.01}),
                "垂直倾斜": ("FLOAT", {"default": 0.0, "min": -1.0, "max": 1.0, "step": 0.01}),
                "水平拉伸": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 3.0, "step": 0.1}),
                "垂直拉伸": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 3.0, "step": 0.1}),
                "混合模式": (["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "soft-light", "hard-light", "hologram"], {"default": "normal"}),
                # Hidden by the frontend, but serialized as a normal widget so
                # the interactive preview transform reaches queue execution.
                "t_data": ("STRING", {"default": "", "multiline": False}),
            },
            "optional": {
                "fg_img_2": ("IMAGE", {"forceInput": True}),
                "fg_alpha_mask_1": ("MASK", {"forceInput": True}),
                "fg_alpha_mask_2": ("MASK", {"forceInput": True}),
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING", "MASK")
    RETURN_NAMES = ("image", "l_data", "贴图遮罩")
    FUNCTION = "apply_texture"
    CATEGORY = "My-Comfnode/图像"
    DESCRIPTION = "按背景图、深度图、变换数据、背景遮罩和两层前景贴图进行深度贴图合成。"

    def apply_texture(self, **kwargs: Any):
        background = kwargs.get("bg_img")
        texture = kwargs.get("fg_img_1")
        texture_2 = kwargs.get("fg_img_2")
        texture_alpha_mask_1 = kwargs.get("fg_alpha_mask_1")
        texture_alpha_mask_2 = kwargs.get("fg_alpha_mask_2")
        background_mask = kwargs.get("bg_mask")
        depth_map = kwargs.get("bg_depth_map")
        transform_data = kwargs.get("t_data", "")
        try:
            transform_payload = json.loads(transform_data) if str(transform_data or "").strip() else {}
        except (json.JSONDecodeError, TypeError):
            transform_payload = {}
        erase_strokes = transform_payload.get("erase_strokes", []) if isinstance(transform_payload, dict) else []
        if not isinstance(erase_strokes, list):
            erase_strokes = []
        erase_space = str(transform_payload.get("erase_space", "screen")) if isinstance(transform_payload, dict) else "screen"
        deformation = max(0.0, min(1.0, float(kwargs.get("形变强度", 0.3))))
        opacity = max(0.0, min(1.0, float(kwargs.get("透明度", 1.0))))
        skew_x = max(-1.0, min(1.0, float(kwargs.get("水平倾斜", 0.0))))
        skew_y = max(-1.0, min(1.0, float(kwargs.get("垂直倾斜", 0.0))))
        stretch_x = max(0.1, min(3.0, float(kwargs.get("水平拉伸", 1.0))))
        stretch_y = max(0.1, min(3.0, float(kwargs.get("垂直拉伸", 1.0))))
        blend_mode = str(kwargs.get("混合模式", "normal"))
        if background is None or texture is None:
            raise ValueError("bg_img 和 fg_img_1 不能为空")

        batch_count = max(
            background.shape[0],
            texture.shape[0],
            texture_2.shape[0] if texture_2 is not None else 1,
            texture_alpha_mask_1.shape[0] if texture_alpha_mask_1 is not None else 1,
            texture_alpha_mask_2.shape[0] if texture_alpha_mask_2 is not None else 1,
            background_mask.shape[0] if background_mask is not None else 1,
            depth_map.shape[0] if depth_map is not None else 1,
        )
        images = []
        masks = []
        for index in range(batch_count):
            bg_item = _as_batch_index(background, index)
            depth_item = _as_batch_index(depth_map, index) if depth_map is not None else None
            background_mask_item = _as_batch_index(background_mask, index) if background_mask is not None else None
            image = bg_item[..., :3].clone()
            mask = torch.zeros(bg_item.shape[:2], device=bg_item.device, dtype=bg_item.dtype)
            layers = [(texture, texture_alpha_mask_1)]
            if texture_2 is not None:
                layers.append((texture_2, texture_alpha_mask_2))
            layer_records = []
            for layer_index, (layer_texture, layer_alpha_mask) in enumerate(layers, 1):
                state = _layer_transform(transform_data, layer_index, bg_item.shape[1], bg_item.shape[0])
                rgba = _image_to_rgba_array(_as_batch_index(layer_texture, index))
                alpha_mask_item = _as_batch_index(layer_alpha_mask, index) if layer_alpha_mask is not None else None
                rgba = _apply_standard_alpha_mask(rgba, alpha_mask_item)
                if erase_space == "texture":
                    rgba = _apply_texture_erase_strokes(rgba, erase_strokes)
                target_width = max(1, int(round(bg_item.shape[1] * state["scale"][0] * stretch_x)))
                # Preserve the texture's own aspect ratio.  scale_x/scale_y
                # remain independent multipliers, but a wide transparent PNG
                # must not be stretched into the background's portrait ratio.
                target_height = max(1, int(round(
                    bg_item.shape[1] * (rgba.shape[0] / max(1, rgba.shape[1])) * state["scale"][1] * stretch_y
                )))
                overlay = _resize_overlay(rgba, target_width, target_height, state["rotation"], "高质量")
                left = int(round(state["offset"][0] * bg_item.shape[1]))
                top = int(round(state["offset"][1] * bg_item.shape[0]))
                depth_clip_polygon = None
                if state.get("free_transform") and state.get("corners"):
                    overlay, left, top = _warp_overlay_to_quad(
                        rgba,
                        state["corners"],
                        bg_item.shape[1],
                        bg_item.shape[0],
                    )
                    depth_clip_polygon = np.asarray(state["corners"], dtype=np.float64)
                    depth_clip_polygon[:, 0] *= float(bg_item.shape[1])
                    depth_clip_polygon[:, 1] *= float(bg_item.shape[0])
                    depth_clip_polygon -= np.asarray([left, top], dtype=np.float64)

                if not state.get("free_transform"):
                    overlay = _skew_overlay(overlay, skew_x, skew_y)
                # Preserve transparent room around the projected artwork.  A
                # depth scale can move edge strokes outside the original quad;
                # warping inside a tightly cropped array would cut them off.
                depth_padding = max(4, int(math.ceil(max(overlay.shape[:2]) * deformation * 0.12)))
                if deformation > 0.0001:
                    overlay = np.pad(
                        overlay,
                        ((depth_padding, depth_padding), (depth_padding, depth_padding), (0, 0)),
                        mode="constant",
                        constant_values=0.0,
                    )
                    left -= depth_padding
                    top -= depth_padding
                    if depth_clip_polygon is not None:
                        depth_clip_polygon += float(depth_padding)

                depth_array = None
                if depth_item is not None:
                    depth_array = _image_to_rgba_array(depth_item)[..., :3].mean(axis=2)
                local_depth = _surface_crop(
                    depth_array,
                    left,
                    top,
                    overlay.shape[1],
                    overlay.shape[0],
                    bg_item.shape[1],
                    bg_item.shape[0],
                )

                background_rgba = _image_to_rgba_array(bg_item)
                background_luminance = (
                    background_rgba[..., 0] * 0.2126
                    + background_rgba[..., 1] * 0.7152
                    + background_rgba[..., 2] * 0.0722
                )
                local_luminance = _surface_crop(
                    background_luminance,
                    left,
                    top,
                    overlay.shape[1],
                    overlay.shape[0],
                    bg_item.shape[1],
                    bg_item.shape[0],
                )

                # Apply the smooth depth-field curvature after the quad
                # transform, then transfer fold lighting without changing
                # alpha.  The depth field is deliberately low frequency.
                overlay = _depth_warp_overlay(overlay, local_depth, deformation)
                overlay = _apply_surface_shading(overlay, local_luminance, deformation)
                overlay = _defringe_rgba(overlay)
                if depth_clip_polygon is not None:
                    # The depth warp uses transparent padding so edge strokes
                    # can deform cleanly. Clip after that warp so no visible
                    # pixel can escape the user's four-point paste boundary.
                    aa_scale = 4
                    mask_size = (overlay.shape[1] * aa_scale, overlay.shape[0] * aa_scale)
                    clip_mask = Image.new("L", mask_size, 0)
                    polygon = [tuple(point * aa_scale) for point in depth_clip_polygon]
                    ImageDraw.Draw(clip_mask).polygon(polygon, fill=255)
                    clip_mask = clip_mask.resize(
                        (overlay.shape[1], overlay.shape[0]),
                        Image.Resampling.LANCZOS,
                    )
                    overlay[..., 3] *= np.asarray(clip_mask, dtype=np.float32) / 255.0
                if erase_space != "texture":
                    overlay = _apply_screen_erase_strokes(
                        overlay,
                        erase_strokes,
                        left,
                        top,
                        bg_item.shape[1],
                        bg_item.shape[0],
                    )
                image, layer_mask = _paste_overlay(
                    image, overlay, background_mask_item,
                    left,
                    top,
                    opacity,
                    blend_mode,
                )
                mask = torch.maximum(mask, layer_mask)
                layer_records.append({
                    "offset": state["offset"],
                    "scale": state["scale"],
                    "rotation": state["rotation"],
                    "free_transform": state.get("free_transform", False),
                    "corners": state.get("corners"),
                })
            images.append(image)
            masks.append(mask)

        result_image = torch.stack(images, dim=0)
        result_mask = torch.stack(masks, dim=0)
        first_bg = _as_batch_index(background, 0)
        first_texture = _as_batch_index(texture, 0)
        first_state = _layer_transform(transform_data, 1, first_bg.shape[1], first_bg.shape[0])
        layer_data = json.dumps(
            {
                "currentLayer_1": {
                    "offset": first_state["offset"],
                    "scale": first_state["scale"],
                    "rotation": first_state["rotation"],
                    "free_transform": first_state.get("free_transform", False),
                    "corners": first_state.get("corners"),
                    "deformation": deformation,
                    "opacity": opacity,
                    "skew": [skew_x, skew_y],
                    "stretch": [stretch_x, stretch_y],
                    "blend_mode": blend_mode,
                }
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
        ui = {
            "my_texture_preview": [
                {
                    "background": _preview_data_url(first_bg, 1280, "JPEG"),
                    "texture": _preview_data_url(first_texture, 1024, "PNG"),
                    "background_width": int(first_bg.shape[1]),
                    "background_height": int(first_bg.shape[0]),
                    "texture_width": int(first_texture.shape[1]),
                    "texture_height": int(first_texture.shape[0]),
                    "batch_count": int(batch_count),
                    "layer_data": layer_data,
                }
            ]
        }
        return {"ui": ui, "result": (result_image, layer_data, result_mask)}


NODE_CLASS_MAPPINGS = {"MyComfnodeTexture": MyTexture}
NODE_DISPLAY_NAME_MAPPINGS = {"MyComfnodeTexture": "My贴图"}
