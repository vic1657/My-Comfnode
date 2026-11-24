# -*- coding: utf-8 -*-
"""
MY逐张队列（MYSequentialQueue）
================================
逐张执行：点一次运行 → 第1张走完整条工作流（含保存）→ 服务端自动把第2张
塞回执行队列 → 再走完整条工作流 → …… → 全部跑完自动停止。

- 服务端自动续队：不依赖浏览器事件，100% 可靠
- 每张图都是独立的一次完整工作流执行（真·逐张）
- 原图、原尺寸、不压缩、不裁剪
"""

from __future__ import annotations

import copy
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

import numpy as np
import torch
from PIL import Image, ImageOps

import folder_paths

try:
    from server import PromptServer
    import nodes as comfy_nodes
except Exception:  # 非 ComfyUI 环境（本地语法检查等）
    PromptServer = None
    comfy_nodes = None


def _output_node_ids(prompt: dict) -> list[str]:
    """找出工作流中的输出节点（OUTPUT_NODE 标记，如 SaveImage/PreviewImage）。
    引擎语义：outputs_to_execute=[] = 什么都不执行；正常排队时该值为
    validate_prompt 返回的输出节点ID列表。这里按同一规则计算。"""
    ids = []
    for node_id, node_data in prompt.items():
        if not isinstance(node_data, dict):
            continue
        cls = comfy_nodes.NODE_CLASS_MAPPINGS.get(node_data.get("class_type")) \
            if comfy_nodes else None
        if cls is not None and getattr(cls, "OUTPUT_NODE", False):
            ids.append(node_id)
    return ids


def _checked_items(queue_data: str) -> list[dict[str, Any]]:
    """解析前端传来的队列 JSON，只保留勾选且有效的条目（保持排序）。"""
    try:
        payload = json.loads(queue_data or "[]")
    except (TypeError, json.JSONDecodeError):
        return []
    if isinstance(payload, dict):
        payload = payload.get("items", [])
    if not isinstance(payload, list):
        return []

    items: list[dict[str, Any]] = []
    for entry in payload:
        if not isinstance(entry, dict):
            continue
        if entry.get("checked") is not True:
            continue
        filename = str(entry.get("filename") or "").strip().replace("\\", "/")
        if not filename:
            continue
        items.append(
            {
                "filename": filename,
                "subfolder": str(entry.get("subfolder") or "").strip().replace("\\", "/"),
                "type": str(entry.get("type") or "input").strip(),
                "name": str(entry.get("name") or filename).strip(),
            }
        )
    return items


def _resolve_input_path(item: dict[str, Any]) -> Path:
    """校验并解析 input 目录内路径（拒绝越界与绝对路径）。"""
    if item["type"] != "input":
        raise ValueError("仅支持 ComfyUI input 目录中的图片")
    filename, subfolder = item["filename"], item["subfolder"]
    if os.path.isabs(filename) or os.path.isabs(subfolder):
        raise ValueError("图片引用不能使用绝对路径")
    input_root = Path(folder_paths.get_input_directory()).resolve()
    candidate = (input_root / subfolder / filename).resolve()
    try:
        candidate.relative_to(input_root)
    except ValueError as exc:
        raise ValueError("图片路径超出了 ComfyUI input 目录") from exc
    return candidate


def _load_image_original(path: Path) -> torch.Tensor:
    """原图原尺寸无损解码为 [1,H,W,3] 张量，不做任何缩放/裁剪。"""
    with Image.open(str(path)) as image_file:
        image_file.load()
        frame = ImageOps.exif_transpose(image_file)  # 仅按EXIF摆正方向
        rgb = frame.convert("RGB")
        array = np.asarray(rgb, dtype=np.float32) / 255.0
    return torch.from_numpy(array)[None, :]


def _requeue_next(prompt: dict | None, unique_id: str | None,
                  extra_data: dict | None, next_index: int) -> bool:
    """服务端自动续队：把 run_index+1 的 prompt 副本塞回执行队列。
    返回是否成功。当前这张处理完后，队列中的下一张自动开始执行。"""
    server = getattr(PromptServer, "instance", None) if PromptServer else None
    if server is None or prompt is None or unique_id is None:
        return False
    if unique_id not in prompt or not hasattr(server, "prompt_queue"):
        return False
    try:
        new_prompt = copy.deepcopy(prompt)
        new_prompt[unique_id]["inputs"]["run_index"] = next_index
        new_extra = copy.deepcopy(extra_data) if extra_data else {}
        new_extra["create_time"] = int(time.time() * 1000)
        output_ids = _output_node_ids(new_prompt)
        if not output_ids:
            print("[MY逐张队列] 工作流中没有输出节点，无法续队")
            return False
        new_id = str(uuid.uuid4())
        # 队列条目格式（见 server.py post_prompt）：
        # (number, prompt_id, prompt, extra_data, outputs_to_execute, sensitive)
        # outputs_to_execute = 输出节点ID列表（[] 表示什么都不执行！）
        server.prompt_queue.put(
            (0, new_id, new_prompt, new_extra, output_ids, {}))
        return True
        return True
    except Exception as exc:
        print(f"[MY逐张队列] 自动续队失败: {exc}")
        return False


class MYSequentialQueue:
    """MY逐张队列：每次执行输出当前那一单张，服务端自动续队实现逐张跑完整工作流。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "queue_data": (
                    "STRING",
                    {"default": "[]", "multiline": True, "dynamicPrompts": False},
                ),
                "run_index": (
                    "INT",
                    {"default": 0, "min": 0, "max": 100000},
                ),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_data": "EXTRA_DATA",
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("图片", "原文件名")
    FUNCTION = "load_at_index"
    CATEGORY = "My-Comfnode/图像"
    DESCRIPTION = (
        "逐张执行：每张图独立跑一遍完整工作流（含保存），处理完一张自动接下一张，"
        "全部完成自动停止。原图原尺寸，不压缩不裁剪。"
    )

    def load_at_index(self, queue_data: str, run_index: int = 0,
                      prompt: dict | None = None,
                      extra_data: dict | None = None,
                      unique_id: str | None = None):
        items = _checked_items(queue_data)
        if not items:
            raise ValueError("MY逐张队列：没有勾选任何图片，请先勾选要处理的图片")

        index = max(0, min(int(run_index), len(items) - 1))
        item = items[index]

        path = _resolve_input_path(item)
        if not path.is_file():
            raise FileNotFoundError(f"找不到图片: {item['filename']}")
        image = _load_image_original(path)

        # 逐张核心：当前张处理完，自动把下一张塞回执行队列
        chained = False
        if index + 1 < len(items):
            chained = _requeue_next(prompt, unique_id, extra_data, index + 1)

        original_name = Path(item["name"]).stem or item["filename"]
        print(f"[MY逐张队列] 第 {index + 1}/{len(items)} 张: {original_name}"
              + ("（已自动排队下一张）" if chained else "（最后一张）"))
        # 原文件名输出：建议接到保存节点的 filename_prefix 输入上，
        # 避免时间戳命名在同一秒内互相覆盖
        return (image, original_name)

    @classmethod
    def IS_CHANGED(cls, queue_data: str, run_index: int = 0, **_hidden):
        # 每次排队都强制执行（逐张队列每次运行都是新的处理）
        return float("nan")

    @classmethod
    def VALIDATE_INPUTS(cls, queue_data: str, run_index: int = 0):
        items = _checked_items(queue_data)
        if not items:
            return "MY逐张队列：请先拖入图片并勾选要处理的图片"
        for item in items:
            try:
                path = _resolve_input_path(item)
            except ValueError as exc:
                return str(exc)
            if not path.is_file():
                return f"找不到图片: {item['filename']}"
        return True


NODE_CLASS_MAPPINGS = {
    "MYSequentialQueue": MYSequentialQueue,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MYSequentialQueue": "MY逐张队列",
}


def _register_thumbnail_route():
    """注册缩略图接口：/my_queue_thumb
    界面只加载小缩略图（最长边256px, JPEG），避免几十张大原图把浏览器卡死。
    实际执行时仍解码原尺寸文件，输出不受影响。缩略图按文件内容缓存。"""
    server = getattr(PromptServer, "instance", None)
    if server is None or not hasattr(server, "routes"):
        return
    from aiohttp import web

    async def my_queue_thumb(request):
        try:
            query = request.rel_url.query
            filename = str(query.get("filename", "")).replace("\\", "/")
            subfolder = str(query.get("subfolder", "")).strip().replace("\\", "/")
            if os.path.isabs(filename) or os.path.isabs(subfolder):
                return web.Response(status=400, text="bad path")
            input_root = Path(folder_paths.get_input_directory()).resolve()
            src = (input_root / subfolder / filename).resolve()
            src.relative_to(input_root)
            if not src.is_file():
                return web.Response(status=404, text="not found")

            import hashlib
            stat = src.stat()
            key = hashlib.sha1(
                f"{src}|{stat.st_mtime_ns}|{stat.st_size}".encode()).hexdigest()[:24]
            temp_root = Path(folder_paths.get_temp_directory())
            thumb_dir = temp_root / "my_queue_thumbs"
            thumb_dir.mkdir(parents=True, exist_ok=True)
            thumb = thumb_dir / f"{key}.jpg"
            if not thumb.is_file():
                with Image.open(str(src)) as image_file:
                    frame = ImageOps.exif_transpose(image_file)
                    frame.thumbnail((256, 256))
                    frame.convert("RGB").save(thumb, "JPEG", quality=82)
            resp = web.FileResponse(thumb)
            resp.headers["Cache-Control"] = "public, max-age=86400"
            return resp
        except Exception as exc:
            return web.Response(status=500, text=str(exc))

    server.routes.get("/my_queue_thumb")(my_queue_thumb)


_register_thumbnail_route()

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
