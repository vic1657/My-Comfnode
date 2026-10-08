from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest

import cv2
import numpy as np
import torch


MODULE_PATH = Path(__file__).resolve().parents[1] / "pixel_image_alignment.py"
SPEC = importlib.util.spec_from_file_location("pixel_image_alignment_under_test", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class PixelImageAlignmentTests(unittest.TestCase):
    def test_node_has_single_output(self):
        node = MODULE.MyPixelImageAlignment()
        self.assertEqual(node.RETURN_TYPES, ("IMAGE",))
        self.assertEqual(node.RETURN_NAMES, ("已对齐图像",))
        self.assertEqual(
            MODULE.NODE_DISPLAY_NAME_MAPPINGS["MyPixelImageAlignment"],
            "My像素级图像对齐",
        )

    def test_global_alignment_reduces_geometric_error(self):
        target = np.zeros((320, 320, 3), dtype=np.float32)
        rng = np.random.default_rng(123)
        for _ in range(80):
            x, y = rng.integers(15, 305, size=2)
            radius = int(rng.integers(2, 9))
            color = tuple(float(value) for value in rng.random(3))
            cv2.circle(target, (int(x), int(y)), radius, color, -1)
        matrix = cv2.getRotationMatrix2D((160, 160), 2.0, 1.035)
        matrix[:, 2] += (9.0, -7.0)
        source = cv2.warpAffine(target, matrix, (320, 320), borderMode=cv2.BORDER_REFLECT_101)
        before = float(np.mean(np.abs(source - target)))
        aligned = MODULE._global_affine(source, target)
        after = float(np.mean(np.abs(aligned - target)))
        self.assertLess(after, before * 0.45)

    def test_batch_broadcast_and_output_shape(self):
        node = MODULE.MyPixelImageAlignment()
        original_estimator = MODULE._estimate_dense_flow

        def zero_flow(source, target, work_size, max_displacement, strength):
            height, width = target.shape[:2]
            return (
                np.zeros((height, width, 2), dtype=np.float32),
                np.ones((height, width), dtype=np.float32),
            )

        MODULE._estimate_dense_flow = zero_flow
        try:
            source = torch.rand(1, 96, 80, 3)
            target = torch.rand(2, 128, 112, 3)
            result = node.align(source, target, "快速", 0.85, 64)[0]
            self.assertEqual(result.shape, (2, 128, 112, 3))
        finally:
            MODULE._estimate_dense_flow = original_estimator


if __name__ == "__main__":
    unittest.main()
