"""
ComfyUI Canvas Paint Node - 交互式画布节点
============================================
在 ComfyUI 中实现完整的交互式画布绘画功能

功能：
- 画笔/橡皮擦工具，可调节大小和颜色
- 撤销/清除功能
- 颜色选择器（预设色板）
- 画布拖拽与缩放
- 输出带颜色的绘画图像和遮罩

Author: Myyyds
Version: 1.0.0
"""

import torch
import numpy as np
from PIL import Image
import io
import base64
import json
import os
import urllib.parse
from typing import Tuple, Optional, Union

import folder_paths


# ==================== 工具函数 ====================

def pil_to_tensor(img: Image.Image) -> torch.Tensor:
    """PIL Image -> ComfyUI IMAGE tensor [1, H, W, C]"""
    arr = np.array(img).astype(np.float32) / 255.0
    if arr.ndim == 2:
        arr = np.stack([arr, arr, arr], axis=-1)
    elif arr.shape[2] == 1:
        arr = np.repeat(arr, 3, axis=-1)
    elif arr.shape[2] == 4:
        arr = arr[:, :, :3]
    # ComfyUI IMAGE format: [batch, height, width, channels]
    return torch.from_numpy(arr).unsqueeze(0)


def tensor_to_pil(tensor: Union[torch.Tensor, np.ndarray]) -> Image.Image:
    """ComfyUI IMAGE tensor [B,H,W,C] or [H,W,C] -> PIL Image"""
    if isinstance(tensor, torch.Tensor):
        arr = tensor.cpu().numpy()
    else:
        arr = tensor
    if arr.ndim == 4:
        arr = arr[0]  # [H, W, C]
    arr = (arr * 255).clip(0, 255).astype(np.uint8)
    return Image.fromarray(arr)


def base64_to_image(base64_str: str) -> Optional[Image.Image]:
    """base64 -> PIL Image (RGBA)"""
    if not base64_str or not isinstance(base64_str, str):
        return None
    try:
        if ',' in base64_str:
            base64_str = base64_str.split(',')[1]
        base64_str = base64_str.strip()
        if not base64_str:
            return None
        data = base64.b64decode(base64_str)
        img = Image.open(io.BytesIO(data))
        return img.convert('RGBA')
    except Exception as e:
        print(f"[CanvasPaint] base64 decode error: {e}")
        return None


IMAGE_REF_PREFIX = "__OP_IMAGE_REF__:"
WORK_PAINT_TOKEN = "__OP_WORK_PAINT__:"


def image_ref_to_image(value: str) -> Optional[Image.Image]:
    """Load a previously uploaded ComfyUI input image reference."""
    if not value or not isinstance(value, str) or not value.startswith(IMAGE_REF_PREFIX):
        return None
    try:
        raw = value[len(IMAGE_REF_PREFIX):].strip()
        ref = json.loads(urllib.parse.unquote(raw))
        if not isinstance(ref, dict):
            return None
        ref_type = str(ref.get("type") or "input")
        if ref_type != "input":
            print(f"[CanvasPaint] unsupported image ref type: {ref_type}")
            return None
        filename = str(ref.get("filename") or ref.get("name") or "").replace("\\", "/")
        subfolder = str(ref.get("subfolder") or "").replace("\\", "/")
        if not filename or os.path.isabs(filename) or os.path.isabs(subfolder):
            return None
        input_dir = os.path.abspath(folder_paths.get_input_directory())
        image_path = os.path.abspath(os.path.join(input_dir, subfolder, filename))
        if os.path.commonpath([input_dir, image_path]) != input_dir:
            print("[CanvasPaint] blocked unsafe image ref path")
            return None
        if not os.path.isfile(image_path):
            print(f"[CanvasPaint] image ref not found: {image_path}")
            return None
        with Image.open(image_path) as img:
            return img.convert('RGBA')
    except Exception as e:
        print(f"[CanvasPaint] image ref decode error: {e}")
        return None


def payload_to_image(value: str) -> Optional[Image.Image]:
    """Decode either legacy base64 or a ComfyUI input image reference."""
    if not value or not isinstance(value, str):
        return None
    value = value.strip()
    if value.startswith(IMAGE_REF_PREFIX):
        return image_ref_to_image(value)
    return base64_to_image(value)


def split_work_paint_payload(value: str) -> Tuple[str, Optional[Tuple[int, int]], str]:
    """Split editor composite base and optional work-canvas paint overlay."""
    if not value or WORK_PAINT_TOKEN not in value:
        return value, None, ""
    base_value, overlay = value.split(WORK_PAINT_TOKEN, 1)
    if ":" not in overlay:
        return value, None, ""
    size_text, overlay_value = overlay.split(":", 1)
    try:
        w_text, h_text = size_text.lower().split("x", 1)
        work_size = (max(1, int(w_text)), max(1, int(h_text)))
    except Exception:
        return value, None, ""
    return base_value, work_size, overlay_value


# ==================== 节点类 ====================

def flatten_rgba(img: Image.Image, fallback: Optional[Image.Image] = None) -> Image.Image:
    """RGBA -> RGB, using fallback under transparent pixels."""
    rgba = img.convert('RGBA')
    if fallback is not None:
        base = fallback.convert('RGBA').resize(rgba.size, Image.LANCZOS)
    else:
        base = Image.new('RGBA', rgba.size, (0, 0, 0, 255))
    return Image.alpha_composite(base, rgba).convert('RGB')


def decode_editor_composite(value: str) -> Tuple[Optional[Image.Image], bool]:
    """Decode __OP_FULL_COMPOSITE__ data and return (image, canvas_changed)."""
    if not value or not isinstance(value, str):
        return None, False
    value = value.strip()
    prefix = "__OP_FULL_COMPOSITE__:"
    if not value.startswith(prefix):
        return None, False
    value = value[len(prefix):].strip()
    changed = False
    if value.startswith("changed:"):
        changed = True
        value = value[len("changed:"):].strip()
    elif value.startswith("same:"):
        value = value[len("same:"):].strip()
    if not value:
        return None, changed
    return payload_to_image(value), changed


class CanvasPaintNode:
    """交互式画布绘画节点"""

    DISPLAY_NAME = "My画笔工具"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {
                    "tooltip": "输入图像，将在此图像上进行绘画"
                }),
                "max_size": ("INT", {
                    "default": 1024,
                    "min": 256, "max": 65535,
                    "step": 128,
                    "display": "slider",
                    "tooltip": "输入图像的最长边限制"
                }),
                "paint_base64": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "placeholder": "绘画图层数据（前端自动填充）"
                }),
                "mask_base64": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "placeholder": "遮罩数据（前端自动填充）"
                }),
            },
            "optional": {
                "brush_size": ("INT", {
                    "default": 30,
                    "min": 1, "max": 100,
                    "display": "slider",
                    "tooltip": "画笔大小"
                }),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK", "IMAGE")
    RETURN_NAMES = ("painted_image", "mask", "preview")
    FUNCTION = "process"
    CATEGORY = "My-Comfnode/图像"
    OUTPUT_NODE = False

    def process(
        self,
        image: torch.Tensor,
        max_size: int,
        paint_base64: str = "",
        mask_base64: str = "",
        brush_size: int = 30,
    ) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """
        处理画布输入并输出绘画结果
        """
        # 提取原始图像 (ComfyUI IMAGE format: [B, H, W, C])
        if isinstance(image, torch.Tensor):
            t = image[0] if image.ndim == 4 else image  # [H, W, C]
        else:
            t = image

        orig_h, orig_w = int(t.shape[0]), int(t.shape[1])

        # 转为 PIL
        original = tensor_to_pil(t)
        orig_size = original.size  # (w, h)

        # 按最长边缩放
        max_dim = max(orig_size)
        scale = 1.0
        if max_dim > max_size:
            scale = max_size / max_dim

        if scale < 1.0:
            new_size = (int(orig_size[0] * scale), int(orig_size[1] * scale))
            scaled = original.resize(new_size, Image.LANCZOS)
        else:
            scaled = original.copy()
            new_size = orig_size

        # 确保 RGBA
        if scaled.mode != 'RGBA':
            scaled = scaled.convert('RGBA')

        # 处理绘画图层
        editor_canvas_changed = False
        paint_is_editor_composite = False
        has_paint_layer = False
        overlay_work_size = None
        overlay_layer = None
        paint_layer = Image.new('RGBA', new_size, (0, 0, 0, 0))
        if paint_base64 and isinstance(paint_base64, str):
            paint_base64 = paint_base64.strip()
            editor_prefix = "__OP_FULL_COMPOSITE__:"
            if paint_base64.startswith(editor_prefix):
                paint_is_editor_composite = True
                paint_base64 = paint_base64[len(editor_prefix):].strip()
                if paint_base64.startswith("changed:"):
                    editor_canvas_changed = True
                    paint_base64 = paint_base64[len("changed:"):].strip()
                elif paint_base64.startswith("same:"):
                    editor_canvas_changed = False
                    paint_base64 = paint_base64[len("same:"):].strip()
                paint_base64, overlay_work_size, overlay_payload = split_work_paint_payload(paint_base64)
                if overlay_payload:
                    overlay_layer = payload_to_image(overlay_payload)
            if paint_base64:
                pimg = payload_to_image(paint_base64)
                if pimg:
                    if pimg.size != new_size and pimg.size != orig_size and not editor_canvas_changed:
                        pimg = pimg.resize(new_size, Image.LANCZOS)
                    paint_layer = pimg
                    has_paint_layer = True

        # 处理遮罩
        has_mask_layer = False
        mask_layer = Image.new('L', new_size, 0)
        if mask_base64 and isinstance(mask_base64, str):
            mask_base64 = mask_base64.strip()
            if mask_base64:
                mimg = payload_to_image(mask_base64)
                if mimg:
                    if mimg.mode != 'L':
                        mimg = mimg.convert('L')
                    if mimg.size != new_size and mimg.size != orig_size and not editor_canvas_changed:
                        mimg = mimg.resize(new_size, Image.LANCZOS)
                    mask_layer = mimg
                    has_mask_layer = True

        # preview（缩放尺寸预览）
        preview = scaled.convert('RGB')

        # 遮罩：普通绘制放大回原图尺寸；编辑器改画布时保留编辑尺寸
        if mask_layer.size != orig_size and not editor_canvas_changed:
            final_mask = mask_layer.resize(orig_size, Image.NEAREST)
        else:
            final_mask = mask_layer

        # 合成 painted_image（原图尺寸）
        if has_paint_layer and paint_is_editor_composite:
            if editor_canvas_changed:
                painted_rgb = flatten_rgba(paint_layer)
            else:
                editor_full = paint_layer
                if editor_full.size != orig_size:
                    editor_full = editor_full.resize(orig_size, Image.LANCZOS)
                painted_rgb = flatten_rgba(editor_full, original)
            if overlay_layer is not None:
                overlay_size = painted_rgb.size
                overlay_full = overlay_layer.resize(overlay_size, Image.LANCZOS)
                painted_full = Image.alpha_composite(painted_rgb.convert('RGBA'), overlay_full.convert('RGBA'))
                painted_rgb = painted_full.convert('RGB')
        elif has_paint_layer:
            paint_orig = paint_layer.resize(orig_size, Image.LANCZOS)
            original_rgba = original.convert('RGBA')
            painted_full = Image.alpha_composite(original_rgba, paint_orig.convert('RGBA'))
            painted_rgb = painted_full.convert('RGB')
        else:
            painted_rgb = original.convert('RGB')

        # ComfyUI MASK format: [H, W]
        mask_np = np.array(final_mask).astype(np.float32) / 255.0

        return (
            pil_to_tensor(painted_rgb),
            torch.from_numpy(mask_np),
            pil_to_tensor(preview),
        )


# ==================== 节点注册 ====================

NODE_CLASS_MAPPINGS = {
    "MyComfnodeCanvasPaintNode": CanvasPaintNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MyComfnodeCanvasPaintNode": "🎨 My画笔工具",
}
