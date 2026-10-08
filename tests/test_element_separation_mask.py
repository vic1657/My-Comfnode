from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest

import torch


MODULE_PATH = Path(__file__).resolve().parents[1] / "element_separation_mask.py"
SPEC = importlib.util.spec_from_file_location("element_separation_mask_under_test", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class ElementSeparationMaskTests(unittest.TestCase):
    def setUp(self):
        self.node = MODULE.MyElementSeparationMask()

    @staticmethod
    def base_image(height=48, width=64):
        image = torch.full((1, height, width, 3), 0.25)
        image[:, 8:40, 16:48] = torch.tensor([0.12, 0.08, 0.06])
        return image

    def test_identical_images_keep_the_input_mask(self):
        image = self.base_image()
        source_mask = torch.zeros(1, 48, 64)
        source_mask[:, 8:40, 16:48] = 1.0

        keep, ignored, debug = self.node.separate(image, image, source_mask, mask_feather=0.0)

        self.assertLess(float(ignored.max()), 0.001)
        self.assertGreater(float(keep[:, 12:36, 20:44].mean()), 0.98)
        self.assertEqual(float(debug[:, :5].max()), 0.0)

    def test_new_bright_element_is_removed_only_inside_input_mask(self):
        original = self.base_image()
        ai = original.clone()
        ai[:, 22:30, 28:38] = 1.0
        source_mask = torch.zeros(1, 48, 64)
        source_mask[:, 8:40, 16:48] = 1.0

        keep, ignored, _ = self.node.separate(
            original,
            ai,
            source_mask,
            difference_threshold=0.08,
            transition_width=0.05,
            mask_feather=0.0,
        )

        self.assertGreater(float(ignored[:, 24:28, 30:36].mean()), 0.9)
        self.assertLess(float(keep[:, 24:28, 30:36].mean()), 0.1)
        self.assertEqual(float(ignored[:, :8].max()), 0.0)

    def test_batches_sizes_and_values_are_valid(self):
        original = self.base_image(32, 40)
        ai = self.base_image(32, 40).repeat(2, 1, 1, 1)
        source_mask = torch.ones(1, 16, 20)

        keep, ignored, debug = self.node.separate(original, ai, source_mask)

        self.assertEqual(tuple(keep.shape), (2, 32, 40))
        self.assertEqual(tuple(ignored.shape), (2, 32, 40))
        self.assertEqual(tuple(debug.shape), (2, 32, 40, 3))
        self.assertTrue(torch.isfinite(keep).all())
        self.assertTrue(torch.isfinite(ignored).all())
        self.assertTrue(torch.isfinite(debug).all())
        self.assertGreaterEqual(float(keep.min()), 0.0)
        self.assertLessEqual(float(keep.max()), 1.0)


if __name__ == "__main__":
    unittest.main()
