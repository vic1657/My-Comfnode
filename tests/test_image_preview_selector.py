from __future__ import annotations

import importlib.util
import asyncio
import json
from pathlib import Path
import sys
import threading
import types
import unittest

import torch


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "image_preview_selector.py"


class FakeRoutes:
    @staticmethod
    def get(_path):
        return lambda function: function

    @staticmethod
    def post(_path):
        return lambda function: function


class FakePromptServer:
    instance = types.SimpleNamespace(routes=FakeRoutes(), send_sync=lambda *_args, **_kwargs: None)


class FakePreviewImage:
    def save_images(self, _image, **_kwargs):
        return {
            "ui": {
                "images": [
                    {"filename": "preview.png", "subfolder": "selector", "type": "temp"}
                ]
            }
        }


class FakeRequest:
    def __init__(self, payload):
        self.payload = payload

    async def json(self):
        return self.payload


COMFY = types.ModuleType("comfy")
MODEL_MANAGEMENT = types.ModuleType("comfy.model_management")
MODEL_MANAGEMENT.throw_exception_if_processing_interrupted = lambda: None
COMFY.model_management = MODEL_MANAGEMENT

NODES = types.ModuleType("nodes")
NODES.PreviewImage = FakePreviewImage

SERVER = types.ModuleType("server")
SERVER.PromptServer = FakePromptServer

PREVIOUS_MODULES = {
    name: sys.modules.get(name)
    for name in ("comfy", "comfy.model_management", "nodes", "server")
}
sys.modules["comfy"] = COMFY
sys.modules["comfy.model_management"] = MODEL_MANAGEMENT
sys.modules["nodes"] = NODES
sys.modules["server"] = SERVER
try:
    SPEC = importlib.util.spec_from_file_location("image_preview_selector_under_test", MODULE_PATH)
    MODULE = importlib.util.module_from_spec(SPEC)
    assert SPEC.loader is not None
    SPEC.loader.exec_module(MODULE)
finally:
    for name, previous in PREVIOUS_MODULES.items():
        if previous is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = previous


class ImagePreviewSelectorTests(unittest.TestCase):
    def setUp(self):
        MODULE.ImagePreviewSelector._preview_cache.clear()
        MODULE._SELECTION_SESSIONS.clear()

    def test_preview_metadata_contains_dimensions_and_aspect_ratio(self):
        image = torch.zeros((1, 20, 40, 3), dtype=torch.float32)

        previews = MODULE.ImagePreviewSelector()._preview_images(
            [image], "signature", "node-1", {}, None
        )

        self.assertEqual(len(previews), 1)
        self.assertEqual(previews[0]["width"], 40)
        self.assertEqual(previews[0]["height"], 20)
        self.assertEqual(previews[0]["aspect_ratio"], 2.0)

    def test_normalize_images_splits_batch_into_individual_images(self):
        batch = torch.zeros((4, 12, 16, 3), dtype=torch.float32)

        images = MODULE._normalize_images(batch)

        self.assertEqual(len(images), 4)
        self.assertTrue(all(tuple(image.shape) == (1, 12, 16, 3) for image in images))

    def test_select_route_falls_back_to_unique_matching_signature(self):
        event = threading.Event()
        MODULE._SELECTION_SESSIONS["server-node"] = {
            "event": event,
            "signature": "sig-1",
            "count": 2,
            "previews": [],
            "selected_index": None,
            "cancelled": False,
        }

        response = asyncio.run(MODULE.select_preview_image(FakeRequest({
            "node_id": "frontend-node",
            "signature": "sig-1",
            "index": 1,
        })))
        payload = json.loads(response.text)

        self.assertEqual(response.status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["node_id"], "server-node")
        self.assertEqual(MODULE._SELECTION_SESSIONS["server-node"]["selected_index"], 1)
        self.assertTrue(event.is_set())

    def test_select_route_rejects_ambiguous_signature_fallback(self):
        for node_id in ("server-node-a", "server-node-b"):
            MODULE._SELECTION_SESSIONS[node_id] = {
                "event": threading.Event(),
                "signature": "sig-1",
                "count": 2,
                "previews": [],
                "selected_index": None,
                "cancelled": False,
            }

        response = asyncio.run(MODULE.select_preview_image(FakeRequest({
            "node_id": "frontend-node",
            "signature": "sig-1",
            "index": 1,
        })))
        payload = json.loads(response.text)

        self.assertEqual(response.status, 409)
        self.assertFalse(payload["ok"])


if __name__ == "__main__":
    unittest.main()
