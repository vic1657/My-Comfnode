from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest

import numpy as np
import torch


MODULE_PATH = Path(__file__).resolve().parents[1] / "high_fidelity_detail_restore.py"
SPEC = importlib.util.spec_from_file_location("high_fidelity_detail_restore_under_test", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class MyHighFidelityDetailRestoreTests(unittest.TestCase):
    def setUp(self):
        self.node = MODULE.MyHighFidelityDetailRestore()

    @staticmethod
    def textured_image(height=96, width=128):
        y, x = np.mgrid[:height, :width].astype(np.float32)
        base = 0.20 + 0.36 * y / max(height - 1, 1) + 0.12 * x / max(width - 1, 1)
        texture = 0.025 * np.sin(x * 1.7) * np.sin(y * 1.3)
        rgb = np.stack((base + texture, base * 0.80 + texture, base * 0.58 + texture), axis=2)
        return torch.from_numpy(np.clip(rgb, 0.0, 1.0)).unsqueeze(0)

    def test_version_and_interface(self):
        self.assertEqual(MODULE.ALGORITHM_VERSION, "V5")
        inputs = self.node.INPUT_TYPES()
        self.assertEqual(
            set(inputs["required"]),
            {"original_image", "relit_image", "detail_restore_strength"},
        )
        self.assertEqual(set(inputs["optional"]), {"detail_restore_mask"})

    def test_zero_strength_returns_original_exactly(self):
        original = torch.rand(1, 80, 96, 4, dtype=torch.float64)
        relit = torch.rand(1, 64, 72, 3)
        result, mask = self.node.restore_detail(original, relit, 0.0)
        self.assertTrue(torch.equal(result, original))
        self.assertEqual(float(mask.max()), 0.0)

    def test_output_size_alpha_and_dtype_follow_original(self):
        original = torch.rand(1, 72, 104, 4, dtype=torch.float64)
        relit = torch.rand(1, 96, 128, 3)
        result, mask = self.node.restore_detail(original, relit, 1.0)
        self.assertEqual(result.shape, original.shape)
        self.assertEqual(result.dtype, original.dtype)
        self.assertTrue(torch.equal(result[..., 3], original[..., 3]))
        self.assertEqual(mask.shape, original.shape[:3])

    def test_black_mask_returns_original_exactly(self):
        original = self.textured_image()
        relit = original.clone() * 0.55
        mask = torch.zeros(1, 48, 64)
        result, output_mask = self.node.restore_detail(original, relit, 1.0, mask)
        self.assertTrue(torch.equal(result, original))
        self.assertEqual(float(output_mask.max()), 0.0)

    def test_original_detail_survives_smooth_relighting(self):
        original = self.textured_image(128, 160)
        source = original[0].numpy()
        light = np.linspace(0.55, 1.20, source.shape[1], dtype=np.float32)[None, :, None]
        relit = np.clip(source * light, 0.0, 1.0)
        output, _, metrics = MODULE._restore_one(source, relit, 1.0, None)
        self.assertGreater(metrics["detail_correlation"], 0.95)
        original_luma = MODULE._luminance(MODULE._srgb_to_linear(source))
        relit_luma = MODULE._luminance(MODULE._srgb_to_linear(relit))
        output_luma = MODULE._luminance(MODULE._srgb_to_linear(output))
        before = np.mean(np.abs(original_luma - relit_luma))
        after = np.mean(np.abs(output_luma - relit_luma))
        self.assertLess(float(after), float(before) * 0.65)

    def test_reference_color_speckle_is_not_copied(self):
        original = self.textured_image(80, 96)
        relit = original.clone() * 0.75
        relit[0, 40, 48] = torch.tensor((0.02, 0.98, 0.05))
        result, _ = self.node.restore_detail(original, relit, 1.0)
        center = result[0, 40, 48]
        neighbor = result[0, 40, 47]
        self.assertLess(float((center - neighbor).abs().mean()), 0.08)

    def test_shifted_reference_silhouette_does_not_move_original_edge(self):
        height, width = 96, 128
        original = torch.full((1, height, width, 3), 0.16)
        relit = torch.full_like(original, 0.10)
        original[:, :, 49:] = 0.68
        relit[:, :, 57:] = 0.48
        result, _ = self.node.restore_detail(original, relit, 1.0)
        original_edge = result[:, :, 47:51, :3]
        shifted_edge = result[:, :, 55:59, :3]
        self.assertGreater(float(original_edge.max() - original_edge.min()), 0.30)
        self.assertLess(float(shifted_edge.max() - shifted_edge.min()), 0.22)


if __name__ == "__main__":
    unittest.main()
