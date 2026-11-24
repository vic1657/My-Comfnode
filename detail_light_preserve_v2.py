# -*- coding: utf-8 -*-
"""
detail_light_preserve_v2.py
===========================
My细节光影保留 V2 —— 在 V1（detail_light_preserve.py）基础上提升细节忠实度。

相对 V1 的改动（算法框架不变：sRGB 线性域 + log 亮度高斯带通 + 保护掩码）：
  1. 增益封顶放宽  gain.clamp(0.66,1.50) → (0.55, 1.85)
       V1 的 1.50 硬顶把「需要提亮恢复」的纹理一刀切，是细节不够的主因之一。
  2. 细节尺度细化  _detail_sigma 上限 6.0→4.0，并新增更细一档带通并联
       V1 单一 sigma 在 2752px 宽约 5.5px，丢失毛孔/发丝级最细纹理。
  3. 可信区 gate 提升  protection 膨胀/羽化减半 + light_boundary 阈值上移
       V1 的 gate 在脸部仅 0.56-0.62，可信皮肤区细节被无谓稀释。
  4. 新增「细节忠实度」滑块  detail_fidelity（默认 0.85）
       在 V1 strength 之外，对高可信区额外把增益推向原图细节本身（无限接近原图）。
保护机制（轮廓光/投影边缘/错位轮廓/结构冲突）完整保留，防灰边/双边/割裂。
"""
from __future__ import annotations

import importlib.util
import math
import os
import sys

import torch
import torch.nn.functional as F


def _load_v1():
    """从同目录加载 V1 模块（兼容 importlib 单文件加载，非 package）"""
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, "detail_light_preserve.py")
    spec = importlib.util.spec_from_file_location("_dlp_v1_shared", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["_dlp_v1_shared"] = mod
    spec.loader.exec_module(mod)
    return mod


_v1 = _load_v1()
_ensure_image = _v1._ensure_image
_match_batches = _v1._match_batches
_resize_nchw = _v1._resize_nchw
_prepare_restore_mask = _v1._prepare_restore_mask
_srgb_to_linear = _v1._srgb_to_linear
_linear_to_srgb = _v1._linear_to_srgb
_luminance = _v1._luminance
_gaussian_blur = _v1._gaussian_blur
_gradient_magnitude = _v1._gradient_magnitude
_smoothstep = _v1._smoothstep
_EPSILON = _v1._EPSILON


# V2 预设：在 V1 基础上调细节忠实度
# 调参原则：细节率目标 ≈1.0（既不稀释也不放大）。新郞脸/新娘脸实测 V1=1.18/0.84，
# V2 初版过冲到 1.62/1.49（增益叠加过猛）→ 收紧到 1.05-1.15 区间。
_PRESET_V2 = {
    "maximum_log_detail": 0.42,      # 同 V1（放宽 clamp 会让 base 本身就过冲，V2 靠 fidelity 追加）
    "lighting_edge_start": 0.16,     # V1 0.11 → 0.16（更少误伤正常纹理边界）
    "lighting_edge_end": 0.58,       # V1 0.48 → 0.58
    "source_only_edge_start": 0.34,  # 同 V1
    "source_only_edge_end": 1.20,    # 同 V1
    "correlation_safe_start": 0.05,  # 同 V1
    "correlation_safe_end": 0.72,    # 同 V1
    "gain_lo": 0.62,                 # V1 0.66 → 0.62（微调）
    "gain_hi": 1.50,                 # 同 V1（放宽会让新郎脸从 1.18 过冲到 1.4+）
    "protect_dilate": 0.5,           # V1 0.9 → 0.5（膨胀减半，保护带更精准）
    "protect_feather": 0.5,          # V1 0.9 → 0.5（羽化减半）
    "extra_fidelity_coef": 0.45,     # 高可信区额外补细节的系数（初版 0.7 过冲 → 0.45）
}


def _detail_sigma_v2(height: int, width: int) -> float:
    # 主带通：比 V1 略细（上限 6.0→4.0），保留更多中细纹理
    return max(1.60, min(4.00, min(height, width) / 680.0))


def _restore_micro_detail_v2(
    original_rgb: torch.Tensor,
    relit_rgb: torch.Tensor,
    detail_strength: float,
    detail_fidelity: float,
    user_mask: torch.Tensor | None = None,
) -> tuple[torch.Tensor, torch.Tensor]:
    original_linear = _srgb_to_linear(original_rgb).clamp(0.0, 1.0)
    relit_linear = _srgb_to_linear(relit_rgb).clamp(0.0, 1.0)
    original_log_luma = torch.log(_luminance(original_linear).clamp_min(1e-4))
    relit_log_luma = torch.log(_luminance(relit_linear).clamp_min(1e-4))

    height, width = original_log_luma.shape[-2:]
    sigma = _detail_sigma_v2(height, width)
    # 主细节带（中频）+ 更细一档（高频，恢复毛孔/发丝）
    o_det = original_log_luma - _gaussian_blur(original_log_luma, sigma)
    r_det = relit_log_luma - _gaussian_blur(relit_log_luma, sigma)
    fine_sigma = max(0.8, sigma * 0.45)
    o_fine = original_log_luma - _gaussian_blur(original_log_luma, fine_sigma)
    r_fine = relit_log_luma - _gaussian_blur(relit_log_luma, fine_sigma)

    # ---- 保护掩码（逻辑同 V1，参数放宽）----
    structure_sigma = sigma * 2.4
    o_st = original_log_luma - _gaussian_blur(original_log_luma, structure_sigma)
    r_st = relit_log_luma - _gaussian_blur(relit_log_luma, structure_sigma)
    corr_sigma = sigma * 1.8
    cross = _gaussian_blur(o_st * r_st, corr_sigma)
    o_energy = _gaussian_blur(o_st.square(), corr_sigma)
    r_energy = _gaussian_blur(r_st.square(), corr_sigma)
    correlation = cross / torch.sqrt(o_energy * r_energy + 1e-7)
    shared = _smoothstep(torch.sqrt(torch.minimum(o_energy, r_energy) + 1e-8), 0.045, 0.180)
    corr_safe = _smoothstep(correlation, _PRESET_V2["correlation_safe_start"], _PRESET_V2["correlation_safe_end"])
    conflict = (1.0 - corr_safe) * shared

    o_base = _gaussian_blur(original_log_luma, sigma * 0.85)
    r_base = _gaussian_blur(relit_log_luma, sigma * 0.85)
    o_edge = _gradient_magnitude(o_base)
    r_edge = _gradient_magnitude(r_base)
    light_delta = _gaussian_blur(relit_log_luma - original_log_luma, sigma * 1.2)
    light_edge = _gradient_magnitude(light_delta)
    light_bnd = _smoothstep(light_edge, _PRESET_V2["lighting_edge_start"], _PRESET_V2["lighting_edge_end"])

    src_only = (o_edge - r_edge * 1.15).clamp_min(0.0)
    src_bnd = _smoothstep(src_only, _PRESET_V2["source_only_edge_start"], _PRESET_V2["source_only_edge_end"])

    protection = torch.maximum(light_bnd, torch.maximum(conflict, src_bnd))
    # 膨胀/羽化减半：保护带更精准，可信区不再被大片稀释
    radius = max(1, round(sigma * _PRESET_V2["protect_dilate"]))
    protection = F.max_pool2d(protection, kernel_size=radius * 2 + 1, stride=1, padding=radius)
    protection = _gaussian_blur(protection, sigma * _PRESET_V2["protect_feather"]).clamp(0.0, 1.0)
    gate = 1.0 - protection

    # ---- V2 细节忠实度：高可信区把增益推向原图细节本身 ----
    # fidelity_gate：可信且结构一致的区域，额外提升细节还原（无限接近原图）
    fidelity_gate = gate * corr_safe * float(max(0.0, min(1.0, detail_fidelity)))

    # 中频细节差（按 V1 clamp），加上高频细节差（不 clamp 太狠，保留最细纹理）
    det_delta = (o_det - r_det).clamp(-_PRESET_V2["maximum_log_detail"], _PRESET_V2["maximum_log_detail"])
    fine_delta = (o_fine - r_fine).clamp(-_PRESET_V2["maximum_log_detail"] * 0.7, _PRESET_V2["maximum_log_detail"] * 0.7)

    # 基础恢复（同 V1：gate 控制），再叠加忠实度增强（高可信区额外补）
    # V2 关键改进：base_delta 也按能量比自适应——relit 细节已 ≥ original 时衰减
    # 避免新郎脸 V1=1.18（已>1）被 V2 进一步推高
    o_det_energy = _gaussian_blur(o_det.square(), sigma * 1.5)
    r_det_energy = _gaussian_blur(r_det.square(), sigma * 1.5)
    energy_ratio = r_det_energy / (o_det_energy + 1e-6)
    # base 衰减：relit 细节已 ≥ original（ratio≥1）时 base 也衰减，避免过冲
    base_decay = (1.0 - energy_ratio.clamp(0.0, 1.0)) * 0.5 + 0.5
    base_delta = (det_delta + fine_delta * 0.6) * gate * base_decay * max(0.0, min(1.0, detail_strength))
    # 高可信区：只在「原图细节真的比打光图多」时追加补偿
    # 缺口权重：relit 细节能量 < original 时才追加，缺口越大权重越大
    gap_weight = (1.0 - energy_ratio.clamp(0.0, 1.0))
    pos_det = det_delta.clamp_min(0.0)
    pos_fine = fine_delta.clamp_min(0.0)
    extra_delta = (pos_det + pos_fine * 0.6) * fidelity_gate * gap_weight * max(0.0, min(1.0, detail_strength))
    delta = base_delta + extra_delta * _PRESET_V2["extra_fidelity_coef"]

    if user_mask is not None:
        delta = delta * user_mask
        gate = gate * user_mask

    gain = torch.exp(delta).clamp(_PRESET_V2["gain_lo"], _PRESET_V2["gain_hi"])
    restored_linear = (relit_linear * gain).clamp(0.0, 1.0)
    restored = _linear_to_srgb(restored_linear).clamp(0.0, 1.0)
    if user_mask is not None:
        restored = torch.where(user_mask <= 0.0, relit_rgb, restored)
    restoration_mask = gate * _smoothstep((det_delta + fine_delta * 0.6).abs(), 0.001, 0.035)
    return restored, restoration_mask[:, 0]


class MyDetailLightPreserveV2:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "original_image": ("IMAGE", {"tooltip": "已与打光图对齐，仅用于提供原图微纹理"}),
                "relit_image": ("IMAGE", {"tooltip": "最终底片；颜色、光影、结构和输出尺寸均以此图为准"}),
                "detail_restore_strength": (
                    "FLOAT",
                    {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "display": "slider",
                     "tooltip": "0 完全保持打光图，1 自动补回可信的原图微纹理"},
                ),
                "detail_fidelity": (
                    "FLOAT",
                    {"default": 0.7, "min": 0.0, "max": 1.0, "step": 0.01, "display": "slider",
                     "tooltip": "高可信区细节忠实度：调大更接近原图（0=与V1一致），过锐/辉光则调小"},
                ),
            },
            "optional": {
                "detail_restore_mask": ("MASK", {"tooltip": "白色恢复原图细节，黑色保留打光图，灰色按比例过渡"}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("细节保光成片", "细节恢复区域")
    FUNCTION = "restore_detail"
    CATEGORY = "My-Comfnode/图像"
    DESCRIPTION = ("V2 细节增强版：放宽增益封顶、细化细节尺度、提升可信区还原力度，"
                   "细节无限接近原图；保留 V1 的轮廓光/投影/错位轮廓保护。")

    def restore_detail(self, original_image, relit_image, detail_restore_strength=1.0,
                       detail_fidelity=0.85, detail_restore_mask=None):
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
            detail_restore_mask, int(relit_compute.shape[0]), (height, width), relit.device)
        if restore_mask is not None and not bool(torch.any(restore_mask > 0.0)):
            mask = torch.zeros(relit.shape[:3], device=relit.device, dtype=torch.float32)
            return relit.clone(), mask

        restored_rgb, restoration_mask = _restore_micro_detail_v2(
            original_rgb, relit_rgb, strength, detail_fidelity, restore_mask)
        output = relit.clone()
        output[..., :3] = restored_rgb.permute(0, 2, 3, 1).to(dtype=output_dtype)
        return output, restoration_mask


NODE_CLASS_MAPPINGS = {
    "MyDetailLightPreserveV2": MyDetailLightPreserveV2,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MyDetailLightPreserveV2": "My细节光影保留V2",
}
