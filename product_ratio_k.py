# -*- coding: utf-8 -*-
"""
MyProductRatioToK: 产品占画面比例自动选择放大倍率 K（2=4K / 3=6K / 4=8K）

配合 easy sam3ImageSegmentation 使用：
  LoadImage → easy sam3ModelLoader → easy sam3ImageSegmentation(prompt="product")
      → obj_masks(MASK) → 本节点 → K
逻辑：每层产品掩码取非零区域的 bbox，用最大 bbox 高度 / 画面高度 得到占比，
阈值映射与人脸版一致（特写→K2，中景→K3，全景→K4）。
"""
import torch


def _normalize_masks(masks):
    """把各种形态的输入归一化成 (N, H, W) 张量列表。"""
    if isinstance(masks, (list, tuple)):
        out = []
        for m in masks:
            if m is None:
                continue
            t = m
            while t.dim() > 2:
                # (N,1,H,W)/(1,N,H,W)/(H,W,1) 等形态逐层压掉单一维
                if 1 in t.shape[:2] and t.dim() == 4:
                    t = t.squeeze(1) if t.shape[1] == 1 else t[0]
                else:
                    t = t[0]
            if t.dim() == 2:
                out.append(t)
        return out
    t = masks
    if t.dim() > 3:
        t = t.reshape(-1, t.shape[-2], t.shape[-1])
    t = t.squeeze()
    if t.dim() == 2:
        return [t]
    if t.dim() == 3:
        return [t[i] for i in range(t.shape[0])]
    return []


def compute_k_from_masks(masks, image_h, closeup_threshold=0.45, medium_threshold=0.22,
                         no_target_k=4, auto_mode=True, manual_k=3):
    """纯逻辑，便于单元测试。masks 支持 (N,H,W)/(N,1,H,W)/(H,W)/list 等形态。"""
    if not auto_mode:
        k = int(manual_k)
        return k, f"手动模式 → K={k}（{k * 2}K 档）"

    mask_list = _normalize_masks(masks)
    if image_h <= 0:
        k = int(no_target_k)
        return k, f"画面高度异常 → K={k}"

    max_ratio = 0.0
    for m in mask_list:
        ys, xs = torch.nonzero(m, as_tuple=True)
        if ys.numel() == 0:
            continue
        bbox_h = float(ys.max()) - float(ys.min())
        if bbox_h <= 0:
            continue
        max_ratio = max(max_ratio, bbox_h / float(image_h))

    max_ratio = round(max_ratio, 4)
    if max_ratio <= 0:
        k = int(no_target_k)
        return k, f"未检出产品 → K={k}（{k * 2}K 档）"

    if max_ratio >= closeup_threshold:
        k = 2
        label = "特写"
    elif max_ratio >= medium_threshold:
        k = 3
        label = "中景"
    else:
        k = 4
        label = "全景"

    desc = f"{label}（产品高度占比 {max_ratio * 100:.1f}%）→ K={k}（{k * 2}K 档）"
    return k, desc


class MyProductRatioToK:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "mask": ("MASK",),
                "自动模式": ("BOOLEAN", {"default": True, "label_on": "自动识别景别", "label_off": "手动指定K"}),
                "手动K": ("INT", {"default": 3, "min": 2, "max": 4, "step": 1}),
                "特写阈值": ("FLOAT", {"default": 0.45, "min": 0.05, "max": 1.0, "step": 0.01}),
                "中景阈值": ("FLOAT", {"default": 0.22, "min": 0.02, "max": 1.0, "step": 0.01}),
                "无目标默认K": ("INT", {"default": 4, "min": 2, "max": 4, "step": 1}),
            },
        }

    RETURN_TYPES = ("INT", "STRING")
    RETURN_NAMES = ("K值", "景别说明")
    FUNCTION = "run"
    CATEGORY = "My-Comfnode/自动景别"
    DESCRIPTION = ("按画面中产品的占比自动选择放大倍率 K：\n"
                   "配合 easy sam3ImageSegmentation 的 obj_masks 使用（prompt 填产品描述，如 product）。\n"
                   "特写→K=2(4K)，中景→K=3(6K)，全景→K=4(8K)。")

    def run(self, image, mask, 自动模式, 手动K, 特写阈值, 中景阈值, 无目标默认K):
        image_h = int(image.shape[1])
        k, desc = compute_k_from_masks(mask, image_h, 特写阈值, 中景阈值, 无目标默认K, 自动模式, 手动K)
        print(f"[MyProductRatioToK] {desc}", flush=True)
        return (k, desc)


NODE_CLASS_MAPPINGS = {"MyProductRatioToK": MyProductRatioToK}
NODE_DISPLAY_NAME_MAPPINGS = {"MyProductRatioToK": "产品占比自动选K (My)"}
