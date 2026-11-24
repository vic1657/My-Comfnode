from __future__ import annotations

import importlib.util
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

from comfy_api.latest import io

_RMBG_NODE = None
_VITMATTE_MODEL = None
_VITMATTE_PROCESSOR = None
_VITMATTE_DEVICE = None
_HAIR_SEGMENTER = None


def _load_rmbg_node():
    global _RMBG_NODE
    if _RMBG_NODE is not None:
        return _RMBG_NODE

    path = Path(__file__).resolve().parents[1] / "ComfyUI-Apt_Preset" / "NodeBasic" / "mask_RMBG.py"
    if not path.exists():
        raise RuntimeError(
            "自动抠图需要 ComfyUI-Apt_Preset 的 RMBG 节点，未找到 mask_RMBG.py。"
            "可以先接入外部遮罩，或安装/同步 ComfyUI-Apt_Preset。"
        )
    spec = importlib.util.spec_from_file_location("_my_comfnode_rmbg_bridge", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    _RMBG_NODE = module.Mask_Remove_bg2()
    return _RMBG_NODE


def _rmbg_mask(image: torch.Tensor, process_res: int, sensitivity: float) -> torch.Tensor:
    node = _load_rmbg_node()
    image = _normalize_image(image)
    _foreground, mask, *_rest = node.process_image(
        image=image,
        model="RMBG-2.0",
        sensitivity=float(sensitivity),
        process_res=int(process_res),
        mask_blur=0,
        mask_offset=0,
        invert_output=False,
        refine_foreground=False,
        background="Alpha",
    )
    if mask.ndim == 4 and mask.shape[-1] == 1:
        mask = mask[..., 0]
    if mask.ndim == 4 and mask.shape[1] == 1:
        mask = mask[:, 0]
    return mask.clamp(0.0, 1.0)


def _load_vitmatte():
    global _VITMATTE_MODEL, _VITMATTE_PROCESSOR, _VITMATTE_DEVICE
    if _VITMATTE_MODEL is not None:
        return _VITMATTE_MODEL, _VITMATTE_PROCESSOR, _VITMATTE_DEVICE

    model_path = Path(__file__).resolve().parents[2] / "models" / "vitmatte"
    required = (model_path / "config.json", model_path / "preprocessor_config.json")
    if not all(path.exists() for path in required) or not any(
        (model_path / name).exists() for name in ("model.safetensors", "pytorch_model.bin")
    ):
        raise RuntimeError(
            "内部发丝细化需要 VitMatte 模型。请将模型放到 "
            f"{model_path}，或把“内部发丝细化”设为关闭。"
        )

    from transformers import VitMatteForImageMatting, VitMatteImageProcessor

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    processor = VitMatteImageProcessor.from_pretrained(model_path, local_files_only=True)
    model = VitMatteForImageMatting.from_pretrained(model_path, local_files_only=True)
    model.eval().to(device)
    _VITMATTE_MODEL = model
    _VITMATTE_PROCESSOR = processor
    _VITMATTE_DEVICE = device
    return model, processor, device


def _load_hair_segmenter():
    global _HAIR_SEGMENTER
    if _HAIR_SEGMENTER is not None:
        return _HAIR_SEGMENTER

    model_path = (
        Path(__file__).resolve().parents[2]
        / "models"
        / "mediapipe"
        / "selfie_multiclass_256x256.tflite"
    )
    if not model_path.exists():
        raise RuntimeError(
            "内部发丝细化需要 MediaPipe 头发识别模型："
            f"{model_path}"
        )

    import mediapipe as mp

    options = mp.tasks.vision.ImageSegmenterOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(model_path)),
        running_mode=mp.tasks.vision.RunningMode.IMAGE,
        output_confidence_masks=True,
        output_category_mask=False,
    )
    _HAIR_SEGMENTER = mp.tasks.vision.ImageSegmenter.create_from_options(options)
    return _HAIR_SEGMENTER


def _normalize_image(image: torch.Tensor) -> torch.Tensor:
    if not isinstance(image, torch.Tensor):
        raise TypeError("图像输入必须是 ComfyUI IMAGE 张量")
    if image.ndim == 3:
        image = image.unsqueeze(0)
    if image.ndim != 4 or image.shape[-1] < 3:
        raise ValueError(f"图像必须是 BHWC 张量，当前形状为 {tuple(image.shape)}")
    return image[..., :3].clamp(0.0, 1.0)


def _normalize_mask(mask: torch.Tensor, image: torch.Tensor) -> torch.Tensor:
    if not isinstance(mask, torch.Tensor):
        raise TypeError("遮罩输入必须是 ComfyUI MASK 张量")
    if mask.ndim == 2:
        mask = mask.unsqueeze(0)
    elif mask.ndim == 4 and mask.shape[-1] == 1:
        mask = mask[..., 0]
    elif mask.ndim == 4 and mask.shape[1] == 1:
        mask = mask[:, 0]
    if mask.ndim != 3:
        raise ValueError(f"遮罩必须是 BHW 张量，当前形状为 {tuple(mask.shape)}")

    batch, height, width = image.shape[:3]
    mask = mask.to(device=image.device, dtype=image.dtype).clamp(0.0, 1.0)
    if mask.shape[1:] != (height, width):
        mask = F.interpolate(
            mask.unsqueeze(1),
            size=(height, width),
            mode="bilinear",
            align_corners=False,
        )[:, 0]
    if mask.shape[0] == 1 and batch > 1:
        mask = mask.repeat(batch, 1, 1)
    elif mask.shape[0] != batch:
        raise ValueError(f"遮罩批次数 {mask.shape[0]} 与图像批次数 {batch} 不一致")
    return mask


def _normalize_optional_image(image: torch.Tensor | None, reference: torch.Tensor) -> torch.Tensor | None:
    if image is None:
        return None
    image = _normalize_image(image).to(device=reference.device, dtype=reference.dtype)
    batch, height, width = reference.shape[:3]
    if image.shape[1:3] != (height, width):
        image = F.interpolate(
            image.movedim(-1, 1),
            size=(height, width),
            mode="bilinear",
            align_corners=False,
        ).movedim(1, -1)
    if image.shape[0] == 1 and batch > 1:
        image = image.repeat(batch, 1, 1, 1)
    elif image.shape[0] != batch:
        raise ValueError(f"背景图批次数 {image.shape[0]} 与图像批次数 {batch} 不一致")
    return image


def _odd_kernel(radius: int) -> int:
    return max(1, int(radius) * 2 + 1)


def _box_blur_bchw(tensor: torch.Tensor, radius: int) -> torch.Tensor:
    if radius <= 0:
        return tensor
    kernel = _odd_kernel(radius)
    pad = radius
    tensor = F.pad(tensor, (pad, pad, 0, 0), mode="replicate")
    tensor = F.avg_pool2d(tensor, kernel_size=(1, kernel), stride=1)
    tensor = F.pad(tensor, (0, 0, pad, pad), mode="replicate")
    return F.avg_pool2d(tensor, kernel_size=(kernel, 1), stride=1)


def _dilate(mask: torch.Tensor, radius: int) -> torch.Tensor:
    if radius <= 0:
        return mask
    kernel = _odd_kernel(radius)
    tensor = mask.unsqueeze(1)
    tensor = F.max_pool2d(tensor, kernel_size=(1, kernel), stride=1, padding=(0, radius))
    tensor = F.max_pool2d(tensor, kernel_size=(kernel, 1), stride=1, padding=(radius, 0))
    return tensor[:, 0]


def _erode(mask: torch.Tensor, radius: int) -> torch.Tensor:
    if radius <= 0:
        return mask
    return 1.0 - _dilate(1.0 - mask, radius)


def _vitmatte_trimap(
    mask: torch.Tensor,
    internal_radius: int,
    hair_region: torch.Tensor | None = None,
) -> tuple[torch.Tensor, torch.Tensor]:
    subject = (mask > 0.02).to(mask.dtype)
    # The wide control only expands semantic hair coverage. The generic body
    # edge stays narrow so face, neck and clothing interiors never become a
    # matting work area merely because the subject is thin at that location.
    inner_radius = max(2, min(12, int(round(internal_radius / 6.0))))
    outer_radius = max(2, inner_radius // 3)
    definite_foreground = _erode(subject, inner_radius)
    possible_foreground = _dilate(subject, outer_radius)
    uncertain = (possible_foreground - definite_foreground).clamp(0.0, 1.0)
    uncertain = torch.maximum(
        uncertain,
        ((mask > 0.02) & (mask < 0.98)).to(mask.dtype),
    )
    if hair_region is not None:
        hair_region = hair_region.to(device=mask.device, dtype=mask.dtype).clamp(0.0, 1.0)
        semantic_grow = max(2, min(8, int(round(internal_radius / 9.0))))
        hair_region = _dilate((hair_region > 0.35).to(mask.dtype), semantic_grow)
        uncertain = torch.maximum(uncertain, hair_region * subject)
    definite_foreground = definite_foreground * (1.0 - uncertain)
    trimap = definite_foreground + uncertain * 0.5
    return trimap.clamp(0.0, 1.0), uncertain


def _mediapipe_hair_mask(image: torch.Tensor) -> torch.Tensor:
    import mediapipe as mp

    segmenter = _load_hair_segmenter()
    masks = []
    for batch_index in range(image.shape[0]):
        image_u8 = (
            image[batch_index].detach().cpu().mul(255.0).round().to(torch.uint8).numpy()
        )
        media_image = mp.Image(
            image_format=mp.ImageFormat.SRGB,
            data=np.ascontiguousarray(image_u8),
        )
        result = segmenter.segment(media_image)
        if len(result.confidence_masks) < 2:
            raise RuntimeError("MediaPipe 未返回头发类别遮罩")
        confidence = []
        for confidence_mask in result.confidence_masks:
            class_mask = np.squeeze(
                np.asarray(confidence_mask.numpy_view(), dtype=np.float32)
            )
            if class_mask.ndim != 2:
                raise RuntimeError(f"MediaPipe 分类遮罩形状异常：{class_mask.shape}")
            confidence.append(class_mask)
        confidence = np.stack(confidence, axis=0)
        category = np.argmax(confidence, axis=0)
        hair = np.where(category == 1, confidence[1], 0.0).astype(np.float32)
        if hair.ndim != 2:
            raise RuntimeError(f"MediaPipe 头发遮罩形状异常：{hair.shape}")
        masks.append(torch.from_numpy(hair.copy()))
    return torch.stack(masks, dim=0).to(device=image.device, dtype=image.dtype).clamp(0.0, 1.0)


def _vitmatte_refine_mask(
    image: torch.Tensor,
    mask: torch.Tensor,
    internal_range: int,
    process_resolution: int,
) -> tuple[torch.Tensor, torch.Tensor]:
    image = _normalize_image(image)
    mask = _normalize_mask(mask, image)
    model, processor, device = _load_vitmatte()

    height, width = image.shape[1:3]
    longest = max(height, width)
    scale = min(1.0, float(process_resolution) / float(longest))
    work_height = max(64, int(round(height * scale)))
    work_width = max(64, int(round(width * scale)))
    work_image = F.interpolate(
        image.movedim(-1, 1),
        size=(work_height, work_width),
        mode="bilinear",
        align_corners=False,
    ).movedim(1, -1)
    work_mask = F.interpolate(
        mask.unsqueeze(1),
        size=(work_height, work_width),
        mode="bilinear",
        align_corners=False,
    )[:, 0]

    reference_scale = max(work_height, work_width) / 1200.0
    work_radius = max(2, int(round(float(internal_range) * reference_scale)))
    hair_region = _mediapipe_hair_mask(work_image)
    trimap, uncertain = _vitmatte_trimap(work_mask, work_radius, hair_region=hair_region)
    predictions = []
    for batch_index in range(work_image.shape[0]):
        image_u8 = (
            work_image[batch_index].detach().cpu().mul(255.0).round().to(torch.uint8).numpy()
        )
        trimap_u8 = (
            trimap[batch_index].detach().cpu().mul(255.0).round().to(torch.uint8).numpy()
        )
        pil_image = Image.fromarray(image_u8, mode="RGB")
        pil_trimap = Image.fromarray(trimap_u8, mode="L")
        inputs = processor(images=pil_image, trimaps=pil_trimap, return_tensors="pt")
        inputs = {key: value.to(device) for key, value in inputs.items()}
        with torch.inference_mode():
            alpha = model(**inputs).alphas
        alpha = alpha[..., :work_height, :work_width]
        if alpha.ndim == 4:
            alpha = alpha[:, 0]
        predictions.append(alpha[0].to(device=image.device, dtype=image.dtype))

    predicted = torch.stack(predictions, dim=0).clamp(0.0, 1.0)
    refined_work = torch.where(uncertain > 0.0, predicted, work_mask)
    refined = F.interpolate(
        refined_work.unsqueeze(1),
        size=(height, width),
        mode="bilinear",
        align_corners=False,
    )[:, 0]
    # The supplied/RMBG matte already defines the accepted outer silhouette.
    # Internal refinement may remove contaminated coverage, but must never add
    # new foreground outside that matte.
    full_allowed = F.interpolate(
        uncertain.unsqueeze(1),
        size=(height, width),
        mode="bilinear",
        align_corners=False,
    )[:, 0]
    refined = torch.minimum(refined, mask)
    refined = torch.where(full_allowed > 0.02, refined, mask)
    full_hair_region = F.interpolate(
        hair_region.unsqueeze(1),
        size=(height, width),
        mode="bilinear",
        align_corners=False,
    )[:, 0]
    return refined.clamp(0.0, 1.0), full_hair_region.clamp(0.0, 1.0)


def _local_background(image: torch.Tensor, mask: torch.Tensor, radius: int, background: torch.Tensor | None) -> torch.Tensor:
    if background is not None:
        return background

    img = image.movedim(-1, 1)
    outside = (1.0 - _dilate(mask, max(1, radius // 3))).clamp(0.0, 1.0)
    outside_bchw = outside.unsqueeze(1)
    blur_radius = max(2, radius)
    local_weight = _box_blur_bchw(outside_bchw, blur_radius)
    local_color = _box_blur_bchw(img * outside_bchw, blur_radius) / local_weight.clamp_min(1e-5)

    total_weight = outside_bchw.sum(dim=(2, 3), keepdim=True).clamp_min(1e-5)
    global_color = (img * outside_bchw).sum(dim=(2, 3), keepdim=True) / total_weight
    local_color = torch.where(local_weight > 1e-4, local_color, global_color)
    return local_color.movedim(1, -1).clamp(0.0, 1.0)


def _local_foreground(image: torch.Tensor, mask: torch.Tensor, radius: int) -> torch.Tensor:
    img = image.movedim(-1, 1)
    inside = _erode(mask, max(1, radius // 3)).clamp(0.0, 1.0)
    if float(inside.max().detach().cpu()) <= 1e-4:
        inside = mask.clamp(0.0, 1.0)

    inside_bchw = inside.unsqueeze(1)
    blur_radius = max(2, radius)
    local_weight = _box_blur_bchw(inside_bchw, blur_radius)
    local_color = _box_blur_bchw(img * inside_bchw, blur_radius) / local_weight.clamp_min(1e-5)

    total_weight = inside_bchw.sum(dim=(2, 3), keepdim=True).clamp_min(1e-5)
    global_color = (img * inside_bchw).sum(dim=(2, 3), keepdim=True) / total_weight
    local_color = torch.where(local_weight > 1e-4, local_color, global_color)
    return local_color.movedim(1, -1).clamp(0.0, 1.0)


def _quality_scale(quality: str) -> int:
    quality = str(quality or "标准")
    if quality == "快速":
        return 4
    if quality == "精细":
        return 1
    return 2


def _resize_for_background(
    image: torch.Tensor,
    mask: torch.Tensor,
    background: torch.Tensor | None,
    edge_radius: int,
    quality: str,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor | None, int]:
    scale = _quality_scale(quality)
    if scale <= 1:
        return image, mask, background, edge_radius

    height, width = image.shape[1:3]
    if min(height, width) < 384:
        return image, mask, background, edge_radius

    small_h = max(64, height // scale)
    small_w = max(64, width // scale)
    small_image = F.interpolate(
        image.movedim(-1, 1),
        size=(small_h, small_w),
        mode="bilinear",
        align_corners=False,
    ).movedim(1, -1)
    small_mask = F.interpolate(
        mask.unsqueeze(1),
        size=(small_h, small_w),
        mode="bilinear",
        align_corners=False,
    )[:, 0]
    small_background = None
    if background is not None:
        small_background = F.interpolate(
            background.movedim(-1, 1),
            size=(small_h, small_w),
            mode="bilinear",
            align_corners=False,
        ).movedim(1, -1)
    small_radius = max(1, int(round(edge_radius / scale)))
    return small_image, small_mask, small_background, small_radius


def _upsample_mask_like(mask: torch.Tensor, image: torch.Tensor) -> torch.Tensor:
    if mask.shape[1:3] == image.shape[1:3]:
        return mask
    return F.interpolate(
        mask.unsqueeze(1),
        size=image.shape[1:3],
        mode="bilinear",
        align_corners=False,
    )[:, 0].clamp(0.0, 1.0)


def _upsample_image_like(image: torch.Tensor, reference: torch.Tensor) -> torch.Tensor:
    if image.shape[1:3] == reference.shape[1:3]:
        return image
    return F.interpolate(
        image.movedim(-1, 1),
        size=reference.shape[1:3],
        mode="bilinear",
        align_corners=False,
    ).movedim(1, -1).clamp(0.0, 1.0)


def _luma(image: torch.Tensor) -> torch.Tensor:
    return (
        image[..., 0:1] * 0.299
        + image[..., 1:2] * 0.587
        + image[..., 2:3] * 0.114
    )


def _image_gradient_luma(image: torch.Tensor) -> torch.Tensor:
    luma = (
        image[..., 0] * 0.299
        + image[..., 1] * 0.587
        + image[..., 2] * 0.114
    ).unsqueeze(1)
    dx = F.pad(torch.abs(luma[:, :, :, 1:] - luma[:, :, :, :-1]), (0, 1, 0, 0))
    dy = F.pad(torch.abs(luma[:, :, 1:, :] - luma[:, :, :-1, :]), (0, 0, 0, 1))
    detail = (dx + dy) * 6.0
    return _box_blur_bchw(detail, 1)[:, 0].clamp(0.0, 1.0)


def _weighted_color_propagation(
    image: torch.Tensor,
    weight: torch.Tensor,
    radius: int,
) -> torch.Tensor:
    """Extend known colors into the transition band without changing known pixels."""
    image_bchw = image.movedim(-1, 1)
    weight_b1hw = weight.unsqueeze(1).clamp(0.0, 1.0)
    blur_radius = max(2, int(radius))
    local_weight = _box_blur_bchw(weight_b1hw, blur_radius)
    local_color = _box_blur_bchw(image_bchw * weight_b1hw, blur_radius)
    local_color = local_color / local_weight.clamp_min(1e-5)

    total_weight = weight_b1hw.sum(dim=(2, 3), keepdim=True).clamp_min(1e-5)
    global_color = (image_bchw * weight_b1hw).sum(dim=(2, 3), keepdim=True) / total_weight
    local_color = torch.where(local_weight > 1e-4, local_color, global_color)
    return local_color.movedim(1, -1).clamp(0.0, 1.0)


def _ps_style_matte_solve(
    image: torch.Tensor,
    mask: torch.Tensor,
    background: torch.Tensor | None,
    radius: int,
    tolerance: float,
    mask_clean: float,
    detail_protect: float,
    fringe_suppression: float,
    hair_region: torch.Tensor | None = None,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    """Approximate Select and Mask color decontamination with foreground/background matting."""
    known_background = (mask <= 0.02).to(image.dtype)
    known_foreground = (mask >= 0.98).to(image.dtype)
    propagation_radius = max(4, radius * 2)

    if background is None:
        background_estimate = _weighted_color_propagation(
            image, known_background, propagation_radius
        )
    else:
        background_estimate = background

    if hair_region is not None:
        distance_to_background = torch.sqrt(
            torch.mean((image - background_estimate).pow(2), dim=-1).clamp_min(0.0)
        )
        contamination_limit = min(0.45, 0.05 + tolerance * 2.5)
        background_like_hair = (
            (hair_region > 0.35)
            & (distance_to_background < contamination_limit)
        ).to(image.dtype)
        known_foreground = known_foreground * (1.0 - background_like_hair)
    foreground_estimate = _weighted_color_propagation(
        image, known_foreground, propagation_radius
    )

    color_line = foreground_estimate - background_estimate
    color_line_energy = color_line.pow(2).sum(dim=-1).clamp_min(1e-5)
    solved_alpha = (
        ((image - background_estimate) * color_line).sum(dim=-1) / color_line_energy
    ).clamp(0.0, 1.0)

    reconstructed = (
        background_estimate * (1.0 - solved_alpha.unsqueeze(-1))
        + foreground_estimate * solved_alpha.unsqueeze(-1)
    )
    fit_error = torch.sqrt(torch.mean((image - reconstructed).pow(2), dim=-1).clamp_min(0.0))
    fit_confidence = (1.0 - fit_error / max(0.025, tolerance * 0.55)).clamp(0.0, 1.0)
    separation = torch.sqrt(torch.mean(color_line.pow(2), dim=-1).clamp_min(0.0))
    separation_confidence = (
        (separation - 0.015) / max(0.05, tolerance * 0.65)
    ).clamp(0.0, 1.0)
    solve_confidence = fit_confidence * separation_confidence

    subject = (mask > 0.02).to(image.dtype)
    inner_band = (subject - _erode(subject, radius)).clamp(0.0, 1.0)
    soft_pixels = (1.0 - torch.abs(mask * 2.0 - 1.0)).clamp(0.0, 1.0)
    solve_zone = torch.maximum(inner_band, soft_pixels)
    if hair_region is not None:
        solve_zone = torch.maximum(
            solve_zone,
            (hair_region > 0.35).to(image.dtype),
        )

    detail = _image_gradient_luma(image)
    detail_weight = (1.0 - detail * detail_protect * 0.35).clamp(0.65, 1.0)
    clean_weight = (
        solve_zone * solve_confidence * detail_weight * float(mask_clean)
    ).clamp(0.0, 1.0)

    # Select and Mask's decontamination removes background-colored coverage; it
    # must not invent extra foreground outside the supplied/model matte.
    removable_alpha = (mask - solved_alpha).clamp_min(0.0)
    refined_mask = (mask - removable_alpha * clean_weight).clamp(0.0, 1.0)

    stable_alpha = refined_mask.unsqueeze(-1).clamp_min(0.035)
    unmixed_foreground = (
        (image - background_estimate * (1.0 - stable_alpha)) / stable_alpha
    ).clamp(0.0, 1.0)

    # Very transparent pixels are numerically unstable. Match nearby opaque
    # foreground chroma while retaining the recovered pixel's luminance.
    unmixed_luma = _luma(unmixed_foreground)
    nearby_luma = _luma(foreground_estimate).clamp_min(1e-4)
    nearby_same_luma = (
        foreground_estimate * (unmixed_luma / nearby_luma)
    ).clamp(0.0, 1.0)
    transparent_amount = (1.0 - refined_mask).clamp(0.0, 1.0)
    stabilize_weight = (
        transparent_amount.sqrt() * float(fringe_suppression)
    ).clamp(0.0, 1.0).unsqueeze(-1)
    clean_foreground = torch.lerp(
        unmixed_foreground, nearby_same_luma, stabilize_weight
    ).clamp(0.0, 1.0)

    # A too-low solved alpha can make foreground unmixing negative, which then
    # clips to black and appears as a dark contour. Keep hair untouched, but
    # stabilize ordinary subject edges with the nearest reliable foreground
    # color whenever recovered luminance falls implausibly low.
    non_hair = torch.ones_like(refined_mask)
    if hair_region is not None:
        non_hair = 1.0 - (hair_region > 0.35).to(image.dtype)
    luminance_floor = nearby_luma * 0.55
    repaired_luma = torch.maximum(unmixed_luma, luminance_floor)
    repaired_foreground = (
        foreground_estimate * (repaired_luma / nearby_luma)
    ).clamp(0.0, 1.0)
    dark_clip = (
        (luminance_floor - unmixed_luma)
        / luminance_floor.clamp_min(0.025)
    ).clamp(0.0, 1.0)
    clean_foreground = torch.lerp(
        clean_foreground,
        repaired_foreground,
        (dark_clip[..., 0] * non_hair).unsqueeze(-1),
    ).clamp(0.0, 1.0)
    return clean_foreground, refined_mask, solve_confidence


def refine_matte(
    image: torch.Tensor,
    mask: torch.Tensor,
    background: torch.Tensor | None = None,
    hair_region: torch.Tensor | None = None,
    edge_radius: int = 18,
    decontaminate_strength: float = 0.85,
    background_tolerance: float = 0.42,
    hair_detail_protect: float = 0.35,
    mask_clean: float = 0.55,
    edge_feather: float = 1.2,
    fringe_suppression: float = 0.65,
    body_edge_protect: float = 0.85,
    quality: str = "标准",
) -> tuple[torch.Tensor, torch.Tensor]:
    image = _normalize_image(image)
    mask = _normalize_mask(mask, image)
    source_image = image
    source_mask = mask
    background = _normalize_optional_image(background, image)
    if hair_region is not None:
        hair_region = _normalize_mask(hair_region, image)

    strength = float(max(0.0, min(1.0, decontaminate_strength)))
    tolerance = float(max(0.05, min(1.0, background_tolerance)))
    detail_protect = float(max(0.0, min(1.0, hair_detail_protect)))
    mask_clean = float(max(0.0, min(1.0, mask_clean)))
    fringe_suppression = float(max(0.0, min(1.0, fringe_suppression)))
    body_edge_protect = float(max(0.0, min(1.0, body_edge_protect)))
    edge_radius = int(max(1, min(160, edge_radius)))
    feather_radius = int(max(0, round(float(edge_feather) * 2.0)))

    bg_image, bg_mask, bg_background, bg_radius = _resize_for_background(
        image, mask, background, edge_radius, quality
    )
    bg_hair_region = None
    if hair_region is not None:
        bg_hair_region = F.interpolate(
            hair_region.unsqueeze(1),
            size=bg_image.shape[1:3],
            mode="bilinear",
            align_corners=False,
        )[:, 0]
    clean_small, refined_mask_small, solve_confidence_small = _ps_style_matte_solve(
        image=bg_image,
        mask=bg_mask,
        background=bg_background,
        radius=bg_radius,
        tolerance=tolerance,
        mask_clean=mask_clean,
        detail_protect=detail_protect,
        fringe_suppression=fringe_suppression,
        hair_region=bg_hair_region,
    )
    refined_mask = _upsample_mask_like(refined_mask_small, image)
    clean_foreground = _upsample_image_like(clean_small, image)
    solve_confidence = _upsample_mask_like(solve_confidence_small, image)

    if feather_radius > 0:
        feathered = _box_blur_bchw(refined_mask.unsqueeze(1), feather_radius)[:, 0]
        edge_zone = (
            _dilate((refined_mask > 0.02).to(image.dtype), feather_radius)
            - _erode((refined_mask > 0.98).to(image.dtype), feather_radius)
        ).clamp(0.0, 1.0)
        feather_mix = min(1.0, float(edge_feather) / 5.0)
        refined_mask = torch.lerp(
            refined_mask,
            feathered,
            edge_zone * feather_mix,
        ).clamp(0.0, 1.0)

    hair_zone = torch.zeros_like(refined_mask)
    if hair_region is not None:
        hair_zone = (hair_region > 0.35).to(refined_mask.dtype)
    body_edge_zone = (1.0 - hair_zone).clamp(0.0, 1.0)
    body_alpha_floor = source_mask * body_edge_protect
    refined_mask = torch.where(
        body_edge_zone > 0.0,
        torch.maximum(refined_mask, body_alpha_floor),
        refined_mask,
    )

    transparency = (1.0 - refined_mask).clamp(0.0, 1.0)
    color_zone = (
        solve_confidence * transparency.sqrt() * strength
    ).clamp(0.0, 1.0).unsqueeze(-1)
    refined_image = torch.lerp(image, clean_foreground, color_zone).clamp(0.0, 1.0)

    subject = (source_mask > 0.02).to(source_mask.dtype)
    protected_edge_radius = max(1, min(32, edge_radius))
    allowed_zone = (subject - _erode(subject, protected_edge_radius)).clamp(0.0, 1.0)
    allowed_zone = torch.maximum(
        allowed_zone,
        ((source_mask > 0.02) & (source_mask < 0.98)).to(source_mask.dtype),
    )
    if hair_region is not None:
        allowed_zone = torch.maximum(
            allowed_zone,
            (hair_region > 0.35).to(source_mask.dtype),
        )
    refined_mask = torch.where(allowed_zone > 0.0, refined_mask, source_mask)
    refined_image = torch.where(
        (allowed_zone > 0.0).unsqueeze(-1),
        refined_image,
        source_image,
    )
    return refined_image, refined_mask


def _apply_alpha(image: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    alpha = mask.unsqueeze(-1).to(device=image.device, dtype=image.dtype).clamp(0.0, 1.0)
    return torch.cat([image[..., :3].clamp(0.0, 1.0), alpha], dim=-1)


class MyMatteRefine(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="MyComfnodeMatteRefine",
            display_name="My抠图细化",
            category="My-Comfnode/抠图",
            description="自动细化抠图边缘，削除头发和半透明边缘里混入的背景色。",
            inputs=[
                io.Image.Input("image", display_name="图像", tooltip="已经抠图或需要细化边缘的图像"),
                io.Combo.Input(
                    "mode",
                    ["使用输入遮罩细化", "自动抠图并细化"],
                    display_name="处理模式",
                    default="自动抠图并细化",
                ),
                io.Mask.Input("mask", display_name="遮罩", optional=True, tooltip="可选。接入时可用已有遮罩；不接入时自动调用 RMBG-2.0 抠图。"),
                io.Int.Input("auto_mask_res", display_name="自动抠图分辨率", default=1024, min=512, max=2048, step=64),
                io.Float.Input("auto_sensitivity", display_name="自动抠图灵敏度", default=1.0, min=0.0, max=1.0, step=0.01),
                io.Combo.Input("quality", ["快速", "标准", "精细"], display_name="处理精度", default="标准"),
                io.Int.Input("edge_radius", display_name="边缘范围", default=24, min=1, max=160, step=1),
                io.Float.Input("decontaminate_strength", display_name="去色污染强度", default=1.0, min=0.0, max=1.0, step=0.01),
                io.Float.Input("background_tolerance", display_name="背景相似度", default=0.12, min=0.05, max=1.0, step=0.01),
                io.Float.Input("hair_detail_protect", display_name="发丝保护", default=0.8, min=0.0, max=1.0, step=0.01),
                io.Float.Input("mask_clean", display_name="遮罩清理", default=0.7, min=0.0, max=1.0, step=0.01),
                io.Float.Input("edge_feather", display_name="边缘柔化", default=0.0, min=0.0, max=5.0, step=0.1),
                io.Float.Input("fringe_suppression", display_name="彩边抑制", default=0.75, min=0.0, max=1.0, step=0.01),
                io.Image.Input("background", display_name="背景图", optional=True, tooltip="可选：原背景或纯色背景图。接入后去背景色污染会更准。"),
                io.Combo.Input(
                    "internal_hair_refine",
                    ["开启", "关闭"],
                    display_name="内部发丝细化",
                    default="开启",
                    tooltip="识别整片头发并重算内部被 RMBG 误判为完全不透明的背景缝隙。",
                ),
                io.Int.Input(
                    "internal_hair_range",
                    display_name="内部发丝范围",
                    default=72,
                    min=8,
                    max=256,
                    step=4,
                ),
                io.Int.Input(
                    "matting_resolution",
                    display_name="Alpha细化分辨率",
                    default=1536,
                    min=768,
                    max=2048,
                    step=64,
                ),
                io.Float.Input(
                    "body_edge_protect",
                    display_name="人物边缘保护",
                    default=0.85,
                    min=0.0,
                    max=1.0,
                    step=0.01,
                    tooltip="防止非毛发人物边缘被过度降低 Alpha 后产生黑边。数值越高越接近原遮罩。",
                ),
            ],
            outputs=[
                io.Image.Output(display_name="透明细化图像"),
                io.Mask.Output(display_name="细化遮罩"),
                io.Image.Output(display_name="RGB细化图像"),
            ],
        )

    @classmethod
    def execute(
        cls,
        image,
        mode="自动抠图并细化",
        mask=None,
        auto_mask_res=1024,
        auto_sensitivity=1.0,
        quality="标准",
        internal_hair_refine="开启",
        internal_hair_range=72,
        matting_resolution=1536,
        edge_radius=24,
        decontaminate_strength=1.0,
        background_tolerance=0.12,
        hair_detail_protect=0.8,
        mask_clean=0.7,
        edge_feather=0.0,
        fringe_suppression=0.75,
        body_edge_protect=0.85,
        background=None,
    ) -> io.NodeOutput:
        if mask is None:
            mask = _rmbg_mask(image, auto_mask_res, auto_sensitivity)
        hair_region = None
        if internal_hair_refine == "开启":
            mask, hair_region = _vitmatte_refine_mask(
                image,
                mask,
                internal_range=internal_hair_range,
                process_resolution=matting_resolution,
            )
        refined_image, refined_mask = refine_matte(
            image=image,
            mask=mask,
            background=background,
            hair_region=hair_region,
            edge_radius=edge_radius,
            decontaminate_strength=decontaminate_strength,
            background_tolerance=background_tolerance,
            hair_detail_protect=hair_detail_protect,
            mask_clean=mask_clean,
            edge_feather=edge_feather,
            fringe_suppression=fringe_suppression,
            body_edge_protect=body_edge_protect,
            quality=quality,
        )
        return io.NodeOutput(_apply_alpha(refined_image, refined_mask), refined_mask, refined_image)

    def process(self, **kwargs):
        image = kwargs.get("图像", kwargs.get("image"))
        mask = kwargs.get("遮罩", kwargs.get("mask"))
        mode = kwargs.get("处理模式", kwargs.get("mode", "自动抠图并细化"))
        if mask is None:
            mask = _rmbg_mask(
                image,
                kwargs.get("自动抠图分辨率", kwargs.get("auto_mask_res", 1024)),
                kwargs.get("自动抠图灵敏度", kwargs.get("auto_sensitivity", 1.0)),
            )
        hair_region = None
        if kwargs.get("内部发丝细化", kwargs.get("internal_hair_refine", "开启")) == "开启":
            mask, hair_region = _vitmatte_refine_mask(
                image,
                mask,
                internal_range=kwargs.get("内部发丝范围", kwargs.get("internal_hair_range", 72)),
                process_resolution=kwargs.get("Alpha细化分辨率", kwargs.get("matting_resolution", 1536)),
            )
        refined_image, refined_mask = refine_matte(
            image=image,
            mask=mask,
            background=kwargs.get("背景图", kwargs.get("background")),
            hair_region=hair_region,
            edge_radius=kwargs.get("边缘范围", kwargs.get("edge_radius", 24)),
            decontaminate_strength=kwargs.get("去色污染强度", kwargs.get("decontaminate_strength", 1.0)),
            background_tolerance=kwargs.get("背景相似度", kwargs.get("background_tolerance", 0.12)),
            hair_detail_protect=kwargs.get("发丝保护", kwargs.get("hair_detail_protect", 0.8)),
            mask_clean=kwargs.get("遮罩清理", kwargs.get("mask_clean", 0.7)),
            edge_feather=kwargs.get("边缘柔化", kwargs.get("edge_feather", 0.0)),
            fringe_suppression=kwargs.get("彩边抑制", kwargs.get("fringe_suppression", 0.75)),
            body_edge_protect=kwargs.get("人物边缘保护", kwargs.get("body_edge_protect", 0.85)),
            quality=kwargs.get("处理精度", kwargs.get("quality", "标准")),
        )
        return _apply_alpha(refined_image, refined_mask), refined_mask, refined_image


NODE_CLASS_MAPPINGS = {
    "MyComfnodeMatteRefine": MyMatteRefine,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MyComfnodeMatteRefine": "My抠图细化",
}
