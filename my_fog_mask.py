# -*- coding: utf-8 -*-
"""
My迷雾遮罩（Fog Difference Mask）
=================================
物理雾模型：AI = α·雾色 + (1-α)·原图
- 从两图差异最大的像素自动估计雾色
- 逐像素最小二乘解出雾透明度 α（连续值，天然表达雾的深浅）
- 置信度加权 + 归一化卷积，把雾传播到低置信度区域
  （解决"白雾罩白裙"这种颜色差异趋零、传统差分失效的问题）

大图适配：无分辨率硬限制，显存不足自动降级 CPU。
节点：
  MyFogDifferenceMask  : 原图 + AI图 -> 雾遮罩 (MASK)
  MyFogDetailComposite : 原图 + AI图 + 雾遮罩 -> 细节回贴合成图 (IMAGE)
"""

import torch
import torch.nn.functional as F

try:  # ComfyUI 环境下用它的设备管理（GPU 优先，自动处理显存调度）
    import comfy.model_management as _mm
    _DEVICE = _mm.get_torch_device()
except Exception:
    _DEVICE = torch.device("cpu")

# 抽样统计的最大样本数（百分位估计用，内存恒定，与图片分辨率无关）
_MAX_STAT_SAMPLES = 2_000_000


def _blur(x: torch.Tensor, sigma: float) -> torch.Tensor:
    """三重盒滤波近似高斯模糊，支持 [B,H,W] / [H,W]，比 conv 快且省内存。"""
    if sigma <= 0.05:
        return x
    squeeze_back = False
    if x.dim() == 2:
        x = x[None]
        squeeze_back = True
    w = int(round(sigma * 2))
    if w % 2 == 0:
        w += 1
    w = max(w, 3)
    p = w // 2
    x = x.unsqueeze(1)  # [B,1,H,W]
    for _ in range(3):  # 3次盒滤波 ≈ 高斯
        x = F.pad(x, (p, p, 0, 0), mode="replicate")
        x = F.avg_pool2d(x, kernel_size=(1, w), stride=1)
        x = F.pad(x, (0, 0, p, p), mode="replicate")
        x = F.avg_pool2d(x, kernel_size=(w, 1), stride=1)
    x = x.squeeze(1)
    return x[0] if squeeze_back else x


def _smoothstep(t: torch.Tensor) -> torch.Tensor:
    return t * t * (3 - 2 * t)


def _open_close(x: torch.Tensor, k: int) -> torch.Tensor:
    """形态学开+闭：去掉孤立亮噪点(误判成雾的碎点)和小黑洞，k为奇数。"""
    if k < 3:
        return x
    was2d = x.dim() == 2
    if was2d:
        x = x[None]
    x = x.unsqueeze(1)
    # 开运算：先腐蚀(局部最小)再膨胀(局部最大)，清掉小白点
    x = -F.max_pool2d(-x, kernel_size=k, stride=1, padding=k // 2)
    x = F.max_pool2d(x, kernel_size=k, stride=1, padding=k // 2)
    # 闭运算：先膨胀再腐蚀，补掉雾里的小黑洞
    x = F.max_pool2d(x, kernel_size=k, stride=1, padding=k // 2)
    x = -F.max_pool2d(-x, kernel_size=k, stride=1, padding=k // 2)
    x = x.squeeze(1)
    return x[0] if was2d else x


def _quantile(x: torch.Tensor, q: float) -> torch.Tensor:
    """抽样+排序法百分位。torch.quantile 有 2^24 元素硬限制，
    这里均匀抽样（最多200万样本）后排序，精度足够且内存恒定。"""
    flat = x.flatten().float()
    n = flat.numel()
    if n == 0:
        return flat.new_zeros(())
    if n > _MAX_STAT_SAMPLES:
        step = (n + _MAX_STAT_SAMPLES - 1) // _MAX_STAT_SAMPLES
        flat = flat[::step]
    k = int(round(q * (flat.numel() - 1)))
    k = max(0, min(flat.numel() - 1, k))
    return torch.sort(flat).values[k]


def _solve_alpha(o: torch.Tensor, a: torch.Tensor, fog_color: torch.Tensor):
    """物理模型最小二乘：alpha = <A-O, F-O> / |F-O|²。
    按通道累加计算，峰值内存只有单通道级（8K图也不会爆显存）。
    返回 alpha 与置信度。"""
    denom = None
    num = None
    for c in range(3):
        dc = fog_color[c] - o[..., c]              # [H,W]
        diff_c = a[..., c] - o[..., c]
        term_num = diff_c * dc
        term_den = dc * dc
        if denom is None:
            denom, num = term_den, term_num
        else:
            denom += term_den
            num += term_num
        del dc, diff_c, term_num, term_den
    alpha_raw = num / torch.clamp(denom, min=1e-6)
    conf = torch.clamp(denom / torch.clamp(_quantile(denom, 0.95), min=1e-6), 0, 1)
    return torch.clamp(alpha_raw, -1, 2), conf


def _texture_gate(tex_src: torch.Tensor, alpha: torch.Tensor, scale: float) -> torch.Tensor:
    """平滑度门控：真雾是平滑色罩（纹理/α 比值低），
    AI重绘造成的伪雾（衣物光影变化、碎点噪声）纹理高。
    实测真雾比值<0.25，伪雾>1.4，分割带干净。
    tex_src 必须用模糊前的原始α（保留纹理信息），作用到最终α上。
    浓雾(α>0.45)直接豁免。"""
    sigma = max(2.0 * scale, 2.0)
    x = tex_src
    was2d = x.dim() == 2
    if was2d:
        x = x[None]
    hf = (x - _blur(x, sigma)).abs()
    tex = _blur(hf, sigma)[0] if was2d else _blur(hf, sigma)
    ratio = tex / torch.clamp(alpha, min=1e-3)
    gate = 1.0 - torch.clamp((ratio - 0.4) / 0.6, 0, 1)
    protect = torch.clamp((alpha - 0.45) / 0.2, 0, 1)  # 浓雾豁免
    g = torch.maximum(gate, protect)
    return alpha * g


def _post_process(alpha: torch.Tensor, tex_src: torch.Tensor, scale: float,
                  low_threshold: float, high_threshold: float,
                  gamma: float) -> torch.Tensor:
    """纹理门控(用原始α的纹理) -> 平滑交界 -> 形态学清理 -> 软阈值渐变"""
    alpha = _texture_gate(tex_src, alpha, scale)
    alpha = _blur(alpha, 2.5 * scale)  # 柔化门控造成的点状/块状交界（雾边本来就柔和）
    cleanup_k = int(round(2 * scale)) * 2 + 1
    alpha = _open_close(alpha, cleanup_k)
    t = torch.clamp((alpha - low_threshold) /
                    max(high_threshold - low_threshold, 1e-6), 0, 1)
    return _smoothstep(t) ** gamma


def _compute_one(o: torch.Tensor, a: torch.Tensor, fog_color: torch.Tensor,
                 fog_color_percentile: float, detail_sigma: float,
                 spread_sigma: float, low_threshold: float,
                 high_threshold: float, gamma: float) -> torch.Tensor:
    """单张图完整计算，返回 [H,W] 遮罩。
    所有尺度参数按参考宽度1536自动等比缩放，保证任意分辨率下行为一致。"""
    scale = max(a.shape[0], a.shape[1]) / 1536.0
    scale = max(scale, 1.0)
    detail_sigma = detail_sigma * scale
    spread_sigma = spread_sigma * scale

    # 1) 雾色：取差异最大的前N%像素的平均颜色
    if fog_color is None:
        pix_diff = (a - o).abs().sum(-1)
        thresh = _quantile(pix_diff, fog_color_percentile / 100.0)
        del pix_diff
        sel = (a - o).abs().sum(-1) > thresh
        px = a.reshape(-1, 3)[sel.reshape(-1)]
        fog_color = px.mean(dim=0) if px.shape[0] > 0 else a.reshape(-1, 3).mean(dim=0)
        del sel, px

    # 2) 物理模型解 α（OOM 时自动降级 CPU）
    try:
        alpha_raw, conf = _solve_alpha(o, a, fog_color)
        tex_src = alpha_raw.clamp(0, 1)  # 原始α保留纹理，供门控用
        # 3) 归一化卷积：可靠区域向低置信度区域传播（两尺度取强）
        w1 = _blur(conf, detail_sigma)
        wa1 = _blur(alpha_raw * conf, detail_sigma)
        alpha1 = wa1 / torch.clamp(w1, min=1e-4)
        del w1, wa1
        w2 = _blur(conf, spread_sigma)
        wa2 = _blur(alpha_raw * conf, spread_sigma)
        alpha2 = wa2 / torch.clamp(w2, min=1e-4)
        del w2, wa2, alpha_raw, conf
        alpha = torch.clamp(torch.maximum(alpha1, alpha2), 0, 1)
        del alpha1, alpha2
        alpha = _blur(alpha, 2.0 * scale)
    except (torch.cuda.OutOfMemoryError, MemoryError):
        torch.cuda.empty_cache()
        o, a, fog_color = o.cpu(), a.cpu(), fog_color.cpu()
        alpha_raw, conf = _solve_alpha(o, a, fog_color)
        tex_src = alpha_raw.clamp(0, 1)
        w1 = _blur(conf, detail_sigma)
        wa1 = _blur(alpha_raw * conf, detail_sigma)
        alpha1 = wa1 / torch.clamp(w1, min=1e-4)
        w2 = _blur(conf, spread_sigma)
        wa2 = _blur(alpha_raw * conf, spread_sigma)
        alpha2 = wa2 / torch.clamp(w2, min=1e-4)
        alpha = torch.clamp(torch.maximum(alpha1, alpha2), 0, 1)
        alpha = _blur(alpha, 2.0 * scale)

    return _post_process(alpha, tex_src, scale, low_threshold, high_threshold, gamma)


class MyFogDifferenceMask:
    """对比原图与AI加雾图，按物理雾模型剥离连续雾透明度遮罩。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "original_image": ("IMAGE",),
                "fog_image": ("IMAGE",),
                "fog_color_percentile": ("FLOAT", {
                    "default": 97.0, "min": 80.0, "max": 99.9, "step": 0.1,
                    "tooltip": "取差异最大的前N%像素平均颜色作为雾色。雾偏灰可调低，偏白调高"}),
                "detail_sigma": ("FLOAT", {
                    "default": 6.0, "min": 1.0, "max": 32.0, "step": 0.5,
                    "tooltip": "细节尺度：雾边缘的贴合精度，越小越贴边"}),
                "spread_sigma": ("FLOAT", {
                    "default": 16.0, "min": 2.0, "max": 64.0, "step": 1.0,
                    "tooltip": "扩散尺度：把雾传播进低置信度区域（白裙上的白雾等），越大传播越远"}),
                "low_threshold": ("FLOAT", {
                    "default": 0.06, "min": 0.0, "max": 1.0, "step": 0.01,
                    "tooltip": "低于此透明度视为无雾（黑）。调大可去除薄雾/杂散噪声"}),
                "high_threshold": ("FLOAT", {
                    "default": 0.55, "min": 0.0, "max": 1.0, "step": 0.01,
                    "tooltip": "高于此透明度视为全雾（白），之间为灰度渐变（雾的深浅）"}),
                "gamma": ("FLOAT", {
                    "default": 1.0, "min": 0.2, "max": 3.0, "step": 0.05,
                    "tooltip": ">1 收缩只留浓雾，<1 扩大连薄雾也算"}),
                "manual_fog_color": ("STRING", {
                    "default": "",
                    "tooltip": "手动指定雾色，格式 '0.79,0.78,0.79'（0~1 RGB）。留空则自动估计"}),
            },
        }

    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("fog_mask",)
    FUNCTION = "compute"
    CATEGORY = "My-Comfnode/遮罩"

    def compute(self, original_image, fog_image, fog_color_percentile,
                detail_sigma, spread_sigma, low_threshold, high_threshold,
                gamma, manual_fog_color=""):
        o, a = original_image, fog_image

        # 关键性能优化：ComfyUI 传入的是 CPU 张量，搬到 GPU 计算（快百倍），算完返回 CPU
        if o.device != _DEVICE:
            o = o.to(_DEVICE)
        if a.device != _DEVICE:
            a = a.to(_DEVICE)

        # 尺寸对齐（以 AI 图为基准）
        if o.shape[1:] != a.shape[1:]:
            t = o.permute(0, 3, 1, 2)
            t = F.interpolate(t, size=a.shape[1:3], mode="bilinear", align_corners=False)
            o = t.permute(0, 2, 3, 1)

        # 手动雾色优先
        manual_fc = None
        if manual_fog_color.strip():
            vals = [float(v) for v in manual_fog_color.split(",")][:3]
            manual_fc = torch.clamp(
                torch.tensor(vals, dtype=o.dtype, device=o.device), 0, 1)

        masks = []
        for i in range(a.shape[0]):
            m = _compute_one(o[i], a[i], manual_fc.clone() if manual_fc is not None else None,
                             fog_color_percentile, detail_sigma, spread_sigma,
                             low_threshold, high_threshold, gamma)
            masks.append(m)
        return (torch.stack(masks, 0).cpu(),)


class MyFogDetailComposite:
    """便捷合成：mask 白=保留 AI 图（雾），黑=贴回原图（细节），
    灰度过渡区按比例混合，保留雾的深浅层次。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "original_image": ("IMAGE",),
                "fog_image": ("IMAGE",),
                "fog_mask": ("MASK",),
                "detail_strength": ("FLOAT", {
                    "default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01,
                    "tooltip": "原图细节回贴强度，1.0 完全回贴"}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "composite"
    CATEGORY = "My-Comfnode/图像"

    def composite(self, original_image, fog_image, fog_mask, detail_strength):
        o = original_image
        # GPU 计算（与遮罩节点同策略）
        if o.device != _DEVICE:
            o = o.to(_DEVICE)
        fog_image = fog_image.to(_DEVICE)
        fog_mask = fog_mask.to(_DEVICE)
        if o.shape[1:] != fog_image.shape[1:]:
            t = o.permute(0, 3, 1, 2)
            t = F.interpolate(t, size=fog_image.shape[1:3], mode="bilinear", align_corners=False)
            o = t.permute(0, 2, 3, 1)
        m = fog_mask.unsqueeze(-1)
        if m.shape[1:3] != fog_image.shape[1:3]:
            t = m.permute(0, 3, 1, 2)
            t = F.interpolate(t, size=fog_image.shape[1:3], mode="bilinear", align_corners=False)
            m = t.permute(0, 2, 3, 1)
        detail = fog_image + (o - fog_image) * detail_strength
        out = detail * (1 - m) + fog_image * m
        return (out.clamp(0, 1),)


NODE_CLASS_MAPPINGS = {
    "MyFogDifferenceMask": MyFogDifferenceMask,
    "MyFogDetailComposite": MyFogDetailComposite,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MyFogDifferenceMask": "My迷雾遮罩",
    "MyFogDetailComposite": "My迷雾遮罩合成",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
