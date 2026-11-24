"""色度抠图（Chroma Key）

经典绿幕/蓝幕抠像：纯颜色距离运算把纯色背景抠成透明，
无模型、无 GPU 依赖，速度极快。与 green_spill_remove（去溢色）
配套使用效果最佳，本节点也内置了边缘去溢色。

算法要点：
- 在 YCbCr 色度空间计算像素与背景色的色度距离（与亮度无关，
  背景光照不均时比 RGB 距离稳健得多）
- tolerance / softness 双阈值生成软遮膜，毛发软边自然获得部分透明度
- 支持自动取四边中值探测背景色，或手动指定 HEX 颜色
- 内置遮罩收缩/羽化和边缘去溢色（despill）
"""

from __future__ import annotations

import numpy as np
import torch
import torch.nn.functional as F


# ---------- 工具函数 ----------

def _hex_to_rgb01(hex_color: str) -> torch.Tensor:
    s = hex_color.strip().lstrip("#")
    if len(s) == 3:
        s = "".join(ch * 2 for ch in s)
    if len(s) != 6:
        raise ValueError(f"无效的 HEX 颜色: {hex_color}")
    return torch.tensor(
        [int(s[i : i + 2], 16) / 255.0 for i in (0, 2, 4)], dtype=torch.float32
    )


def _rgb_to_ycbcr(x: torch.Tensor):
    """x: [..., 3]，返回 y/cb/cr（cb、cr 平移到 0~1）"""
    r, g, b = x[..., 0], x[..., 1], x[..., 2]
    y = 0.299 * r + 0.587 * g + 0.114 * b
    cb = (b - y) * 0.564 + 0.5
    cr = (r - y) * 0.713 + 0.5
    return y, cb, cr


def _smoothstep(x: torch.Tensor, edge0: float, edge1: float) -> torch.Tensor:
    if edge1 <= edge0:
        edge1 = edge0 + 1e-6
    t = torch.clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def _dilate(mask: torch.Tensor, radius: int) -> torch.Tensor:
    if radius <= 0:
        return mask
    k = 2 * radius + 1
    return F.max_pool2d(mask, kernel_size=k, stride=1, padding=radius)


def _erode(mask: torch.Tensor, radius: int) -> torch.Tensor:
    if radius <= 0:
        return mask
    return 1.0 - _dilate(1.0 - mask, radius)


def _blur(mask: torch.Tensor, radius: int) -> torch.Tensor:
    if radius <= 0:
        return mask
    k = 2 * radius + 1
    kernel = torch.ones(1, 1, k, k, device=mask.device, dtype=mask.dtype) / (k * k)
    padded = F.pad(mask, (radius, radius, radius, radius), mode="replicate")
    return F.conv2d(padded, kernel)


def _auto_key_color(rgb: torch.Tensor) -> torch.Tensor:
    """取图像四边一圈像素的中值作为背景色，rgb: [B, H, W, 3]"""
    h, w = rgb.shape[1], rgb.shape[2]
    f = max(2, int(min(h, w) * 0.04))
    ring = torch.cat(
        [
            rgb[:, :f].reshape(-1, 3),
            rgb[:, -f:].reshape(-1, 3),
            rgb[:, :, :f].reshape(-1, 3),
            rgb[:, :, -f:].reshape(-1, 3),
        ],
        dim=0,
    )
    return ring.median(dim=0).values


def _box_fast(x: torch.Tensor, r: int) -> torch.Tensor:
    """快速方框模糊（水平+垂直两次 avg_pool），x: [B,C,H,W]"""
    k = 2 * r + 1
    return F.avg_pool2d(F.pad(x, (r, r, r, r), mode="replicate"), k, stride=1)


def _despill(rgb: torch.Tensor, band: torch.Tensor):
    """band: [B,H,W]，去溢色强度权重。把主导背景色的通道压回其余两通道均值"""
    key = _auto_key_color(rgb)
    dom = int(torch.argmax(key).item())
    others = [i for i in range(3) if i != dom]
    limit = (rgb[..., others[0]] + rgb[..., others[1]]) * 0.5
    fixed = torch.minimum(rgb[..., dom], limit)
    rgb[..., dom] = rgb[..., dom] + (fixed - rgb[..., dom]) * band
    return rgb


# ---------- 节点 ----------

class MyChromaKey:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "绿幕/蓝幕/任意纯色背景的原图"}),
                "key_mode": (
                    ["自动检测边缘背景色", "自定义颜色"],
                    {"default": "自动检测边缘背景色"},
                ),
                "key_color": (
                    "STRING",
                    {"default": "#00B140", "tooltip": "自定义模式下的背景色（HEX），绿幕常用 #00B140"},
                ),
                "tolerance": (
                    "FLOAT",
                    {
                        "default": 0.28,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "tooltip": "色相容差：允许被判定为背景的色相偏离范围，抠得太狠（主体被误伤）就调小",
                    },
                ),
                "softness": (
                    "FLOAT",
                    {
                        "default": 0.25,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "tooltip": "过渡带宽度：越大边缘越柔和，毛发软边更自然",
                    },
                ),
                "mask_shrink": (
                    "INT",
                    {
                        "default": 0,
                        "min": -64,
                        "max": 64,
                        "step": 1,
                        "tooltip": "遮罩收缩（正值裁掉边缘残色，会让毛边变硬）/ 扩张（负值保留更多细节）",
                    },
                ),
                "mask_blur": (
                    "INT",
                    {"default": 6, "min": 0, "max": 64, "step": 1, "tooltip": "遮罩羽化半径：毛发类主体建议 4-8"},
                ),
                "shadow": (
                    "FLOAT",
                    {
                        "default": 0.35,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "tooltip": "阴影保护：亮度低于保护范围的暗部（黑毛/深色物体）豁免键控，防止黑毛被抠透明；黑毛仍被误伤就调大",
                    },
                ),
                "edge_solid": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.05,
                        "tooltip": "边缘实化：把毛边过渡带的部分透明 alpha 往 1 推，消除深底上的灰色过渡带；0=保持物理真实的软边，嫌深底上边发灰就调 0.5-0.8",
                    },
                ),
                "despill": (
                    "BOOLEAN",
                    {"default": True, "tooltip": "边缘反混合修色：利用已知背景色解出边缘像素的真实前景色，消除灰边/绿边轮廓带"},
                ),
                "despill_strength": (
                    "FLOAT",
                    {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05,
                     "tooltip": "去溢色强度：0=不修色（边缘保留原始绿染），1=完全重算前景色"},
                ),
                "rgb_key": (
                    "FLOAT",
                    {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.02,
                     "tooltip": "暗部侵蚀（RGB 距离键控）：高档强度行为，暗色像素先被吃掉、亮部保留；配合阴影参数保护想留的暗部"},
                ),
                "hole_fill": (
                    "INT",
                    {"default": 50, "min": 0, "max": 100, "step": 5,
                     "tooltip": "填洞：自动填充主体内部被误键穿的封闭区域（面积上限随滑条增大）；0=关闭"},
                ),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "key_out"
    CATEGORY = "My-Comfnode/图像"
    DESCRIPTION = (
        "色度抠图：纯颜色运算把纯色背景抠成透明（RGBA），并输出前景遮罩。"
        "无模型依赖，速度极快，最适合绿幕/蓝幕等均匀纯色背景。"
    )

    def key_out(self, image, key_mode="自动检测边缘背景色", key_color="#00B140",
                tolerance=0.28, softness=0.25, mask_shrink=0, mask_blur=6,
                shadow=0.35, edge_solid=0.0, despill=True, despill_strength=1.0,
                rgb_key=0.0, hole_fill=50):
        img = image.clone()
        B, H, W, _ = img.shape
        rgb = img[..., :3]

        # 背景参考色（逐张自动检测，或统一指定）
        if key_mode == "自定义颜色":
            keys = _hex_to_rgb01(key_color).to(rgb.device).expand(B, 3)
        else:
            keys = torch.stack([_auto_key_color(rgb[i : i + 1]) for i in range(B)])

        # 色度投影键控（亮度无关）：
        # 把像素色度向量 (cb-0.5, cr-0.5) 投影到背景色向量上，
        # 投影系数 ≈ 像素中背景色的占比（线性，软边混合比例正确），
        # 垂直分量 ≈ 色相偏离，偏离大的像素（异色主体）保持前景
        y_luma, cb, cr = _rgb_to_ycbcr(rgb)
        _, kcb, kcr = _rgb_to_ycbcr(keys)      # 背景色也走完整转换，保证向量方向正确
        # 色度平面降噪：抑制 JPEG 块状噪声造成的遮罩椒盐点
        cb_s = _blur(cb.unsqueeze(1), 2).squeeze(1)
        cr_s = _blur(cr.unsqueeze(1), 2).squeeze(1)
        kvec_cb = kcb - 0.5
        kvec_cr = kcr - 0.5
        p_cb = cb_s - 0.5
        p_cr = cr_s - 0.5
        kk = kvec_cb**2 + kvec_cr**2
        kk = torch.clamp(kk, min=1e-6)[:, None, None]
        proj = (p_cb * kvec_cb[:, None, None] + p_cr * kvec_cr[:, None, None]) / kk
        # 垂直分量（色相偏离）: perp² = |p|² - proj²·|k|²，注意 proj 必须平方
        perp = torch.sqrt(
            torch.clamp(p_cb**2 + p_cr**2 - torch.clamp(proj, 0.0, None) ** 2 * kk, min=0.0)
        ) / torch.sqrt(kk)

        # 背景占比：投影系数决定比例，色相偏离超过容差则整体压回前景。
        # 门起点须高于 JPEG 色度噪声底（实测噪声 perp 可达 0.2+，
        # 而真正异色主体的 perp 通常 > 1），否则背景被误压回前景
        hue_gate0 = 0.30
        hue_gate1 = hue_gate0 + tolerance * 0.6 + softness * 0.2

        # 色相对齐因子：投影对 ±90° 内的所有颜色都有正响应（色相盲），
        # 暖色阴影毛会被误投影。要求像素色度方向与背景色方向足够一致
        p_len = torch.sqrt(torch.clamp(p_cb**2 + p_cr**2, min=1e-10))
        k_len = torch.sqrt(kk)
        align = (p_cb * kvec_cb[:, None, None] + p_cr * kvec_cr[:, None, None]) / (
            p_len * k_len + 1e-6
        )
        align_f = _smoothstep(align, 0.70, 0.85)

        bg = torch.clamp(proj, 0.0, 1.0) * align_f

        # 亮度不变指标：主/次通道占比差对"背景等比例变暗"不敏感，
        # 补足投影法对光照不均的盲区；两者取 max（软边仍以线性投影为主）
        d = torch.argmax(keys, dim=-1)                              # [B]
        dom_ch = F.one_hot(d, 3).bool()[:, None, None, :]           # B,1,1,3
        px = rgb[..., :3]
        c_dom = px.gather(-1, d.view(B, 1, 1, 1).expand(B, H, W, 1)).squeeze(-1)
        c_other = px.masked_fill(dom_ch, float("-inf")).max(dim=-1).values
        ratio = (c_dom - c_other) / (c_dom + c_other + 1e-6)
        k_dom = keys.gather(1, d[:, None]).squeeze(1)
        k_other = keys.masked_fill(F.one_hot(d, 3).bool(), float("-inf")).max(dim=1).values
        ratio_k = (k_dom - k_other) / (k_dom + k_other + 1e-6)
        bg_ratio = torch.clamp(ratio / (ratio_k[:, None, None] + 1e-6), 0.0, 1.0)

        bg = torch.maximum(bg, bg_ratio)
        bg = bg * (1.0 - _smoothstep(perp, hue_gate0, hue_gate1))

        # 中性残点抑制：色度接近中性（p≈0）的像素 proj/perp 双双失效，
        # 用经典色度距离兜底；乘饱和度下限（避免误伤低饱和软边），
        # 并乘严格的色相门（0.12-0.30，只放行真正的背景色系，
        # 否则暖色/异色阴影毛会因色度距离近被整块抠穿）
        mag = p_len / k_len
        kcb_abs = kcb[:, None, None]
        kcr_abs = kcr[:, None, None]
        dist = torch.sqrt((cb_s - kcb_abs) ** 2 + (cr_s - kcr_abs) ** 2)
        t1 = tolerance * 0.45
        t2 = t1 + max(softness * 0.3, 1e-4)
        gate_d = 1.0 - _smoothstep(perp, 0.12, 0.30)
        bg_dist = (
            (1.0 - _smoothstep(dist, t1, t2))
            * _smoothstep(mag, 0.4, 0.6)
            * gate_d
        )

        # 距离判据只允许"补足"线性判据的不足（中性残点/暗背景），
        # 不得覆盖线性结果——否则绿毛混合比高的过渡像素（如 70%绿+30%毛）
        # 会被整块判成背景，毛边被啃出锯齿（割裂感）
        bg = torch.maximum(bg, bg_dist * (1.0 - _smoothstep(bg, 0.2, 0.5)))

        # RGB 距离侵蚀（对应剪映高"强度"行为）：用含亮度的 RGB 距离做
        # 附加键控——暗色像素离中等亮度的 key 更"近"会先被吃掉，
        # 亮部（白毛高光）保留。rgb_key=0 时关闭；由"阴影"参数兜底保护
        if rgb_key > 0:
            dist_rgb = torch.sqrt(((rgb - keys[:, None, None, :]) ** 2).sum(-1))
            r2 = rgb_key * 1.15 + 0.05
            r1 = r2 * 0.7
            bg = torch.maximum(bg, 1.0 - _smoothstep(dist_rgb, r1, r2))

        # 阴影保护（对应剪映"阴影"参数）：亮度低于保护范围的暗部
        # （黑毛/深色物体，绿幕反光下呈暗绿色系）豁免键控，防止被抠透明
        y_s = _blur(y_luma.unsqueeze(1), 2).squeeze(1)
        y_lo = 0.04
        y_hi = y_lo + shadow * 0.6
        key_allowed = _smoothstep(y_s, y_lo, y_hi)   # 暗→0(禁止键控) 亮→1(正常键控)
        bg = bg * key_allowed

        matte = 1.0 - bg
        raw_matte = matte.clone()                # 原始软 α（修色公式专用）

        # 填洞：主体内部被误键穿的封闭背景区（暗绿阴影区颜色酷似背景，
        # 颜色判据无解）直接填充为前景。只填"不与图像边界连通"且面积
        # 小于阈值的洞；先腐蚀背景断开细通道，避免腔体经缝隙漏到边界
        filled = torch.zeros_like(matte)
        if hole_fill > 0:
            try:
                import cv2

                matte_np = matte.detach().cpu().numpy()
                limit = hole_fill / 100.0 * 0.03 * H * W
                kernel = np.ones((5, 5), np.uint8)
                for b_i in range(B):
                    bg_bin = (matte_np[b_i] < 0.5).astype(np.uint8)
                    bg_er = cv2.erode(bg_bin, kernel)
                    num, labels, stats, _ = cv2.connectedComponentsWithStats(bg_er, connectivity=4)
                    border = set(np.unique(np.concatenate([
                        labels[0], labels[-1], labels[:, 0], labels[:, -1]
                    ]))) - {0}
                    fill = np.zeros_like(bg_bin)
                    for lbl in range(1, num):
                        if lbl in border:
                            continue
                        if stats[lbl, cv2.CC_STAT_AREA] <= limit:
                            fill[labels == lbl] = 1
                    if fill.any():
                        fill = cv2.dilate(fill, kernel, iterations=2)
                        fill_t = torch.from_numpy(fill.astype(np.float32))[None, None]
                        fill_t = _blur(fill_t.to(device=matte.device, dtype=matte.dtype), 2)[0, 0]
                        matte[b_i] = torch.maximum(matte[b_i], fill_t)
                        filled[b_i] = torch.maximum(filled[b_i], fill_t)
            except Exception:
                pass

        # 闭运算填充：与外部背景经窄通道连通的暗色侵入区（暗毛+暗绿阴影
        # 颜色难分被键穿），封闭填洞无能为力——用形态学闭运算桥接填充，
        # 大块合法背景（腿间隙等）宽度大于核则不受影响
        if hole_fill > 0:
            try:
                import cv2

                close_r = int(hole_fill / 100.0 * 70)
                if close_r >= 2:
                    kernel_fg = cv2.getStructuringElement(
                        cv2.MORPH_ELLIPSE, (2 * close_r + 1, 2 * close_r + 1))
                    matte_np = matte.detach().cpu().numpy()
                    for b_i in range(B):
                        bin_fg = (matte_np[b_i] > 0.5).astype(np.uint8)
                        closed = cv2.morphologyEx(bin_fg, cv2.MORPH_CLOSE, kernel_fg)
                        if not np.array_equal(closed, bin_fg):
                            m_t = torch.from_numpy(closed.astype(np.float32))[None, None]
                            m_t = _blur(m_t.to(device=matte.device, dtype=matte.dtype), 2)[0, 0]
                            added = torch.clamp(m_t - matte[b_i], min=0.0)
                            matte[b_i] = torch.maximum(matte[b_i], m_t)
                            filled[b_i] = torch.maximum(filled[b_i], added)
            except Exception:
                pass

        # 遮罩清理：先羽化，后收缩（choke）——收缩切掉羽化外扩的残影
        m = matte.unsqueeze(1)                   # B,1,H,W
        m = _blur(m, mask_blur)
        if mask_shrink > 0:
            m = _erode(m, mask_shrink)
            m = _blur(m, 1)                      # 侵蚀后轻模糊，消除块状锯齿
        elif mask_shrink < 0:
            m = _dilate(m, -mask_shrink)
        matte = m.squeeze(1).clamp(0.0, 1.0)

        # 边缘实化：把过渡带 alpha 往 1 推（白点下压），缩小深底上的灰色
        # 过渡带宽度；外圈最软的毛尖仍在低段保持柔和
        if edge_solid > 0:
            lo = 0.05 * edge_solid
            hi = 1.0 - 0.6 * edge_solid
            matte = ((matte - lo) / (hi - lo)).clamp(0.0, 1.0)

        # 填充区颜色修复：被填洞/闭运算新纳入的像素保留原色会呈暗绿/
        # 洋红杂斑——用大半径归一化模糊从周围前景取平均色填充
        filled_soft = None
        if hole_fill > 0 and filled.any():
            filled_soft = _box_fast(filled.unsqueeze(-1), 3).clamp(0.0, 1.0)
            col_sum = _box_fast(rgb * raw_matte.unsqueeze(-1), 21)
            wsum = _box_fast(raw_matte.unsqueeze(-1), 21).clamp(min=1e-4)
            fill_color = col_sum / wsum
            rgb = rgb * (1.0 - filled_soft) + fill_color * filled_soft

        # ★ 边缘反混合修色（在形状处理之后执行，但 α 用"原始软遮膜"）：
        #   边缘像素 = α·前景 + (1-α)·背景，用原始软 α 解真实前景色，
        #   从根源上移除灰边/绿边。仅作用于原始 α 足够大的真实边缘带；
        #   被填洞/闭运算新纳入的像素已在上方用邻近前景色填充
        if despill and despill_strength > 0:
            a = raw_matte.unsqueeze(-1)              # B,H,W,1（原始软 α）
            a_safe = torch.clamp(a, min=0.25)
            f_raw = (rgb - (1.0 - a) * keys[:, None, None, :]) / a_safe
            # 解混合无解判定：任一通道原始解为明显负值，说明该像素颜色
            # 无法用"前景+背景"混合解释（如暗部），回退用原色防止色偏
            valid = (f_raw.min(dim=-1, keepdim=True)[0] >= -0.05).to(rgb.dtype)
            f_est = torch.clamp(f_raw, 0.0, 1.0)
            # 每通道钳制修正幅度，防止不对称钳位产生洋红色偏
            f_est = torch.minimum(f_est, rgb + 0.2)
            # 色相合理性：G 不得远低于 R/B 中较高者（否则修色结果变品红）
            fmax = torch.maximum(f_est[..., 0:1], f_est[..., 2:3])
            hue_ok = (f_est[..., 1:2] >= 0.7 * fmax - 0.02).to(rgb.dtype)
            # 无解/色相不合理像素的回退：绿限模式（G 压到 max(R,B)），
            # 只去绿、永不产生品红
            g_limit = torch.maximum(rgb[..., 0:1], rgb[..., 2:3])
            f_fallback = torch.cat([rgb[..., 0:1],
                                    torch.minimum(rgb[..., 1:2], g_limit),
                                    rgb[..., 2:3]], dim=-1)
            f_est = f_est * hue_ok + f_fallback * (1.0 - hue_ok)
            band = _smoothstep(raw_matte, 0.15, 0.30).unsqueeze(-1)
            ws = despill_strength * band
            rgb = rgb * (1.0 - ws) + f_est * ws

        out = rgb.clamp(0.0, 1.0)
        rgba = torch.cat([out, matte.unsqueeze(-1)], dim=-1)  # B,H,W,4
        return (rgba, matte)


NODE_CLASS_MAPPINGS = {"MyChromaKey": MyChromaKey}
NODE_DISPLAY_NAME_MAPPINGS = {"MyChromaKey": "My色度抠图"}
