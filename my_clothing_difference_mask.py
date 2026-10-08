# -*- coding: utf-8 -*-
"""Detect clothing changes between an original image and an edited result.

The node uses a clothing-aware SegFormer model to constrain a multi-scale
photo difference.  RGB images are the primary signal; optional depth maps can
reinforce true geometry changes without turning props or background changes
into clothing.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Iterable, Optional, Sequence, Tuple

import cv2
import numpy as np
import torch
import torch.nn.functional as F


_MODEL_REPO = "sayeed99/segformer_b3_clothes"
_CLOTHING_LABELS = (4, 5, 6, 7, 8, 17)  # upper, skirt, pants, dress, belt, scarf
_NON_CLOTHING_LABELS = (1, 2, 3, 9, 10, 11, 12, 13, 14, 15, 16)
_MODEL_LOCK = threading.Lock()
_PROCESSOR = None
_MODEL = None
_MODEL_DEVICE = None


def _image_batch(value: torch.Tensor, name: str) -> torch.Tensor:
    if not isinstance(value, torch.Tensor):
        raise TypeError(f"{name}必须是 ComfyUI IMAGE 张量")
    if value.ndim != 4 or value.shape[-1] < 3:
        raise ValueError(f"{name}必须是 BHWC 图像张量，当前形状为 {tuple(value.shape)}")
    return value[..., :3].detach().float().cpu().clamp(0.0, 1.0)


def _broadcast_index(index: int, count: int) -> int:
    if count == 1:
        return 0
    return index


def _resize_rgb(image: np.ndarray, height: int, width: int) -> np.ndarray:
    if image.shape[:2] == (height, width):
        return image
    interpolation = cv2.INTER_AREA if image.shape[0] > height or image.shape[1] > width else cv2.INTER_CUBIC
    return cv2.resize(image, (width, height), interpolation=interpolation)


def _odd(value: int, minimum: int = 3) -> int:
    value = max(minimum, int(value))
    return value if value % 2 else value + 1


def _model_directory() -> Path:
    try:
        import folder_paths

        return Path(folder_paths.models_dir) / "segformer_b3_clothes"
    except Exception:
        # Unit tests and direct execution do not necessarily import ComfyUI.
        return Path(__file__).resolve().parents[2] / "models" / "segformer_b3_clothes"


def _load_model():
    global _PROCESSOR, _MODEL
    if _PROCESSOR is not None and _MODEL is not None:
        return _PROCESSOR, _MODEL

    with _MODEL_LOCK:
        if _PROCESSOR is not None and _MODEL is not None:
            return _PROCESSOR, _MODEL

        from transformers import AutoModelForSemanticSegmentation, SegformerImageProcessor

        model_dir = _model_directory()
        config_path = model_dir / "config.json"
        weights_path = model_dir / "model.safetensors"
        if not config_path.exists() or not weights_path.exists():
            from huggingface_hub import snapshot_download

            model_dir.mkdir(parents=True, exist_ok=True)
            print(f"[My服装差异遮罩识别] 首次使用，正在下载服装分割模型到 {model_dir}")
            snapshot_download(repo_id=_MODEL_REPO, local_dir=str(model_dir))

        _PROCESSOR = SegformerImageProcessor.from_pretrained(
            str(model_dir), local_files_only=True
        )
        _MODEL = AutoModelForSemanticSegmentation.from_pretrained(
            str(model_dir), local_files_only=True
        ).eval()
        return _PROCESSOR, _MODEL


def _torch_device(mode: str) -> torch.device:
    if mode in ("CPU", "处理器（CPU）"):
        return torch.device("cpu")
    if torch.cuda.is_available():
        try:
            import comfy.model_management as model_management

            return model_management.get_torch_device()
        except Exception:
            return torch.device("cuda")
    return torch.device("cpu")


def _segment_probabilities(
    images: Sequence[np.ndarray], device_mode: str
) -> Tuple[
    Sequence[np.ndarray],
    Sequence[np.ndarray],
    Sequence[np.ndarray],
    Sequence[np.ndarray],
]:
    """Return clothing, non-clothing, bag/prop, and clothing-class changes."""

    from PIL import Image

    global _MODEL_DEVICE
    processor, model = _load_model()
    device = _torch_device(device_mode)
    if _MODEL_DEVICE != str(device):
        model.to(device)
        _MODEL_DEVICE = str(device)

    pil_images = [Image.fromarray(np.clip(image * 255.0, 0, 255).astype(np.uint8)) for image in images]
    encoded = processor(images=pil_images, return_tensors="pt")
    encoded = {key: value.to(device) for key, value in encoded.items()}

    with torch.inference_mode():
        logits = model(**encoded).logits
        probabilities = logits.softmax(dim=1)
        clothing = probabilities[:, list(_CLOTHING_LABELS)].sum(dim=1, keepdim=True)
        non_clothing = probabilities[:, list(_NON_CLOTHING_LABELS)].sum(dim=1, keepdim=True)
        # This clothes parsing model uses class 16 for bags. Hand fans and
        # similar handheld props are commonly mapped to the same class, so it
        # is useful as a dedicated exclusion signal.
        bag_or_prop = probabilities[:, 16:17]

        clothing_maps = []
        non_clothing_maps = []
        bag_or_prop_maps = []
        for index, image in enumerate(images):
            size = image.shape[:2]
            clothing_map = F.interpolate(
                clothing[index : index + 1], size=size, mode="bilinear", align_corners=False
            )[0, 0]
            non_clothing_map = F.interpolate(
                non_clothing[index : index + 1], size=size, mode="bilinear", align_corners=False
            )[0, 0]
            bag_or_prop_map = F.interpolate(
                bag_or_prop[index : index + 1], size=size, mode="bilinear", align_corners=False
            )[0, 0]
            clothing_maps.append(clothing_map.float().cpu().numpy())
            non_clothing_maps.append(non_clothing_map.float().cpu().numpy())
            bag_or_prop_maps.append(bag_or_prop_map.float().cpu().numpy())

        class_change_maps = []
        clothing_classes = probabilities[:, list(_CLOTHING_LABELS)]
        for index in range(0, len(images), 2):
            # Comparing the individual clothing classes avoids losing a change
            # when one garment class replaces another but both still count as
            # generic "clothing".
            class_change = 0.5 * torch.abs(
                clothing_classes[index + 1] - clothing_classes[index]
            ).sum(dim=0, keepdim=True).unsqueeze(0)
            class_change = F.interpolate(
                class_change,
                size=images[index + 1].shape[:2],
                mode="bilinear",
                align_corners=False,
            )[0, 0]
            class_change_maps.append(class_change.float().cpu().numpy())

    return clothing_maps, non_clothing_maps, bag_or_prop_maps, class_change_maps


def _align_original(original: np.ndarray, result: np.ndarray, enabled: bool) -> np.ndarray:
    """Conservatively align the original to the result with an affine ECC warp."""

    height, width = result.shape[:2]
    original = _resize_rgb(original, height, width)
    if not enabled:
        return original

    scale = min(1.0, 768.0 / max(height, width))
    small_size = (max(32, round(width * scale)), max(32, round(height * scale)))
    original_small = cv2.resize(original, small_size, interpolation=cv2.INTER_AREA)
    result_small = cv2.resize(result, small_size, interpolation=cv2.INTER_AREA)
    original_gray = cv2.cvtColor(original_small, cv2.COLOR_RGB2GRAY).astype(np.float32)
    result_gray = cv2.cvtColor(result_small, cv2.COLOR_RGB2GRAY).astype(np.float32)
    original_gray = cv2.GaussianBlur(original_gray, (5, 5), 0)
    result_gray = cv2.GaussianBlur(result_gray, (5, 5), 0)

    warp = np.eye(2, 3, dtype=np.float32)
    try:
        correlation, warp = cv2.findTransformECC(
            result_gray,
            original_gray,
            warp,
            cv2.MOTION_AFFINE,
            (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 80, 1e-5),
            None,
            3,
        )
        linear = warp[:, :2]
        singular_values = np.linalg.svd(linear, compute_uv=False)
        rotation = abs(np.degrees(np.arctan2(linear[1, 0], linear[0, 0])))
        translation = np.linalg.norm(warp[:, 2]) / max(small_size)
        if (
            correlation < 0.72
            or singular_values.min() < 0.94
            or singular_values.max() > 1.06
            or rotation > 4.0
            or translation > 0.06
        ):
            return original
    except cv2.error:
        return original

    warp_full = warp.copy()
    warp_full[:, 2] /= max(scale, 1e-6)
    return cv2.warpAffine(
        original,
        warp_full,
        (width, height),
        flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
        borderMode=cv2.BORDER_REFLECT_101,
    )


def _gray_depth(value: Optional[torch.Tensor], index: int, height: int, width: int) -> Optional[np.ndarray]:
    if value is None:
        return None
    batch = _image_batch(value, "深度图")
    image = batch[_broadcast_index(index, batch.shape[0])].numpy()
    gray = image.mean(axis=2).astype(np.float32)
    if gray.shape != (height, width):
        gray = cv2.resize(gray, (width, height), interpolation=cv2.INTER_LINEAR)
    low, high = np.percentile(gray, (2.0, 98.0))
    return np.clip((gray - low) / max(high - low, 1e-6), 0.0, 1.0)


def _fill_and_filter(
    mask: np.ndarray, minimum_area: int, required_seed: Optional[np.ndarray] = None
) -> np.ndarray:
    binary = (mask > 0).astype(np.uint8)
    filled = np.zeros_like(binary)
    component_count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    seed = None if required_seed is None else required_seed.astype(bool)
    for label in range(1, component_count):
        area = int(stats[label, cv2.CC_STAT_AREA])
        if area < minimum_area:
            continue
        component = labels == label
        if seed is not None:
            seed_pixels = int(np.count_nonzero(component & seed))
            required = max(12, min(256, round(area * 0.0015)))
            if seed_pixels < required:
                continue
        component_u8 = component.astype(np.uint8)
        contours, _ = cv2.findContours(
            component_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        cv2.drawContours(filled, contours, -1, 1, thickness=cv2.FILLED)
    return filled


def _difference_mask(
    original: np.ndarray,
    result: np.ndarray,
    clothing_original: np.ndarray,
    clothing_result: np.ndarray,
    non_clothing_original: np.ndarray,
    non_clothing_result: np.ndarray,
    bag_or_prop_original: np.ndarray,
    bag_or_prop_result: np.ndarray,
    clothing_class_change: np.ndarray,
    sensitivity: float,
    clothing_confidence: float,
    minimum_area_percent: float,
    expansion: int,
    feather: int,
    original_depth: Optional[np.ndarray],
    result_depth: Optional[np.ndarray],
    depth_weight: float,
) -> Tuple[np.ndarray, np.ndarray]:
    height, width = result.shape[:2]
    short_side = min(height, width)

    # Multi-scale RGB differences suppress compression noise while retaining
    # broad folds, displaced hems, and newly generated flowing fabric.
    blur_small = _odd(round(short_side / 350), 3)
    blur_large = _odd(round(short_side / 140), 7)
    original_small = cv2.GaussianBlur(original, (blur_small, blur_small), 0)
    result_small = cv2.GaussianBlur(result, (blur_small, blur_small), 0)
    original_large = cv2.GaussianBlur(original, (blur_large, blur_large), 0)
    result_large = cv2.GaussianBlur(result, (blur_large, blur_large), 0)
    fine_difference = np.mean(np.abs(result_small - original_small), axis=2)
    broad_difference = np.mean(np.abs(result_large - original_large), axis=2)
    photo_difference = np.maximum(fine_difference * 0.72, broad_difference)

    semantic_difference = np.maximum(
        np.abs(clothing_result - clothing_original),
        clothing_class_change * 0.9,
    )
    clothing_union_soft = np.maximum(clothing_original, clothing_result)
    clothing_union = clothing_union_soft >= clothing_confidence

    # Strongly exclude pixels the model identifies as face, hair, limbs, shoes,
    # or bag. Clothing wins at ambiguous garment boundaries.
    exclusion = np.maximum(non_clothing_original, non_clothing_result)
    clothing_wins = clothing_union_soft >= exclusion * 0.82
    attention = clothing_union & clothing_wins
    bag_or_prop = np.maximum(bag_or_prop_original, bag_or_prop_result)
    prop_exclusion = bag_or_prop >= 0.24
    prop_size = _odd(round(short_side / 500), 3)
    prop_exclusion = cv2.dilate(
        prop_exclusion.astype(np.uint8),
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (prop_size, prop_size)),
    ) > 0
    attention &= ~prop_exclusion

    result_binary = clothing_result >= clothing_confidence
    original_binary = clothing_original >= clothing_confidence
    geometry_kernel = _odd(round(short_side / 180), 5)
    geometry_element = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (geometry_kernel, geometry_kernel))
    original_near = cv2.dilate(original_binary.astype(np.uint8), geometry_element) > 0
    result_near = cv2.dilate(result_binary.astype(np.uint8), geometry_element) > 0
    new_result_cloth = result_binary & ~original_near
    removed_original_cloth = original_binary & ~result_near
    silhouette_change = new_result_cloth | removed_original_cloth

    # Higher sensitivity means a lower visual threshold. The semantic and
    # silhouette terms make newly flowing cloth survive even when its color is
    # similar to the original garment.
    sensitivity = float(np.clip(sensitivity, 0.0, 1.0))
    visual_threshold = 0.19 - 0.13 * sensitivity
    semantic_threshold = 0.58 - 0.28 * sensitivity
    visual_change = photo_difference >= visual_threshold
    semantic_change = semantic_difference >= semantic_threshold

    depth_change = np.zeros((height, width), dtype=np.float32)
    if original_depth is not None and result_depth is not None and depth_weight > 0.0:
        depth_change = np.abs(result_depth - original_depth)
        depth_change = cv2.GaussianBlur(depth_change, (blur_large, blur_large), 0)
        depth_threshold = 0.19 - 0.11 * sensitivity
        depth_change = np.clip(depth_change / max(depth_threshold, 1e-4), 0.0, 1.0)

    score = np.maximum.reduce(
        [
            np.clip(photo_difference / max(visual_threshold, 1e-4), 0.0, 1.5) * 0.62,
            semantic_difference * 1.15,
            silhouette_change.astype(np.float32),
            depth_change * float(np.clip(depth_weight, 0.0, 1.0)),
        ]
    )
    # Photo and semantic changes may extend far inside the old silhouette.
    # They are collected globally, then component filtering below retains only
    # regions that actually touch a changed garment silhouette.
    raw = attention & (
        silhouette_change
        | visual_change
        | semantic_change
        | (depth_change >= 0.78)
    )

    # Grow from the changed silhouette through weak visual evidence. Requiring
    # every accepted component to remain connected to a silhouette seed keeps
    # this from selecting an independently repainted but stationary sleeve.
    weak_change = attention & (
        (photo_difference >= visual_threshold * 0.42)
        | (semantic_difference >= semantic_threshold * 0.48)
        | (depth_change >= 0.46)
    )
    raw |= weak_change

    close_size = _odd(round(short_side / 46), 11)
    open_size = _odd(round(short_side / 420), 3)
    raw_u8 = raw.astype(np.uint8)
    raw_u8 = cv2.morphologyEx(
        raw_u8,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close_size, close_size)),
    )
    raw_u8 = cv2.morphologyEx(
        raw_u8,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (open_size, open_size)),
    )

    minimum_area = max(1, round(height * width * minimum_area_percent / 100.0))
    clean = _fill_and_filter(raw_u8, minimum_area, silhouette_change)
    # Re-apply the prop cut after contour filling so a filled component cannot
    # bridge back across a fan or handbag.
    clean[prop_exclusion] = 0
    if expansion != 0:
        size = _odd(abs(expansion) * 2 + 1, 3)
        element = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))
        clean = cv2.dilate(clean, element) if expansion > 0 else cv2.erode(clean, element)

    binary_mask = clean.astype(np.float32)
    if feather > 0:
        kernel = _odd(feather * 2 + 1, 3)
        output_mask = cv2.GaussianBlur(binary_mask, (kernel, kernel), max(0.5, feather / 2.0))
    else:
        output_mask = binary_mask
    output_mask = np.clip(output_mask, 0.0, 1.0)

    reference = np.clip(score, 0.0, 1.0)
    return output_mask, reference


def _preview(result: np.ndarray, mask: np.ndarray) -> np.ndarray:
    overlay = result.copy()
    red = np.zeros_like(overlay)
    red[..., 0] = 1.0
    alpha = np.clip(mask[..., None] * 0.58, 0.0, 0.58)
    overlay = overlay * (1.0 - alpha) + red * alpha
    edge = cv2.morphologyEx((mask > 0.4).astype(np.uint8), cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8))
    overlay[edge > 0] = np.array([1.0, 0.92, 0.0], dtype=np.float32)
    return np.clip(overlay, 0.0, 1.0).astype(np.float32)


class MyClothingDifferenceMask:
    CATEGORY = "My-Comfnode/遮罩"
    FUNCTION = "detect"
    RETURN_TYPES = ("MASK", "IMAGE", "IMAGE", "MASK")
    RETURN_NAMES = ("服装差异遮罩", "遮罩预览", "差异参考图", "服装联合遮罩")
    DESCRIPTION = (
        "对比原图与结果图，只识别服装发生改变的区域。照片差异为主，服装语义约束；"
        "可选深度图仅辅助几何变化，自动排除脸、头发、手臂、包和背景。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "原图": ("IMAGE", {"tooltip": "修改前的原始照片"}),
                "结果图": ("IMAGE", {"tooltip": "修改后的结果照片；输出遮罩与此图尺寸一致"}),
                "自动对齐": (
                    ["开启", "关闭"],
                    {"default": "开启", "tooltip": "自动校正两张图的轻微平移、旋转和缩放"},
                ),
                "检测灵敏度": (
                    "FLOAT",
                    {
                        "default": 0.55,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display": "slider",
                        "tooltip": "越高识别越多；误检时降低，漏掉细小衣摆时提高",
                    },
                ),
                "服装置信度": (
                    "FLOAT",
                    {
                        "default": 0.35,
                        "min": 0.05,
                        "max": 0.95,
                        "step": 0.01,
                        "display": "slider",
                        "tooltip": "服装语义区域阈值；透明薄纱漏检时适当降低",
                    },
                ),
                "最小区域百分比": (
                    "FLOAT",
                    {
                        "default": 0.05,
                        "min": 0.0,
                        "max": 5.0,
                        "step": 0.01,
                        "tooltip": "过滤小于整张图该百分比的零碎误检",
                    },
                ),
                "遮罩扩张": (
                    "INT",
                    {"default": 3, "min": -64, "max": 64, "step": 1, "tooltip": "正数外扩，负数内缩"},
                ),
                "遮罩羽化": (
                    "INT",
                    {"default": 2, "min": 0, "max": 64, "step": 1, "tooltip": "遮罩边缘柔化像素数"},
                ),
                "深度辅助强度": (
                    "FLOAT",
                    {
                        "default": 0.35,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.05,
                        "display": "slider",
                        "tooltip": "仅连接两张深度图时生效；0 表示完全不用深度",
                    },
                ),
                "计算设备": (
                    ["自动", "显卡（GPU）", "处理器（CPU）"],
                    {"default": "自动", "tooltip": "自动优先使用显卡；显存不足时可改用处理器"},
                ),
            },
            "optional": {
                "原图深度图": ("IMAGE", {"tooltip": "可选；不连接也能正常识别"}),
                "结果图深度图": ("IMAGE", {"tooltip": "可选；需与原图深度图同时连接"}),
            },
        }

    def detect(
        self,
        原图,
        结果图,
        自动对齐="开启",
        检测灵敏度=0.55,
        服装置信度=0.35,
        最小区域百分比=0.05,
        遮罩扩张=3,
        遮罩羽化=2,
        深度辅助强度=0.35,
        计算设备="自动",
        原图深度图=None,
        结果图深度图=None,
    ):
        original_batch = _image_batch(原图, "原图")
        result_batch = _image_batch(结果图, "结果图")
        counts = [original_batch.shape[0], result_batch.shape[0]]
        if 原图深度图 is not None:
            counts.append(_image_batch(原图深度图, "原图深度图").shape[0])
        if 结果图深度图 is not None:
            counts.append(_image_batch(结果图深度图, "结果图深度图").shape[0])
        batch_size = max(counts)
        if any(count not in (1, batch_size) for count in counts):
            raise ValueError(f"输入批次数量必须相同或为 1，当前为 {counts}")

        pairs = []
        for index in range(batch_size):
            result = result_batch[_broadcast_index(index, result_batch.shape[0])].numpy()
            original = original_batch[_broadcast_index(index, original_batch.shape[0])].numpy()
            original = _align_original(original, result, 自动对齐 == "开启")
            pairs.append((original.astype(np.float32), result.astype(np.float32)))

        segment_inputs = [image for pair in pairs for image in pair]
        (
            clothing_maps,
            non_clothing_maps,
            bag_or_prop_maps,
            class_change_maps,
        ) = _segment_probabilities(segment_inputs, 计算设备)

        masks = []
        previews = []
        references = []
        clothing_unions = []
        for index, (original, result) in enumerate(pairs):
            height, width = result.shape[:2]
            original_depth = _gray_depth(原图深度图, index, height, width)
            result_depth = _gray_depth(结果图深度图, index, height, width)
            if (original_depth is None) != (result_depth is None):
                raise ValueError("原图深度图和结果图深度图必须同时连接，或都不连接")

            clothing_original = clothing_maps[index * 2]
            clothing_result = clothing_maps[index * 2 + 1]
            non_clothing_original = non_clothing_maps[index * 2]
            non_clothing_result = non_clothing_maps[index * 2 + 1]
            bag_or_prop_original = bag_or_prop_maps[index * 2]
            bag_or_prop_result = bag_or_prop_maps[index * 2 + 1]
            mask, reference = _difference_mask(
                original,
                result,
                clothing_original,
                clothing_result,
                non_clothing_original,
                non_clothing_result,
                bag_or_prop_original,
                bag_or_prop_result,
                class_change_maps[index],
                float(检测灵敏度),
                float(服装置信度),
                float(最小区域百分比),
                int(遮罩扩张),
                int(遮罩羽化),
                original_depth,
                result_depth,
                float(深度辅助强度),
            )
            clothing_union = np.maximum(clothing_original, clothing_result)
            masks.append(torch.from_numpy(mask.astype(np.float32)))
            previews.append(torch.from_numpy(_preview(result, mask)))
            references.append(torch.from_numpy(np.repeat(reference[..., None], 3, axis=2).astype(np.float32)))
            clothing_unions.append(torch.from_numpy(clothing_union.astype(np.float32)))

        return (
            torch.stack(masks, dim=0),
            torch.stack(previews, dim=0),
            torch.stack(references, dim=0),
            torch.stack(clothing_unions, dim=0),
        )


NODE_CLASS_MAPPINGS = {
    "MyClothingDifferenceMask": MyClothingDifferenceMask,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MyClothingDifferenceMask": "My服装差异遮罩识别",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
