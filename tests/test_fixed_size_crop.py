from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import types
import unittest

import torch
import torch.nn.functional as F


def _install_comfy_stubs():
    if "nodes" not in sys.modules:
        sys.modules["nodes"] = types.SimpleNamespace(MAX_RESOLUTION=16384)

    if "comfy" in sys.modules and "comfy.utils" in sys.modules:
        return

    comfy_module = types.ModuleType("comfy")
    utils_module = types.ModuleType("comfy.utils")

    def common_upscale(samples, width, height, method, crop):
        if method == "area":
            return F.interpolate(samples, size=(height, width), mode="area")
        return F.interpolate(samples, size=(height, width), mode="bicubic", align_corners=False)

    utils_module.common_upscale = common_upscale
    comfy_module.utils = utils_module
    sys.modules["comfy"] = comfy_module
    sys.modules["comfy.utils"] = utils_module


_install_comfy_stubs()

MODULE_PATH = Path(__file__).resolve().parents[1] / "fixed_size_crop.py"
SPEC = importlib.util.spec_from_file_location("fixed_size_crop_under_test", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class FixedSizeImagePadTests(unittest.TestCase):
    def test_portrait_square_pad_fills_height_and_only_pads_sides(self):
        image = torch.linspace(0.0, 1.0, 768).view(1, 768, 1, 1).expand(1, 768, 512, 3).contiguous()
        node = MODULE.FixedSizeImagePad()

        output, width, height, info, content_x, content_y, content_width, content_height = node.pad_to_fixed_size(
            image,
            "1:1",
            "原始",
            "居中",
            "白色",
            255,
            255,
            255,
        )

        self.assertEqual(tuple(output.shape), (1, 1024, 1024, 3))
        self.assertEqual((width, height), (1024, 1024))
        self.assertGreater(content_width, image.shape[2])
        self.assertEqual(content_height, 1024)
        self.assertEqual(content_y, 0)
        self.assertGreater(content_x, 0)
        self.assertIn("缩放=", info)


class CropBackgroundBorderTests(unittest.TestCase):
    def test_virtual_canvas_coordinates_are_scaled_before_cropping(self):
        image = torch.ones(1, 1024, 1024, 3)
        image[:, :, 170:854, :] = 0.25
        node = MODULE.CropBackgroundBorder()

        output, width, height, info = node.crop_background_border(
            image,
            "白色",
            0.02,
            0,
            255,
            255,
            255,
            crop_x=340,
            crop_y=0,
            crop_width=1368,
            crop_height=2048,
        )

        self.assertEqual(tuple(output.shape), (1, 1024, 684, 3))
        self.assertEqual((width, height), (684, 1024))
        self.assertLess(float(output[..., :3].mean()), 0.3)
        self.assertIn("坐标按高度缩放", info)


if __name__ == "__main__":
    unittest.main()
