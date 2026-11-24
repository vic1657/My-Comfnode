from __future__ import annotations

import json
import os
import re
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image
from PIL.PngImagePlugin import PngInfo

import folder_paths


_SAVE_LOCK = threading.Lock()
_INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _clean_filename_part(value: str) -> str:
    cleaned = _INVALID_FILENAME_CHARS.sub("_", str(value or "").strip()).rstrip(". ")
    return cleaned


def _build_filename_base(source_name: str, manual_prefix: str) -> str:
    combined = f"{_clean_filename_part(manual_prefix)}{_clean_filename_part(source_name)}"
    return combined or "图片"


def _clean_folder_name(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("选择自定义名称时，自定义文件夹名不能为空")
    if raw in {".", ".."} or "/" in raw or "\\" in raw:
        raise ValueError("自定义文件夹名只能填写单层文件夹名称")
    cleaned = _INVALID_FILENAME_CHARS.sub("_", raw).rstrip(". ")
    if not cleaned:
        raise ValueError("自定义文件夹名无效")
    return cleaned


def _resolve_target_directory(save_path: str, folder_mode: str, custom_folder: str) -> Path:
    output_root = Path(folder_paths.get_output_directory()).expanduser().resolve()
    raw_path = os.path.expandvars(str(save_path or "").strip())
    base = Path(raw_path).expanduser() if raw_path else output_root
    if not base.is_absolute():
        base = output_root / base

    if folder_mode == "自定义名称":
        base = base / _clean_folder_name(custom_folder)
    elif folder_mode == "按当天日期(MMDD)":
        date_name = datetime.now().strftime("%m%d")
        custom_prefix = str(custom_folder or "").strip()
        if custom_prefix:
            date_name = f"{_clean_folder_name(custom_prefix)}{date_name}"
        base = base / date_name
    elif folder_mode != "不新建":
        raise ValueError(f"未知的新建文件夹方式：{folder_mode}")

    target = base.resolve()
    target.mkdir(parents=True, exist_ok=True)
    return target


def _next_number(directory: Path, prefix: str) -> int:
    pattern = re.compile(rf"^{re.escape(prefix)}(\d+)\.(?:png|jpe?g)$", re.IGNORECASE)
    highest = 0
    for item in directory.iterdir():
        if not item.is_file():
            continue
        match = pattern.match(item.name)
        if match:
            highest = max(highest, int(match.group(1)))
    return highest + 1


def _to_pil(image: Any, keep_alpha: bool, transparency_mask: Any = None) -> Image.Image:
    array = np.clip(image.detach().cpu().float().numpy(), 0.0, 1.0)
    if array.ndim != 3 or array.shape[-1] < 3:
        raise ValueError(f"图像必须是 HWC RGB/RGBA 格式，当前为 {tuple(array.shape)}")
    pixels = (array * 255.0 + 0.5).astype(np.uint8)
    if keep_alpha and transparency_mask is not None:
        mask = np.clip(transparency_mask.detach().cpu().float().numpy(), 0.0, 1.0)
        if mask.ndim == 3 and mask.shape[0] == 1:
            mask = mask[0]
        if mask.ndim != 2:
            raise ValueError(f"透明遮罩必须是 HW 格式，当前为 {tuple(mask.shape)}")
        if mask.shape != pixels.shape[:2]:
            mask_image = Image.fromarray((mask * 255.0 + 0.5).astype(np.uint8))
            mask = np.asarray(
                mask_image.resize((pixels.shape[1], pixels.shape[0]), Image.Resampling.BILINEAR),
                dtype=np.float32,
            ) / 255.0
        alpha = ((1.0 - mask) * 255.0 + 0.5).astype(np.uint8)
        return Image.fromarray(np.dstack((pixels[..., :3], alpha)))
    if keep_alpha and pixels.shape[-1] >= 4:
        return Image.fromarray(pixels[..., :4])
    if pixels.shape[-1] >= 4:
        alpha = pixels[..., 3:4].astype(np.float32) / 255.0
        rgb = (pixels[..., :3].astype(np.float32) * alpha + 255.0 * (1.0 - alpha) + 0.5).astype(np.uint8)
        return Image.fromarray(rgb)
    return Image.fromarray(pixels[..., :3])


def _png_metadata(prompt: Any, extra_pnginfo: Any) -> PngInfo:
    metadata = PngInfo()
    if prompt is not None:
        metadata.add_text("prompt", json.dumps(prompt, ensure_ascii=False, default=str))
    if isinstance(extra_pnginfo, dict):
        for key, value in extra_pnginfo.items():
            metadata.add_text(str(key), json.dumps(value, ensure_ascii=False, default=str))
    return metadata


def _preview_descriptor(path: Path) -> dict[str, str] | None:
    output_root = Path(folder_paths.get_output_directory()).resolve()
    try:
        relative = path.resolve().relative_to(output_root)
    except ValueError:
        return None
    return {
        "filename": relative.name,
        "subfolder": relative.parent.as_posix() if relative.parent != Path(".") else "",
        "type": "output",
    }


def _save_small_preview(image: Image.Image) -> dict[str, str]:
    temp_root = Path(folder_paths.get_temp_directory()).resolve()
    subfolder = "my-image-saver-preview"
    preview_dir = temp_root / subfolder
    preview_dir.mkdir(parents=True, exist_ok=True)
    preview = image.copy()
    preview.thumbnail((768, 768), Image.Resampling.LANCZOS)
    has_alpha = "A" in preview.getbands()
    extension = "png" if has_alpha else "jpg"
    filename = f"preview-{uuid.uuid4().hex}.{extension}"
    if has_alpha:
        preview.save(preview_dir / filename, format="PNG", compress_level=4)
    else:
        preview.convert("RGB").save(
            preview_dir / filename,
            format="JPEG",
            quality=88,
            subsampling=1,
            optimize=True,
        )
    return {"filename": filename, "subfolder": subfolder, "type": "temp"}


class MyImageSaver:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "保存格式": (["PNG", "JPG"], {"default": "JPG"}),
                "原图源名称接入点": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "tooltip": "连接图像加载节点输出的原图原名称，例如051。",
                    },
                ),
                "文件名前缀": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "tooltip": "填写后加在原图源名称前面；例如填写AI_，原图源名称为051，保存为AI_05101。留空则忽略。",
                    },
                ),
                "保存路径": (
                    "STRING",
                    {
                        "default": folder_paths.get_output_directory(),
                        "multiline": False,
                        "tooltip": "留空保存到 ComfyUI/output；支持绝对路径或 output 下的相对路径",
                    },
                ),
                "新建文件夹": (
                    ["不新建", "自定义名称", "按当天日期(MMDD)"],
                    {"default": "不新建"},
                ),
                "自定义文件夹名": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "tooltip": "选择自定义名称时作为完整文件夹名；选择按当天日期时作为日期前缀，例如填写项目A会创建项目A0820。",
                    },
                ),
                "JPG质量（95推荐；越高越清晰、文件越大）": (
                    "INT",
                    {
                        "default": 95,
                        "min": 1,
                        "max": 100,
                        "step": 1,
                        "tooltip": "推荐95。数值越高越清晰，同时文件体积越大；通常90-95即可。",
                    },
                ),
                "PNG压缩（4推荐；越高文件越小、保存越慢）": (
                    "INT",
                    {
                        "default": 4,
                        "min": 0,
                        "max": 9,
                        "step": 1,
                        "tooltip": "PNG是无损格式，压缩等级不影响画质。0最快文件最大，9最慢文件最小，推荐4。",
                    },
                ),
            },
            "optional": {
                "透明遮罩（白色透明）": (
                    "MASK",
                    {"tooltip": "可连接加载图片节点的MASK输出；白色区域保存为透明。仅PNG格式生效。"},
                ),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    RETURN_TYPES = ()
    FUNCTION = "save_images"
    OUTPUT_NODE = True
    CATEGORY = "My-Comfnode/图像"
    DESCRIPTION = "按前缀加连续两位编号保存 PNG/JPG，可指定路径并按自定义名称或当天日期新建文件夹。"

    def save_images(self, prompt=None, extra_pnginfo=None, **kwargs):
        images = kwargs["图像"]
        image_format = str(kwargs["保存格式"]).upper()
        if "原图源名称接入点" in kwargs:
            source_name = kwargs.get("原图源名称接入点", "")
            manual_prefix = kwargs.get("文件名前缀", "")
        else:
            # 兼容旧版通过接口直接提交的“文件名前缀”参数。
            source_name = kwargs.get("文件名前缀", "")
            manual_prefix = ""
        prefix = _build_filename_base(source_name, manual_prefix)
        target = _resolve_target_directory(
            kwargs["保存路径"],
            kwargs["新建文件夹"],
            kwargs["自定义文件夹名"],
        )
        extension = "png" if image_format == "PNG" else "jpg"
        saved_paths: list[Path] = []
        previews: list[dict[str, str]] = []
        transparency_masks = kwargs.get("透明遮罩（白色透明）")
        jpg_quality = int(
            kwargs.get("JPG质量（95推荐；越高越清晰、文件越大）", kwargs.get("JPG质量", 95))
        )
        png_compression = int(
            kwargs.get("PNG压缩（4推荐；越高文件越小、保存越慢）", kwargs.get("PNG压缩", 4))
        )

        with _SAVE_LOCK:
            number = _next_number(target, prefix)
            for index, image in enumerate(images):
                filename = f"{prefix}{number:02d}.{extension}"
                path = target / filename
                mask = None
                if transparency_masks is not None:
                    mask_index = min(index, max(0, len(transparency_masks) - 1))
                    mask = transparency_masks[mask_index]
                pil_image = _to_pil(
                    image,
                    keep_alpha=image_format == "PNG",
                    transparency_mask=mask,
                )
                if image_format == "PNG":
                    pil_image.save(
                        path,
                        format="PNG",
                        compress_level=png_compression,
                        pnginfo=_png_metadata(prompt, extra_pnginfo),
                    )
                else:
                    pil_image.save(
                        path,
                        format="JPEG",
                        quality=jpg_quality,
                        subsampling=0,
                        optimize=True,
                    )
                saved_paths.append(path)
                previews.append(_save_small_preview(pil_image))
                number += 1

        ui: dict[str, Any] = {"text": [str(path) for path in saved_paths]}
        if previews:
            ui["images"] = previews
        return {"ui": ui}


NODE_CLASS_MAPPINGS = {"MyComfnodeImageSaver": MyImageSaver}
NODE_DISPLAY_NAME_MAPPINGS = {"MyComfnodeImageSaver": "My图像保存"}
