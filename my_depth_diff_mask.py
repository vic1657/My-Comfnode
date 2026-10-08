# -*- coding: utf-8 -*-
"""MY深度差异遮罩：对比外部提供的两张深度图，识别变化区域输出遮罩。

深度图由外部节点生成（本节点不含深度模型，也不限定尺寸——
深度图/图像的分辨率由上游决定，尺寸不一致时自动对齐到原图尺寸）。

双区阈值识别（实测调优）：
  深度归一化(2/98分位) → 绝对差 → 自适应核平滑
  自动提取人物/服饰注意力区域（rembg 双图并集）：
    区域内  低阈值 → 中度衣物变化（飘带、裙摆形态）不漏检
    区域外  高阈值 → 只有剧烈变化才保留（压住 AI 重绘背景的深度噪声）
  闭运算/填孔/连通域面积过滤 → 输出 MASK（白=变化区域）
"""

import numpy as np
import cv2
import torch

try:
    from scipy import ndimage
    _HAS_SCIPY = True
except Exception:
    _HAS_SCIPY = False


class MyDepthDiffMask:
    CATEGORY = "My-Comfnode/图像"
    FUNCTION = "compare"
    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("遮罩",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "原图": ("IMAGE",),
                "AI图": ("IMAGE",),
                "原图深度图": ("IMAGE",),
                "AI图深度图": ("IMAGE",),
                "灵敏度": ("FLOAT", {"default": 0.8, "min": 0.1, "max": 1.5,
                                     "step": 0.05,
                                     "description": "1.0=标准；越小越敏感（检出更多），越大越保守"}),
                "最小面积": ("FLOAT", {"default": 0.1, "min": 0.01, "max": 5.0,
                                       "step": 0.01,
                                       "description": "小于画面百分比的碎块丢弃（噪声过滤）"}),
            },
        }

    @staticmethod
    def _to_u8(img: torch.Tensor) -> np.ndarray:
        arr = img.detach().cpu().numpy()
        return (np.clip(arr, 0.0, 1.0) * 255.0).astype(np.uint8)

    @staticmethod
    def _to_gray_u8(img: torch.Tensor) -> np.ndarray:
        arr = img.detach().cpu().numpy()
        if arr.ndim == 3 and arr.shape[-1] >= 3:
            arr = arr[..., :3].mean(axis=-1)
        return (np.clip(arr, 0.0, 1.0) * 255.0).astype(np.uint8)

    _SESSIONS = {}

    @classmethod
    def _get_session(cls):
        if "u2net" not in cls._SESSIONS:
            from rembg import new_session
            cls._SESSIONS["u2net"] = new_session("u2net")
        return cls._SESSIONS["u2net"]

    def _person_region(self, rgb: np.ndarray) -> np.ndarray:
        from rembg import remove
        from PIL import Image as PILImage
        return np.array(remove(PILImage.fromarray(rgb),
                               session=self._get_session(), only_mask=True))

    def _attention_region(self, orig_u8, ai_u8):
        """人物/服饰注意力区域 = 两图人物剪影并集（外扩+柔化）"""
        try:
            a1 = self._person_region(orig_u8)
            a2 = self._person_region(ai_u8)
        except Exception as exc:
            print(f"[MY深度差异遮罩] 注意力区域提取失败，退回全局阈值: {exc}")
            return None
        region = cv2.dilate(np.maximum(a1, a2),
                            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (41, 41)))
        region_s = cv2.GaussianBlur(region, (31, 31), 0)
        return region_s > 100

    def _one_mask(self, orig_u8, ai_u8, lo_u8, la_u8, size_hw, p) -> np.ndarray:
        h, w = size_hw
        if lo_u8.shape[:2] != (h, w):
            lo_u8 = cv2.resize(lo_u8, (w, h), interpolation=cv2.INTER_LINEAR)
        if la_u8.shape[:2] != (h, w):
            la_u8 = cv2.resize(la_u8, (w, h), interpolation=cv2.INTER_LINEAR)

        def norm(d):
            lo, hi = np.percentile(d, 2), np.percentile(d, 98)
            return np.clip((d - lo) / max(hi - lo, 1e-6) * 255.0, 0, 255)

        raw = np.abs(norm(la_u8.astype(np.float32)) -
                     norm(lo_u8.astype(np.float32)))

        # 自适应核平滑（核大小随图像尺寸，不写死）
        k = max(5, (min(h, w) // 64) * 2 + 1)
        diff = cv2.GaussianBlur(raw, (k, k), 0)
        diff_u8 = diff.astype(np.uint8)

        # ---- 人物/服饰注意力区域（rembg 双图并集）----
        t_in, t_out = 12.0, 35.0
        region_b = self._attention_region(orig_u8, ai_u8)
        sens = float(np.clip(p["灵敏度"], 0.1, 1.5))
        t_in *= sens
        t_out *= sens

        # ---- 双区阈值 ----
        binary = np.zeros((h, w), np.uint8)
        if region_b is not None:
            binary[region_b & (diff_u8 > t_in)] = 255
            binary[~region_b & (diff_u8 > t_out)] = 255
        else:
            # 注意力区域提取失败时退回全局 Otsu
            _, g_bin = cv2.threshold(diff_u8, 0, 255,
                                     cv2.THRESH_BINARY + cv2.THRESH_OTSU)
            binary = g_bin

        # 清理：闭运算 → 填孔 → 面积过滤
        ck = max(7, (min(h, w) // 100) * 2 + 1)
        binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE,
                                  cv2.getStructuringElement(
                                      cv2.MORPH_ELLIPSE, (ck, ck)))
        mask_bool = binary > 127
        if _HAS_SCIPY and mask_bool.any():
            mask_bool = ndimage.binary_fill_holes(mask_bool)
        min_area = max(1, int(float(p["最小面积"]) / 100.0 * h * w))
        num, labels, stats, _ = cv2.connectedComponentsWithStats(
            mask_bool.astype(np.uint8) * 255, 8)
        for i in range(1, num):
            if stats[i, cv2.CC_STAT_AREA] < min_area:
                mask_bool[labels == i] = False

        # 只输出识别结果：不做外扩/羽化/反相（由外部节点决定）
        return mask_bool.astype(np.float32)

    def compare(self, 原图, AI图, 原图深度图, AI图深度图, 灵敏度, 最小面积):
        p = {"灵敏度": 灵敏度, "最小面积": 最小面积}
        o = 原图.detach().cpu().numpy()
        a = AI图.detach().cpu().numpy()
        lo = 原图深度图.detach().cpu().numpy()
        la = AI图深度图.detach().cpu().numpy()
        b = min(o.shape[0], a.shape[0], lo.shape[0], la.shape[0])
        masks = []
        for i in range(b):
            size_hw = o[i].shape[:2]
            orig_u8 = self._to_u8(torch.from_numpy(o[i]))
            ai_u8 = self._to_u8(torch.from_numpy(a[i]))
            lo_u8 = self._to_gray_u8(torch.from_numpy(lo[i]))
            la_u8 = self._to_gray_u8(torch.from_numpy(la[i]))
            masks.append(self._one_mask(orig_u8, ai_u8, lo_u8, la_u8,
                                        size_hw, p))
        out = np.stack(masks, axis=0).astype(np.float32)
        return (torch.from_numpy(out),)


NODE_CLASS_MAPPINGS = {
    "MyDepthDiffMask": MyDepthDiffMask,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MyDepthDiffMask": "MY深度差异遮罩",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
