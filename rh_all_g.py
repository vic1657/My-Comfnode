from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
import time
import uuid
from pathlib import Path
from typing import Any

import torch


def _load_shared_module():
    module = sys.modules.get("_my_comfnode_rh_big_banana")
    if module is not None:
        return module
    try:
        import _my_comfnode_rh_big_banana as imported

        return imported
    except ImportError:
        path = Path(__file__).with_name("rh_big_banana.py")
        spec = importlib.util.spec_from_file_location("_my_comfnode_rh_big_banana", path)
        if spec is None or spec.loader is None:
            raise RuntimeError("无法加载 RunningHub 公共请求模块")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module


_shared = _load_shared_module()

MODEL_PATH = "rhart-image-g-2/image-to-image"
MODEL_CHANNEL = "RH全能G"
ASPECT_RATIOS = [
    "auto",
    "1:1", "2:3", "3:2", "4:5", "5:4", "4:3", "3:4",
    "16:9", "9:16", "21:9", "9:21", "2:1", "1:2", "3:1", "1:3",
]
RESOLUTIONS = ["1k", "2k", "4k"]
_JOBS: dict[str, dict[str, Any]] = {}
_MAX_JOBS = 200


async def _run_rh_all_g(
    api_key: str,
    prompt: str,
    aspect_ratio: str,
    resolution: str,
    image_bytes: list[bytes],
):
    # Reuse the proven upload, polling, download and proxy behavior.  Only the
    # documented RH Art Image G 2 model endpoint differs from RH大香蕉.
    _shared.CHANNEL_ENDPOINTS[MODEL_CHANNEL] = MODEL_PATH
    return await _shared._run_runninghub(
        api_key,
        prompt,
        aspect_ratio,
        resolution,
        image_bytes,
        MODEL_CHANNEL,
    )


async def _run_standalone_fields(fields: dict[str, Any], image_bytes: list[bytes]) -> dict[str, Any]:
    prepared = await _shared._standalone_image_bytes(fields, image_bytes)
    image, image_url, response = await _run_rh_all_g(
        str(fields.get("API_KEY") or ""),
        str(fields.get("prompt") or ""),
        str(fields.get("aspectRatio") or "auto"),
        str(fields.get("resolution") or "2k"),
        prepared,
    )
    return {
        "image": _shared._save_result_jpeg(image, f"RH_All_G_{uuid.uuid4().hex[:8]}"),
        "image_url": image_url,
        "response": response,
    }


def _error(message: str, status: int = 500):
    if _shared.web is None:
        raise RuntimeError(message)
    return _shared.web.json_response({"ok": False, "error": message}, status=status)


def _trim_jobs() -> None:
    if len(_JOBS) < _MAX_JOBS:
        return
    completed = sorted(
        ((job_id, job) for job_id, job in _JOBS.items() if job.get("status") in {"SUCCESS", "ERROR"}),
        key=lambda item: float(item[1].get("finished_at") or 0),
    )
    for job_id, _job in completed[: max(1, len(_JOBS) - _MAX_JOBS + 1)]:
        _JOBS.pop(job_id, None)


async def _execute_job(job_id: str, fields: dict[str, Any], image_bytes: list[bytes]) -> None:
    job = _JOBS[job_id]
    job["status"] = "RUNNING"
    try:
        job["result"] = await _run_standalone_fields(fields, image_bytes)
        job["status"] = "SUCCESS"
    except Exception as exc:
        job["error"] = str(exc)
        job["status"] = "ERROR"
    finally:
        job["finished_at"] = time.monotonic()


async def start_rh_all_g(request):
    try:
        if request.content_type.startswith("multipart/"):
            fields, image_bytes = await _shared._standalone_payload_from_request(request)
        else:
            fields = await request.json()
            if not isinstance(fields, dict):
                raise ValueError("请求内容必须是 JSON 对象")
            image_bytes = []
        _trim_jobs()
        job_id = uuid.uuid4().hex
        _JOBS[job_id] = {"status": "QUEUED", "created_at": time.monotonic()}
        _JOBS[job_id]["task"] = asyncio.create_task(_execute_job(job_id, dict(fields), list(image_bytes)))
        return _shared.web.json_response({"ok": True, "job_id": job_id, "status": "QUEUED"})
    except Exception as exc:
        return _error(str(exc), 400)


async def get_rh_all_g_status(request):
    job_id = str(request.match_info.get("job_id") or "")
    job = _JOBS.get(job_id)
    if job is None:
        return _error("找不到 RH全能G 独立运行任务", 404)
    status = str(job.get("status") or "QUEUED")
    payload: dict[str, Any] = {"ok": status != "ERROR", "job_id": job_id, "status": status}
    if status == "SUCCESS":
        payload.update(job.get("result") or {})
    elif status == "ERROR":
        payload["error"] = str(job.get("error") or "RH全能G 独立运行失败")
    return _shared.web.json_response(payload)


def _register_routes() -> None:
    if _shared.web is None or _shared.PromptServer is None or getattr(_shared.PromptServer, "instance", None) is None:
        return
    routes = _shared.PromptServer.instance.routes

    @routes.post("/my-comfnode/rh-all-g/start")
    async def rh_all_g_start(request):
        return await start_rh_all_g(request)

    @routes.get("/my-comfnode/rh-all-g/status/{job_id}")
    async def rh_all_g_status(request):
        return await get_rh_all_g_status(request)


_register_routes()


class RHAllG:
    @classmethod
    def INPUT_TYPES(cls):
        optional = {"images": ("IMAGE", {"tooltip": "第1张参考图"})}
        optional.update(
            {f"image{index}": ("IMAGE", {"tooltip": f"第{index + 1}张参考图"}) for index in range(1, 10)}
        )
        return {
            "required": {
                "prompt": ("STRING", {"default": "", "multiline": True}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "control_after_generate": True}),
                "aspectRatio": (ASPECT_RATIOS, {"default": "auto"}),
                "resolution": (RESOLUTIONS, {"default": "2k"}),
                "skip_error": ("BOOLEAN", {"default": False}),
                "API_KEY": ("STRING", {"default": "", "password": True}),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("IMAGE", "STRING", "STRING")
    RETURN_NAMES = ("image", "image_url", "response")
    FUNCTION = "generate"
    OUTPUT_NODE = True
    CATEGORY = "My-Comfnode/API"
    DESCRIPTION = "RunningHub RH Art Image G 2 图生图，最多支持10张参考图。"

    async def generate(self, prompt, seed, aspectRatio, resolution, skip_error, API_KEY, **kwargs):
        del seed
        values = [kwargs.get("images")] + [kwargs.get(f"image{index}") for index in range(1, 10)]
        try:
            return await _run_rh_all_g(
                API_KEY,
                prompt,
                aspectRatio,
                resolution,
                _shared._collect_images(values),
            )
        except Exception as exc:
            if not skip_error:
                raise
            return (
                torch.zeros((1, 64, 64, 3), dtype=torch.float32),
                "",
                json.dumps({"status": "ERROR", "errorMessage": str(exc)}, ensure_ascii=False, indent=2),
            )


NODE_CLASS_MAPPINGS = {"RHAllG": RHAllG}
NODE_DISPLAY_NAME_MAPPINGS = {"RHAllG": "RH全能G"}
