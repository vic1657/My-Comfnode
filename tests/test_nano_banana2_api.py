from __future__ import annotations

import asyncio
import base64
import io
import importlib.util
import inspect
from pathlib import Path
import unittest

from aiohttp import web
from PIL import Image
import torch


MODULE_PATH = Path(__file__).resolve().parents[1] / "nano_banana2_api.py"
SPEC = importlib.util.spec_from_file_location("nano_banana2_api_under_test", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class NanoBanana2APITests(unittest.TestCase):
    def test_standard_node_interface(self):
        node = MODULE.MyNanoBanana2API()
        inputs = node.INPUT_TYPES()
        self.assertEqual(
            set(inputs["required"]),
            {"调用网址", "API_KEY", "提示词", "尺寸", "分辨率", "模型"},
        )
        self.assertEqual(set(inputs["optional"]), {f"图像{i}" for i in range(1, 15)})
        self.assertEqual(node.RETURN_NAMES, ("生成图片", "任务状态", "任务ID"))
        self.assertEqual(node.RETURN_TYPES, ("IMAGE", "STRING", "STRING"))
        self.assertEqual(node.FUNCTION, "generate")
        self.assertTrue(node.OUTPUT_NODE)
        self.assertTrue(inspect.iscoroutinefunction(node.generate))

    def test_resolution_options(self):
        self.assertEqual(MODULE.RESOLUTIONS, ["默认", "0.5K", "1K", "2K", "4K"])
        self.assertIn("自动", MODULE.ASPECT_RATIOS)
        self.assertIn("8:1", MODULE.ASPECT_RATIOS)

    def test_reference_images_are_jpeg_data_uris_and_limited_to_fourteen(self):
        inputs = [torch.rand(1, 12, 16, 3) for _ in range(16)]
        result = MODULE._tensor_images_to_data_uris(inputs)
        self.assertEqual(len(result), 14)
        self.assertTrue(all(item.startswith("data:image/jpeg;base64,") for item in result))
        decoded = base64.b64decode(result[0].split(",", 1)[1])
        with Image.open(io.BytesIO(decoded)) as opened:
            self.assertEqual(opened.size, (16, 12))
            self.assertEqual(opened.format, "JPEG")

    def test_task_url_from_generation_endpoint(self):
        urls = MODULE._task_query_urls(
            "https://api.apimart.ai/v1/images/generations", "task 123"
        )
        self.assertEqual(urls[0], "https://api.apimart.ai/v1/tasks/task%20123")

    def test_extract_submitted_task(self):
        data = {"code": 200, "data": [{"status": "submitted", "task_id": "task_01"}]}
        self.assertEqual(MODULE._extract_task_id(data), "task_01")
        self.assertEqual(MODULE._extract_status(data), "submitted")

    def test_async_generation_returns_image_status_and_task_id(self):
        asyncio.run(self._async_generation_returns_image_status_and_task_id())

    async def _async_generation_returns_image_status_and_task_id(self):
        buffer = io.BytesIO()
        Image.new("RGB", (32, 24), (220, 145, 35)).save(buffer, "PNG")
        image_uri = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
        captured = {}

        async def submit(request):
            captured.update(await request.json())
            return web.json_response(
                {"code": 200, "data": [{"status": "submitted", "task_id": "mock_task"}]}
            )

        async def task(_request):
            return web.json_response(
                {"status": "succeeded", "data": {"images": [image_uri]}}
            )

        application = web.Application()
        application.router.add_post("/v1/images/generations", submit)
        application.router.add_get("/v1/tasks/mock_task", task)
        runner = web.AppRunner(application)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        original_proxy = MODULE._PROXY_CACHE
        MODULE._PROXY_CACHE = None
        try:
            image, status, task_id = await MODULE._generate_image(
                f"http://127.0.0.1:{port}/v1/images/generations",
                "test-key",
                "test prompt",
                "1:1",
                "4K",
                "mock-model",
                ["data:image/jpeg;base64,AAAA"],
            )
            self.assertEqual(image.shape, (1, 24, 32, 3))
            self.assertEqual(status, "succeeded")
            self.assertEqual(task_id, "mock_task")
            self.assertEqual(captured["resolution"], "4K")
            self.assertEqual(captured["size"], "1:1")
            self.assertEqual(len(captured["image_urls"]), 1)
        finally:
            MODULE._PROXY_CACHE = original_proxy
            await runner.cleanup()

    def test_invalid_endpoint_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "完整"):
            MODULE._normalize_endpoint("api.apimart.ai/v1/images/generations")

    def test_trace_ip_parser_uses_api_host(self):
        self.assertEqual(
            MODULE.urlparse("https://api.apimart.ai/v1/images/generations").netloc,
            "api.apimart.ai",
        )


if __name__ == "__main__":
    unittest.main()
