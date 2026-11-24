from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path
import unittest

import torch


MODULE_PATH = Path(__file__).resolve().parents[1] / "rh_all_g.py"
SPEC = importlib.util.spec_from_file_location("rh_all_g_under_test", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class RHAllGTests(unittest.TestCase):
    def test_interface_uses_documented_model_options(self):
        node = MODULE.RHAllG()
        inputs = node.INPUT_TYPES()
        self.assertEqual(MODULE.NODE_DISPLAY_NAME_MAPPINGS["RHAllG"], "RH全能G")
        self.assertEqual(inputs["required"]["resolution"][1]["default"], "2k")
        self.assertTrue(inputs["required"]["API_KEY"][1]["password"])
        self.assertNotIn("channel", inputs["required"])
        self.assertEqual(inputs["required"]["aspectRatio"][0][-1], "1:3")
        self.assertEqual(list(inputs["optional"]), ["images"] + [f"image{i}" for i in range(1, 10)])

    def test_request_reuses_shared_runner_with_g2_endpoint(self):
        asyncio.run(self._test_request_reuses_shared_runner_with_g2_endpoint())

    async def _test_request_reuses_shared_runner_with_g2_endpoint(self):
        original = MODULE._shared._run_runninghub
        received = {}

        async def fake_runner(*args):
            received["args"] = args
            return torch.zeros((1, 2, 2, 3)), "https://example.test/result.png", "{}"

        MODULE._shared._run_runninghub = fake_runner
        try:
            image, image_url, response = await MODULE._run_rh_all_g(
                "test-key", "test prompt", "16:9", "2k", [b"image"]
            )
        finally:
            MODULE._shared._run_runninghub = original

        self.assertEqual(image.shape, (1, 2, 2, 3))
        self.assertEqual(image_url, "https://example.test/result.png")
        self.assertEqual(response, "{}")
        self.assertEqual(received["args"][-1], MODULE.MODEL_CHANNEL)
        self.assertEqual(MODULE._shared.CHANNEL_ENDPOINTS[MODULE.MODEL_CHANNEL], "rhart-image-g-2/image-to-image")


if __name__ == "__main__":
    unittest.main()
