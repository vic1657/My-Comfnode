# -*- coding: utf-8 -*-
"""MY色度可视化抠图 —— 剪映式色度抠图(可视化实时预览)

行为对齐剪映「色度抠图」:
  强度     : 抠色容差, 0=不抠, 越大抠得越多(拉满会伤主体)
  阴影     : 暗部/投影处理, 越大暗绿越容易被抠(拉满会啃暗色主体)
  边缘羽化 : 边缘过渡柔化
  边缘清除 : 去绿边+边缘收缩; 0=保留原图绿边, 调高后绿边消失且主体完整

前端 JS 实时预览与后端同一套算法, 拖滑块即时出效果, 无需重新排队。
"""

from __future__ import annotations

import time

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

import folder_paths


def _hex_to_rgb01(hex_str: str):
    s = (hex_str or "").strip().lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    if len(s) != 8 and len(s) == 6:
        try:
            return (int(s[0:2], 16) / 255.0, int(s[2:4], 16) / 255.0, int(s[4:6], 16) / 255.0)
        except ValueError:
            pass
    return (74 / 255.0, 223 / 255.0, 92 / 255.0)  # 兜底: 剪映默认绿


def _ss(e0, e1, x):
    if isinstance(x, (int, float)) and isinstance(e0, (int, float)) and isinstance(e1, (int, float)):
        u = (x - e0) / max(e1 - e0, 1e-6)
        u = min(1.0, max(0.0, u))
        return u * u * (3 - 2 * u)
    denom = e1 - e0
    if not torch.is_tensor(denom):
        denom = torch.full_like(x if torch.is_tensor(x) else e0, float(denom) if abs(float(denom)) > 1e-12 else 1e-6)
    denom = torch.clamp(denom, min=1e-6)
    t = torch.clamp((x - e0) / denom, 0.0, 1.0)
    return t * t * (3 - 2 * t)


def _key_chroma_norm(key_rgb):
    kr, kg, kb = key_rgb
    luma = max(0.299 * kr + 0.587 * kg + 0.114 * kb, 0.02)
    cr, cb = (kr - luma) / luma, (kb - luma) / luma
    if cr * cr + cb * cb < 1e-6:  # 灰色取色兜底 -> 标准绿
        cr, cb = -0.548, -0.437
    return cr, cb


def _box_blur3(a: torch.Tensor, r: int) -> torch.Tensor:
    """3 次 box blur 近似高斯。a: (N,1,H,W)"""
    if r <= 0:
        return a
    k = 2 * r + 1
    wx = torch.ones(1, 1, 1, k, device=a.device, dtype=a.dtype) / k
    wy = wx.transpose(2, 3)
    for _ in range(3):
        a = F.conv2d(F.pad(a, (r, r, 0, 0), mode="replicate"), wx)
        a = F.conv2d(F.pad(a, (0, 0, r, r), mode="replicate"), wy)
    return a


class MyChromaKeyVisual:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE", {"tooltip": "输入图像(绿幕/蓝幕素材)"}),
                "取色器": ("STRING", {"default": "#4ADF5C", "tooltip": "抠像键控色, 可点击画布吸色"}),
                "强度": ("FLOAT", {"default": 22.0, "min": 0.0, "max": 100.0, "step": 1}),
                "阴影": ("FLOAT", {"default": 33.0, "min": 0.0, "max": 100.0, "step": 1}),
                "边缘羽化": ("FLOAT", {"default": 14.0, "min": 0.0, "max": 100.0, "step": 1}),
                "边缘清除": ("FLOAT", {"default": 33.0, "min": 0.0, "max": 100.0, "step": 1}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "IMAGE")
    RETURN_NAMES = ("图像RGBA", "蒙版(主体为1)", "图像(黑底RGB)")
    FUNCTION = "run"
    CATEGORY = "My-Comfnode/抠图"
    DESCRIPTION = "剪映式色度抠图可视化节点: 拖动滑块实时预览抠图结果, 无需重新排队。取色器可吸色。"
    OUTPUT_NODE = True

    def run(self, 图像, 取色器, 强度, 阴影, 边缘羽化, 边缘清除):
        img = 图像
        device = img.device
        x = img[..., :3].permute(0, 3, 1, 2).contiguous()  # N,3,H,W

        r, g, b = x[:, 0], x[:, 1], x[:, 2]
        luma = 0.299 * r + 0.587 * g + 0.114 * b
        luma_s = torch.clamp(luma, min=0.02)
        cr = (r - luma_s) / luma_s
        cb = (b - luma_s) / luma_s

        kcr, kcb = _key_chroma_norm(_hex_to_rgb01(取色器))
        k2 = kcr * kcr + kcb * kcb
        kmag = k2 ** 0.5

        a = (cr * kcr + cb * kcb) / k2
        cmag2 = cr * cr + cb * cb
        cross = torch.abs(cr * kcb - cb * kcr)
        sin_dh = cross / (torch.sqrt(cmag2 + 1e-10) * kmag + 1e-10)
        cmag = torch.sqrt((r - luma) ** 2 + (b - luma) ** 2)
        # 绝对色度门槛: 黑毛反光(cmag~0.03-0.06)与暗绿地面影(0.1+)的区分, 保护暗色主体
        chroma_w = _ss(0.015, 0.05, cmag)

        t = float(强度) / 100.0
        st = float(阴影) / 100.0
        ft = float(边缘羽化) / 100.0
        ct = float(边缘清除) / 100.0

        gain = _ss(0.0, 0.08, t)  # 强度=0 时完全不抠(含阴影项)

        # 对齐阈值: 强度越高阈值越低(抠得越多)
        a_lo = 0.30 + (0.02 - 0.30) * t
        # 色相窗口: 强度越高越宽
        hue_in = 0.15 + 0.25 * t
        hue_out = 0.45 + 0.45 * t
        hue_w = 1.0 - _ss(hue_in, hue_out, sin_dh)

        # 阴影: 暗部权重
        v = x.max(dim=1, keepdim=True).values.squeeze(1)
        dark_w = 1.0 - _ss(0.06, 0.45 - 0.30 * st, v)
        # 暗部保护: 阴影低时, 暗色主体(黑毛绿反光)需要更强的绿色关联才会被抠
        a_lo_eff = a_lo + (1.0 - st) * 0.22 * dark_w
        align_w = _ss(a_lo_eff, a_lo_eff + 0.08, a)

        big = align_w * hue_w * chroma_w * gain

        # 阴影项: 补抠暗部且绿色关联中等的像素(绿幕投影), 也受强度门控
        b_dark = st * gain * dark_w * hue_w * _ss(0.25, 0.45, a) * chroma_w
        big = torch.maximum(big, b_dark)

        alpha = 1.0 - torch.clamp(big, 0.0, 1.0)
        alpha4 = alpha.unsqueeze(1)  # N,1,H,W

        # 背景扩散净化: 从确信背景向外扩散, 压制边缘半透明残留
        conf = (alpha4 < 0.15).float()
        grow = conf
        for _ in range(10):
            grow = F.max_pool2d(grow, 3, stride=1, padding=1)
        soft = (grow > 0.5) & (alpha4 < 0.92) & (conf < 0.5)
        alpha4 = torch.where(soft, alpha4 * 0.30, alpha4)

        # 主体内部破洞自动填补: 被实心区包围的孤立破洞/半透明点补实
        solid = (alpha4 > 0.9).float()
        nb21 = F.avg_pool2d(F.pad(solid, (10, 10, 10, 10), mode="replicate"), 21, stride=1)
        nb15 = F.avg_pool2d(F.pad(solid, (7, 7, 7, 7), mode="replicate"), 15, stride=1)
        fill = ((alpha4 < 0.5) & (nb21 > 0.8)) | ((alpha4 < 0.92) & (nb21 > 0.92)) \
             | ((alpha4 < 0.5) & (nb15 > 0.72))
        alpha4 = torch.where(fill, torch.full_like(alpha4, 0.99), alpha4)

        # 边缘羽化
        sigma = ft * 8.0
        if sigma > 0.3:
            alpha4 = _box_blur3(alpha4, max(1, int(round(sigma))))

        # 边缘清除: 收缩(侵蚀)
        r_er = int(round(ct * 4))
        if r_er > 0:
            k = 2 * r_er + 1
            alpha4 = -F.max_pool2d(-alpha4, k, stride=1, padding=r_er)

        # 去溢色(despill): 仅作用于边缘半透明带
        band = 1.0 - _ss(0.30, 1.0, alpha4)
        spill_scale = min(1.0, ct * 5.0)
        spill_w = (spill_scale * band * (alpha4 > 0.003).float()).clamp(0.0, 1.0)

        kr, kg, kb = _hex_to_rgb01(取色器)
        if kg >= kr and kg >= kb:
            others = torch.max(x[:, 0], x[:, 2]).unsqueeze(1)
            dom2 = torch.min(x[:, 1].unsqueeze(1), others)
            x = torch.cat([x[:, 0:1], x[:, 1:2] * (1 - spill_w) + dom2 * spill_w, x[:, 2:3]], dim=1)
        elif kr >= kg and kr >= kb:
            others = torch.max(x[:, 1], x[:, 2]).unsqueeze(1)
            dom2 = torch.min(x[:, 0].unsqueeze(1), others)
            x = torch.cat([x[:, 0:1] * (1 - spill_w) + dom2 * spill_w, x[:, 1:2], x[:, 2:3]], dim=1)
        else:
            others = torch.max(x[:, 0], x[:, 1]).unsqueeze(1)
            dom2 = torch.min(x[:, 2].unsqueeze(1), others)
            x = torch.cat([x[:, 0:1], x[:, 1:2], x[:, 2:3] * (1 - spill_w) + dom2 * spill_w], dim=1)

        alpha_c = alpha4.squeeze(1).clamp(0.0, 1.0)
        rgba = torch.cat([x.clamp(0.0, 1.0), alpha_c.unsqueeze(1)], dim=1).permute(0, 2, 3, 1)
        rgb_black = (x.clamp(0.0, 1.0) * alpha4).permute(0, 2, 3, 1)
        mask = alpha_c

        # 保存源图供前端实时预览(JS 端用同一算法在浏览器重算)
        src_entry = None
        try:
            import os
            arr = (img[0].detach().float().cpu().numpy() * 255.0 + 0.5).clip(0, 255).astype(np.uint8)
            pil = Image.fromarray(arr[..., :3])
            out_dir = folder_paths.get_temp_directory()
            os.makedirs(out_dir, exist_ok=True)  # temp 目录可能被启动器清理
            fname = f"mychroma_src_{int(time.time() * 1000)}.png"
            pil.save(os.path.join(out_dir, fname), compress_level=1)
            src_entry = {"filename": fname, "subfolder": "", "type": "temp"}
        except Exception as e:
            print(f"[MY色度抠图] 保存预览源图失败: {e}")
            src_entry = None

        ui = {"src_images": [src_entry]} if src_entry else {}
        return {"ui": ui, "result": (rgba, mask, rgb_black)}


NODE_CLASS_MAPPINGS = {"MyChromaKeyVisual": MyChromaKeyVisual}
NODE_DISPLAY_NAME_MAPPINGS = {"MyChromaKeyVisual": "MY色度可视化抠图"}
