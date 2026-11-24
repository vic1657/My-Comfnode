# -*- coding: utf-8 -*-
"""
MY图片批量排序（MYBatchSort）
==============================
批量拖入图片 → 按文件名自然排序（E001、E002…E010，数字位按数值比较）→
每张图一个独立 IMAGE 输出口（图1、图2…），输出原图原尺寸，不缩放不裁剪。

- 最多支持 100 张（100 个输出口）
- 未使用的输出口输出黑色占位图（不连接即可，无影响）
- 排序规则：文件名自然排序（忽略大小写，数字段按数值比较）
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any

import numpy as np
import torch
from PIL import Image, ImageOps

import folder_paths

MAX_OUTPUTS = 100


def _natural_key(name: str) -> list:
    """文件名自然排序键：E2 < E10（数字段按数值比较，其余忽略大小写）"""
    return [int(t) if t.isdigit() else t.lower()
            for t in re.split(r"(\d+)", name)]


def _parse_refs(sort_data: str) -> list[dict[str, Any]]:
    try:
        payload = json.loads(sort_data or "[]")
    except (TypeError, json.JSONDecodeError):
        return []
    if isinstance(payload, dict):
        payload = payload.get("items", [])
    if not isinstance(payload, list):
        return []
    refs = []
    for entry in payload[:MAX_OUTPUTS]:
        if not isinstance(entry, dict):
            continue
        filename = str(entry.get("filename") or "").strip().replace("\\", "/")
        if not filename:
            continue
        refs.append({
            "filename": filename,
            "subfolder": str(entry.get("subfolder") or "").strip().replace("\\", "/"),
            "type": str(entry.get("type") or "input").strip(),
            "name": str(entry.get("name") or filename).strip(),
        })
    return refs


def _resolve_input_path(ref: dict[str, Any]) -> Path:
    if ref["type"] != "input":
        raise ValueError("仅支持 ComfyUI input 目录中的图片")
    filename, subfolder = ref["filename"], ref["subfolder"]
    if os.path.isabs(filename) or os.path.isabs(subfolder):
        raise ValueError("图片引用不能使用绝对路径")
    root = Path(folder_paths.get_input_directory()).resolve()
    path = (root / subfolder / filename).resolve()
    path.relative_to(root)
    if not path.is_file():
        raise FileNotFoundError(filename)
    return path


def _load_original(path: Path) -> torch.Tensor:
    """原图原尺寸无损解码为 [1,H,W,3]，不缩放不裁剪。"""
    with Image.open(str(path)) as image_file:
        image_file.load()
        frame = ImageOps.exif_transpose(image_file)
        rgb = frame.convert("RGB")
        array = np.asarray(rgb, dtype=np.float32) / 255.0
    return torch.from_numpy(array)[None, :]


class MYBatchSort:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "sort_data": ("STRING", {"default": "[]", "multiline": True,
                                          "dynamicPrompts": False}),
            },
        }

    RETURN_TYPES = ("IMAGE",) * MAX_OUTPUTS
    RETURN_NAMES = tuple(f"图{i}" for i in range(1, MAX_OUTPUTS + 1))
    FUNCTION = "load_sorted"
    CATEGORY = "My-Comfnode/图像"
    DESCRIPTION = (
        "批量载入图片并按文件名自然排序（E001、E002…），每张图一个独立输出口，"
        "原图原尺寸输出，不缩放不裁剪。"
    )

    def load_sorted(self, sort_data: str):
        refs = _parse_refs(sort_data)
        if not refs:
            raise ValueError("MY图片批量排序：请先拖入图片")

        # 服务端兜底：按文件名自然排序（与前端一致）
        refs.sort(key=lambda r: _natural_key(Path(r["name"] or r["filename"]).name))

        tensors: list[torch.Tensor] = []
        for ref in refs:
            path = _resolve_input_path(ref)
            tensors.append(_load_original(path))

        # 未使用的输出口输出黑色占位（不连接无影响）
        placeholder = torch.zeros((1, 64, 64, 3), dtype=torch.float32)
        while len(tensors) < MAX_OUTPUTS:
            tensors.append(placeholder)

        return tuple(tensors[:MAX_OUTPUTS])

    @classmethod
    def IS_CHANGED(cls, sort_data: str, **_hidden):
        digest = hashlib.sha256()
        digest.update(b"my-batch-sort-v1")
        refs = _parse_refs(sort_data)
        digest.update(json.dumps(refs, ensure_ascii=False, sort_keys=True).encode("utf-8"))
        for ref in refs:
            try:
                path = _resolve_input_path(ref)
                stat = path.stat()
                digest.update(f"{stat.st_size}:{stat.st_mtime_ns}".encode("utf-8"))
            except OSError:
                digest.update(b"missing")
        return digest.hexdigest()

    @classmethod
    def VALIDATE_INPUTS(cls, sort_data: str):
        refs = _parse_refs(sort_data)
        if not refs:
            return "MY图片批量排序：请先拖入图片"
        for ref in refs:
            try:
                path = _resolve_input_path(ref)
            except ValueError as exc:
                return str(exc)
            if not path.is_file():
                return f"找不到图片: {ref['filename']}"
        return True


NODE_CLASS_MAPPINGS = {
    "MYBatchSort": MYBatchSort,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MYBatchSort": "MY图片批量排序",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
