from __future__ import annotations

import asyncio
import io
import json
import os
import subprocess
import time
import uuid
from typing import Any
from urllib.parse import urljoin

import aiohttp
import numpy as np
import torch
from PIL import Image, ImageOps

try:
    from aiohttp import web
except Exception:
    web = None

try:
    import folder_paths
except Exception:
    folder_paths = None

try:
    from server import PromptServer
except Exception:
    PromptServer = None


BASE_ENDPOINT = "https://www.runninghub.ai/openapi/v2"
CHANNEL_ENDPOINTS = {
    "官方稳定版": "rhart-image-n-g31-flash-official/image-to-image",
    "低价渠道": "rhart-image-n-g31-flash/image-to-image",
    "Third-party": "rhart-image-n-g31-flash/image-to-image",
}
QUERY_ENDPOINT = "https://www.runninghub.ai/openapi/v2/query"
UPLOAD_ENDPOINT = "https://www.runninghub.ai/openapi/v2/media/upload/binary"
ACCOUNT_ENDPOINT = "https://www.runninghub.ai/uc/openapi/accountStatus"
ASPECT_RATIOS = [
    "auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3",
    "5:4", "4:5", "21:9", "1:4", "4:1", "1:8", "8:1",
]
RESOLUTIONS = ["1k", "2k", "4k"]
SUCCESS_STATES = {"SUCCESS", "SUCCEEDED", "COMPLETED", "DONE"}
FAILED_STATES = {"FAILED", "FAIL", "ERROR", "CANCELLED", "CANCELED"}
_PROXY_CACHE: str | None | object = object()
_STANDALONE_JOBS: dict[str, dict[str, Any]] = {}
_MAX_STANDALONE_JOBS = 200


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
                "[Uri]'https://www.runninghub.ai').AbsoluteUri"
            )
            result = subprocess.run(
                ["powershell", "-NoProfile", "-Command", command],
                capture_output=True,
                text=True,
                timeout=5,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            value = result.stdout.strip()
            if value and value != "https://www.runninghub.ai/":
                _PROXY_CACHE = value
                return value
        except Exception:
            pass
    _PROXY_CACHE = None
    return None


def _tensor_to_jpeg(tensor: torch.Tensor) -> bytes:
    if tensor.ndim != 3 or tensor.shape[-1] < 3:
        raise ValueError(f"图片必须是 HWC RGB 格式，当前为 {tuple(tensor.shape)}")
    array = np.clip(tensor.detach().cpu().float().numpy()[..., :3], 0.0, 1.0)
    rgb = (array * 255.0 + 0.5).astype(np.uint8)
    buffer = io.BytesIO()
    Image.fromarray(rgb).save(buffer, "JPEG", quality=95, subsampling=0, optimize=True)
    return buffer.getvalue()


def _image_bytes_to_jpeg(content: bytes) -> bytes:
    with Image.open(io.BytesIO(content)) as opened:
        rgb = opened.convert("RGB")
    buffer = io.BytesIO()
    rgb.save(buffer, "JPEG", quality=95, subsampling=0, optimize=True)
    return buffer.getvalue()


def _image_ref_to_jpeg(reference: dict[str, Any], max_size: int = 0, scale_mode: bool = True) -> bytes:
    if folder_paths is None:
        raise RuntimeError("ComfyUI folder_paths 不可用，无法读取图片引用")
    if not isinstance(reference, dict):
        raise ValueError("图片引用格式无效")
    filename = str(reference.get("filename") or "").strip().replace("\\", "/")
    subfolder = str(reference.get("subfolder") or "").strip().replace("\\", "/")
    image_type = str(reference.get("type") or "input").strip()
    if not filename or image_type != "input":
        raise ValueError("批量直连仅支持 ComfyUI input 目录图片")
    if os.path.isabs(filename) or os.path.isabs(subfolder):
        raise ValueError("图片引用不能使用绝对路径")

    root = os.path.realpath(folder_paths.get_input_directory())
    path = os.path.realpath(os.path.join(root, subfolder, filename))
    if os.path.commonpath([root, path]) != root or not os.path.isfile(path):
        raise ValueError(f"找不到输入图片：{filename}")

    with Image.open(path) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")
        size = max(0, int(max_size or 0))
        if size:
            basis = max(image.size) if scale_mode else min(image.size)
            scale = min(1.0, size / max(1, basis))
            if scale < 1.0:
                target = (
                    max(1, round(image.width * scale)),
                    max(1, round(image.height * scale)),
                )
                image = image.resize(target, Image.Resampling.LANCZOS)
        buffer = io.BytesIO()
        image.save(buffer, "JPEG", quality=95, subsampling=0, optimize=True)
        return buffer.getvalue()


def _tensor_to_pil(tensor: torch.Tensor) -> Image.Image:
    if tensor.ndim == 4:
        tensor = tensor[0]
    if tensor.ndim != 3 or tensor.shape[-1] < 3:
        raise ValueError(f"图片必须是 HWC/BHWC RGB 格式，当前为 {tuple(tensor.shape)}")
    array = np.clip(tensor.detach().cpu().float().numpy()[..., :3], 0.0, 1.0)
    rgb = (array * 255.0 + 0.5).astype(np.uint8)
    return Image.fromarray(rgb)


def _save_result_jpeg(image: torch.Tensor, filename_prefix: str = "RH_Big_Banana") -> dict[str, str]:
    if folder_paths is None:
        raise RuntimeError("ComfyUI folder_paths 不可用，无法保存独立运行结果")
    pil_image = _tensor_to_pil(image)
    output_dir = folder_paths.get_output_directory()
    full_output_folder, filename, counter, subfolder, _filename_prefix = (
        folder_paths.get_save_image_path(
            filename_prefix,
            output_dir,
            pil_image.width,
            pil_image.height,
        )
    )
    os.makedirs(full_output_folder, exist_ok=True)
    file = f"{filename}_{counter:05}_.jpg"
    path = os.path.join(full_output_folder, file)
    pil_image.save(path, "JPEG", quality=92, subsampling=1, optimize=True)
    return {"filename": file, "subfolder": subfolder, "type": "output"}


def _iter_image_tensors(value: Any):
    if value is None:
        return
    if isinstance(value, torch.Tensor):
        yield value
        return
    if isinstance(value, (list, tuple)):
        for item in value:
            yield from _iter_image_tensors(item)
        return
    raise TypeError(f"图片输入必须是 IMAGE 张量或图片列表，当前为 {type(value).__name__}")


def _collect_images(values: list[Any]) -> list[bytes]:
    images: list[bytes] = []
    for tensor in values:
        for tensor in _iter_image_tensors(tensor):
            if not isinstance(tensor, torch.Tensor):
                raise TypeError("图片输入必须是 ComfyUI IMAGE")
            if tensor.ndim == 3:
                tensor = tensor.unsqueeze(0)
            if tensor.ndim != 4:
                raise ValueError(f"图片输入必须是 BHWC 格式，当前为 {tuple(tensor.shape)}")
            for item in tensor:
                images.append(_tensor_to_jpeg(item))
                if len(images) == 10:
                    return images
    return images


async def _read_json(response: aiohttp.ClientResponse) -> dict[str, Any]:
    text = await response.text(encoding="utf-8", errors="replace")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"RunningHub 返回的不是 JSON（HTTP {response.status}）") from exc
    if response.status >= 400:
        message = data.get("errorMessage") or data.get("message") or text[:500]
        raise RuntimeError(f"RunningHub 请求失败（HTTP {response.status}）：{message}")
    if not isinstance(data, dict):
        raise RuntimeError("RunningHub 返回格式无效")
    return data


def _api_error(data: dict[str, Any], fallback: str) -> str:
    message = data.get("errorMessage") or data.get("message") or data.get("msg")
    failed = data.get("failedReason")
    if message:
        return str(message)
    if failed:
        return json.dumps(failed, ensure_ascii=False, default=str)
    code = data.get("code") or data.get("errorCode")
    if code:
        return f"{fallback}（错误码：{code}）"
    return fallback


async def _check_standard_api_access(
    session: aiohttp.ClientSession,
    api_key: str,
    proxy: str | None,
) -> None:
    try:
        async with session.post(
            ACCOUNT_ENDPOINT,
            json={"apiKey": api_key},
            proxy=proxy,
        ) as response:
            data = await _read_json(response)
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError):
        return

    account = data.get("data") if isinstance(data.get("data"), dict) else {}
    api_type = str(account.get("apiType") or "").strip().upper()
    if api_type == "NORMAL":
        raise RuntimeError(
            "当前 API_KEY 是普通 Key（NORMAL），不能调用 RunningHub 标准模型 API。"
            "该接口仅支持企业级-共享 API Key；请在 RunningHub 全球站获取企业级-共享 Key后重新填写。"
        )


async def _upload_image(
    session: aiohttp.ClientSession,
    content: bytes,
    index: int,
    proxy: str | None,
    request_id: str,
) -> str:
    data = None
    last_error = None
    for attempt in range(4):
        form = aiohttp.FormData()
        form.add_field(
            "file",
            content,
            filename=f"rh_reference_{request_id}_{index:02d}.jpg",
            content_type="image/jpeg",
        )
        try:
            async with session.post(UPLOAD_ENDPOINT, data=form, proxy=proxy) as response:
                data = await _read_json(response)
            break
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as exc:
            last_error = exc
            if attempt == 3:
                raise RuntimeError(f"RunningHub 图片上传网络重试失败：{exc}") from exc
            await asyncio.sleep(2 ** attempt)
    if data is None:
        raise RuntimeError(f"RunningHub 图片上传失败：{last_error}")
    if data.get("code") not in (None, 0, "0"):
        raise RuntimeError(_api_error(data, "RunningHub 图片上传失败"))
    uploaded = data.get("data") if isinstance(data.get("data"), dict) else {}
    url = uploaded.get("download_url") or uploaded.get("downloadUrl") or uploaded.get("url")
    if not url:
        raise RuntimeError("RunningHub 图片上传成功，但没有返回图片 URL")
    return urljoin(UPLOAD_ENDPOINT, str(url))


def _result_urls(data: dict[str, Any]) -> list[str]:
    results = data.get("results")
    if not isinstance(results, list):
        return []
    urls = []
    for result in results:
        if not isinstance(result, dict):
            continue
        url = result.get("url")
        output_type = str(result.get("outputType") or "").lower()
        if url and (not output_type or output_type in {"png", "jpg", "jpeg", "webp"}):
            urls.append(str(url))
    return urls


async def _download_tensor(
    session: aiohttp.ClientSession,
    url: str,
    proxy: str | None,
) -> torch.Tensor:
    content = None
    for attempt in range(4):
        try:
            async with session.get(
                url, proxy=proxy, timeout=aiohttp.ClientTimeout(total=180)
            ) as response:
                response.raise_for_status()
                content = await response.read()
            break
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as exc:
            if attempt == 3:
                raise RuntimeError(f"RunningHub 结果图片下载失败：{exc}") from exc
            await asyncio.sleep(2 ** attempt)
    if content is None:
        raise RuntimeError("RunningHub 结果图片下载失败")
    with Image.open(io.BytesIO(content)) as opened:
        rgb = np.asarray(opened.convert("RGB"), dtype=np.float32) / 255.0
    return torch.from_numpy(rgb).unsqueeze(0)


async def _run_runninghub(
    api_key: str,
    prompt: str,
    aspect_ratio: str,
    resolution: str,
    image_bytes: list[bytes],
    channel: str = "官方稳定版",
) -> tuple[torch.Tensor, str, str]:
    api_key = (api_key or "").strip()
    prompt = (prompt or "").strip()
    if not api_key:
        raise ValueError("API_KEY 不能为空")
    if not prompt:
        raise ValueError("prompt 不能为空")
    if not image_bytes:
        raise ValueError("至少连接一张输入图片")
    endpoint_path = CHANNEL_ENDPOINTS.get(channel, CHANNEL_ENDPOINTS["官方稳定版"])
    generate_endpoint = f"{BASE_ENDPOINT}/{endpoint_path}"

    headers = {"Authorization": f"Bearer {api_key}"}
    request_id = uuid.uuid4().hex
    proxy = _system_proxy()
    timeout = aiohttp.ClientTimeout(total=180)
    async with aiohttp.ClientSession(headers=headers, timeout=timeout) as session:
        await _check_standard_api_access(session, api_key, proxy)
        image_urls = []
        for index, content in enumerate(image_bytes, start=1):
            image_urls.append(await _upload_image(session, content, index, proxy, request_id))

        payload: dict[str, Any] = {
            "imageUrls": image_urls,
            "prompt": prompt,
            "resolution": resolution,
        }
        if aspect_ratio != "auto":
            payload["aspectRatio"] = aspect_ratio

        submitted = None
        for attempt in range(4):
            try:
                async with session.post(
                    generate_endpoint,
                    json=payload,
                    proxy=proxy,
                ) as response:
                    submitted = await _read_json(response)
                break
            except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as exc:
                if attempt == 3:
                    raise RuntimeError(f"RunningHub 任务提交网络重试失败：{exc}") from exc
                await asyncio.sleep(2 ** attempt)
        if submitted is None:
            raise RuntimeError("RunningHub 任务提交失败")

        task_id = str(submitted.get("taskId") or "")
        status = str(submitted.get("status") or "").upper()
        if not task_id:
            raise RuntimeError(_api_error(submitted, "RunningHub 未返回任务 ID"))

        final_data = submitted
        deadline = time.monotonic() + 1200
        while status not in SUCCESS_STATES:
            if status in FAILED_STATES:
                raise RuntimeError(_api_error(final_data, f"RunningHub 任务失败：{status}"))
            if time.monotonic() >= deadline:
                raise TimeoutError(f"RunningHub 任务超时，任务 ID：{task_id}")
            await asyncio.sleep(2)
            query_data = None
            for attempt in range(4):
                try:
                    async with session.post(
                        QUERY_ENDPOINT,
                        json={"taskId": task_id},
                        proxy=proxy,
                    ) as response:
                        query_data = await _read_json(response)
                    break
                except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as exc:
                    if attempt == 3:
                        raise RuntimeError(f"RunningHub 任务查询网络重试失败：{exc}") from exc
                    await asyncio.sleep(2 ** attempt)
            if query_data is None:
                raise RuntimeError("RunningHub 任务查询失败")
            final_data = query_data
            status = str(final_data.get("status") or status).upper()

        urls = _result_urls(final_data)
        if not urls:
            raise RuntimeError("RunningHub 任务成功，但结果中没有图片 URL")
        image = await _download_tensor(session, urls[0], proxy)
        response_text = json.dumps(final_data, ensure_ascii=False, indent=2, default=str)
        return image, urls[0], response_text


def _standalone_error_response(message: str, status: int = 500):
    if web is None:
        raise RuntimeError(message)
    return web.json_response({"ok": False, "error": message}, status=status)


async def _standalone_payload_from_request(request) -> tuple[dict[str, Any], list[bytes]]:
    image_bytes: list[bytes] = []
    if request.content_type.startswith("multipart/"):
        reader = await request.multipart()
        fields: dict[str, Any] = {}
        while True:
            field = await reader.next()
            if field is None:
                break
            if field.filename:
                content = await field.read(decode=False)
                if content:
                    image_bytes.append(_image_bytes_to_jpeg(content))
                    if len(image_bytes) == 10:
                        break
            else:
                fields[field.name] = await field.text()
        return fields, image_bytes

    data = await request.json()
    references = data.get("image_refs") or []
    if references:
        if not isinstance(references, list):
            raise ValueError("image_refs 必须是数组")
        max_size = int(data.get("max_size") or 0)
        scale_mode = bool(data.get("scale_mode", True))
        tasks = [
            asyncio.to_thread(_image_ref_to_jpeg, reference, max_size, scale_mode)
            for reference in references[:10]
        ]
        image_bytes.extend(await asyncio.gather(*tasks))
        return data, image_bytes

    images = data.get("images") or []
    if not isinstance(images, list):
        raise ValueError("images 必须是数组")
    for item in images[:10]:
        if not isinstance(item, str):
            continue
        raw = item.split(",", 1)[1] if "," in item else item
        import base64

        image_bytes.append(_image_bytes_to_jpeg(base64.b64decode(raw)))
    return data, image_bytes


async def _standalone_image_bytes(fields: dict[str, Any], image_bytes: list[bytes]) -> list[bytes]:
    if image_bytes:
        return image_bytes

    references = fields.get("image_refs") or []
    if references:
        if not isinstance(references, list):
            raise ValueError("image_refs 必须是数组")
        max_size = int(fields.get("max_size") or 0)
        scale_mode = bool(fields.get("scale_mode", True))
        tasks = [
            asyncio.to_thread(_image_ref_to_jpeg, reference, max_size, scale_mode)
            for reference in references[:10]
        ]
        return list(await asyncio.gather(*tasks))

    images = fields.get("images") or []
    if not isinstance(images, list):
        raise ValueError("images 必须是数组")
    decoded: list[bytes] = []
    for item in images[:10]:
        if not isinstance(item, str):
            continue
        raw = item.split(",", 1)[1] if "," in item else item
        import base64

        decoded.append(_image_bytes_to_jpeg(base64.b64decode(raw)))
    return decoded


async def _run_standalone_fields(fields: dict[str, Any], image_bytes: list[bytes]) -> dict[str, Any]:
    prepared = await _standalone_image_bytes(fields, image_bytes)
    image, image_url, response_text = await _run_runninghub(
        str(fields.get("API_KEY") or ""),
        str(fields.get("prompt") or ""),
        str(fields.get("aspectRatio") or "auto"),
        str(fields.get("resolution") or "4k"),
        prepared,
        str(fields.get("channel") or "官方稳定版"),
    )
    descriptor = _save_result_jpeg(image, f"RH_Big_Banana_{uuid.uuid4().hex[:8]}")
    return {
        "image": descriptor,
        "image_url": image_url,
        "response": response_text,
    }


async def run_rh_big_banana_standalone(request):
    try:
        fields, image_bytes = await _standalone_payload_from_request(request)
        result = await _run_standalone_fields(fields, image_bytes)
        return web.json_response({"ok": True, **result})
    except Exception as exc:
        return _standalone_error_response(str(exc))


def _trim_standalone_jobs() -> None:
    if len(_STANDALONE_JOBS) < _MAX_STANDALONE_JOBS:
        return
    finished = sorted(
        (
            (job_id, job)
            for job_id, job in _STANDALONE_JOBS.items()
            if job.get("status") in {"SUCCESS", "ERROR"}
        ),
        key=lambda item: float(item[1].get("finished_at") or 0),
    )
    for job_id, _job in finished[: max(1, len(_STANDALONE_JOBS) - _MAX_STANDALONE_JOBS + 1)]:
        _STANDALONE_JOBS.pop(job_id, None)


async def _execute_standalone_job(
    job_id: str,
    fields: dict[str, Any],
    image_bytes: list[bytes],
) -> None:
    job = _STANDALONE_JOBS[job_id]
    job["status"] = "RUNNING"
    try:
        job["result"] = await _run_standalone_fields(fields, image_bytes)
        job["status"] = "SUCCESS"
    except Exception as exc:
        job["error"] = str(exc)
        job["status"] = "ERROR"
    finally:
        job["finished_at"] = time.monotonic()


def _start_standalone_job(fields: dict[str, Any], image_bytes: list[bytes]) -> str:
    _trim_standalone_jobs()
    job_id = uuid.uuid4().hex
    _STANDALONE_JOBS[job_id] = {
        "status": "QUEUED",
        "created_at": time.monotonic(),
    }
    task = asyncio.create_task(_execute_standalone_job(job_id, dict(fields), list(image_bytes)))
    _STANDALONE_JOBS[job_id]["task"] = task
    return job_id


async def start_rh_big_banana_standalone(request):
    try:
        if request.content_type.startswith("multipart/"):
            fields, image_bytes = await _standalone_payload_from_request(request)
        else:
            fields = await request.json()
            if not isinstance(fields, dict):
                raise ValueError("请求内容必须是 JSON 对象")
            image_bytes = []
        job_id = _start_standalone_job(fields, image_bytes)
        return web.json_response({"ok": True, "job_id": job_id, "status": "QUEUED"})
    except Exception as exc:
        return _standalone_error_response(str(exc), 400)


async def get_rh_big_banana_standalone_job(request):
    job_id = str(request.match_info.get("job_id") or "")
    job = _STANDALONE_JOBS.get(job_id)
    if job is None:
        return _standalone_error_response("找不到独立运行任务", 404)
    status = str(job.get("status") or "QUEUED")
    payload: dict[str, Any] = {"ok": status != "ERROR", "job_id": job_id, "status": status}
    if status == "SUCCESS":
        payload.update(job.get("result") or {})
    elif status == "ERROR":
        payload["error"] = str(job.get("error") or "独立运行失败")
    return web.json_response(payload)


def _register_routes() -> None:
    if web is None or PromptServer is None or getattr(PromptServer, "instance", None) is None:
        return
    routes = PromptServer.instance.routes

    @routes.post("/my-comfnode/rh-big-banana/run")
    async def rh_big_banana_run(request):
        return await run_rh_big_banana_standalone(request)

    @routes.post("/my-comfnode/rh-big-banana/start")
    async def rh_big_banana_start(request):
        return await start_rh_big_banana_standalone(request)

    @routes.get("/my-comfnode/rh-big-banana/status/{job_id}")
    async def rh_big_banana_status(request):
        return await get_rh_big_banana_standalone_job(request)


_register_routes()


class RHBigBanana:
    @classmethod
    def INPUT_TYPES(cls):
        optional = {"images": ("IMAGE", {"tooltip": "第1张参考图"})}
        optional.update(
            {f"image{index}": ("IMAGE", {"tooltip": f"第{index + 1}张参考图"}) for index in range(1, 10)}
        )
        return {
            "required": {
                "prompt": ("STRING", {"default": "", "multiline": True}),
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                    },
                ),
                "aspectRatio": (ASPECT_RATIOS, {"default": "auto"}),
                "resolution": (RESOLUTIONS, {"default": "4k"}),
                "skip_error": ("BOOLEAN", {"default": False}),
                "channel": (["官方稳定版", "低价渠道"], {"default": "官方稳定版"}),
                "API_KEY": ("STRING", {"default": "", "password": True}),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("IMAGE", "STRING", "STRING")
    RETURN_NAMES = ("image", "image_url", "response")
    FUNCTION = "generate"
    OUTPUT_NODE = True
    CATEGORY = "My-Comfnode/API"
    DESCRIPTION = "RunningHub RH Art Image N Gemini 3.1 Flash 图生图，最多支持10张参考图。"

    async def generate(
        self,
        prompt,
        seed,
        aspectRatio,
        resolution,
        skip_error,
        channel,
        API_KEY,
        **kwargs,
    ):
        del seed
        values = [kwargs.get("images")] + [kwargs.get(f"image{index}") for index in range(1, 10)]
        try:
            image_bytes = _collect_images(values)
            return await _run_runninghub(
                API_KEY,
                prompt,
                aspectRatio,
                resolution,
                image_bytes,
                channel,
            )
        except Exception as exc:
            if not skip_error:
                raise
            fallback = torch.zeros((1, 64, 64, 3), dtype=torch.float32)
            response = json.dumps(
                {"status": "ERROR", "errorMessage": str(exc)},
                ensure_ascii=False,
                indent=2,
            )
            return fallback, "", response


NODE_CLASS_MAPPINGS = {"RHBigBanana": RHBigBanana}
NODE_DISPLAY_NAME_MAPPINGS = {"RHBigBanana": "RH大香蕉"}
