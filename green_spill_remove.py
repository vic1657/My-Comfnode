"""绿色溢色去除（Green Spill Remove）

RMBG 等分割模型抠图后，边缘半透明像素里残留的绿幕背景色（绿边）
不会被修复，因为掩膜只决定透明度、不改像素颜色。本节点用经典
色度运算做去溢色：对"绿色显著高于红蓝均值"的像素，把绿通道
压回 (R+B)/2，从而把混进来的绿洗回中性色。

- 纯数值运算，无模型、无依赖，CPU/GPU 均可，速度极快
- 只处理"绿色占优"的像素，画面里真正的绿色物体默认会被保护
  （如需对整图强制处理，把 threshold 调到 0）
"""

from __future__ import annotations

import torch
import torch.nn.functional as F


def _dilate_mask(mask: torch.Tensor, radius: int) -> torch.Tensor:
    """mask: [B, 1, H, W] -> 膨胀后的 0/1 掩膜，用于限定边缘处理带"""
    if radius <= 0:
        return mask
    k = 2 * radius + 1
    kernel = torch.ones(1, 1, k, k, device=mask.device, dtype=mask.dtype)
    padded = F.pad(mask, (radius, radius, radius, radius), mode="replicate")
    out = F.conv2d(padded, kernel)
    return (out > 0).to(mask.dtype)


class MyGreenSpillRemove:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "抠图后的图像（带软边/毛边）"}),
                "strength": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.05,
                        "tooltip": "去溢色强度，1.0 = 绿通道完全压回 (R+B)/2",
                    },
                ),
                "threshold": (
                    "FLOAT",
                    {
                        "default": 0.03,
                        "min": 0.0,
                        "max": 0.5,
                        "step": 0.01,
                        "tooltip": "绿色占优判定阈值。越大越保守（只处理明显发绿的像素）；设 0 则所有 G>R、G>B 的像素都参与",
                    },
                ),
                "edge_radius": (
                    "INT",
                    {
                        "default": 12,
                        "min": 0,
                        "max": 256,
                        "step": 1,
                        "tooltip": "接入 mask 时，向外扩展多少像素作为边缘处理带；0 = 不扩展",
                    },
                ),
            },
            "optional": {
                "mask": (
                    "MASK",
                    {"tooltip": "可选。RMBG 输出的 alpha 遮罩，接入后只在边缘带内去溢色，主体内部完全不动"},
                ),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "remove_spill"
    CATEGORY = "My-Comfnode/图像"
    DESCRIPTION = "去除绿幕/纯绿背景抠图后残留在软边缘的绿色溢色（绿边），纯颜色运算，速度极快。"

    def remove_spill(self, image, strength=1.0, threshold=0.03, edge_radius=12, mask=None):
        img = image.clone()
        rgb = img[..., :3]
        r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]

        half = (r + b) * 0.5

        # 软性"绿色占优"权重：超出阈值越多，参与去溢色越充分
        excess = g - half - threshold
        weight = torch.clamp(excess / 0.10, 0.0, 1.0)

        # 经典溢色抑制：绿通道压向 (R+B)/2（不增不减其他通道的亮度关系）
        g_fixed = torch.minimum(g, half)
        factor = weight * strength
        g_new = g + (g_fixed - g) * factor

        rgb[..., 1] = g_new

        # 可选：只在 mask 边缘带内生效
        if mask is not None:
            m = mask.to(device=img.device, dtype=img.dtype).unsqueeze(1)  # B,1,H,W
            m = _dilate_mask(m, edge_radius).squeeze(1)  # B,H,W
            if m.shape[-2:] != rgb.shape[1:3]:
                m = F.interpolate(
                    m.unsqueeze(1), size=rgb.shape[1:3], mode="bilinear", align_corners=False
                ).squeeze(1)
            band = m.unsqueeze(-1)  # B,H,W,1
            rgb.mul_(band).add_(img[..., :3] * (1.0 - band))

        img[..., :3] = rgb
        return (img,)


NODE_CLASS_MAPPINGS = {"MyGreenSpillRemove": MyGreenSpillRemove}
NODE_DISPLAY_NAME_MAPPINGS = {"MyGreenSpillRemove": "My绿色溢色去除"}
