from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest

import torch


MODULE_PATH = Path(__file__).resolve().parents[1] / "my_lighting.py"
SPEC = importlib.util.spec_from_file_location("my_lighting_under_test", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class MyLightingTests(unittest.TestCase):
    def setUp(self):
        self.node = MODULE.MyLighting()

    @staticmethod
    def gradient(height=96, width=128):
        x = torch.linspace(0.15, 0.85, width).view(1, 1, width, 1)
        y = torch.linspace(0.0, 0.12, height).view(1, height, 1, 1)
        return (x + y).expand(1, height, width, 3).clamp(0.0, 1.0).contiguous()

    def test_strength_zero_preserves_every_original_value(self):
        original = torch.rand(1, 72, 91, 4, dtype=torch.float64)
        reference = torch.rand(1, 65, 100, 3)
        result, mask = self.node.apply_lighting(original, reference, 0.0, "#FFFFFF")
        self.assertTrue(torch.equal(result, original))
        self.assertEqual(tuple(mask.shape), (1, 72, 91))

    def test_identical_reference_is_neutral(self):
        original = self.gradient()
        result, mask = self.node.apply_lighting(original, original.clone(), 1.0, "#FFFFFF")
        self.assertLess(float((result - original).abs().max()), 2e-4)
        self.assertLess(float((mask - 0.5).abs().max()), 2e-3)

    def test_reference_lighting_direction_is_extracted(self):
        original = self.gradient()
        reference = original.clone()
        reference[:, :, :64] *= 0.55
        reference[:, :, 64:] = 1.0 - (1.0 - reference[:, :, 64:]) * 0.45
        result, mask = self.node.apply_lighting(original, reference, 0.85, "#FFFFFF")
        left_mask = float(mask[:, :, :48].mean())
        right_mask = float(mask[:, :, 80:].mean())
        self.assertGreater(right_mask - left_mask, 0.30)
        self.assertLess(float(result[:, :, :48].mean()), float(original[:, :, :48].mean()))
        self.assertGreater(float(result[:, :, 80:].mean()), float(original[:, :, 80:].mean()))

    def test_single_reference_broadcasts_and_keeps_source_size(self):
        original = torch.rand(2, 80, 120, 3)
        reference = torch.rand(1, 100, 100, 3)
        result, mask = self.node.apply_lighting(original, reference, 0.5, "#FFD7A3")
        self.assertEqual(tuple(result.shape), (2, 80, 120, 3))
        self.assertEqual(tuple(mask.shape), (2, 80, 120))

    def test_small_reference_translation_is_corrected(self):
        source_luma = torch.zeros(1, 1, 96, 128)
        source_luma[:, :, 20:55, 30:70] = 0.7
        source_luma[:, :, 30:45, 72:92] = 1.0
        shifted = MODULE._translate_replicate(source_luma, [(5, -7)])
        correction = MODULE._estimate_translation(source_luma, shifted)
        aligned = MODULE._translate_replicate(shifted, correction)
        self.assertEqual(correction, [(-5, 7)])
        self.assertLess(float((source_luma - aligned).abs().mean()), 1e-6)

    def test_only_two_user_adjustable_widgets_are_exposed(self):
        inputs = self.node.INPUT_TYPES()
        self.assertNotIn("optional", inputs)
        self.assertEqual(
            set(inputs["required"]),
            {"original_image", "lighting_reference", "light_strength", "light_color"},
        )
        self.assertEqual(inputs["required"]["light_strength"][1]["min"], 0.0)
        self.assertEqual(inputs["required"]["light_strength"][1]["max"], 1.0)
        self.assertEqual(inputs["required"]["light_color"][1]["default"], "#FFFFFF")

    def test_serial_lighting_is_supported(self):
        original = self.gradient(64, 64)
        first_reference = original.clone()
        first_reference[:, :, 32:] = (first_reference[:, :, 32:] + 0.3).clamp(0.0, 1.0)
        first, _ = self.node.apply_lighting(original, first_reference, 0.5, "#FFF0D0")
        second_reference = original.clone()
        second_reference[:, :32] = (second_reference[:, :32] + 0.25).clamp(0.0, 1.0)
        second, mask = self.node.apply_lighting(first, second_reference, 0.4, "#D9ECFF")
        self.assertEqual(second.shape, original.shape)
        self.assertEqual(mask.shape, original.shape[:3])
        self.assertTrue(torch.isfinite(second).all())

    def test_invalid_color_has_actionable_error(self):
        validation = self.node.VALIDATE_INPUTS("white")
        self.assertIsInstance(validation, str)
        with self.assertRaisesRegex(ValueError, "#RRGGBB"):
            self.node.apply_lighting(self.gradient(), self.gradient(), 0.5, "white")


if __name__ == "__main__":
    unittest.main()
