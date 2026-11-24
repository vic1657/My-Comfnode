from __future__ import annotations

import base64
import importlib.util
import io
from pathlib import Path
import unittest

import torch
from PIL import Image


MODULE_PATH = Path(__file__).resolve().parents[1] / "custom_light_render.py"
FRONTEND_PATH = Path(__file__).resolve().parents[1] / "web" / "custom_light_render.js"
SPEC = importlib.util.spec_from_file_location("custom_light_render_under_test", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class MyCustomLightRenderTests(unittest.TestCase):
    def setUp(self):
        self.node = MODULE.MyCustomLightRender()

    @staticmethod
    def data_url(color=(20, 80, 160)):
        buffer = io.BytesIO()
        Image.new("RGB", (32, 24), color).save(buffer, format="PNG")
        payload = base64.b64encode(buffer.getvalue()).decode("ascii")
        return f"data:image/png;base64,{payload}"

    def test_chinese_interface_and_category(self):
        inputs = self.node.INPUT_TYPES()["required"]
        self.assertEqual(
            set(inputs),
            {"光源方向", "光源高度", "光照强度", "光源颜色", "颜色透明度", "渲染数据"},
        )
        self.assertEqual(self.node.RETURN_NAMES, ("渲染图", "颜色信息"))
        self.assertEqual(self.node.CATEGORY, "My-Comfnode/图像处理")
        self.assertEqual(
            MODULE.NODE_DISPLAY_NAME_MAPPINGS["MyCustomLightRender"],
            "My自定义光源渲染",
        )
        self.assertEqual(inputs["光照强度"][1]["max"], 6.0)

    def test_render_data_is_decoded_and_resized(self):
        image, color = self.node.render(0, 45, 1.5, "#1450A0", 0.4, self.data_url())
        self.assertEqual(tuple(image.shape), (1, 1024, 1024, 3))
        self.assertEqual(image.dtype, torch.float32)
        self.assertAlmostEqual(float(image[0, 512, 512, 0]), 20 / 255, places=4)
        self.assertEqual(color, "rgba(20, 80, 160, 0.400)")

    def test_missing_render_returns_white_placeholder(self):
        image, color = self.node.render(0, 45, 1.5, "#FF0000", 1.0, "")
        self.assertEqual(tuple(image.shape), (1, 1024, 1024, 3))
        self.assertAlmostEqual(float(image.mean()), 1.0, places=4)
        self.assertEqual(color, "rgba(255, 0, 0, 1.000)")

    def test_invalid_color_and_opacity_are_normalized(self):
        _, low = self.node.render(0, 45, 1.5, "bad", -2.0, "")
        _, high = self.node.render(0, 45, 1.5, "#00ff7f", 3.0, "")
        self.assertEqual(low, "rgba(255, 255, 255, 0.000)")
        self.assertEqual(high, "rgba(0, 255, 127, 1.000)")

    def test_frontend_matches_reference_light_calibration(self):
        source = FRONTEND_PATH.read_text(encoding="utf-8")
        self.assertIn("const BACKGROUND_COLOR = 0xffffff", source)
        self.assertIn("renderer.setClearColor(BACKGROUND_COLOR, 1)", source)
        self.assertIn("scene.background = new THREE.Color(BACKGROUND_COLOR)", source)
        self.assertIn("renderer.toneMapping = THREE.NoToneMapping", source)
        self.assertIn("const REFERENCE_INTENSITY_MAX = 3", source)
        self.assertIn("const CONTROL_INTENSITY_MAX = 6", source)
        self.assertIn("const LEGACY_LIGHT_SCALE = Math.PI", source)
        self.assertIn(
            "function legacyLinearColor(red, green = red, blue = red)", source
        )
        self.assertIn("THREE.LinearSRGBColorSpace", source)
        self.assertIn("legacyLinearColor(138)", source)
        self.assertIn("legacyLinearColor(204)", source)
        self.assertIn(
            "referenceIntensityFor(controlIntensity) * opacity * LEGACY_LIGHT_SCALE",
            source,
        )


if __name__ == "__main__":
    unittest.main()
