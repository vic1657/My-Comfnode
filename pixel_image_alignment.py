from __future__ import annotations

from typing import Iterable

import cv2
import numpy as np
import torch


PRECISION_SIZES = {"快速": 640, "标准": 896, "精细": 1152}


def _tensor_to_rgb(image: torch.Tensor) -> np.ndarray:
    return np.clip(image.detach().cpu().float().numpy()[..., :3], 0.0, 1.0)


def _structure_gray(rgb: np.ndarray) -> np.ndarray:
    uint8 = (np.clip(rgb, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
    gray = cv2.cvtColor(uint8, cv2.COLOR_RGB2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    return clahe.apply(gray)


def _fit_size(width: int, height: int, max_side: int) -> tuple[int, int]:
    scale = min(1.0, max_side / max(width, height))
    fitted_width = max(8, int(round(width * scale / 8.0)) * 8)
    fitted_height = max(8, int(round(height * scale / 8.0)) * 8)
    return fitted_width, fitted_height


def _global_affine(source: np.ndarray, target: np.ndarray) -> np.ndarray:
    height, width = target.shape[:2]
    source_at_target = cv2.resize(
        source,
        (width, height),
        interpolation=cv2.INTER_LANCZOS4,
    )
    reg_width, reg_height = _fit_size(width, height, 1400)
    source_reg = cv2.resize(source_at_target, (reg_width, reg_height), interpolation=cv2.INTER_AREA)
    target_reg = cv2.resize(target, (reg_width, reg_height), interpolation=cv2.INTER_AREA)
    source_gray = _structure_gray(source_reg)
    target_gray = _structure_gray(target_reg)

    detector = cv2.SIFT_create(nfeatures=6000, contrastThreshold=0.02, edgeThreshold=12)
    source_points, source_desc = detector.detectAndCompute(source_gray, None)
    target_points, target_desc = detector.detectAndCompute(target_gray, None)
    if source_desc is None or target_desc is None or len(source_points) < 8 or len(target_points) < 8:
        return source_at_target

    matches = cv2.BFMatcher(cv2.NORM_L2).knnMatch(source_desc, target_desc, k=2)
    good = [first for first, second in matches if first.distance < 0.76 * second.distance]
    if len(good) < 8:
        return source_at_target

    source_xy = np.float32([source_points[item.queryIdx].pt for item in good])
    target_xy = np.float32([target_points[item.trainIdx].pt for item in good])
    matrix, inliers = cv2.estimateAffine2D(
        source_xy,
        target_xy,
        method=cv2.RANSAC,
        ransacReprojThreshold=3.0,
        maxIters=5000,
        confidence=0.995,
        refineIters=20,
    )
    if matrix is None or inliers is None or int(inliers.sum()) < 8:
        return source_at_target

    linear = matrix[:, :2]
    determinant = float(np.linalg.det(linear))
    singular_values = np.linalg.svd(linear, compute_uv=False)
    if determinant <= 0.0 or singular_values.min() < 0.75 or singular_values.max() > 1.25:
        return source_at_target

    scale_x = width / reg_width
    scale_y = height / reg_height
    full_matrix = matrix.astype(np.float64)
    full_matrix[0, 1] *= scale_x / scale_y
    full_matrix[1, 0] *= scale_y / scale_x
    full_matrix[0, 2] *= scale_x
    full_matrix[1, 2] *= scale_y
    return cv2.warpAffine(
        source_at_target,
        full_matrix,
        (width, height),
        flags=cv2.INTER_LANCZOS4,
        borderMode=cv2.BORDER_REFLECT_101,
    )


def _estimate_dense_flow(
    source: np.ndarray,
    target: np.ndarray,
    work_size: int,
    max_displacement: float,
    strength: float,
) -> tuple[np.ndarray, np.ndarray]:
    height, width = target.shape[:2]
    work_width, work_height = _fit_size(width, height, work_size)
    source_work = cv2.resize(source, (work_width, work_height), interpolation=cv2.INTER_AREA)
    target_work = cv2.resize(target, (work_width, work_height), interpolation=cv2.INTER_AREA)
    source_gray = _structure_gray(source_work)
    target_gray = _structure_gray(target_work)

    estimator = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    estimator.setUseSpatialPropagation(True)
    forward = estimator.calc(target_gray, source_gray, None)
    backward = estimator.calc(source_gray, target_gray, None)
    max_work = max_displacement * max(work_width / width, work_height / height)
    magnitude = np.linalg.norm(forward, axis=2)
    scale = np.minimum(1.0, max_work / np.maximum(magnitude, 1e-6))
    forward *= scale[..., None]

    y, x = np.mgrid[0:work_height, 0:work_width].astype(np.float32)
    map_x = x + forward[..., 0]
    map_y = y + forward[..., 1]
    backward_x = cv2.remap(
        backward[..., 0], map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT
    )
    backward_y = cv2.remap(
        backward[..., 1], map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT
    )
    consistency = np.sqrt(
        (forward[..., 0] + backward_x) ** 2 + (forward[..., 1] + backward_y) ** 2
    )
    valid = (map_x >= 0) & (map_x <= work_width - 1) & (map_y >= 0) & (map_y <= work_height - 1)
    confidence = np.exp(-((consistency / 2.5) ** 2)).astype(np.float32) * valid.astype(np.float32)
    confidence = cv2.GaussianBlur(confidence, (0, 0), 1.5)
    forward *= confidence[..., None] * float(strength)

    flow_full = cv2.resize(forward, (width, height), interpolation=cv2.INTER_LINEAR)
    flow_full[..., 0] *= width / work_width
    flow_full[..., 1] *= height / work_height
    confidence_full = cv2.resize(confidence, (width, height), interpolation=cv2.INTER_LINEAR)
    return flow_full.astype(np.float32), confidence_full.astype(np.float32)


def _apply_flow(source: np.ndarray, flow: np.ndarray) -> np.ndarray:
    height, width = source.shape[:2]
    y, x = np.mgrid[0:height, 0:width].astype(np.float32)
    map_x = x + flow[..., 0].astype(np.float32)
    map_y = y + flow[..., 1].astype(np.float32)
    return cv2.remap(
        source,
        map_x,
        map_y,
        interpolation=cv2.INTER_LANCZOS4,
        borderMode=cv2.BORDER_REFLECT_101,
    )


def align_image(
    source: np.ndarray,
    target: np.ndarray,
    precision: str = "标准",
    local_strength: float = 0.75,
    max_displacement: float = 160.0,
) -> np.ndarray:
    global_aligned = _global_affine(source, target)
    if local_strength <= 0.0:
        return np.clip(global_aligned, 0.0, 1.0)
    flow, _confidence = _estimate_dense_flow(
        global_aligned,
        target,
        PRECISION_SIZES.get(precision, PRECISION_SIZES["标准"]),
        max_displacement,
        local_strength,
    )
    return np.clip(_apply_flow(global_aligned, flow), 0.0, 1.0)


def _pair_batches(source: torch.Tensor, target: torch.Tensor) -> Iterable[tuple[torch.Tensor, torch.Tensor]]:
    source_batch = source if source.ndim == 4 else source.unsqueeze(0)
    target_batch = target if target.ndim == 4 else target.unsqueeze(0)
    count = max(source_batch.shape[0], target_batch.shape[0])
    if source_batch.shape[0] not in (1, count) or target_batch.shape[0] not in (1, count):
        raise ValueError("原图和AI图的批次数量必须相同，或其中一端只能有1张图")
    for index in range(count):
        yield (
            source_batch[0 if source_batch.shape[0] == 1 else index],
            target_batch[0 if target_batch.shape[0] == 1 else index],
        )


class MyPixelImageAlignment:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "原图": ("IMAGE",),
                "AI图": ("IMAGE",),
                "对齐精度": (["标准", "精细", "快速"], {"default": "标准"}),
                "局部对齐强度": (
                    "FLOAT",
                    {"default": 0.75, "min": 0.0, "max": 1.0, "step": 0.05},
                ),
                "最大局部位移": (
                    "INT",
                    {"default": 160, "min": 16, "max": 512, "step": 8},
                ),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("已对齐图像",)
    FUNCTION = "align"
    CATEGORY = "My-Comfnode/图像"
    DESCRIPTION = "以AI图为坐标基准，将原图做全局仿射与局部稠密光流对齐。"

    def align(self, 原图, AI图, 对齐精度, 局部对齐强度, 最大局部位移):
        outputs = []
        for source_item, target_item in _pair_batches(原图, AI图):
            aligned = align_image(
                _tensor_to_rgb(source_item),
                _tensor_to_rgb(target_item),
                对齐精度,
                float(局部对齐强度),
                float(最大局部位移),
            )
            outputs.append(torch.from_numpy(aligned.astype(np.float32)))
        return (torch.stack(outputs, dim=0),)


NODE_CLASS_MAPPINGS = {"MyPixelImageAlignment": MyPixelImageAlignment}
NODE_DISPLAY_NAME_MAPPINGS = {"MyPixelImageAlignment": "My像素级图像对齐"}
