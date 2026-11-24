from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest

import torch


MODULE_PATH = Path(__file__).resolve().parents[1] / "ps_transparent_shadow_layer.py"
SPEC = importlib.util.spec_from_file_location("ps_transparent_shadow_layer_under_test", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class PSTransparentShadowLayerTests(unittest.TestCase):
    @staticmethod
    def synthetic(height=80, width=96):
        background = torch.full((1, height, width, 3), 0.82)
        background[:, 14:48, 18:72] *= 0.56
        composite = torch.empty_like(background)
        composite[..., 0] = 0.72
        composite[..., 1] = 0.82
        composite[..., 2] = 0.88
        return background, composite

    def test_outputs_transparent_rgba_layer(self):
        background, composite = self.synthetic()
        mask = torch.ones(1, 80, 96)
        fused, layer, actual = MODULE.composite_ps_shadow_layer(
            background,
            composite,
            mask,
            layer_opacity=0.4,
            extraction_scale=12.0,
            shadow_threshold=0.01,
            region_shrink=0.0,
        )

        self.assertEqual(tuple(fused.shape), (1, 80, 96, 3))
        self.assertEqual(tuple(layer.shape), (1, 80, 96, 4))
        self.assertEqual(tuple(actual.shape), (1, 80, 96))
        self.assertGreater(float(layer[:, 22:40, 28:62, 3].mean()), 0.05)
        self.assertLess(float(layer[:, :8, :, 3].max()), 0.01)

    def test_target_mask_clips_the_shadow_layer(self):
        background, composite = self.synthetic()
        mask = torch.zeros(1, 80, 96)
        mask[:, 20:42, 28:52] = 1.0
        fused, _, actual = MODULE.composite_ps_shadow_layer(
            background,
            composite,
            mask,
            layer_opacity=0.5,
            extraction_scale=12.0,
            shadow_threshold=0.01,
            region_shrink=0.0,
        )

        self.assertLess(float((fused[:, :12] - composite[:, :12]).abs().max()), 0.001)
        self.assertGreater(float(actual[:, 24:36, 32:48].mean()), 0.03)
        self.assertLess(float(actual[:, 24:36, 58:68].max()), 0.001)

    def test_soft_light_preserves_source_chroma(self):
        background, composite = self.synthetic()
        mask = torch.ones(1, 80, 96)
        fused, _, _ = MODULE.composite_ps_shadow_layer(
            background,
            composite,
            mask,
            blend_mode="柔光",
            layer_opacity=0.5,
            extraction_scale=12.0,
            shadow_threshold=0.01,
            region_shrink=0.0,
        )

        before = composite[:, 24:38, 30:58]
        after = fused[:, 24:38, 30:58]
        before_chroma = before.max(dim=-1).values - before.min(dim=-1).values
        after_chroma = after.max(dim=-1).values - after.min(dim=-1).values
        self.assertLess(float(after.mean()), float(before.mean()))
        self.assertGreater(float(after_chroma.mean() / before_chroma.mean()), 0.95)

    def test_zero_opacity_keeps_the_composite(self):
        background, composite = self.synthetic()
        fused, layer, actual = MODULE.composite_ps_shadow_layer(
            background,
            composite,
            torch.ones(1, 80, 96),
            layer_opacity=0.0,
            extraction_scale=12.0,
            shadow_threshold=0.01,
            region_shrink=0.0,
        )

        self.assertLess(float((fused - composite).abs().max()), 0.001)
        self.assertLess(float(layer[..., 3].max()), 0.001)
        self.assertLess(float(actual.max()), 0.001)

    def test_chinese_interface(self):
        node = MODULE.MyPSTransparentShadowLayer
        required = node.INPUT_TYPES()["required"]
        self.assertIn("图层不透明度", required)
        self.assertIn("阴影色调", required)
        self.assertEqual(node.RETURN_NAMES, ("融合图", "透明阴影层", "实际叠加遮罩"))
        self.assertEqual(
            MODULE.NODE_DISPLAY_NAME_MAPPINGS["MyPSTransparentShadowLayer"],
            "MyPS透明阴影图层",
        )


if __name__ == "__main__":
    unittest.main()
