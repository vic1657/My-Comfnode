from __future__ import annotations

import asyncio
import io
import json
import mimetypes
import os
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import aiohttp
import numpy as np
import torch
from PIL import Image

import folder_paths
from comfy_api.input_impl import VideoFromFile


BASE_URL = "https://www.runninghub.cn/openapi/v2"
SUBMIT_URL = f"{BASE_URL}/bytedance/dreamactor-v2"
QUERY_URL = f"{BASE_URL}/query"
UPLOAD_URL = f"{BASE_URL}/media/upload/binary"
SUCCESS_STATES = {"SUCCESS", "SUCCEEDED", "COMPLETED", "DONE"}
FAILED_STATES = {"FAILED", "FAIL", "ERROR", "CANCELLED", "CANCELED"}


def _proxy() -> str | None:
    for name in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"):
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return None


async def _json_response(response: aiohttp.ClientResponse) -> dict[str, Any]:
    body = await response.text(encoding="utf-8", errors="replace")
    try:
        data = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"RunningHub 返回的不是 JSON（HTTP {response.status}）") from exc
    if response.status >= 400:
        message = data.get("errorMessage") or data.get("message") or body[:500]
        raise RuntimeError(f"RunningHub 请求失败（HTTP {response.status}）：{message}")
    if not isinstance(data, dict):
        raise RuntimeError("RunningHub 返回格式无效")
    return data


def _api_error(data: dict[str, Any], fallback: str) -> str:
    failed = data.get("failedReason")
    if isinstance(failed, (dict, list)):
        failed = json.dumps(failed, ensure_ascii=False)
    return str(data.get("errorMessage") or data.get("message") or failed or fallback)


def _image_bytes(image: torch.Tensor) -> bytes:
    if not isinstance(image, torch.Tensor):
        raise ValueError("角色图片必须是 IMAGE 输入")
    if image.ndim == 4:
        if image.shape[0] < 1:
            raise ValueError("角色图片批次为空")
        image = image[0]
    if image.ndim != 3 or image.shape[-1] < 3:
        raise ValueError("角色图片必须是 HWC/BHWC RGB 格式")
    array = np.clip(image.detach().cpu().float().numpy()[..., :3], 0.0, 1.0)
    output = io.BytesIO()
    Image.fromarray((array * 255.0 + 0.5).astype(np.uint8), "RGB").save(output, "PNG", optimize=True)
    content = output.getvalue()
    if len(content) > 5 * 1024 * 1024:
        raise ValueError("角色图片超过 RunningHub 的 5 MB 限制")
    return content


def _video_bytes(video: Any) -> tuple[bytes, str]:
    if not hasattr(video, "get_stream_source"):
        raise ValueError("驱动视频必须连接到 VIDEO 输入")
    source = video.get_stream_source()
    if isinstance(source, (str, os.PathLike)):
        path = Path(source)
        if not path.is_file():
            raise FileNotFoundError(f"找不到驱动视频：{path}")
        return path.read_bytes(), path.suffix.lower() or ".mp4"
    if hasattr(source, "getvalue"):
        source.seek(0)
        return source.getvalue(), ".mp4"
    if hasattr(video, "save_to"):
        temporary = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
        temporary_path = Path(temporary.name)
        temporary.close()
        try:
            video.save_to(str(temporary_path))
            return temporary_path.read_bytes(), ".mp4"
        finally:
            temporary_path.unlink(missing_ok=True)
    raise ValueError("当前 VIDEO 输入无法读取文件内容")


async def _upload(session: aiohttp.ClientSession, content: bytes, filename: str, content_type: str, proxy: str | None) -> str:
    form = aiohttp.FormData()
    form.add_field("file", content, filename=filename, content_type=content_type)
    async with session.post(UPLOAD_URL, data=form, proxy=proxy) as response:
        data = await _json_response(response)
    if data.get("code") not in (None, 0, "0"):
        raise RuntimeError(_api_error(data, "RunningHub 文件上传失败"))
    uploaded = data.get("data") if isinstance(data.get("data"), dict) else {}
    url = uploaded.get("download_url") or uploaded.get("downloadUrl") or uploaded.get("url")
    if not url:
        raise RuntimeError("RunningHub 上传成功但没有返回文件 URL")
    value = str(url)
    if value.startswith(("http://", "https://")):
        return value
    return urljoin("https://www.runninghub.cn/", value.lstrip("/"))


def _result_video(data: dict[str, Any]) -> tuple[str, str] | None:
    results = data.get("results")
    if not isinstance(results, list):
        return None
    for result in results:
        if not isinstance(result, dict) or not result.get("url"):
            continue
        output_type = str(result.get("outputType") or "").lower()
        if output_type in {"mp4", "mov", "webm", "mkv", "video"} or not output_type:
            extension = output_type if output_type in {"mp4", "mov", "webm", "mkv"} else "mp4"
            return str(result["url"]), extension
    return None


async def _download(session: aiohttp.ClientSession, url: str, proxy: str | None) -> bytes:
    async with session.get(url, proxy=proxy, timeout=aiohttp.ClientTimeout(total=600)) as response:
        if response.status >= 400:
            raise RuntimeError(f"RunningHub 结果视频下载失败（HTTP {response.status}）")
        return await response.read()


async def _run(api_key: str, image: torch.Tensor, video: Any, timeout_seconds: int = 1800) -> tuple[Path, dict[str, Any]]:
    image_content = _image_bytes(image)
    video_content, suffix = _video_bytes(video)
    if len(video_content) > 100 * 1024 * 1024:
        raise ValueError("驱动视频超过 RunningHub 的 100 MB 限制")
    proxy = _proxy()
    headers = {"Authorization": f"Bearer {api_key}"}
    timeout = aiohttp.ClientTimeout(total=600)
    async with aiohttp.ClientSession(headers=headers, timeout=timeout) as session:
        image_url = await _upload(session, image_content, f"dream_actor_{uuid.uuid4().hex}.png", "image/png", proxy)
        video_ext = suffix if suffix in {".mp4", ".mov", ".webm", ".mkv", ".avi", ".flv", ".m4v"} else ".mp4"
        video_url = await _upload(session, video_content, f"dream_actor_{uuid.uuid4().hex}{video_ext}", mimetypes.guess_type(video_ext)[0] or "video/mp4", proxy)
        async with session.post(SUBMIT_URL, json={"imageUrl": image_url, "videoUrl": video_url}, proxy=proxy) as response:
            submitted = await _json_response(response)
        task_id = str(submitted.get("taskId") or "")
        if not task_id:
            raise RuntimeError(_api_error(submitted, "RunningHub 未返回任务 ID"))
        status = str(submitted.get("status") or "").upper()
        final = submitted
        deadline = time.monotonic() + max(60, int(timeout_seconds))
        while status not in SUCCESS_STATES:
            if status in FAILED_STATES:
                raise RuntimeError(_api_error(final, f"RunningHub 梦梦老师动作模仿任务失败：{status}"))
            if time.monotonic() >= deadline:
                raise TimeoutError(f"RunningHub 任务超时，任务 ID：{task_id}")
            await asyncio.sleep(3)
            async with session.post(QUERY_URL, json={"taskId": task_id}, proxy=proxy) as response:
                final = await _json_response(response)
            status = str(final.get("status") or status).upper()
        result = _result_video(final)
        if not result:
            raise RuntimeError("RunningHub 任务成功但没有返回视频 URL")
        result_url, output_extension = result
        content = await _download(session, result_url, proxy)
    output_dir = Path(folder_paths.get_output_directory()) / "dream_actor_v2"
    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / f"dream_actor_v2_{uuid.uuid4().hex[:10]}.{output_extension}"
    target.write_bytes(content)
    return target, final


class DreamActorV2:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "角色图片": ("IMAGE",),
                "驱动视频": ("VIDEO", {"forceInput": True}),
                "API_KEY": ("STRING", {"default": os.environ.get("RUNNINGHUB_API_KEY", ""), "password": True}),
            },
            "optional": {
                "超时秒数": ("INT", {"default": 1800, "min": 60, "max": 7200}),
            },
        }

    RETURN_TYPES = ("VIDEO", "STRING")
    RETURN_NAMES = ("视频", "任务响应")
    FUNCTION = "generate"
    CATEGORY = "My-Comfnode/API"
    DESCRIPTION = "RunningHub 梦梦老师动作模仿 2.0：使用角色图片和驱动视频生成动作模仿视频。"

    async def generate(self, 角色图片, 驱动视频, API_KEY, 超时秒数=1800):
        key = (API_KEY or os.environ.get("RUNNINGHUB_API_KEY", "")).strip()
        if not key:
            raise ValueError("请填写 RunningHub API_KEY，或设置 RUNNINGHUB_API_KEY 环境变量")
        target, response = await _run(key, 角色图片, 驱动视频, int(超时秒数))
        return (VideoFromFile(str(target)), json.dumps(response, ensure_ascii=False, indent=2))


NODE_CLASS_MAPPINGS = {"DreamActorV2": DreamActorV2}
NODE_DISPLAY_NAME_MAPPINGS = {"DreamActorV2": "梦梦老师动作模仿2.0"}
