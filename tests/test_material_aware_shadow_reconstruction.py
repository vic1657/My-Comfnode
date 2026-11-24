from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest

import torch


MODULE_PATH = Path(__file__).resolve().parents[1] / "material_aware_shadow_reconstruction.py"
SPEC = importlib.util.spec_from_file_location("material_aware_shadow_reconstruction_under_test", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class MaterialAwareShadowReconstructionTests(unittest.TestCase):
    @staticmethod
    def synthetic(height=80, width=96):
        x = torch.linspace(0.72, 0.84, width).view(1, 1, width, 1)
        background = x.expand(1, height, width, 3).clone()
        background[:, 14:44, 20:68] *= 0.58
        composite = background.clone()
        stripes = ((torch.arange(width) % 2) * 2 - 1).float() * 0.045
        composite[:, 10:66, 16:78] = (
            0.72 + stripes.view(1, 1, width, 1)[:, :, 16:78]
        ).expand(1, 56, 62, 3)
        return background, composite

    def test_shadow_is_rebuilt_only_on_the_target(self):
        background, composite = self.synthetic()
        mask = torch.zeros(1, 80, 96)
        mask[:, 10:66, 16:78] = 1.0

        fused, actual, decomposition = MODULE.reconstruct_material_aware_shadow(
            background, composite, mask,
            shadow_strength=0.8,
            shadow_threshold=0.01,
            extraction_scale=12.0,
            edge_preservation=0.7,
            region_shrink=0.0,
        )

        self.assertEqual(tuple(fused.shape), (1, 80, 96, 3))
        self.assertEqual(tuple(actual.shape), (1, 80, 96))
        self.assertEqual(tuple(decomposition.shape), (1, 80, 96, 3))
        self.assertLess(float(fused[:, 22:38, 30:58].mean()), float(composite[:, 22:38, 30:58].mean()))
        self.assertLess(float((fused[:, :7] - composite[:, :7]).abs().max()), 0.001)
        self.assertGreater(float(actual[:, 22:38, 30:58].mean()), 0.05)

    def test_high_frequency_material_detail_is_preserved(self):
        background, composite = self.synthetic()
        mask = torch.ones(1, 80, 96)
        fused, _, _ = MODULE.reconstruct_material_aware_shadow(
            background, composite, mask,
            shadow_strength=0.9,
            shadow_threshold=0.01,
            extraction_scale=12.0,
            edge_preservation=0.65,
            highlight_protection=0.9,
            region_shrink=0.0,
        )

        before = (composite[:, 24:38, 31:59] - composite[:, 24:38, 30:58]).abs().mean()
        after = (fused[:, 24:38, 31:59] - fused[:, 24:38, 30:58]).abs().mean()
        self.assertGreater(float(after / before), 0.90)

    def test_highlight_protection_reduces_specular_darkening(self):
        background, composite = self.synthetic()
        composite[:, 20:40, 44:48] = 0.98
        mask = torch.ones(1, 80, 96)
        protected, _, _ = MODULE.reconstruct_material_aware_shadow(
            background, composite, mask, 0.9, 0.01, 12.0, 0.65, 1.0, 0.5, 0.0)
        unprotected, _, _ = MODULE.reconstruct_material_aware_shadow(
            background, composite, mask, 0.9, 0.01, 12.0, 0.65, 0.0, 0.5, 0.0)

        protected_loss = composite[:, 24:36, 44:48].mean() - protected[:, 24:36, 44:48].mean()
        unprotected_loss = composite[:, 24:36, 44:48].mean() - unprotected[:, 24:36, 44:48].mean()
        self.assertLess(float(protected_loss), float(unprotected_loss))

    def test_soft_light_shadow_preserves_base_chroma(self):
        background = torch.full((1, 80, 96, 3), 0.82)
        background[:, 14:48, 18:72] *= 0.55
        composite = torch.empty_like(background)
        composite[..., 0] = 0.72
        composite[..., 1] = 0.82
        composite[..., 2] = 0.88
        mask = torch.ones(1, 80, 96)

        fused, _, _ = MODULE.reconstruct_material_aware_shadow(
            background,
            composite,
            mask,
            shadow_strength=0.9,
            shadow_threshold=0.01,
            extraction_scale=12.0,
            edge_preservation=0.9,
            highlight_protection=0.0,
            region_shrink=0.0,
            existing_shadow_protection=0.0,
        )

        before = composite[:, 22:40, 28:62]
        after = fused[:, 22:40, 28:62]
        before_chroma = before.max(dim=-1).values - before.min(dim=-1).values
        after_chroma = after.max(dim=-1).values - after.min(dim=-1).values
        self.assertLess(float(after.mean()), float(before.mean()))
        self.assertGreater(float(after_chroma.mean() / before_chroma.mean()), 0.95)

    def test_flat_background_creates_no_shadow(self):
        background = torch.full((1, 48, 64, 3), 0.7)
        composite = torch.full((1, 48, 64, 3), 0.5)
        mask = torch.ones(1, 48, 64)
        fused, actual, _ = MODULE.reconstruct_material_aware_shadow(
            background, composite, mask, extraction_scale=10.0, region_shrink=0.0)

        self.assertLess(float((fused - composite).abs().max()), 0.001)
        self.assertLess(float(actual.max()), 0.001)

    def test_existing_shadow_is_not_applied_twice(self):
        background, _ = self.synthetic()
        mask = torch.ones(1, 80, 96)
        fused, actual, _ = MODULE.reconstruct_material_aware_shadow(
            background,
            background.clone(),
            mask,
            shadow_strength=1.0,
            shadow_threshold=0.0,
            extraction_scale=12.0,
            region_shrink=0.0,
            existing_shadow_protection=1.0,
        )

        self.assertLess(float((fused - background).abs().max()), 0.001)
        self.assertLess(float(actual.max()), 0.001)

    def test_auto_region_ignores_global_color_shift(self):
        background, composite = self.synthetic()
        composite = (background * 1.025 + 0.012).clamp(0.0, 1.0)
        composite[:, 18:62, 24:76] = 0.70

        auto_mask = MODULE._auto_target_mask(
            background.permute(0, 3, 1, 2),
            composite.permute(0, 3, 1, 2),
            0.58,
        )

        self.assertGreater(float(auto_mask[:, :, 24:56, 30:70].mean()), 0.80)
        self.assertLess(float(auto_mask[:, :, :8, :].mean()), 0.05)

    def test_chinese_interface(self):
        node = MODULE.MyMaterialAwareShadowReconstruction
        required = node.INPUT_TYPES()["required"]
        self.assertIn("高光保护", required)
        self.assertIn("已有阴影保护", required)
        self.assertIn("边缘保留", required)
        self.assertEqual(node.RETURN_NAMES, ("阴影重建图", "实际阴影遮罩", "光照分解图"))
        self.assertEqual(MODULE.NODE_DISPLAY_NAME_MAPPINGS["MyMaterialAwareShadowReconstruction"],
                         "My材质感知阴影重建")


if __name__ == "__main__":
    unittest.main()
