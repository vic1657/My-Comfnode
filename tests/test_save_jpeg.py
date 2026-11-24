from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import tempfile
import types
import unittest

from PIL import Image
import torch


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "save_jpeg.py"


class MySaveJPEGTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        folder_paths = types.ModuleType("folder_paths")
        folder_paths.get_output_directory = lambda: str(root)
        folder_paths.get_save_image_path = (
            lambda prefix, output, width, height: (output, prefix, 1, "", prefix)
        )
        self.previous = sys.modules.get("folder_paths")
        sys.modules["folder_paths"] = folder_paths
        spec = importlib.util.spec_from_file_location("save_jpeg_under_test", MODULE_PATH)
        self.module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(self.module)

    def tearDown(self):
        if self.previous is None:
            sys.modules.pop("folder_paths", None)
        else:
            sys.modules["folder_paths"] = self.previous
        self.temp.cleanup()

    def test_interface_and_jpeg_output(self):
        node = self.module.MySaveJPEG()
        self.assertTrue(node.OUTPUT_NODE)
        inputs = node.INPUT_TYPES()["required"]
        self.assertEqual(set(inputs), {"images", "filename_prefix", "quality", "chroma_subsampling"})
        image = torch.rand(1, 64, 96, 3)
        result = node.save_images(image, "test", 92, "4:4:4")
        saved = Path(self.temp.name) / result["ui"]["images"][0]["filename"]
        self.assertTrue(saved.exists())
        with Image.open(saved) as opened:
            self.assertEqual(opened.format, "JPEG")
            self.assertEqual(opened.size, (96, 64))
        self.assertLess(saved.stat().st_size, 96 * 64 * 3)


if __name__ == "__main__":
    unittest.main()
