"""My光影细节融合 —— 把 AI 打光图的光影叠到原图上，原图细节一根毛都不动。

## 为什么不是高低频

传统高低频是「加法」：out = AI低频 + 原图高频。加法把两张图混在一起，会产生
两个解不开的矛盾：

1. 原图自己的中低频明暗（它本来就有光影）被当成"高频"塞进结果，跟 AI 的光
   对冲 —— 于是 AI 的方向光被稀释、变平；
2. 为了让光影不被污染，只能把分频半径调小 —— 于是细节又拿不回来。

所以在加法/减法框架里，这两个诉求天然对立，调参只是在对立的两端来回挪。

## 本节点的做法

光影在物理上属于「照明」，细节属于「反射率」，二者是相乘关系：

    I = 反射率 × 照明

所以节点只从打光图里取「平滑的照明场」，然后乘到原图上：

    out = 原图 × ( 打光图平滑 / 原图平滑 ) ^ 光影强度

* 乘性场是平滑的，不存在振铃，因此**不可能产生光晕**（高低频最典型的病）；
* 原图的像素结构完全没被改写，因此**细节是原封不动的，不是"还原"回来**；
* 照明场取多平滑由「光影尺度」控制：越小越贴近 AI 的局部光影，越大只取大方向光。

代价（说清楚，不糊弄）：
* 比「光影尺度」更细的照明变化（例如树叶缝隙的碎光、非常硬的阴影边缘）不会
  被搬过来 —— 这是刻意的取舍，不是缺陷；
* 如果 AI 图把某个区域重画了（脸、手），本节点不会把重画的结构带过来，
  结果仍然是你的原图，只是换了光。要保留 AI 的重绘，应当用图生图/局部重绘节点，
  而不是细节融合节点。
"""

from __future__ import annotations

import numpy as np
import torch

try:
    import cv2
except ImportError:  # pragma: no cover - ComfyUI 运行环境自带 OpenCV
    cv2 = None


ALGORITHM_VERSION = "1.0"
_LUMA = np.array((0.2126, 0.7152, 0.0722), np.float32)
_LOG_EPS = 1e-5


# --------------------------------------------------------------------------- #
# 基础工具
# --------------------------------------------------------------------------- #
def _srgb_to_linear(value: np.ndarray) -> np.ndarray:
    return np.where(
        value <= 0.04045,
        value / 12.92,
        ((value + 0.055) / 1.055) ** 2.4,
    ).astype(np.float32)


def _linear_to_srgb(value: np.ndarray) -> np.ndarray:
    value = np.clip(value, 0.0, None)
    return np.where(
        value <= 0.0031308,
        value * 12.92,
        1.055 * value ** (1.0 / 2.4) - 0.055,
    ).astype(np.float32)


def _soft_highlights(linear: np.ndarray, knee: float, amount: float) -> np.ndarray:
    """高光软压缩：AI 的曝光明亮时，直接乘会顶到 1.0 把织物纹理压平。"""
    if amount <= 0.0:
        return np.clip(linear, 0.0, 1.0)
    knee = float(np.clip(knee, 0.2, 0.98))
    scale = 1.0 - knee
    compressed = np.where(
        linear <= knee,
        linear,
        knee + scale * (1.0 - np.exp(-(linear - knee) / scale)),
    ).astype(np.float32)
    return np.clip(linear + float(amount) * (compressed - linear), 0.0, 1.0).astype(np.float32)


# --------------------------------------------------------------------------- #
# 核心：照明场传递
# --------------------------------------------------------------------------- #
def _blur(array: np.ndarray, sigma: float) -> np.ndarray:
    """大半径高斯：先降采样再模糊，照明场本身就是平滑的，肉眼无差但快很多。"""
    if sigma < 8.0:
        return cv2.GaussianBlur(array, (0, 0), sigma, borderType=cv2.BORDER_REFLECT)
    step = max(1, int(round(sigma / 4.0)))
    height, width = array.shape[:2]
    small = cv2.resize(array, (max(2, width // step), max(2, height // step)),
                       interpolation=cv2.INTER_AREA)
    small = cv2.GaussianBlur(small, (0, 0), sigma / step, borderType=cv2.BORDER_REFLECT)
    return cv2.resize(small, (width, height), interpolation=cv2.INTER_LINEAR)


def _illumination_ratio(
    original_linear: np.ndarray,
    relit_linear: np.ndarray,
    sigma: float,
    light: float,
    chroma: float,
    mask: np.ndarray | None,
) -> np.ndarray:
    """返回逐像素的乘性照明场 ratio，形状 HxWx3。"""
    log_o = np.log(np.maximum(original_linear, _LOG_EPS))
    log_a = np.log(np.maximum(relit_linear, _LOG_EPS))

    blur_o = _blur(log_o, sigma)
    blur_a = _blur(log_a, sigma)

    # 亮度部分的照明差（决定光的强弱和方向）
    luma_o = (original_linear @ _LUMA).astype(np.float32)
    luma_a = (relit_linear @ _LUMA).astype(np.float32)
    l_ratio = (
        _blur(np.log(np.maximum(luma_a, _LOG_EPS)), sigma)
        - _blur(np.log(np.maximum(luma_o, _LOG_EPS)), sigma)
    )

    # 色度部分只搬色偏，不重复搬一次亮度
    color_ratio = (blur_a - blur_o) - l_ratio[..., None]

    exponent = light * l_ratio[..., None] + chroma * color_ratio
    if mask is not None:
        exponent = exponent * mask[..., None]
    return np.exp(exponent).astype(np.float32)


def _detail_gain(original_linear: np.ndarray, amount: float) -> np.ndarray | None:
    """细节强度：1 = 原图原样；>1 在原图纹理上再抬一点微对比；<1 柔化。"""
    if abs(amount - 1.0) < 1e-3:
        return None
    luma = (original_linear @ _LUMA).astype(np.float32)
    log_luma = np.log(np.maximum(luma, _LOG_EPS))
    fine = log_luma - cv2.GaussianBlur(log_luma, (0, 0), 1.2, borderType=cv2.BORDER_REFLECT)
    fine = 0.6 * np.tanh(fine / 0.6)

    darkness = np.clip((log_luma - np.log(0.004)) / (np.log(0.05) - np.log(0.004)), 0.0, 1.0)
    darkness = 0.3 + 0.7 * (darkness * darkness * (3.0 - 2.0 * darkness))
    return np.exp((amount - 1.0) * fine * darkness).astype(np.float32)


def _fuse(
    original_linear: np.ndarray,
    relit_linear: np.ndarray,
    light: float,
    sigma: float,
    detail: float,
    chroma: float,
    highlight: float,
    mask: np.ndarray | None,
) -> np.ndarray:
    ratio = _illumination_ratio(original_linear, relit_linear, sigma, light, chroma, mask)
    out = original_linear * ratio

    gain = _detail_gain(original_linear, detail)
    if gain is not None:
        out = out * gain[..., None]

    out = _soft_highlights(out, 0.85, highlight)
    return np.clip(out, 0.0, 1.0).astype(np.float32)


# --------------------------------------------------------------------------- #
# ComfyUI 节点
# --------------------------------------------------------------------------- #
class MyLightDetailFusion:
    """AI 打光图的光影 × 原图的像素结构，无光晕、细节零损失。"""

    CATEGORY = "My-Comfnode/图像"
    FUNCTION = "fuse"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("高保真成片",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "原图": ("IMAGE", {
                    "tooltip": "成品尺寸、真实结构和全部分辨率细节都来自这张图",
                }),
                "打光图": ("IMAGE", {
                    "tooltip": "只取它的照明方向、阴影和色温，绝不复制它的像素结构",
                }),
                "光影强度": ("FLOAT", {
                    "default": 1.0, "min": 0.0, "max": 2.0, "step": 0.01, "display": "slider",
                    "tooltip": "1.0 = 完全采用打光图的光；0 = 只看原图；大于 1 会加强方向光",
                }),
                # 单位是像素：4K 建议 20~30，1K 建议 8~12；越小越贴近 AI 的局部光影
                "光影尺度": ("FLOAT", {
                    "default": 24.0, "min": 4.0, "max": 200.0, "step": 1.0, "display": "slider",
                    "tooltip": "单位像素。越小越贴合 AI 的局部光影，越大只保留大的方向光；比这个尺度更细的光不会搬过来",
                }),
                "细节强度": ("FLOAT", {
                    "default": 1.0, "min": 0.0, "max": 2.0, "step": 0.01, "display": "slider",
                    "tooltip": "1.0 = 原图纹理原样；大于 1 抬微对比；小于 1 柔化。任何值都不会产生光晕",
                }),
                "色彩强度": ("FLOAT", {
                    "default": 1.0, "min": 0.0, "max": 1.5, "step": 0.01, "display": "slider",
                    "tooltip": "打光图的色温/色调。0 = 保留原图颜色，只借光影",
                }),
                "高光保护": ("FLOAT", {
                    "default": 0.35, "min": 0.0, "max": 1.0, "step": 0.01, "display": "slider",
                    "tooltip": "打光图把画面顶到纯白时，软压缩保住织物和皮肤的高光层次",
                }),
                "自动对齐": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "两图有平移或轻微旋转时自动校正；亚像素位移不重采样，避免把光场弄软",
                }),
            },
            "optional": {
                "光影范围遮罩": ("MASK", {
                    "tooltip": "只在这块区域应用打光图的光，其余保持原图",
                }),
            },
        }

    # ---------------- 输入整理 ----------------
    @staticmethod
    def _check_image(value, name: str) -> torch.Tensor:
        if not isinstance(value, torch.Tensor):
            raise TypeError(f"{name} 必须是 ComfyUI IMAGE 张量")
        if value.ndim == 3:
            value = value.unsqueeze(0)
        if value.ndim != 4 or value.shape[-1] < 3:
            raise ValueError(f"{name} 必须是 BHWC 图像，当前形状 {tuple(value.shape)}")
        return value

    @staticmethod
    def _match_batch(original: torch.Tensor, relit: torch.Tensor):
        no, na = int(original.shape[0]), int(relit.shape[0])
        if no == na:
            return original, relit
        if no == 1:
            return original.expand(na, -1, -1, -1), relit
        if na == 1:
            return original, relit.expand(no, -1, -1, -1)
        raise ValueError(f"原图与打光图批次必须一致，或其中一侧只有一张；当前 {no} 与 {na}")

    @staticmethod
    def _prepare_mask(mask, batch: int, height: int, width: int, device):
        if mask is None:
            return None
        if not isinstance(mask, torch.Tensor):
            raise TypeError("光影范围遮罩必须是 ComfyUI MASK 张量")
        if mask.ndim == 2:
            mask = mask.unsqueeze(0)
        if mask.ndim == 4 and mask.shape[-1] == 1:
            mask = mask[..., 0]
        if mask.ndim != 3:
            raise ValueError(f"遮罩必须是 BHW，当前形状 {tuple(mask.shape)}")
        if mask.shape[0] == 1 and batch > 1:
            mask = mask.expand(batch, -1, -1)
        elif mask.shape[0] != batch:
            raise ValueError("遮罩批次必须与图像一致，或只有一张")
        if tuple(mask.shape[-2:]) != (height, width):
            mask = torch.nn.functional.interpolate(
                mask.unsqueeze(1), size=(height, width), mode="bilinear", align_corners=False
            )[:, 0]
        return mask.to(device=device, dtype=torch.float32).clamp(0.0, 1.0).cpu().numpy()

    # ---------------- 尺寸与对齐 ----------------
    @staticmethod
    def _fit(array: np.ndarray, height: int, width: int) -> np.ndarray:
        if array.shape[0] == height and array.shape[1] == width:
            return array
        interp = cv2.INTER_AREA if array.shape[0] > height else cv2.INTER_LANCZOS4
        return cv2.resize(array, (width, height), interpolation=interp).astype(np.float32)

    @staticmethod
    def _align(original: np.ndarray, relit: np.ndarray) -> np.ndarray:
        """ECC 欧氏对齐（平移 + 微旋转）。亚像素位移不重采样，避免把光场弄软。"""
        height, width = original.shape[:2]
        scale = min(1.0, 1024.0 / max(height, width))
        try:
            gray_o = cv2.cvtColor(original, cv2.COLOR_RGB2GRAY)
            gray_a = cv2.cvtColor(relit, cv2.COLOR_RGB2GRAY)
            small_o = cv2.resize(gray_o, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
            small_a = cv2.resize(gray_a, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
            template = np.ascontiguousarray((small_o * 255.0).astype(np.uint8))
            moving = np.ascontiguousarray((small_a * 255.0).astype(np.uint8))
            warp = np.eye(2, 3, dtype=np.float32)
            criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 80, 1e-6)
            _, warp = cv2.findTransformECC(
                template, moving, warp, cv2.MOTION_EUCLIDEAN, criteria, None, 5
            )
        except Exception:
            return relit

        if not np.isfinite(warp).all():
            return relit
        tx, ty = float(warp[0, 2]) / scale, float(warp[1, 2]) / scale
        rotation = abs(float(warp[0, 1]))
        if abs(tx) < 1.5 and abs(ty) < 1.5 and rotation < 1.5e-3 and abs(float(warp[0, 0]) - 1.0) < 1e-3:
            return relit

        matrix = warp.copy()
        matrix[0, 2], matrix[1, 2] = tx, ty
        return cv2.warpAffine(
            relit, matrix, (width, height),
            flags=cv2.INTER_LANCZOS4 | cv2.WARP_INVERSE_MAP,
            borderMode=cv2.BORDER_REFLECT101,
        ).astype(np.float32)

    # ---------------- 主流程 ----------------
    def fuse(
        self,
        原图,
        打光图,
        光影强度,
        光影尺度,
        细节强度,
        色彩强度,
        高光保护,
        自动对齐,
        光影范围遮罩=None,
    ):
        if cv2 is None:
            raise RuntimeError("未找到 OpenCV，无法运行 My光影细节融合")

        original = self._check_image(原图, "原图")
        relit = self._check_image(打光图, "打光图")
        original, relit = self._match_batch(original, relit)

        batch, height, width = int(original.shape[0]), int(original.shape[1]), int(original.shape[2])
        device, dtype = original.device, original.dtype
        extra = int(original.shape[-1]) - 3

        mask_np = self._prepare_mask(光影范围遮罩, batch, height, width, device)
        if mask_np is not None:
            # 遮罩边缘轻微羽化，避免灯光明暗出现硬接缝
            mask_np = np.stack([
                cv2.GaussianBlur(m, (0, 0), 3.0, borderType=cv2.BORDER_REPLICATE) for m in mask_np
            ])

        outputs = []
        for index in range(batch):
            source = original[index, :, :, :3].detach().float().cpu().numpy()
            target = relit[index, :, :, :3].detach().float().cpu().numpy()
            target = self._fit(target, height, width)
            if 自动对齐:
                target = self._align(source, target)

            result = _fuse(
                _srgb_to_linear(source),
                _srgb_to_linear(target),
                light=float(光影强度),
                sigma=max(float(光影尺度), 1.0),
                detail=float(细节强度),
                chroma=float(色彩强度),
                highlight=float(高光保护),
                mask=None if mask_np is None else mask_np[index],
            )
            result = _linear_to_srgb(result)

            if extra > 0:
                tail = relit[index, :, :, 3:].detach().float().cpu().numpy()
                tail = self._fit(tail, height, width)
                result = np.concatenate((result, tail), axis=-1)

            outputs.append(torch.from_numpy(np.ascontiguousarray(result)))

        return (torch.stack(outputs, dim=0).to(device=device, dtype=dtype),)


NODE_CLASS_MAPPINGS = {"MyLightDetailFusion": MyLightDetailFusion}
NODE_DISPLAY_NAME_MAPPINGS = {"MyLightDetailFusion": "My光影细节融合"}
