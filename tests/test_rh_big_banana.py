from __future__ import annotations

import asyncio
import base64
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import types
import unittest

from aiohttp import web
from PIL import Image
import torch


MODULE_PATH = Path(__file__).resolve().parents[1] / "rh_big_banana.py"
SPEC = importlib.util.spec_from_file_location("rh_big_banana_under_test", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class RHBigBananaTests(unittest.TestCase):
    def test_node_interface_matches_requested_ports(self):
        node = MODULE.RHBigBanana()
        inputs = node.INPUT_TYPES()
        self.assertEqual(
            list(inputs["optional"]),
            ["images"] + [f"image{i}" for i in range(1, 10)],
        )
        self.assertEqual(node.RETURN_NAMES, ("image", "image_url", "response"))
        self.assertEqual(MODULE.NODE_DISPLAY_NAME_MAPPINGS["RHBigBanana"], "RH大香蕉")
        self.assertEqual(inputs["required"]["resolution"][1]["default"], "4k")
        self.assertEqual(inputs["required"]["channel"][1]["default"], "官方稳定版")
        self.assertTrue(inputs["required"]["API_KEY"][1]["password"])

    def test_collect_images_encodes_jpeg_and_limits_to_ten(self):
        values = [torch.rand(2, 12, 16, 3) for _ in range(6)]
        encoded = MODULE._collect_images(values)
        self.assertEqual(len(encoded), 10)
        with Image.open(io.BytesIO(encoded[0])) as opened:
            self.assertEqual(opened.format, "JPEG")
            self.assertEqual(opened.size, (16, 12))

    def test_collect_images_accepts_original_size_list_output(self):
        values = [[torch.rand(1, 8, 12, 3), torch.rand(1, 10, 14, 3)]]
        encoded = MODULE._collect_images(values)
        self.assertEqual(len(encoded), 2)
        with Image.open(io.BytesIO(encoded[1])) as opened:
            self.assertEqual(opened.format, "JPEG")
            self.assertEqual(opened.size, (14, 10))

    def test_image_reference_is_loaded_and_resized_on_backend(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            Image.new("RGB", (4000, 3000), (40, 120, 220)).save(root / "large.jpg", quality=90)
            original_folder_paths = MODULE.folder_paths
            MODULE.folder_paths = types.SimpleNamespace(get_input_directory=lambda: str(root))
            try:
                content = MODULE._image_ref_to_jpeg(
                    {"filename": "large.jpg", "subfolder": "", "type": "input"},
                    2048,
                    True,
                )
            finally:
                MODULE.folder_paths = original_folder_paths
            with Image.open(io.BytesIO(content)) as opened:
                self.assertEqual(opened.format, "JPEG")
                self.assertEqual(opened.size, (2048, 1536))

    def test_full_async_upload_submit_poll_download(self):
        asyncio.run(self._full_async_upload_submit_poll_download())

    def test_concurrent_upload_names_are_isolated(self):
        asyncio.run(self._concurrent_upload_names_are_isolated())

    async def _concurrent_upload_names_are_isolated(self):
        filenames = []

        async def upload(request):
            reader = await request.multipart()
            field = await reader.next()
            filenames.append(field.filename)
            await field.read()
            return web.json_response(
                {"code": 0, "data": {"download_url": f"https://example.test/{field.filename}"}}
            )

        app = web.Application()
        app.router.add_post("/upload", upload)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        original_endpoint = MODULE.UPLOAD_ENDPOINT
        MODULE.UPLOAD_ENDPOINT = f"http://127.0.0.1:{port}/upload"
        try:
            async with MODULE.aiohttp.ClientSession() as session:
                urls = await asyncio.gather(
                    MODULE._upload_image(session, b"first", 1, None, "group_a"),
                    MODULE._upload_image(session, b"second", 1, None, "group_b"),
                )
            self.assertEqual(
                sorted(filenames),
                ["rh_reference_group_a_01.jpg", "rh_reference_group_b_01.jpg"],
            )
            self.assertEqual(len(set(urls)), 2)
        finally:
            MODULE.UPLOAD_ENDPOINT = original_endpoint
            await runner.cleanup()

    async def _full_async_upload_submit_poll_download(self):
        output = io.BytesIO()
        Image.new("RGB", (40, 24), (210, 150, 30)).save(output, "JPEG")
        seen = {"uploads": 0, "payload": None}

        async def upload(request):
            reader = await request.multipart()
            field = await reader.next()
            self.assertEqual(field.name, "file")
            self.assertTrue((await field.read()).startswith(b"\xff\xd8"))
            seen["uploads"] += 1
            return web.json_response(
                {
                    "code": 0,
                    "message": "success",
                    "data": {"download_url": f"http://127.0.0.1:{port}/input.jpg"},
                }
            )

        async def account(request):
            self.assertEqual((await request.json())["apiKey"], "test-key")
            return web.json_response(
                {"code": 0, "data": {"apiType": "ENTERPRISE_SHARED"}}
            )

        async def generate(request):
            seen["payload"] = await request.json()
            return web.json_response({"taskId": "rh_task_1", "status": "RUNNING"})

        async def query(request):
            self.assertEqual((await request.json())["taskId"], "rh_task_1")
            return web.json_response(
                {
                    "taskId": "rh_task_1",
                    "status": "SUCCESS",
                    "results": [
                        {
                            "url": f"http://127.0.0.1:{port}/result.jpg",
                            "outputType": "jpg",
                        }
                    ],
                }
            )

        async def result(_request):
            return web.Response(body=output.getvalue(), content_type="image/jpeg")

        app = web.Application()
        app.router.add_post("/account", account)
        app.router.add_post("/upload", upload)
        app.router.add_post("/generate", generate)
        app.router.add_post("/query", query)
        app.router.add_get("/result.jpg", result)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        original = (
            MODULE.UPLOAD_ENDPOINT,
            MODULE.BASE_ENDPOINT,
            MODULE.QUERY_ENDPOINT,
            MODULE.ACCOUNT_ENDPOINT,
            MODULE._PROXY_CACHE,
            MODULE.asyncio.sleep,
        )
        MODULE.UPLOAD_ENDPOINT = f"http://127.0.0.1:{port}/upload"
        MODULE.BASE_ENDPOINT = f"http://127.0.0.1:{port}"
        original_channels = MODULE.CHANNEL_ENDPOINTS
        MODULE.CHANNEL_ENDPOINTS = {
            "官方稳定版": "generate",
            "低价渠道": "generate",
            "Third-party": "generate",
        }
        MODULE.QUERY_ENDPOINT = f"http://127.0.0.1:{port}/query"
        MODULE.ACCOUNT_ENDPOINT = f"http://127.0.0.1:{port}/account"
        MODULE._PROXY_CACHE = None

        async def no_sleep(_seconds):
            return None

        MODULE.asyncio.sleep = no_sleep
        try:
            image, url, response = await MODULE._run_runninghub(
                "test-key",
                "test prompt",
                "16:9",
                "4k",
                [b"\xff\xd8mock"],
                "官方稳定版",
            )
            self.assertEqual(image.shape, (1, 24, 40, 3))
            self.assertEqual(url, f"http://127.0.0.1:{port}/result.jpg")
            self.assertEqual(seen["uploads"], 1)
            self.assertEqual(seen["payload"]["aspectRatio"], "16:9")
            self.assertEqual(seen["payload"]["resolution"], "4k")
            self.assertEqual(json.loads(response)["status"], "SUCCESS")
        finally:
            (
                MODULE.UPLOAD_ENDPOINT,
                MODULE.BASE_ENDPOINT,
                MODULE.QUERY_ENDPOINT,
                MODULE.ACCOUNT_ENDPOINT,
                MODULE._PROXY_CACHE,
                MODULE.asyncio.sleep,
            ) = original
            MODULE.CHANNEL_ENDPOINTS = original_channels
            await runner.cleanup()

    def test_normal_key_is_rejected_before_upload(self):
        asyncio.run(self._normal_key_is_rejected_before_upload())

    async def _normal_key_is_rejected_before_upload(self):
        async def account(_request):
            return web.json_response({"code": 0, "data": {"apiType": "NORMAL"}})

        app = web.Application()
        app.router.add_post("/account", account)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        original = (MODULE.ACCOUNT_ENDPOINT, MODULE._PROXY_CACHE)
        MODULE.ACCOUNT_ENDPOINT = f"http://127.0.0.1:{port}/account"
        MODULE._PROXY_CACHE = None
        try:
            with self.assertRaisesRegex(RuntimeError, "企业级-共享"):
                await MODULE._run_runninghub(
                    "normal-key",
                    "test prompt",
                    "1:1",
                    "1k",
                    [b"\xff\xd8mock"],
                    "官方稳定版",
                )
        finally:
            MODULE.ACCOUNT_ENDPOINT, MODULE._PROXY_CACHE = original
            await runner.cleanup()

    def test_skip_error_returns_workflow_safe_outputs(self):
        node = MODULE.RHBigBanana()
        image, url, response = asyncio.run(
            node.generate("prompt", 0, "auto", "4k", True, "Third-party", "")
        )
        self.assertEqual(image.shape, (1, 64, 64, 3))
        self.assertEqual(url, "")
        self.assertEqual(json.loads(response)["status"], "ERROR")

    def test_standalone_route_saves_jpg_and_allows_concurrency(self):
        asyncio.run(self._standalone_route_saves_jpg_and_allows_concurrency())

    def test_standalone_jobs_start_independently_without_blocking(self):
        asyncio.run(self._standalone_jobs_start_independently_without_blocking())

    async def _standalone_jobs_start_independently_without_blocking(self):
        class FakeRequest:
            content_type = "application/json"

            def __init__(self, prompt):
                self._payload = {
                    "API_KEY": "local-test-key",
                    "prompt": prompt,
                    "aspectRatio": "auto",
                    "resolution": "4k",
                    "channel": "官方稳定版",
                    "images": [],
                }

            async def json(self):
                return self._payload

        original_runner = MODULE._run_standalone_fields
        original_jobs = MODULE._STANDALONE_JOBS
        MODULE._STANDALONE_JOBS = {}
        running = 0
        max_running = 0
        completed_prompts = []

        async def fake_runner(fields, _image_bytes):
            nonlocal running, max_running
            running += 1
            max_running = max(max_running, running)
            await asyncio.sleep(0.02)
            running -= 1
            completed_prompts.append(fields["prompt"])
            return {
                "image": {"filename": f"{fields['prompt']}.jpg", "subfolder": "", "type": "output"},
                "image_url": "",
                "response": "{\"status\": \"SUCCESS\"}",
            }

        class JobRequest:
            def __init__(self, job_id):
                self.match_info = {"job_id": job_id}

        try:
            MODULE._run_standalone_fields = fake_runner
            started = await asyncio.gather(
                *[
                    MODULE.start_rh_big_banana_standalone(FakeRequest(f"group-{index}"))
                    for index in range(10)
                ]
            )
            payloads = [json.loads(response.text) for response in started]
            job_ids = [payload["job_id"] for payload in payloads]
            self.assertEqual(len(set(job_ids)), 10)
            self.assertTrue(all(payload["status"] == "QUEUED" for payload in payloads))

            results = []
            for job_id in job_ids:
                for _ in range(20):
                    response = await MODULE.get_rh_big_banana_standalone_job(JobRequest(job_id))
                    payload = json.loads(response.text)
                    if payload["status"] == "SUCCESS":
                        results.append(payload)
                        break
                    await asyncio.sleep(0.005)

            self.assertEqual(len(results), 10)
            self.assertEqual(max_running, 10)
            self.assertEqual(sorted(completed_prompts), [f"group-{index}" for index in range(10)])
        finally:
            MODULE._run_standalone_fields = original_runner
            MODULE._STANDALONE_JOBS = original_jobs

    async def _standalone_route_saves_jpg_and_allows_concurrency(self):
        source = io.BytesIO()
        Image.new("RGB", (18, 14), (10, 120, 230)).save(source, "PNG")
        image_data = "data:image/png;base64," + base64.b64encode(source.getvalue()).decode("ascii")

        class FakeRequest:
            content_type = "application/json"

            def __init__(self, prompt):
                self._payload = {
                    "API_KEY": "test-key",
                    "prompt": prompt,
                    "aspectRatio": "auto",
                    "resolution": "4k",
                    "channel": "官方稳定版",
                    "images": [image_data],
                }

            async def json(self):
                return self._payload

        running = 0
        max_running = 0
        calls = []

        async def fake_run(api_key, prompt, aspect_ratio, resolution, image_bytes, channel):
            nonlocal running, max_running
            calls.append((api_key, prompt, aspect_ratio, resolution, len(image_bytes), channel))
            running += 1
            max_running = max(max_running, running)
            await asyncio.sleep(0.01)
            running -= 1
            image = torch.full((1, 16, 20, 3), 0.45, dtype=torch.float32)
            return image, f"https://example.test/{prompt}.jpg", json.dumps({"status": "SUCCESS"})

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fake_folder_paths = types.SimpleNamespace(
                get_output_directory=lambda: str(root),
                get_save_image_path=lambda prefix, output_dir, width, height: (
                    str(Path(output_dir) / "rh"),
                    prefix,
                    1,
                    "rh",
                    prefix,
                ),
            )
            original_run = MODULE._run_runninghub
            original_folder_paths = MODULE.folder_paths
            MODULE._run_runninghub = fake_run
            MODULE.folder_paths = fake_folder_paths
            try:
                responses = await asyncio.gather(
                    *[
                        MODULE.run_rh_big_banana_standalone(FakeRequest(f"group-{index}"))
                        for index in range(10)
                    ]
                )
            finally:
                MODULE._run_runninghub = original_run
                MODULE.folder_paths = original_folder_paths

            payloads = [json.loads(response.text) for response in responses]
            self.assertTrue(all(payload["ok"] for payload in payloads))
            self.assertEqual(max_running, 10)
            self.assertEqual(len(calls), 10)
            self.assertTrue(all(call[4] == 1 for call in calls))
            for payload in payloads:
                image_info = payload["image"]
                self.assertEqual(image_info["type"], "output")
                self.assertTrue(image_info["filename"].endswith(".jpg"))
                saved = root / image_info["subfolder"] / image_info["filename"]
                self.assertTrue(saved.is_file())
                with Image.open(saved) as opened:
                    self.assertEqual(opened.format, "JPEG")


if __name__ == "__main__":
    unittest.main()
