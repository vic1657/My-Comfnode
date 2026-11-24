# -*- coding: utf-8 -*-
"""
My-FaceRatioK: 人脸占比自动选择放大倍率 K（2=4K / 3=6K / 4=8K）

原理：用 Impact Pack 的 UltralyticsDetectorProvider 检出人脸 SEGS，
取最大人脸的 bbox 高度占画面高度的比例，按阈值映射景别：
  特写(>=特写阈值)  -> K=2 (4K)
  中景(两者之间)    -> K=3 (6K)
  全景(<中景阈值)   -> K=4 (8K)
  未检出人脸        -> 使用"无人脸默认K"
"""
from collections import namedtuple

# 与 Impact Pack 保持一致的轻量 SEG 结构（仅用于单元测试）
SEG = namedtuple("SEG", ["cropped_image", "cropped_mask", "confidence", "crop_region", "bbox", "label", "head"])


def compute_k(segs, image_h, closeup_threshold=0.45, medium_threshold=0.22,
              no_face_k=4, auto_mode=True, manual_k=3):
    """核心纯逻辑，便于单元测试。

    segs: Impact SEGS = (shape, [SEG, ...])，SEG.bbox = (x1, y1, x2, y2)
    image_h: 画面高度（像素）
    返回: (k, 描述字符串)
    """
    if not auto_mode:
        k = int(manual_k)
        return k, f"手动模式 → K={k}（{k * 2}K 档）"

    items = segs[1] if isinstance(segs, (tuple, list)) and len(segs) >= 2 else []
    if image_h <= 0:
        k = int(no_face_k)
        return k, f"画面高度异常 → K={k}"

    max_ratio = 0.0
    for seg in items:
        try:
            bbox = seg.bbox
            face_h = float(bbox[3]) - float(bbox[1])
            if face_h <= 0:
                continue
            max_ratio = max(max_ratio, face_h / float(image_h))
        except Exception:
            continue

    max_ratio = round(max_ratio, 4)
    if max_ratio <= 0:
        k = int(no_face_k)
        return k, f"未检出人脸 → K={k}（{k * 2}K 档）"

    if max_ratio >= closeup_threshold:
        k = 2
        label = "特写"
    elif max_ratio >= medium_threshold:
        k = 3
        label = "中景"
    else:
        k = 4
        label = "全景"

    desc = f"{label}（脸高占比 {max_ratio * 100:.1f}%）→ K={k}（{k * 2}K 档）"
    return k, desc


class MyFaceRatioToK:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "segs": ("SEGS",),
                "自动模式": ("BOOLEAN", {"default": True, "label_on": "自动识别景别", "label_off": "手动指定K"}),
                "手动K": ("INT", {"default": 3, "min": 2, "max": 4, "step": 1}),
                "特写阈值": ("FLOAT", {"default": 0.45, "min": 0.05, "max": 1.0, "step": 0.01}),
                "中景阈值": ("FLOAT", {"default": 0.22, "min": 0.02, "max": 1.0, "step": 0.01}),
                "无人脸默认K": ("INT", {"default": 4, "min": 2, "max": 4, "step": 1}),
            },
        }

    RETURN_TYPES = ("INT", "STRING")
    RETURN_NAMES = ("K值", "景别说明")
    FUNCTION = "run"
    CATEGORY = "My-Comfnode/自动景别"
    DESCRIPTION = ("按画面中最大人脸的占比自动选择放大倍率 K：\n"
                   "特写→K=2(4K)，中景→K=3(6K)，全景→K=4(8K)。\n"
                   "输出 K 直接接到 SimpleMath 的 a 输入。")

    def run(self, image, segs, 自动模式, 手动K, 特写阈值, 中景阈值, 无人脸默认K):
        # ComfyUI IMAGE 张量: (B, H, W, C)
        image_h = int(image.shape[1])
        k, desc = compute_k(segs, image_h, 特写阈值, 中景阈值, 无人脸默认K, 自动模式, 手动K)
        print(f"[MyFaceRatioToK] {desc}", flush=True)
        return (k, desc)


NODE_CLASS_MAPPINGS = {"MyFaceRatioToK": MyFaceRatioToK}
NODE_DISPLAY_NAME_MAPPINGS = {"MyFaceRatioToK": "人脸占比自动选K (My)"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "MyFaceRatioToK"]
