from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest

import torch


MODULE_PATH = Path(__file__).resolve().parents[1] / "original_color_relight.py"
SPEC = importlib.util.spec_from_file_location("original_color_relight_under_test", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class MyOriginalColorRelightTests(unittest.TestCase):
    def setUp(self):
        self.node = MODULE.MyOriginalColorRelight()

    @staticmethod
    def gradient(height=80, width=96, color=(0.90, 0.45, 0.18)):
        light = torch.linspace(0.18, 0.92, width).view(1, 1, width, 1)
        rgb = torch.tensor(color).view(1, 1, 1, 3)
        return (light * rgb).expand(1, height, width, 3).clamp(0.0, 1.0).contiguous()

    def test_zero_restore_returns_every_relit_value(self):
        original = torch.rand(1, 73, 91, 3)
        relit = torch.rand(1, 65, 87, 4, dtype=torch.float64)
        result, mask = self.node.restore_original_color(
            original, relit, color_restore_strength=0.0, color_saturation=1.0
        )
        self.assertTrue(torch.equal(result, relit))
        self.assertEqual(tuple(mask.shape), (1, 65, 87))

    def test_output_size_and_alpha_follow_relit_image(self):
        original = torch.rand(2, 101, 75, 3)
        relit = torch.rand(1, 64, 96, 4, dtype=torch.float64)
        result, mask = self.node.restore_original_color(original, relit)
        self.assertEqual(result.shape, (2, 64, 96, 4))
        self.assertEqual(mask.shape, (2, 64, 96))
        self.assertTrue(torch.equal(result[..., 3], relit.expand(2, -1, -1, -1)[..., 3]))

    def test_linear_luminance_is_preserved_pixel_by_pixel(self):
        original = self.gradient(color=(0.95, 0.30, 0.10))
        relit = self.gradient(color=(0.25, 0.72, 0.85))
        relit[:, 20:55, 35:70] = (relit[:, 20:55, 35:70] * 1.7).clamp(0.0, 1.0)
        result, _ = self.node.restore_original_color(original, relit, 1.0, 1.0)
        relit_luma = MODULE._luminance(
            MODULE._srgb_to_linear(relit.permute(0, 3, 1, 2))
        )
        result_luma = MODULE._luminance(
            MODULE._srgb_to_linear(result.permute(0, 3, 1, 2))
        )
        self.assertLess(float((result_luma - relit_luma).abs().max()), 2e-5)

    def test_restored_chromaticity_moves_toward_original(self):
        original = self.gradient(color=(0.92, 0.32, 0.12))
        relit = self.gradient(color=(0.25, 0.80, 0.45))
        result, _ = self.node.restore_original_color(original, relit, 1.0, 1.0)

        def chroma(image):
            linear = MODULE._srgb_to_linear(image.permute(0, 3, 1, 2))
            return linear / MODULE._luminance(linear).clamp_min(1e-6)

        original_chroma = chroma(original)
        relit_chroma = chroma(relit)
        result_chroma = chroma(result)
        before = (relit_chroma - original_chroma).abs().mean()
        after = (result_chroma - original_chroma).abs().mean()
        self.assertLess(float(after), float(before) * 0.15)

    def test_controls_do_not_expose_lighting_or_blur_adjustments(self):
        required = self.node.INPUT_TYPES()["required"]
        self.assertEqual(
            set(required),
            {
                "original_image",
                "relit_image",
                "color_restore_strength",
                "color_saturation",
            },
        )
        self.assertEqual(required["color_restore_strength"][1]["max"], 1.0)
        self.assertEqual(required["color_saturation"][1]["max"], 2.0)

    def test_extreme_colors_remain_finite_and_in_gamut(self):
        original = torch.rand(1, 48, 64, 3)
        relit = torch.rand(1, 48, 64, 3)
        result, mask = self.node.restore_original_color(original, relit, 1.0, 2.0)
        self.assertTrue(torch.isfinite(result).all())
        self.assertTrue(torch.isfinite(mask).all())
        self.assertGreaterEqual(float(result.min()), 0.0)
        self.assertLessEqual(float(result.max()), 1.0)


if __name__ == "__main__":
    unittest.main()
