from __future__ import annotations

import hashlib
import os
from pathlib import Path, PurePosixPath

import numpy as np
import torch
from PIL import Image, ImageOps

import folder_paths
import node_helpers
import nodes

try:
    from aiohttp import web
    from server import PromptServer
except Exception:
    web = None
    PromptServer = None


def _load_mask_image(mask_path: str, width: int, height: int) -> torch.Tensor:
    image = node_helpers.pillow(Image.open, mask_path)
    image = node_helpers.pillow(ImageOps.exif_transpose, image)

    if "A" in image.getbands():
        alpha = image.getchannel("A")
        mask = image.convert("L") if alpha.getextrema() == (255, 255) else alpha
    else:
        mask = image.convert("L")

    if mask.size != (width, height):
        mask = mask.resize((width, height), Image.Resampling.BILINEAR)

    array = np.asarray(mask, dtype=np.float32) / 255.0
    return torch.from_numpy(array.copy()).clamp_(0.0, 1.0)


def _original_image_name(image: str) -> str:
    annotated = str(image or "").split(" [", 1)[0].replace("\\", "/")
    return PurePosixPath(annotated).stem


def _resolved_original_name(image: str, original_name: str) -> str:
    image_name = _original_image_name(image)
    stored_name = str(original_name or "").strip()
    # Older workflows stored the native upload widget marker in this newly
    # appended widget position. It is not the source filename.
    if not stored_name or (stored_name == "image" and image_name != "image"):
        return image_name
    return stored_name


class MyImageMaskBrush(nodes.LoadImage):
    @classmethod
    def INPUT_TYPES(cls):
        inputs = super().INPUT_TYPES()
        image_input = inputs["required"]["image"]
        return {
            "required": {
                "image": image_input,
                "mask_file": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "tooltip": "节点内遮罩画笔自动维护的遮罩文件",
                    },
                ),
                "inverse_mask_file": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "tooltip": "节点内图片编辑器自动维护的反向遮罩文件",
                    },
                ),
                "original_name": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "tooltip": "节点内部保存的首次导入原图名称",
                    },
                ),
            }
        }

    CATEGORY = "My-Comfnode/图像"
    RETURN_TYPES = ("IMAGE", "MASK", "MASK", "STRING")
    RETURN_NAMES = ("图像", "手绘遮罩", "反向遮罩", "原图原名称")
    FUNCTION = "load_image_with_mask"
    DESCRIPTION = "加载图像，并直接在节点预览上绘制圆形或方形遮罩。"

    def load_image_with_mask(
        self,
        image: str,
        mask_file: str = "",
        inverse_mask_file: str = "",
        original_name: str = "",
    ):
        loaded_image, _ = super().load_image(image)
        batch, height, width = loaded_image.shape[:3]

        mask_file = str(mask_file or "").strip()
        if mask_file:
            mask_path = folder_paths.get_annotated_filepath(mask_file)
            mask = _load_mask_image(mask_path, width, height)
            mask = mask.unsqueeze(0).repeat(batch, 1, 1)
            mask = mask.to(dtype=loaded_image.dtype, device=loaded_image.device)
        else:
            mask = torch.zeros(
                (batch, height, width),
                dtype=loaded_image.dtype,
                device=loaded_image.device,
            )

        inverse_mask_file = str(inverse_mask_file or "").strip()
        if inverse_mask_file:
            inverse_mask_path = folder_paths.get_annotated_filepath(inverse_mask_file)
            inverse_mask = _load_mask_image(inverse_mask_path, width, height)
            inverse_mask = inverse_mask.unsqueeze(0).repeat(batch, 1, 1)
            inverse_mask = inverse_mask.to(dtype=loaded_image.dtype, device=loaded_image.device)
        else:
            inverse_mask = (1.0 - mask).clamp_(0.0, 1.0)

        return loaded_image, mask, inverse_mask, _resolved_original_name(image, original_name)

    @classmethod
    def IS_CHANGED(
        cls,
        image: str,
        mask_file: str = "",
        inverse_mask_file: str = "",
        original_name: str = "",
    ):
        image_hash = super().IS_CHANGED(image)
        digest = hashlib.sha256()
        digest.update(str(original_name or "").encode("utf-8"))
        for label, value in (("mask", mask_file), ("inverse", inverse_mask_file)):
            value = str(value or "").strip()
            digest.update(f"{label}:".encode("utf-8"))
            if not value:
                digest.update(b"empty")
                continue
            mask_path = folder_paths.get_annotated_filepath(value)
            with open(mask_path, "rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
        return f"{image_hash}:{digest.hexdigest()}"

    @classmethod
    def VALIDATE_INPUTS(
        cls,
        image: str,
        mask_file: str = "",
        inverse_mask_file: str = "",
        original_name: str = "",
    ):
        del original_name
        image_result = super().VALIDATE_INPUTS(image)
        if image_result is not True:
            return image_result

        mask_file = str(mask_file or "").strip()
        if mask_file and not folder_paths.exists_annotated_filepath(mask_file):
            return f"遮罩文件不存在: {mask_file}"
        inverse_mask_file = str(inverse_mask_file or "").strip()
        if inverse_mask_file and not folder_paths.exists_annotated_filepath(inverse_mask_file):
            return f"反向遮罩文件不存在: {inverse_mask_file}"
        return True


NODE_CLASS_MAPPINGS = {
    "MyComfnodeImageMaskBrush": MyImageMaskBrush,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MyComfnodeImageMaskBrush": "图像遮罩画笔",
}

