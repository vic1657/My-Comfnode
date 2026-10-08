# -*- coding: utf-8 -*-
"""
RH大香蕉并发（RHBananaConcurrent）
===================================
批量并发提交 RunningHub 图生图任务：
- 最多 100 组，每组 图片1 + 图片2 + 提示词（共 200 张图）
- 界面只显示 256px 缩略图；实际提交用原图（长边不超过 2048）
- 复用 RH大香蕉 的 RunningHub API 链路（上传/提交/轮询/下载）
- "开始"按钮走独立后台任务，不占用 ComfyUI 队列
- 也支持正常排队执行（结果图按列表逐张输出）
"""

from __future__ import annotations

import asyncio
import copy
import json
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any

import torch
from PIL import Image, ImageOps

import folder_paths

# ---- 复用已加载的 rh_big_banana 模块（RunningHub API 链路）----
_rh = sys.modules.get("_my_comfnode_rh_big_banana")
if _rh is None:
    import importlib.util
    _rh_path = os.path.join(os.path.dirname(__file__), "rh_big_banana.py")
    if os.path.isfile(_rh_path):
        _spec = importlib.util.spec_from_file_location(
            "_my_comfnode_rh_big_banana", _rh_path)
        _rh = importlib.util.module_from_spec(_spec)
        sys.modules["_my_comfnode_rh_big_banana"] = _rh
        _spec.loader.exec_module(_rh)

try:
    from server import PromptServer
except Exception:
    PromptServer = None

try:
    from aiohttp import web
except Exception:
    web = None

MAX_GROUPS = 100
MAX_LONG_EDGE = 2048
SUBFOLDER = "rh_concurrent"
JOBS: dict[str, dict[str, Any]] = {}
MAX_JOBS = 30


def _input_file_path(reference: dict[str, Any]) -> Path:
    filename = str(reference.get("filename") or "").replace("\\", "/")
    subfolder = str(reference.get("subfolder") or "").replace("\\", "/")
    if not filename:
        raise ValueError("图片引用为空")
    root = Path(folder_paths.get_input_directory()).resolve()
    path = (root / subfolder / filename).resolve()
    path.relative_to(root)
    if not path.is_file():
        raise FileNotFoundError(filename)
    return path


def _load_group_image(reference: dict[str, Any]) -> bytes:
    """读取原图：长边超过 2048 才等比缩小，否则按原样（仅转JPEG上传格式）。"""
    return _rh._image_ref_to_jpeg(reference, MAX_LONG_EDGE, True)


def _groups_from_payload(raw: Any) -> list[dict[str, Any]]:
    """解析分组：只保留填了图片的组（有多少有效组就并发多少次），空组直接跳过。"""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw or "[]")
        except json.JSONDecodeError:
            return []
    if not isinstance(raw, list):
        return []
    groups = []
    for i in range(min(len(raw), MAX_GROUPS)):
        entry = raw[i] if isinstance(raw[i], dict) else {}
        image1 = entry.get("image1") if isinstance(entry.get("image1"), dict) else None
        image2 = entry.get("image2") if isinstance(entry.get("image2"), dict) else None
        if not image1 and not image2:
            continue  # 空组：不参与提交
        groups.append({
            "image1": image1,
            "image2": image2,
            "prompt": str(entry.get("prompt") or ""),
        })
    return groups


# ---- 独立后台任务 ----
def _trim_jobs() -> None:
    if len(JOBS) < MAX_JOBS:
        return
    finished = sorted(
        ((jid, j) for jid, j in JOBS.items() if j.get("status") in {"SUCCESS", "ERROR"}),
        key=lambda kv: float(kv[1].get("finished_at") or 0),
    )
    for jid, _j in finished[: max(1, len(JOBS) - MAX_JOBS + 1)]:
        JOBS.pop(jid, None)


async def _run_one_group(
    session,
    api_key: str,
    channel: str,
    aspect_ratio: str,
    resolution: str,
    index: int,
    group: dict[str, Any],
    max_long_edge: int,
    proxy: str | None,
) -> dict[str, Any]:
    refs = [r for r in (group.get("image1"), group.get("image2")) if r]
    if not refs:
        raise ValueError("该组没有图片")
    prompt = (group.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("该组没有提示词")
    image_bytes = [
        await asyncio.to_thread(_rh._image_ref_to_jpeg, ref, max_long_edge, True)
        for ref in refs
    ]
    image, image_url, response_text = await _rh._run_runninghub(
        api_key, prompt, aspect_ratio, resolution, image_bytes, channel)
    descriptor = _rh._save_result_jpeg(
        image, f"RH_Concurrent_{uuid.uuid4().hex[:6]}_{index + 1:03d}")
    return {
        "index": index,
        "status": "SUCCESS",
        "image": descriptor,
        "image_url": image_url,
        "response": response_text,
    }


async def _execute_batch(job_id: str) -> None:
    job = JOBS[job_id]
    job["status"] = "RUNNING"
    results: dict[str, dict[str, Any]] = {}
    job["results"] = results
    semaphore = asyncio.Semaphore(job["concurrency"])
    proxy = _rh._system_proxy()
    timeout = getattr(_rh.aiohttp, "ClientTimeout")(total=None)
    headers = {"Authorization": f"Bearer {job['api_key']}"}

    async def one(index: int, group: dict[str, Any]) -> None:
        async with semaphore:
            try:
                async with _rh.aiohttp.ClientSession(
                        headers=headers, timeout=timeout) as session:
                    result = await _run_one_group(
                        session, job["api_key"], job["channel"],
                        job["aspect_ratio"], job["resolution"],
                        index, group, job["max_long_edge"], proxy)
                results[str(index)] = result
            except Exception as exc:
                results[str(index)] = {
                    "index": index,
                    "status": "ERROR",
                    "error": str(exc),
                }
            finally:
                job["done"] = sum(1 for r in results.values()
                                  if r.get("status") in {"SUCCESS", "ERROR"})

    try:
        tasks = [asyncio.create_task(one(i, g))
                 for i, g in enumerate(job["groups"])]
        await asyncio.gather(*tasks)
        failed = [r for r in results.values() if r.get("status") == "ERROR"]
        job["status"] = "SUCCESS" if (job["skip_error"] or not failed) else "ERROR"
        if failed and not job["skip_error"]:
            job["error"] = "；".join(
                f"第{f['index'] + 1}组: {f.get('error')}" for f in failed[:5])
    except Exception as exc:
        job["status"] = "ERROR"
        job["error"] = str(exc)
    finally:
        job["finished_at"] = time.monotonic()


def _start_batch_job(payload: dict[str, Any]) -> str:
    _trim_jobs()
    job_id = uuid.uuid4().hex
    groups = _groups_from_payload(payload.get("groups"))
    if not groups:
        raise ValueError("没有可提交的分组（至少需要一组图片+提示词）")
    JOBS[job_id] = {
        "status": "QUEUED",
        "created_at": time.monotonic(),
        "api_key": str(payload.get("API_KEY") or "").strip(),
        "channel": str(payload.get("channel") or "官方稳定版"),
        "aspect_ratio": str(payload.get("aspectRatio") or "auto"),
        "resolution": str(payload.get("resolution") or "4k"),
        "skip_error": payload.get("skip_error") is True,
        "concurrency": max(1, min(100, int(payload.get("concurrency") or 5))),
        "max_long_edge": max(256, min(8192, int(payload.get("max_long_edge") or 2048))),
        "groups": groups,
        "total": len(groups),
        "done": 0,
        "results": {},
    }
    JOBS[job_id]["task"] = asyncio.create_task(_execute_batch(job_id))
    return job_id


def _register_routes() -> None:
    server = getattr(PromptServer, "instance", None)
    if web is None or server is None or not hasattr(server, "routes"):
        return
    routes = server.routes

    @routes.post("/my-comfnode/rh-banana-concurrent/start")
    async def rh_concurrent_start(request):
        try:
            payload = await request.json()
            if not isinstance(payload, dict):
                raise ValueError("请求内容必须是 JSON 对象")
            job_id = _start_batch_job(payload)
            return web.json_response({"ok": True, "job_id": job_id,
                                       "status": "QUEUED",
                                       "total": JOBS[job_id]["total"]})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)

    @routes.get("/my-comfnode/rh-banana-concurrent/status/{job_id}")
    async def rh_concurrent_status(request):
        job_id = str(request.match_info.get("job_id") or "")
        job = JOBS.get(job_id)
        if job is None:
            return web.json_response({"ok": False, "error": "找不到任务"}, status=404)
        payload = {
            "ok": job.get("status") != "ERROR",
            "job_id": job_id,
            "status": job.get("status"),
            "total": job.get("total"),
            "done": job.get("done"),
        }
        if job.get("status") in {"SUCCESS", "ERROR"}:
            payload["results"] = job.get("results", {})
            if job.get("error"):
                payload["error"] = job["error"]
        return web.json_response(payload)

    @routes.get("/my-comfnode/rh-banana-concurrent/thumb")
    async def rh_concurrent_thumb(request):
        try:
            query = request.rel_url.query
            filename = str(query.get("filename", "")).replace("\\", "/")
            subfolder = str(query.get("subfolder", "")).replace("\\", "/")
            root = Path(folder_paths.get_input_directory()).resolve()
            src = (root / subfolder / filename).resolve()
            src.relative_to(root)
            if not src.is_file():
                return web.Response(status=404, text="not found")
            stat = src.stat()
            key = __import__("hashlib").sha1(
                f"{src}|{stat.st_mtime_ns}|{stat.st_size}".encode()).hexdigest()[:24]
            thumb_dir = Path(folder_paths.get_temp_directory()) / "rh_concurrent_thumbs"
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


_register_routes()


class RHBananaConcurrent:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "group_data": ("STRING", {"default": "[]", "multiline": True,
                                           "dynamicPrompts": False}),
                "concurrency": ("INT", {"default": 5, "min": 1, "max": 100,
                                         "tooltip": "同时提交的任务数"}),
                "aspectRatio": (["auto", "1:1", "16:9", "9:16", "4:3", "3:4",
                                  "3:2", "2:3", "5:4", "4:5", "21:9", "1:4",
                                  "4:1", "1:8", "8:1"], {"default": "auto"}),
                "resolution": (["1k", "2k", "4k"], {"default": "4k"}),
                "skip_error": ("BOOLEAN", {"default": False}),
                "channel": (["官方稳定版", "低价渠道"], {"default": "官方稳定版"}),
                "API_KEY": ("STRING", {"default": "", "password": True}),
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("结果图", "response")
    OUTPUT_IS_LIST = (True, False)
    FUNCTION = "generate"
    OUTPUT_NODE = True
    CATEGORY = "My-Comfnode/API"
    DESCRIPTION = "批量并发提交 RunningHub 图生图任务：最多100组（每组2图+提示词），界面显示缩略图，提交原图（长边≤2048）。"

    async def generate(self, group_data, concurrency, aspectRatio,
                       resolution, skip_error, channel, API_KEY):
        groups = _groups_from_payload(group_data)
        if not groups:
            raise ValueError("RH大香蕉并发：没有可提交的分组")
        results: dict[int, dict[str, Any]] = {}
        semaphore = asyncio.Semaphore(max(1, min(100, int(concurrency))))
        proxy = _rh._system_proxy()
        headers = {"Authorization": f"Bearer {str(API_KEY).strip()}"}
        timeout = _rh.aiohttp.ClientTimeout(total=None)

        async def one(index: int, group: dict[str, Any]):
            async with semaphore:
                try:
                    refs = [r for r in (group.get("image1"), group.get("image2")) if r]
                    if not refs:
                        raise ValueError("该组没有图片")
                    prompt = (group.get("prompt") or "").strip()
                    if not prompt:
                        raise ValueError("该组没有提示词")
                    image_bytes = [
                        await asyncio.to_thread(_rh._image_ref_to_jpeg,
                                                r, MAX_LONG_EDGE, True)
                        for r in refs]
                    image, image_url, response_text = await _rh._run_runninghub(
                        str(API_KEY).strip(), prompt, aspectRatio, resolution,
                        image_bytes, channel)
                    descriptor = _rh._save_result_jpeg(
                        image, f"RH_Concurrent_{uuid.uuid4().hex[:6]}_{index + 1:03d}")
                    results[index] = {"status": "SUCCESS", "tensor": image,
                                       "image_url": image_url,
                                       "response": response_text}
                except Exception as exc:
                    results[index] = {"status": "ERROR", "error": str(exc)}

        tasks = [asyncio.create_task(one(i, g)) for i, g in enumerate(groups)]
        await asyncio.gather(*tasks)

        tensors = []
        summary = []
        failed = []
        for i in range(len(groups)):
            r = results.get(i, {"status": "ERROR", "error": "未执行"})
            if r["status"] == "SUCCESS":
                tensors.append(r["tensor"])
                summary.append({"index": i, "status": "SUCCESS",
                                 "image_url": r.get("image_url", ""),
                                 "response": json.loads(r["response"])
                                 if r.get("response") else {}})
            else:
                failed.append(f"第{i + 1}组: {r.get('error')}")
                summary.append({"index": i, "status": "ERROR",
                                 "error": r.get("error")})
        if failed and not skip_error:
            raise RuntimeError("RH大香蕉并发部分组失败：" + "；".join(failed[:5]))
        if not tensors:
            raise RuntimeError("RH大香蕉并发：所有分组都失败了")
        response_text = json.dumps(summary, ensure_ascii=False, indent=2, default=str)
        return (tensors, response_text)


NODE_CLASS_MAPPINGS = {
    "RHBananaConcurrent": RHBananaConcurrent,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "RHBananaConcurrent": "RH大香蕉并发",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
