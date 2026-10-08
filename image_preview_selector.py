from __future__ import annotations

import hashlib
import threading
import uuid
from typing import Any

import torch
from aiohttp import web

import comfy.model_management
import nodes
from server import PromptServer


_SELECTION_EVENT = "my-comfnode-image-preview-selector"
_SELECTION_ROUTE = "/my-comfnode/image-preview-selector/select"
_SESSIONS_ROUTE = "/my-comfnode/image-preview-selector/sessions"
_SELECTION_SESSIONS: dict[str, dict[str, Any]] = {}
_SELECTION_LOCK = threading.Lock()


def _find_session_for_selection(node_id: str, signature: str) -> tuple[str | None, dict[str, Any] | None, str | None]:
    session = _SELECTION_SESSIONS.get(node_id)
    if session is not None:
        return node_id, session, None

    signature_matches = [
        (candidate_id, candidate)
        for candidate_id, candidate in _SELECTION_SESSIONS.items()
        if not candidate["cancelled"] and candidate["signature"] == signature
    ]
    if len(signature_matches) == 1:
        return signature_matches[0][0], signature_matches[0][1], None
    if len(signature_matches) > 1:
        return None, None, "找到多个同批次等待任务，请重新执行后再选择"
    return None, None, "当前没有等待选择的任务"


@PromptServer.instance.routes.get(_SESSIONS_ROUTE)
async def list_preview_selection_sessions(request):
    with _SELECTION_LOCK:
        sessions = [
            {
                "node_id": node_id,
                "images": session["previews"],
                "selector_state": {
                    "session_id": session["session_id"],
                    "signature": session["signature"],
                    "count": session["count"],
                    "status": "waiting",
                    "selected_index": None,
                },
            }
            for node_id, session in _SELECTION_SESSIONS.items()
            if not session["cancelled"]
        ]
    return web.json_response({"sessions": sessions})


def _first(value: Any, default: Any = None) -> Any:
    if isinstance(value, list):
        return value[0] if value else default
    return default if value is None else value


def _normalize_images(value: Any) -> list[torch.Tensor]:
    pending = value if isinstance(value, list) else [value]
    images: list[torch.Tensor] = []

    for item in pending:
        if item is None:
            continue
        if isinstance(item, (list, tuple)):
            images.extend(_normalize_images(list(item)))
            continue
        if not isinstance(item, torch.Tensor):
            raise TypeError(f"不支持的图像输入类型: {type(item).__name__}")

        tensor = item
        if tensor.ndim == 3:
            tensor = tensor.unsqueeze(0)
        if tensor.ndim != 4:
            raise ValueError(f"图像张量必须是 HWC 或 BHWC，当前形状为 {tuple(tensor.shape)}")

        for index in range(int(tensor.shape[0])):
            images.append(tensor[index : index + 1])

    if not images:
        raise ValueError("图像预览选择器：没有收到可选择的图片")
    return images


def _image_signature(images: list[torch.Tensor]) -> str:
    digest = hashlib.sha256()
    digest.update(b"my-comfnode-image-preview-selector-v1")

    for image in images:
        tensor = image.detach().to(device="cpu").contiguous()
        digest.update(str(tuple(tensor.shape)).encode("ascii"))
        digest.update(str(tensor.dtype).encode("ascii"))
        digest.update(tensor.view(torch.uint8).numpy().tobytes())
    return digest.hexdigest()


@PromptServer.instance.routes.post(_SELECTION_ROUTE)
async def select_preview_image(request):
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "请求数据无效"}, status=400)

    node_id = str(payload.get("node_id", ""))
    signature = str(payload.get("signature", ""))
    session_id = str(payload.get("session_id", ""))
    selected_index = payload.get("index")

    with _SELECTION_LOCK:
        matched_node_id, session, lookup_error = _find_session_for_selection(node_id, signature)
        if session is None:
            return web.json_response({"ok": False, "error": lookup_error or "当前没有等待选择的任务"}, status=409)
        if signature != session["signature"]:
            return web.json_response({"ok": False, "error": "图片批次已经变化，请重新选择"}, status=409)
        if session_id and session_id != session["session_id"]:
            return web.json_response({"ok": False, "error": "本轮选择已经结束，请使用最新显示的图片"}, status=409)
        if not isinstance(selected_index, int) or not 0 <= selected_index < session["count"]:
            return web.json_response({"ok": False, "error": "图片索引无效"}, status=400)

        session["selected_index"] = selected_index
        session["event"].set()

    return web.json_response({"ok": True, "node_id": matched_node_id or node_id, "selected_index": selected_index})


class ImagePreviewSelector:
    _preview_cache: dict[str, tuple[str, list[dict[str, Any]]]] = {}

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "selection_payload": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "dynamicPrompts": False,
                    },
                ),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("选中图像",)
    FUNCTION = "select_image"
    CATEGORY = "My-Comfnode/图像"
    DESCRIPTION = "显示全部输入图片，选择一张并点击下一步后，仅放行该图片到下游。"
    OUTPUT_NODE = True
    INPUT_IS_LIST = True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    def _preview_images(
        self,
        images: list[torch.Tensor],
        signature: str,
        unique_id: str,
        prompt: Any,
        extra_pnginfo: Any,
    ) -> list[dict[str, Any]]:
        cached = self._preview_cache.get(unique_id)
        if cached and cached[0] == signature:
            return cached[1]

        previews: list[dict[str, Any]] = []
        preview_node = nodes.PreviewImage()
        for image in images:
            result = preview_node.save_images(
                image,
                filename_prefix=f"MyComfnodePreviewSelector/{unique_id}",
                prompt=prompt,
                extra_pnginfo=extra_pnginfo,
            )
            height = int(image.shape[1])
            width = int(image.shape[2])
            aspect_ratio = width / max(1, height)
            for preview in result.get("ui", {}).get("images", []):
                previews.append({
                    **preview,
                    "width": width,
                    "height": height,
                    "aspect_ratio": aspect_ratio,
                })

        self._preview_cache[unique_id] = (signature, previews)
        return previews

    def select_image(
        self,
        images: Any,
        selection_payload: Any,
        prompt: Any = None,
        extra_pnginfo: Any = None,
        unique_id: Any = None,
    ):
        normalized = _normalize_images(images)
        signature = _image_signature(normalized)
        node_id = str(_first(unique_id, "unknown"))
        previews = self._preview_images(
            normalized,
            signature,
            node_id,
            _first(prompt, {}),
            _first(extra_pnginfo),
        )
        session_id = uuid.uuid4().hex

        waiting_state = {
            "session_id": session_id,
            "signature": signature,
            "count": len(normalized),
            "status": "waiting",
            "selected_index": None,
        }

        event = threading.Event()
        session = {
            "session_id": session_id,
            "event": event,
            "signature": signature,
            "count": len(normalized),
            "previews": previews,
            "selected_index": None,
            "cancelled": False,
        }
        with _SELECTION_LOCK:
            previous = _SELECTION_SESSIONS.get(node_id)
            if previous is not None:
                previous["cancelled"] = True
                previous["event"].set()
            _SELECTION_SESSIONS[node_id] = session

        PromptServer.instance.send_sync(
            _SELECTION_EVENT,
            {
                "node_id": node_id,
                "images": previews,
                "selector_state": waiting_state,
            },
        )

        try:
            while not event.wait(0.1):
                comfy.model_management.throw_exception_if_processing_interrupted()

            if session["cancelled"]:
                raise comfy.model_management.InterruptProcessingException()
            selected_index = session["selected_index"]
            if not isinstance(selected_index, int):
                raise comfy.model_management.InterruptProcessingException()
        finally:
            with _SELECTION_LOCK:
                if _SELECTION_SESSIONS.get(node_id) is session:
                    _SELECTION_SESSIONS.pop(node_id, None)

        passed_state = {
            "session_id": session_id,
            "signature": signature,
            "count": len(normalized),
            "status": "passed",
            "selected_index": selected_index,
        }
        return {
            "ui": {
                "selector_images": previews,
                "selector_state": [passed_state],
            },
            "result": (normalized[selected_index],),
        }


NODE_CLASS_MAPPINGS = {
    "MyComfnodeImagePreviewSelector": ImagePreviewSelector,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MyComfnodeImagePreviewSelector": "图像预览选择器",
}
