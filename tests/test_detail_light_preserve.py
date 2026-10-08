from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest

import torch
import torch.nn.functional as F


MODULE_PATH = Path(__file__).resolve().parents[1] / "detail_light_preserve.py"
SPEC = importlib.util.spec_from_file_location("detail_light_preserve_under_test", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class MyDetailLightPreserveTests(unittest.TestCase):
    def setUp(self):
        self.node = MODULE.MyDetailLightPreserve()

    @staticmethod
    def textured_image(height=96, width=128):
        y = torch.linspace(0.18, 0.75, height).view(1, height, 1, 1)
        x = torch.linspace(0.0, 0.16, width).view(1, 1, width, 1)
        yy = torch.arange(height).view(1, height, 1, 1)
        xx = torch.arange(width).view(1, 1, width, 1)
        texture = 0.025 * torch.sin(xx * 1.7) * torch.sin(yy * 1.3)
        rgb = torch.cat((y + x, y * 0.78 + x, y * 0.55 + x), dim=-1)
        return (rgb + texture).clamp(0.0, 1.0).contiguous()

    def test_zero_strength_returns_every_relit_value(self):
        original = torch.rand(1, 71, 93, 3)
        relit = torch.rand(1, 65, 87, 4, dtype=torch.float64)
        result, mask = self.node.restore_detail(original, relit, 0.0)
        self.assertTrue(torch.equal(result, relit))
        self.assertEqual(tuple(mask.shape), (1, 65, 87))

    def test_output_size_alpha_and_batch_follow_relit_image(self):
        original = torch.rand(2, 101, 75, 3)
        relit = torch.rand(1, 64, 96, 4, dtype=torch.float64)
        result, mask = self.node.restore_detail(original, relit, 1.0)
        self.assertEqual(result.shape, (2, 64, 96, 4))
        self.assertEqual(mask.shape, (2, 64, 96))
        self.assertTrue(torch.equal(result[..., 3], relit.expand(2, -1, -1, -1)[..., 3]))

    def test_missing_aligned_microtexture_is_restored(self):
        original = self.textured_image()
        relit = F.avg_pool2d(
            original.permute(0, 3, 1, 2), kernel_size=3, stride=1, padding=1
        ).permute(0, 2, 3, 1)
        light = torch.linspace(0.82, 1.18, relit.shape[2]).view(1, 1, -1, 1)
        relit = (relit * light).clamp(0.0, 1.0)
        result, mask = self.node.restore_detail(original, relit, 1.0)

        def high_pass(image):
            nchw = image[..., :3].mean(dim=-1, keepdim=True).permute(0, 3, 1, 2)
            return nchw - F.avg_pool2d(nchw, kernel_size=5, stride=1, padding=2)

        original_detail = high_pass(original)
        before = (high_pass(relit) - original_detail).abs().mean()
        after = (high_pass(result) - original_detail).abs().mean()
        self.assertLess(float(after), float(before) * 0.60)
        self.assertGreater(float(mask.mean()), 0.005)

        relit_low = F.avg_pool2d(
            relit[..., :3].mean(dim=-1, keepdim=True).permute(0, 3, 1, 2),
            kernel_size=15,
            stride=1,
            padding=7,
        )
        result_low = F.avg_pool2d(
            result[..., :3].mean(dim=-1, keepdim=True).permute(0, 3, 1, 2),
            kernel_size=15,
            stride=1,
            padding=7,
        )
        self.assertLess(float((result_low - relit_low).abs().mean()), 0.003)

    def test_shifted_hard_edge_is_not_copied_as_double_edge(self):
        height, width = 96, 128
        original = torch.full((1, height, width, 3), 0.18)
        relit = torch.full_like(original, 0.18)
        original[:, :, 50:] = 0.72
        relit[:, :, 57:] = 0.78
        result, mask = self.node.restore_detail(original, relit, 1.0)
        protected_band = slice(46, 62)
        self.assertLess(
            float((result[:, :, protected_band] - relit[:, :, protected_band]).abs().max()),
            0.015,
        )
        self.assertLess(float(mask[:, :, protected_band].mean()), 0.03)

    def test_new_rim_light_stays_equal_to_relit_image(self):
        original = self.textured_image(96, 128)
        relit = original.clone()
        relit[:, :, 72:77] = (relit[:, :, 72:77] + 0.42).clamp(0.0, 1.0)
        result, mask = self.node.restore_detail(original, relit, 1.0)
        rim = slice(70, 79)
        self.assertLess(float((result[:, :, rim] - relit[:, :, rim]).abs().max()), 0.012)
        self.assertLess(float(mask[:, :, rim].mean()), 0.08)

    def test_only_one_adjustable_widget_is_exposed(self):
        inputs = self.node.INPUT_TYPES()
        required = inputs["required"]
        self.assertEqual(
            set(required),
            {"original_image", "relit_image", "detail_restore_strength"},
        )
        self.assertEqual(required["detail_restore_strength"][1]["min"], 0.0)
        self.assertEqual(required["detail_restore_strength"][1]["max"], 1.0)
        self.assertEqual(set(inputs["optional"]), {"detail_restore_mask"})

    def test_black_user_mask_returns_relit_image_exactly(self):
        original = self.textured_image(80, 96)
        relit = F.avg_pool2d(
            original.permute(0, 3, 1, 2), kernel_size=3, stride=1, padding=1
        ).permute(0, 2, 3, 1)
        mask = torch.zeros(1, 40, 48)
        result, restored_mask = self.node.restore_detail(original, relit, 1.0, mask)
        self.assertTrue(torch.equal(result, relit))
        self.assertEqual(float(restored_mask.max()), 0.0)

    def test_user_mask_restores_only_white_half(self):
        original = self.textured_image(80, 96)
        relit = F.avg_pool2d(
            original.permute(0, 3, 1, 2), kernel_size=3, stride=1, padding=1
        ).permute(0, 2, 3, 1)
        mask = torch.zeros(1, 80, 96)
        mask[:, :, 48:] = 1.0
        result, restored_mask = self.node.restore_detail(original, relit, 1.0, mask)
        left_change = (result[:, :, :44] - relit[:, :, :44]).abs().max()
        right_change = (result[:, :, 52:] - relit[:, :, 52:]).abs().mean()
        self.assertEqual(float(left_change), 0.0)
        self.assertGreater(float(right_change), 0.0005)
        self.assertEqual(float(restored_mask[:, :, :44].max()), 0.0)

    def test_extreme_values_remain_finite_and_in_gamut(self):
        original = torch.rand(1, 48, 64, 3)
        relit = torch.rand(1, 48, 64, 3)
        result, mask = self.node.restore_detail(original, relit, 1.0)
        self.assertTrue(torch.isfinite(result).all())
        self.assertTrue(torch.isfinite(mask).all())
        self.assertGreaterEqual(float(result.min()), 0.0)
        self.assertLessEqual(float(result.max()), 1.0)


if __name__ == "__main__":
    unittest.main()
