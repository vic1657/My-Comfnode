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
    if min(value.shape[:3]) < 1:
        raise ValueError(f"{name} 不能为空")
    return value


def _match_batches(first: torch.Tensor, second: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    first_batch = int(first.shape[0])
    second_batch = int(second.shape[0])
    if first_batch == second_batch:
        return first, second
    if first_batch == 1:
        return first.expand(second_batch, -1, -1, -1), second
    if second_batch == 1:
        return first, second.expand(first_batch, -1, -1, -1)
    raise ValueError(
        "原图与 AI 图批次数量必须一致，或其中一侧只能有一张图；"
        f"当前为 {first_batch} 与 {second_batch}"
    )


def _match_mask(
    value: torch.Tensor,
    batch: int,
    height: int,
    width: int,
    device: torch.device,
) -> torch.Tensor:
    if not isinstance(value, torch.Tensor):
        raise TypeError("输入遮罩必须是 ComfyUI MASK 张量")
    if value.ndim == 2:
        value = value.unsqueeze(0)
    elif value.ndim == 4 and value.shape[-1] == 1:
        value = value[..., 0]
    elif value.ndim == 4 and value.shape[1] == 1:
        value = value[:, 0]
    if value.ndim != 3 or min(value.shape) < 1:
        raise ValueError(f"输入遮罩必须是 BHW 张量，当前形状为 {tuple(value.shape)}")
    if value.shape[0] == 1 and batch > 1:
        value = value.expand(batch, -1, -1)
    elif value.shape[0] != batch:
        raise ValueError(
            "输入遮罩批次数量必须与图像一致，或遮罩只能有一张；"
            f"当前为 {value.shape[0]} 与 {batch}"
        )
    mask = value.to(device=device, dtype=torch.float32).unsqueeze(1)
    if mask.shape[-2:] != (height, width):
        mask = F.interpolate(mask, size=(height, width), mode="bilinear", align_corners=False)
    return mask.clamp(0.0, 1.0)


def _resize_nchw(value: torch.Tensor, size: tuple[int, int]) -> torch.Tensor:
    if value.shape[-2:] == size:
        return value
    return F.interpolate(value, size=size, mode="bilinear", align_corners=False)


def _gaussian_blur(value: torch.Tensor, sigma: float) -> torch.Tensor:
    sigma = max(0.01, float(sigma))
    if sigma <= 0.08:
        return value
    radius = max(1, int(round(sigma * 3.0)))
    coords = torch.arange(-radius, radius + 1, device=value.device, dtype=value.dtype)
    kernel = torch.exp(-(coords.square()) / (2.0 * sigma * sigma))
    kernel = kernel / kernel.sum().clamp_min(1e-8)
    channels = value.shape[1]
    horizontal = kernel.view(1, 1, 1, -1).expand(channels, 1, 1, -1)
    vertical = kernel.view(1, 1, -1, 1).expand(channels, 1, -1, 1)
    padded = F.pad(value, (radius, radius, 0, 0), mode="replicate")
    blurred = F.conv2d(padded, horizontal, groups=channels)
    padded = F.pad(blurred, (0, 0, radius, radius), mode="replicate")
    return F.conv2d(padded, vertical, groups=channels)


def _luminance(rgb: torch.Tensor) -> torch.Tensor:
    weights = rgb.new_tensor(_LUMA).view(1, 3, 1, 1)
    return (rgb * weights).sum(dim=1, keepdim=True)


def _smoothstep(value: torch.Tensor, start: float, end: float) -> torch.Tensor:
    scaled = ((value - start) / max(float(end) - float(start), 1e-6)).clamp(0.0, 1.0)
    return scaled.square() * (3.0 - 2.0 * scaled)


def separate_elements(
    original_image: torch.Tensor,
    ai_image: torch.Tensor,
    input_mask: torch.Tensor,
    difference_threshold: float = 0.14,
    transition_width: float = 0.10,
    structure_weight: float = 0.25,
    mask_feather: float = 1.5,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    original = _ensure_image(original_image, "原图")
    ai = _ensure_image(ai_image, "AI 图")
    original, ai = _match_batches(original, ai)
    batch, height, width = ai.shape[:3]
    device = ai.device
    original_rgb = original[..., :3].to(device=device, dtype=torch.float32).clamp(0.0, 1.0)
    ai_rgb = ai[..., :3].to(device=device, dtype=torch.float32).clamp(0.0, 1.0)
    original_rgb = _resize_nchw(original_rgb.permute(0, 3, 1, 2), (height, width))
    ai_rgb = ai_rgb.permute(0, 3, 1, 2)
    source_mask = _match_mask(input_mask, batch, height, width, device)

    original_luma = _luminance(original_rgb)
    ai_luma = _luminance(ai_rgb)
    rgb_difference = (original_rgb - ai_rgb).abs().mean(dim=1, keepdim=True)
    luma_difference = (original_luma - ai_luma).abs()

    # 大尺度差异抓住积雪、光斑和新增物体；高频差异只占较小权重，避免把正常纹理变化全删掉。
    broad_difference = _gaussian_blur(rgb_difference * 0.7 + luma_difference * 0.3, 2.2)
    original_detail = original_luma - _gaussian_blur(original_luma, 1.6)
    ai_detail = ai_luma - _gaussian_blur(ai_luma, 1.6)
    structure_difference = (original_detail - ai_detail).abs()
    difference = (broad_difference * (1.0 - structure_weight) + structure_difference * structure_weight).clamp(0.0, 1.0)

    threshold = max(0.0, min(1.0, float(difference_threshold)))
    transition = max(0.005, min(1.0, float(transition_width)))
    added_score = _smoothstep(difference, threshold, threshold + transition)
    if mask_feather > 0.05:
        source_mask = _gaussian_blur(source_mask, float(mask_feather)).clamp(0.0, 1.0)

    ignored_mask = (source_mask * added_score).clamp(0.0, 1.0)
    keep_mask = (source_mask * (1.0 - added_score)).clamp(0.0, 1.0)
    debug_score = (added_score * source_mask).clamp(0.0, 1.0)
    debug = torch.cat(
        (
            (debug_score * 1.15).clamp(0.0, 1.0),
            (debug_score * 0.22).clamp(0.0, 1.0),
            (debug_score * 0.08).clamp(0.0, 1.0),
        ),
        dim=1,
    )
    return keep_mask[:, 0], ignored_mask[:, 0], debug.permute(0, 2, 3, 1)


class MyElementSeparationMask:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "原图": ("IMAGE", {"tooltip": "未生成元素前的原图，需与 AI 图对应"}),
                "AI图": ("IMAGE", {"tooltip": "AI 生成图，包含需要保留的雪、光或新增物体"}),
                "输入遮罩": ("MASK", {"tooltip": "人物或目标候选遮罩；白色区域才会参与元素分离"}),
                "差异阈值": (
                    "FLOAT",
                    {"default": 0.14, "min": 0.0, "max": 1.0, "step": 0.01, "display": "slider",
                     "tooltip": "原图与 AI 图差异低于此值时保留原图细节；调低会更容易排除 AI 新元素"},
                ),
                "过渡宽度": (
                    "FLOAT",
                    {"default": 0.10, "min": 0.01, "max": 0.5, "step": 0.01, "display": "slider",
                     "tooltip": "差异到排除遮罩的过渡宽度；调大边缘更柔和"},
                ),
                "结构差异权重": (
                    "FLOAT",
                    {"default": 0.25, "min": 0.0, "max": 1.0, "step": 0.01, "display": "slider",
                     "tooltip": "结构差异权重；积雪和新增物体明显时可适当调高"},
                ),
                "遮罩羽化": (
                    "FLOAT",
                    {"default": 1.5, "min": 0.0, "max": 12.0, "step": 0.5, "display": "slider",
                     "tooltip": "输入人物遮罩边缘羽化，避免细节恢复出现硬边"},
                ),
            }
        }

    RETURN_TYPES = ("MASK", "MASK", "IMAGE")
    RETURN_NAMES = ("有效细节遮罩", "AI新增元素遮罩", "差异参考图")
    FUNCTION = "separate"
    CATEGORY = "My-Comfnode/遮罩"
    DESCRIPTION = "对比原图与 AI 图，在输入候选遮罩内排除 AI 新增的雪、光和物体，输出适合细节恢复的有效遮罩。"

    def separate(self, original_image=None, ai_image=None, input_mask=None, difference_threshold=0.14,
                 transition_width=0.10, structure_weight=0.25, mask_feather=1.5, **kwargs):
        # 用中文接口名显示，同时兼容内部测试和旧式英文调用。
        original_image = kwargs.get("原图", original_image)
        ai_image = kwargs.get("AI图", ai_image)
        input_mask = kwargs.get("输入遮罩", input_mask)
        difference_threshold = kwargs.get("差异阈值", difference_threshold)
        transition_width = kwargs.get("过渡宽度", transition_width)
        structure_weight = kwargs.get("结构差异权重", structure_weight)
        mask_feather = kwargs.get("遮罩羽化", mask_feather)
        keep, ignored, debug = separate_elements(
            original_image,
            ai_image,
            input_mask,
            difference_threshold,
            transition_width,
            structure_weight,
            mask_feather,
        )
        return keep, ignored, debug


NODE_CLASS_MAPPINGS = {
    "MyElementSeparationMask": MyElementSeparationMask,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MyElementSeparationMask": "My元素分离遮罩",
}
