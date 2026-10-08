from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest

from PIL import Image
import torch


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "batch_image_loader.py"


class BatchImageLoaderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.previous = {
            name: sys.modules.get(name)
            for name in ("folder_paths", "node_helpers", "comfy", "comfy.model_management")
        }
        cls.folder_paths = types.ModuleType("folder_paths")
        cls.folder_paths.get_input_directory = lambda: ""
        node_helpers = types.ModuleType("node_helpers")
        node_helpers.pillow = lambda function, *args, **kwargs: function(*args, **kwargs)
        comfy = types.ModuleType("comfy")
        model_management = types.ModuleType("comfy.model_management")
        model_management.intermediate_dtype = lambda: torch.float32
        comfy.model_management = model_management
        sys.modules["folder_paths"] = cls.folder_paths
        sys.modules["node_helpers"] = node_helpers
        sys.modules["comfy"] = comfy
        sys.modules["comfy.model_management"] = model_management

        spec = importlib.util.spec_from_file_location("batch_image_loader_under_test", MODULE_PATH)
        cls.module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(cls.module)

    @classmethod
    def tearDownClass(cls):
        for name, previous in cls.previous.items():
            if previous is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = previous

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.folder_paths.get_input_directory = lambda: str(self.root)
        Image.new("RGB", (12, 8), "red").save(self.root / "server-a.png")
        Image.new("RGB", (16, 10), "blue").save(self.root / "server-b.jpg")

    def tearDown(self):
        self.temp.cleanup()

    def _payload(self, selected_second=False):
        return json.dumps(
            [
                {
                    "filename": "server-a.png",
                    "originalName": "客户原图A.png",
                    "type": "input",
                    "selected": False,
                },
                {
                    "filename": "server-b.jpg",
                    "originalName": "客户原图B.jpg",
                    "type": "input",
                    "selected": selected_second,
                },
            ],
            ensure_ascii=False,
        )

    def test_interface_appends_name_without_changing_three_image_outputs(self):
        node = self.module.BatchImageLoader
        self.assertEqual(node.RETURN_TYPES, ("IMAGE", "IMAGE", "IMAGE", "STRING"))
        self.assertEqual(node.RETURN_NAMES, ("原尺寸列表", "单次批次", "逐张单图", "原图原名称"))
        self.assertEqual(node.OUTPUT_IS_LIST, (True, False, False, False))

    def test_multi_image_run_uses_first_active_original_name(self):
        result = self.module.BatchImageLoader().load_images(self._payload())
        self.assertEqual(len(result), 4)
        self.assertEqual(result[3], "客户原图A")
        self.assertEqual(tuple(result[2].shape), (1, 8, 12, 3))

    def test_selected_or_sequential_image_uses_that_original_name(self):
        result = self.module.BatchImageLoader().load_images(self._payload(selected_second=True))
        self.assertEqual(result[3], "客户原图B")
        self.assertEqual(tuple(result[2].shape), (1, 10, 16, 3))

    def test_payload_order_controls_first_single_image(self):
        payload = json.loads(self._payload())
        payload.reverse()
        result = self.module.BatchImageLoader().load_images(
            json.dumps(payload, ensure_ascii=False)
        )
        self.assertEqual(result[3], "客户原图B")
        self.assertEqual(tuple(result[2].shape), (1, 10, 16, 3))


if __name__ == "__main__":
    unittest.main()
