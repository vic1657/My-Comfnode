from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import subprocess
import time
from typing import Any
from urllib.parse import quote, urlparse

import aiohttp
import numpy as np
import torch
from PIL import Image


DEFAULT_ENDPOINT = "https://api.apimart.ai/v1/images/generations"
DEFAULT_MODEL = "gemini-3.1-flash-image-preview"
RESOLUTIONS = ["默认", "0.5K", "1K", "2K", "4K"]
ASPECT_RATIOS = [
    "自动", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16",
    "5:4", "4:5", "21:9", "1:4", "4:1", "1:8", "8:1",
]
SUCCESS_STATES = {"success", "succeeded", "succeed", "completed", "complete", "done", "finished"}
FAILED_STATES = {"failed", "fail", "error", "cancelled", "canceled"}
RUNNING_STATES = {"submitted", "queued", "pending", "running", "processing", "in_progress", "generating"}
_PROXY_CACHE: str | None | object = object()


def _system_proxy() -> str | None:
    global _PROXY_CACHE
    if _PROXY_CACHE.__class__ is not object:
        return _PROXY_CACHE  # type: ignore[return-value]
    for name in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"):
        value = os.environ.get(name, "").strip()
        if value:
            _PROXY_CACHE = value
            return value
    if os.name == "nt":
        try:
            command = (
                "[System.Net.WebRequest]::DefaultWebProxy.GetProxy("
                "[Uri]'https://api.apimart.ai').AbsoluteUri"
            )
            result = subprocess.run(
                ["powershell", "-NoProfile", "-Command", command],
                capture_output=True,
                text=True,
                timeout=5,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            value = result.stdout.strip()
            if value and value != "https://api.apimart.ai/":
                _PROXY_CACHE = value
                return value
        except Exception:
            pass
    _PROXY_CACHE = None
    return None


def _normalize_endpoint(value: str) -> str:
    endpoint = (value or DEFAULT_ENDPOINT).strip()
    parsed = urlparse(endpoint)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("调用网址必须是完整的 http:// 或 https:// 地址")
    return endpoint.rstrip("/")


def _task_query_urls(endpoint: str, task_id: str) -> list[str]:
    parsed = urlparse(endpoint)
    path = parsed.path.rstrip("/")
    if path.endswith("/images/generations"):
        base_path = path[: -len("/images/generations")]
    elif path.endswith("/images/generation"):
        base_path = path[: -len("/images/generation")]
    else:
        base_path = path.rsplit("/", 1)[0]
    root = f"{parsed.scheme}://{parsed.netloc}{base_path}"
    encoded = quote(str(task_id), safe="")
    return [f"{root}/tasks/{encoded}", f"{root}/tasks/status?task_id={encoded}"]


def _first_container(data: Any):
    if isinstance(data, list):
        return data[0] if data else None
    return data


def _extract_task_id(data: Any) -> str:
    if not isinstance(data, dict):
        return ""
    for container in (data, data.get("data"), data.get("output"), data.get("result")):
        container = _first_container(container)
        if isinstance(container, dict):
            value = container.get("task_id") or container.get("taskId") or container.get("id")
            if value:
                return str(value)
    return ""


def _extract_status(data: Any) -> str:
    if not isinstance(data, dict):
        return ""
    for container in (data, data.get("data"), data.get("output"), data.get("result")):
        container = _first_container(container)
        if isinstance(container, dict):
            value = (
                container.get("task_status")
                or container.get("status")
                or container.get("state")
                or container.get("taskStatus")
            )
            if value:
                return str(value).strip().lower()
    return ""


def _safe_error_message(data: Any, fallback: str) -> str:
    if isinstance(data, dict):
        error = data.get("error")
        if isinstance(error, dict):
            value = error.get("message") or error.get("detail")
            if value:
                return str(value)
        for key in ("message", "msg", "detail", "error_message", "fail_reason"):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return fallback


def _collect_image_sources(data: Any) -> list[str]:
    found: list[str] = []
    preferred = {
        "url", "image_url", "image_urls", "images", "output_images", "output_imgs",
        "img_url", "result_url", "results", "b64_json", "image_base64",
    }

    def add(value: Any, key: str = "") -> None:
        if isinstance(value, str):
            text = value.strip()
            if not text:
                return
            if text.lower().startswith(("http://", "https://", "data:image/")):
                found.append(text)
            elif "base64" in key.lower() or key.lower() in {"b64_json", "b64", "image_base64"}:
                found.append(f"data:image/png;base64,{text}")
            return
        if isinstance(value, list):
            for item in value:
                add(item, key)
            return
        if not isinstance(value, dict):
            return
        for child_key, child in value.items():
            if str(child_key).lower() in preferred:
                add(child, str(child_key))
        for child_key, child in value.items():
            if str(child_key).lower() not in preferred and isinstance(child, (dict, list)):
                add(child, str(child_key))

    add(data)
    return list(dict.fromkeys(found))


def _tensor_images_to_data_uris(images: list[torch.Tensor | None]) -> list[str]:
    result: list[str] = []
    for tensor in images:
        if tensor is None:
            continue
        if not isinstance(tensor, torch.Tensor):
            raise TypeError("图像输入必须是 ComfyUI IMAGE 张量")
        if tensor.ndim == 3:
            tensor = tensor.unsqueeze(0)
        if tensor.ndim != 4 or tensor.shape[-1] < 3:
            raise ValueError(f"图像输入必须是 BHWC 格式，当前为 {tuple(tensor.shape)}")
        for item in tensor:
            array = np.clip(item.detach().cpu().float().numpy()[..., :3], 0.0, 1.0)
            rgb = (array * 255.0 + 0.5).astype(np.uint8)
            buffer = io.BytesIO()
            Image.fromarray(rgb).save(
                buffer, "JPEG", quality=95, subsampling=0, optimize=True
            )
            encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
            result.append(f"data:image/jpeg;base64,{encoded}")
            if len(result) >= 14:
                return result
    return result


def _decode_image_bytes(data: bytes) -> torch.Tensor:
    with Image.open(io.BytesIO(data)) as opened:
        rgb = np.asarray(opened.convert("RGB"), dtype=np.float32) / 255.0
    return torch.from_numpy(rgb).unsqueeze(0)


async def _read_json(response: aiohttp.ClientResponse) -> dict[str, Any]:
    text = await response.text(encoding="utf-8", errors="replace")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"接口返回的不是 JSON（HTTP {response.status}）") from exc
    if response.status >= 400:
        raise RuntimeError(_safe_error_message(data, f"接口请求失败（HTTP {response.status}）"))
    if not isinstance(data, dict):
        raise RuntimeError("接口返回格式无效")
    return data


async def _detect_endpoint_exit_ip(endpoint: str, proxy: str | None) -> str:
    if not proxy:
        return ""
    parsed = urlparse(endpoint)
    trace_url = f"{parsed.scheme}://{parsed.netloc}/cdn-cgi/trace"
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as session:
            async with session.get(trace_url, proxy=proxy) as response:
                if response.status >= 400:
                    return ""
                text = await response.text(encoding="utf-8", errors="replace")
        for line in text.splitlines():
            if line.startswith("ip="):
                return line.split("=", 1)[1].strip()
    except Exception:
        return ""
    return ""


async def _download_image(
    session: aiohttp.ClientSession, source: str, api_key: str, proxy: str | None
) -> bytes:
    if source.startswith("data:image/"):
        if "," not in source:
            raise RuntimeError("Base64图片格式无效")
        return base64.b64decode(source.split(",", 1)[1], validate=False)
    async with session.get(
        source, proxy=proxy, timeout=aiohttp.ClientTimeout(total=180)
    ) as response:
        if response.status not in {401, 403}:
            response.raise_for_status()
            return await response.read()
    async with session.get(
        source,
        headers={"Authorization": f"Bearer {api_key}"},
        proxy=proxy,
        timeout=aiohttp.ClientTimeout(total=180),
    ) as response:
        response.raise_for_status()
        return await response.read()


async def _generate_image(
    endpoint: str,
    api_key: str,
    prompt: str,
    aspect_ratio: str,
    resolution: str,
    model: str,
    image_urls: list[str],
) -> tuple[torch.Tensor, str, str]:
    endpoint = _normalize_endpoint(endpoint)
    api_key = (api_key or "").strip()
    prompt = (prompt or "").strip()
    if not api_key:
        raise ValueError("API KEY 不能为空")
    if not prompt:
        raise ValueError("提示词不能为空")

    payload: dict[str, Any] = {
        "model": (model or DEFAULT_MODEL).strip() or DEFAULT_MODEL,
        "prompt": prompt,
        "size": "auto" if aspect_ratio == "自动" else aspect_ratio,
        "n": 1,
    }
    if resolution != "默认":
        payload["resolution"] = resolution
    if image_urls:
        payload["image_urls"] = image_urls[:14]

    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    proxy = _system_proxy()
    async with aiohttp.ClientSession(
        headers=headers, timeout=aiohttp.ClientTimeout(total=180)
    ) as session:
        async with session.post(endpoint, json=payload, proxy=proxy) as response:
            try:
                response_data = await _read_json(response)
            except RuntimeError as exc:
                message = str(exc)
                if "not in the allowed list" in message.lower():
                    exit_ip = await _detect_endpoint_exit_ip(endpoint, proxy)
                    if exit_ip:
                        raise RuntimeError(
                            f"API Key 的IP白名单不包含当前实际出口IP：{exit_ip}。"
                            "请把这个地址加入APIMart白名单，或在FlClash中固定代理线路。"
                        ) from exc
                raise
        sources = _collect_image_sources(response_data)
        task_id = _extract_task_id(response_data)
        final_status = _extract_status(response_data) or "submitted"

        if not sources and task_id:
            query_urls = _task_query_urls(endpoint, task_id)
            active_url = query_urls[0]
            deadline = time.monotonic() + 900
            while time.monotonic() < deadline:
                query_data = None
                last_error = ""
                for query_url in query_urls:
                    try:
                        async with session.get(
                            query_url,
                            proxy=proxy,
                            timeout=aiohttp.ClientTimeout(total=60),
                        ) as response:
                            query_data = await _read_json(response)
                        active_url = query_url
                        break
                    except Exception as exc:
                        last_error = str(exc)
                if query_data is None:
                    raise RuntimeError(f"任务查询失败：{last_error}")
                sources = _collect_image_sources(query_data)
                final_status = _extract_status(query_data) or final_status
                if sources:
                    break
                if final_status in FAILED_STATES:
                    raise RuntimeError(
                        _safe_error_message(query_data, f"生成失败，状态：{final_status}")
                    )
                await asyncio.sleep(2.0)
                query_urls = [active_url] + [url for url in query_urls if url != active_url]
            if not sources:
                raise TimeoutError(f"生成超时，任务ID：{task_id}")

        if not sources:
            raise RuntimeError("接口没有返回生成图片")
        image_bytes = await _download_image(session, sources[0], api_key, proxy)
        return _decode_image_bytes(image_bytes), final_status or "success", task_id


class MyNanoBanana2API:
    @classmethod
    def INPUT_TYPES(cls):
        optional = {
            f"图像{index}": ("IMAGE", {"tooltip": f"第{index}张参考图，最多支持14张"})
            for index in range(1, 15)
        }
        return {
            "required": {
                "调用网址": ("STRING", {"default": DEFAULT_ENDPOINT}),
                "API_KEY": ("STRING", {"default": "", "password": True}),
                "提示词": ("STRING", {"default": "", "multiline": True}),
                "尺寸": (ASPECT_RATIOS, {"default": "自动"}),
                "分辨率": (RESOLUTIONS, {"default": "默认"}),
                "模型": ("STRING", {"default": DEFAULT_MODEL}),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("IMAGE", "STRING", "STRING")
    RETURN_NAMES = ("生成图片", "任务状态", "任务ID")
    FUNCTION = "generate"
    OUTPUT_NODE = True
    CATEGORY = "My-Comfnode/API"
    DESCRIPTION = "Nano banana2 API 标准工作流节点，支持1到14张参考图与最高4K输出。"

    async def generate(self, 调用网址, API_KEY, 提示词, 尺寸, 分辨率, 模型, **kwargs):
        images = [kwargs.get(f"图像{index}") for index in range(1, 15)]
        image_urls = _tensor_images_to_data_uris(images)
        return await _generate_image(
            调用网址,
            API_KEY,
            提示词,
            尺寸,
            分辨率,
            模型,
            image_urls,
        )


NODE_CLASS_MAPPINGS = {"MyNanoBanana2API": MyNanoBanana2API}
NODE_DISPLAY_NAME_MAPPINGS = {"MyNanoBanana2API": "Nano banana2 API"}
