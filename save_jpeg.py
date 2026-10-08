from __future__ import annotations

import json
import os

import numpy as np
from PIL import Image

import folder_paths


def _image_to_pil(image) -> Image.Image:
    array = np.clip(image.detach().cpu().numpy(), 0.0, 1.0)
    rgb = (array[..., :3] * 255.0 + 0.5).astype(np.uint8)
    if array.shape[-1] >= 4:
        alpha = array[..., 3:4]
        rgb = (rgb.astype(np.float32) * alpha + 255.0 * (1.0 - alpha) + 0.5).astype(np.uint8)
    return Image.fromarray(rgb)


class MySaveJPEG:
    def __init__(self):
        self.output_dir = folder_paths.get_output_directory()
        self.type = "output"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE", {"tooltip": "需要保存为小体积 JPG 的图片"}),
                "filename_prefix": ("STRING", {"default": "My_JPG"}),
                "quality": (
                    "INT",
                    {"default": 95, "min": 70, "max": 100, "step": 1, "display": "slider"},
                ),
                "chroma_subsampling": (["4:4:4", "4:2:2", "4:2:0"], {"default": "4:4:4"}),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    RETURN_TYPES = ()
    FUNCTION = "save_images"
    OUTPUT_NODE = True
    CATEGORY = "My-Comfnode/图像"
    DESCRIPTION = "以可调质量保存 JPG；默认 95 品质和 4:4:4 色度，明显减小文件体积。"

    def save_images(
        self,
        images,
        filename_prefix="My_JPG",
        quality=95,
        chroma_subsampling="4:4:4",
        prompt=None,
        extra_pnginfo=None,
    ):
        full_output_folder, filename, counter, subfolder, filename_prefix = (
            folder_paths.get_save_image_path(
                filename_prefix,
                self.output_dir,
                images[0].shape[1],
                images[0].shape[0],
            )
        )
        results = []
        subsampling = {"4:4:4": 0, "4:2:2": 1, "4:2:0": 2}[chroma_subsampling]
        metadata = {"prompt": prompt, "extra_pnginfo": extra_pnginfo}
        comment = json.dumps(metadata, ensure_ascii=False, default=str).encode("utf-8")
        for image in images:
            file = f"{filename}_{counter:05}_.jpg"
            path = os.path.join(full_output_folder, file)
            _image_to_pil(image).save(
                path,
                format="JPEG",
                quality=int(quality),
                subsampling=subsampling,
                optimize=True,
                comment=comment,
            )
            results.append({"filename": file, "subfolder": subfolder, "type": self.type})
            counter += 1
        return {"ui": {"images": results}}


NODE_CLASS_MAPPINGS = {"MySaveJPEG": MySaveJPEG}
NODE_DISPLAY_NAME_MAPPINGS = {"MySaveJPEG": "My保存JPG"}
