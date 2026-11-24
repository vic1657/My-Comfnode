from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

import numpy as np
import torch
from PIL import Image, ImageOps, ImageSequence

import comfy.model_management
import folder_paths
import node_helpers


def _parse_entries(image_data: str) -> list[dict[str, Any]]:
    try:
        payload = json.loads(image_data or "[]")
    except (TypeError, json.JSONDecodeError):
        return []

    if isinstance(payload, dict):
        payload = payload.get("images", [])
    if not isinstance(payload, list):
        return []

    entries: list[dict[str, Any]] = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        filename = str(item.get("filename") or item.get("name") or "").strip()
        if not filename:
            continue
        entries.append(
            {
                "filename": filename.replace("\\", "/"),
                "subfolder": str(item.get("subfolder") or "").strip().replace("\\", "/"),
                "type": str(item.get("type") or "input").strip(),
                "selected": item.get("selected") is True,
                "original_name": str(
                    item.get("original_name") or item.get("originalName") or filename
                ).strip(),
            }
        )
    return entries


def _active_entries(image_data: str) -> list[dict[str, Any]]:
    entries = _parse_entries(image_data)
    selected = [entry for entry in entries if entry["selected"]]
    return selected or entries


def _original_name(entry: dict[str, Any]) -> str:
    return Path(
        str(entry.get("original_name") or entry.get("filename") or "").replace("\\", "/")
    ).stem


def _resolve_input_path(entry: dict[str, Any]) -> Path:
    if entry["type"] != "input":
        raise ValueError("仅支持 ComfyUI input 目录中的图片")

    filename = entry["filename"]
    subfolder = entry["subfolder"]
    if os.path.isabs(filename) or os.path.isabs(subfolder):
        raise ValueError("图片引用不能使用绝对路径")

    input_root = Path(folder_paths.get_input_directory()).resolve()
    candidate = (input_root / subfolder / filename).resolve()
    try:
        candidate.relative_to(input_root)
    except ValueError as exc:
        raise ValueError("图片路径超出了 ComfyUI input 目录") from exc
    return candidate


def _load_image(path: Path) -> torch.Tensor:
    image_file = node_helpers.pillow(Image.open, str(path))
    frames = []
    width = height = None
    dtype = comfy.model_management.intermediate_dtype()

    try:
        for frame in ImageSequence.Iterator(image_file):
            frame = node_helpers.pillow(ImageOps.exif_transpose, frame)
            if frame.mode == "I":
                frame = frame.point(lambda value: value * (1 / 255))
            rgb = frame.convert("RGB")

            if width is None:
                width, height = rgb.size
            elif rgb.size != (width, height):
                continue

            array = np.asarray(rgb).astype(np.float32) / 255.0
            frames.append(torch.from_numpy(array)[None,].to(dtype=dtype))

            if image_file.format == "MPO":
                break
    finally:
        image_file.close()

    if not frames:
        raise ValueError(f"图片中没有可读取的画面: {path.name}")
    return torch.cat(frames, dim=0) if len(frames) > 1 else frames[0]


def _single_frame(image: torch.Tensor) -> torch.Tensor:
    if image.ndim == 4 and image.shape[0] > 1:
        return image[:1]
    return image


def _as_original_size_batch(images: list[torch.Tensor]) -> torch.Tensor | list[torch.Tensor]:
    frames = [frame for image in images for frame in image]
    first_shape = tuple(frames[0].shape)
    if all(tuple(frame.shape) == first_shape for frame in frames[1:]):
        return torch.stack(frames, dim=0)
    return frames


class BatchImageLoader:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_data": (
                    "STRING",
                    {
                        "default": "[]",
                        "multiline": True,
                        "dynamicPrompts": False,
                    },
                ),
            },
            "hidden": {
                "prompt": "PROMPT",
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "IMAGE", "STRING")
    RETURN_NAMES = ("原尺寸列表", "单次批次", "逐张单图", "原图原名称")
    OUTPUT_IS_LIST = (True, False, False, False)
    FUNCTION = "load_images"
    CATEGORY = "My-Comfnode/图像"
    DESCRIPTION = "保留原尺寸列表与单次批次两种输出，新增逐张单图口，适合按图片逐个排队执行。"

    def load_images(
        self,
        image_data: str,
        batch_mode: bool = True,
        prompt: dict[str, Any] | None = None,
        unique_id: str | None = None,
    ):
        entries = _active_entries(image_data)
        if not entries:
            raise ValueError("图像批量加载：请先拖入或上传至少一张图片")

        images = []
        errors = []
        for entry in entries:
            try:
                path = _resolve_input_path(entry)
                if not path.is_file():
                    raise FileNotFoundError(path)
                images.append(_load_image(path))
            except Exception as exc:
                errors.append(f"{entry['filename']}: {exc}")

        if errors:
            raise ValueError("图像批量加载失败：" + "；".join(errors))

        batch_output = _as_original_size_batch(images)
        single_output = _single_frame(images[0])
        return (images, batch_output, single_output, _original_name(entries[0]))

    @classmethod
    def IS_CHANGED(cls, image_data: str, batch_mode: bool = True, **_hidden_inputs):
        digest = hashlib.sha256()
        entries = _active_entries(image_data)
        digest.update(b"dual-mode-plus-single-v1")
        digest.update(json.dumps(entries, ensure_ascii=False, sort_keys=True).encode("utf-8"))
        for entry in entries:
            try:
                path = _resolve_input_path(entry)
                with path.open("rb") as handle:
                    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                        digest.update(chunk)
            except OSError:
                digest.update(b"missing")
        return digest.hexdigest()

    @classmethod
    def VALIDATE_INPUTS(cls, image_data: str, batch_mode: bool = True):
        entries = _active_entries(image_data)
        if not entries:
            return "请先拖入或上传至少一张图片"
        for entry in entries:
            try:
                path = _resolve_input_path(entry)
            except ValueError as exc:
                return str(exc)
            if not path.is_file():
                return f"找不到图片: {entry['filename']}"
        return True


NODE_CLASS_MAPPINGS = {
    "MyComfnodeBatchImageLoader": BatchImageLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MyComfnodeBatchImageLoader": "图像批量加载",
}
