from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest

import numpy as np
import torch


MODULE_PATH = Path(__file__).resolve().parents[1] / "light_redemption.py"
SPEC = importlib.util.spec_from_file_location("light_redemption_under_test", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class MyLightRedemptionTests(unittest.TestCase):
    def setUp(self):
        self.node = MODULE.MyLightRedemption()

    @staticmethod
    def source(height=160, width=120):
        y, x = np.mgrid[:height, :width].astype(np.float32)
        base = 0.18 + 0.42 * x / max(width - 1, 1) + 0.10 * y / max(height - 1, 1)
        texture = 0.035 * np.sin(x * 1.8) * np.sin(y * 1.45)
        rgb = np.stack((base + texture, base * 0.82 + texture, base * 0.64 + texture), axis=2)
        return torch.from_numpy(np.clip(rgb, 0.0, 1.0)).unsqueeze(0)

    def test_chinese_interface_and_name(self):
        self.assertEqual(MODULE.ALGORITHM_VERSION, "V1")
        inputs = self.node.INPUT_TYPES()
        self.assertEqual(
            set(inputs["required"]),
            {"原图", "AI打光图", "光影强度", "光影细节", "光色保留", "杂边抑制", "闭环校准"},
        )
        self.assertEqual(set(inputs["optional"]), {"作用遮罩"})
        self.assertEqual(MODULE.NODE_DISPLAY_NAME_MAPPINGS["MyLightRedemption"], "My光的救赎")

    def test_output_uses_original_size_dtype_and_alpha(self):
        original = torch.cat((self.source(192, 144).double(), torch.rand(1, 192, 144, 1).double()), dim=3)
        relit = self.source(96, 72) * 0.7
        output, preview = self.node.redeem_light(original, relit, 1.0, 0.82, 1.0, 0.78, 0.65)
        self.assertEqual(output.shape, original.shape)
        self.assertEqual(preview.shape, (1, 192, 144, 3))
        self.assertEqual(output.dtype, original.dtype)
        self.assertTrue(torch.equal(output[..., 3], original[..., 3]))

    def test_mismatched_aspect_ratio_is_rejected(self):
        original = self.source(192, 144)
        relit = self.source(96, 96)
        with self.assertRaisesRegex(ValueError, "宽高比不一致"):
            self.node.redeem_light(original, relit, 1.0, 0.82, 1.0, 0.78, 0.65)

    def test_zero_strength_preserves_original_rgb(self):
        original = self.source()
        relit = torch.clamp(self.source(80, 60) * 1.25, 0.0, 1.0)
        output, _ = self.node.redeem_light(original, relit, 0.0, 0.82, 1.0, 0.78, 0.65)
        self.assertTrue(torch.allclose(output, original, atol=2e-6))

    def test_black_mask_preserves_original(self):
        original = self.source()
        relit = torch.clamp(self.source(80, 60) * 1.35, 0.0, 1.0)
        output, _ = self.node.redeem_light(
            original, relit, 1.0, 0.82, 1.0, 0.78, 0.65, torch.zeros(1, 40, 30)
        )
        self.assertTrue(torch.allclose(output, original, atol=2e-6))

    def test_smooth_light_is_rebuilt_without_losing_source_texture(self):
        original = self.source(192, 144)
        small = torch.nn.functional.interpolate(
            original.permute(0, 3, 1, 2), size=(96, 72), mode="bilinear", align_corners=False
        ).permute(0, 2, 3, 1)
        light = torch.linspace(0.55, 1.35, 72).view(1, 1, 72, 1)
        relit = torch.clamp(small * light, 0.0, 1.0)
        output, _ = self.node.redeem_light(original, relit, 1.0, 0.8, 0.0, 0.8, 0.7)

        output_small = torch.nn.functional.interpolate(
            output.permute(0, 3, 1, 2), size=(96, 72), mode="area"
        ).permute(0, 2, 3, 1)
        before = torch.mean(torch.abs(small - relit))
        after = torch.mean(torch.abs(output_small - relit))
        self.assertLess(float(after), float(before) * 0.45)

        source_detail = original - torch.nn.functional.avg_pool2d(
            original.permute(0, 3, 1, 2), 5, 1, 2
        ).permute(0, 2, 3, 1)
        output_detail = output - torch.nn.functional.avg_pool2d(
            output.permute(0, 3, 1, 2), 5, 1, 2
        ).permute(0, 2, 3, 1)
        correlation = torch.corrcoef(torch.stack((source_detail.flatten(), output_detail.flatten())))[0, 1]
        self.assertGreater(float(correlation), 0.90)

    def test_misaligned_colored_edge_does_not_create_magenta_halo(self):
        original = torch.full((1, 192, 144, 3), 0.42)
        original[:, 48:155, 78:118, :] = torch.tensor((0.04, 0.26, 0.06))
        relit = torch.nn.functional.interpolate(
            original.permute(0, 3, 1, 2), size=(96, 72), mode="area"
        ).permute(0, 2, 3, 1)
        relit = relit * torch.tensor((1.18, 1.02, 0.78))
        relit[:, 24:78, 42:62, :] = torch.tensor((0.05, 0.30, 0.07))
        output, _ = self.node.redeem_light(original, relit, 1.0, 0.82, 1.0, 0.78, 0.65)

        edge_band = output[0, 45:158, 73:124]
        magenta_excess = edge_band[..., 0] + edge_band[..., 2] - 2.0 * edge_band[..., 1]
        self.assertLess(float(magenta_excess.max()), 0.12)

    def test_warm_highlight_color_is_preserved_without_tinting_shadows(self):
        original = torch.full((1, 192, 144, 3), 0.48)
        small = torch.nn.functional.interpolate(
            original.permute(0, 3, 1, 2), size=(96, 72), mode="area"
        ).permute(0, 2, 3, 1)
        relit = small.clone() * 0.72
        relit[:, 18:76, 22:58, :] = torch.clamp(
            small[:, 18:76, 22:58, :] * torch.tensor((1.55, 1.18, 0.72)), 0.0, 1.0
        )
        output, _ = self.node.redeem_light(original, relit, 1.0, 0.85, 1.0, 0.8, 0.65)

        lit = output[0, 42:142, 50:110]
        shadow = output[0, 2:30, 2:30]
        self.assertGreater(float((lit[..., 0] - lit[..., 2]).mean()), 0.14)
        self.assertLess(float(torch.abs(shadow[..., 0] - shadow[..., 2]).mean()), 0.035)


if __name__ == "__main__":
    unittest.main()
