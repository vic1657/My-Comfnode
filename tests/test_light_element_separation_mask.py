from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest

import torch


MODULE_PATH = Path(__file__).resolve().parents[1] / "light_element_separation_mask.py"
SPEC = importlib.util.spec_from_file_location("light_element_separation_mask_under_test", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class LightElementSeparationMaskTests(unittest.TestCase):
    def setUp(self):
        self.node = MODULE.MyLightElementSeparationMask()

    @staticmethod
    def base_image(height=64, width=80):
        image = torch.full((1, height, width, 3), 0.22)
        image[:, 8:56, 16:64] = torch.tensor([0.12, 0.10, 0.09])
        return image

    def test_identical_images_keep_the_input_mask(self):
        image = self.base_image()
        mask = torch.zeros(1, 64, 80)
        mask[:, 8:56, 16:64] = 1.0

        keep, light, debug = self.node.separate_light(image, image, mask, mask_feather=0.0)

        self.assertLess(float(light.max()), 0.001)
        self.assertGreater(float(keep[:, 12:52, 20:60].mean()), 0.99)
        self.assertEqual(tuple(debug.shape), (1, 64, 80, 3))

    def test_strong_added_highlight_is_detected(self):
        original = self.base_image()
        ai = original.clone()
        ai[:, 18:38, 28:48] = 0.70
        mask = torch.ones(1, 64, 80)

        keep, light, _ = self.node.separate_light(
            original, ai, mask,
            weak_light_sensitivity=0.0,
            light_smoothing=1.0,
            mask_feather=0.0,
        )

        self.assertGreater(float(light[:, 22:34, 32:44].mean()), 0.90)
        self.assertLess(float(keep[:, 22:34, 32:44].mean()), 0.10)
        self.assertLess(float(light[:, :6].max()), 0.001)

    def test_weak_light_sensitivity_controls_subtle_brightening(self):
        original = self.base_image()
        ai = original.clone()
        ai[:, 18:46, 26:54] += 0.035
        mask = torch.ones(1, 64, 80)

        _, low_light, _ = self.node.separate_light(
            original, ai, mask,
            weak_light_sensitivity=0.0,
            weak_light_threshold=0.02,
            light_smoothing=1.0,
            mask_feather=0.0,
        )
        _, high_light, _ = self.node.separate_light(
            original, ai, mask,
            weak_light_sensitivity=1.0,
            weak_light_threshold=0.01,
            light_smoothing=1.0,
            mask_feather=0.0,
        )

        region = (slice(None), slice(22, 42), slice(30, 50))
        self.assertLess(float(low_light[region].mean()), 0.10)
        self.assertGreater(float(high_light[region].mean()), 0.35)

    def test_dark_only_change_is_not_classified_as_added_light(self):
        original = self.base_image()
        ai = original.clone()
        ai[:, 18:46, 26:54] *= 0.35
        mask = torch.ones(1, 64, 80)

        _, light, _ = self.node.separate_light(
            original, ai, mask,
            weak_light_sensitivity=1.0,
            weak_light_threshold=0.002,
            mask_feather=0.0,
        )

        self.assertLess(float(light.max()), 0.001)

    def test_batch_and_resized_mask_are_supported(self):
        original = self.base_image(48, 60)
        ai = original.repeat(2, 1, 1, 1)
        mask = torch.ones(1, 12, 15)

        keep, light, debug = self.node.separate_light(original, ai, mask)

        self.assertEqual(tuple(keep.shape), (2, 48, 60))
        self.assertEqual(tuple(light.shape), (2, 48, 60))
        self.assertEqual(tuple(debug.shape), (2, 48, 60, 3))
        self.assertTrue(torch.isfinite(debug).all())

    def test_chinese_interface(self):
        required = self.node.INPUT_TYPES()["required"]
        self.assertIn("高光识别强度", required)
        self.assertIn("弱光灵敏度", required)
        self.assertIn("弱光阈值", required)
        self.assertEqual(self.node.RETURN_NAMES,
                         ("有效细节遮罩", "AI新增光元素遮罩", "光元素参考图"))


if __name__ == "__main__":
    unittest.main()
