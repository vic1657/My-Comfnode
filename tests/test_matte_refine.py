from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest

import torch


ROOT = Path(__file__).resolve().parents[1]
COMFY_ROOT = ROOT.parents[1]
if str(COMFY_ROOT) not in sys.path:
    sys.path.insert(0, str(COMFY_ROOT))
MODULE_PATH = ROOT / "matte_refine.py"
SPEC = importlib.util.spec_from_file_location("matte_refine_under_test", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class MatteRefineTests(unittest.TestCase):
    def test_refine_keeps_shape_and_reduces_background_like_hair_gap(self):
        image = torch.full((1, 64, 64, 3), 0.08, dtype=torch.float32)
        mask = torch.zeros((1, 64, 64), dtype=torch.float32)
        mask[:, 12:52, 12:52] = 1.0

        image[:, 12:52, 12:52] = torch.tensor([0.72, 0.48, 0.36])
        image[:, 18:46, 14:18] = 0.08
        image[:, 18:46, 20:22] = torch.tensor([0.22, 0.12, 0.08])
        hair_region = torch.zeros_like(mask)
        hair_region[:, 12:52, 12:24] = 1.0

        refined_image, refined_mask = MODULE.refine_matte(
            image,
            mask,
            hair_region=hair_region,
            edge_radius=10,
            decontaminate_strength=0.9,
            background_tolerance=0.35,
            hair_detail_protect=0.2,
            mask_clean=0.8,
            edge_feather=0.0,
        )

        self.assertEqual(tuple(refined_image.shape), tuple(image.shape))
        self.assertEqual(tuple(refined_mask.shape), tuple(mask.shape))
        self.assertLess(float(refined_mask[0, 24, 15]), 0.6)
        self.assertGreater(float(refined_mask[0, 24, 21]), float(refined_mask[0, 24, 15]))

    def test_optional_background_image_is_accepted(self):
        image = torch.rand((2, 24, 32, 3), dtype=torch.float32)
        mask = torch.ones((1, 24, 32), dtype=torch.float32)
        background = torch.zeros((1, 24, 32, 3), dtype=torch.float32)

        transparent_image, refined_mask, refined_image = MODULE.MyMatteRefine().process(
            image=image,
            mask=mask,
            mode="使用输入遮罩细化",
            internal_hair_refine="关闭",
            background=background,
        )

        self.assertEqual(tuple(transparent_image.shape), (2, 24, 32, 4))
        self.assertEqual(tuple(refined_image.shape), tuple(image.shape))
        self.assertEqual(tuple(refined_mask.shape), (2, 24, 32))

    def test_ps_style_decontamination_recovers_foreground_color(self):
        background = torch.full((1, 64, 64, 3), 0.92, dtype=torch.float32)
        foreground_color = torch.tensor([0.20, 0.09, 0.045], dtype=torch.float32)
        true_alpha = torch.zeros((1, 64, 64), dtype=torch.float32)
        true_alpha[:, 12:52, 12:52] = 1.0
        true_alpha[:, 12:52, 8:12] = torch.tensor([0.20, 0.40, 0.65, 0.85]).view(1, 1, 4)
        image = (
            foreground_color.view(1, 1, 1, 3) * true_alpha.unsqueeze(-1)
            + background * (1.0 - true_alpha.unsqueeze(-1))
        )
        inflated_mask = true_alpha.clone()
        inflated_mask[:, 12:52, 8:12] = (inflated_mask[:, 12:52, 8:12] + 0.12).clamp(0.0, 1.0)

        refined_image, refined_mask = MODULE.refine_matte(
            image,
            inflated_mask,
            background=background,
            edge_radius=8,
            decontaminate_strength=1.0,
            background_tolerance=0.20,
            hair_detail_protect=0.0,
            mask_clean=1.0,
            edge_feather=0.0,
            fringe_suppression=0.25,
            quality="精细",
        )

        sample = (0, 24, 10)
        before_error = torch.mean(torch.abs(image[sample] - foreground_color))
        after_error = torch.mean(torch.abs(refined_image[sample] - foreground_color))
        self.assertLess(float(after_error), float(before_error) * 0.55)
        self.assertLess(abs(float(refined_mask[sample]) - 0.65), 0.12)

    def test_ps_style_keeps_opaque_subject_pixels_unchanged(self):
        image = torch.rand((1, 48, 48, 3), dtype=torch.float32)
        mask = torch.zeros((1, 48, 48), dtype=torch.float32)
        mask[:, 8:40, 8:40] = 1.0

        refined_image, refined_mask = MODULE.refine_matte(
            image,
            mask,
            edge_radius=6,
            decontaminate_strength=1.0,
            mask_clean=1.0,
            edge_feather=0.0,
            quality="精细",
        )

        self.assertTrue(torch.equal(refined_image[:, 16:32, 16:32], image[:, 16:32, 16:32]))
        self.assertTrue(torch.equal(refined_mask[:, 16:32, 16:32], mask[:, 16:32, 16:32]))

    def test_semantic_hair_region_refines_background_like_pixels_inside_opaque_mask(self):
        image = torch.full((1, 80, 80, 3), 0.92, dtype=torch.float32)
        mask = torch.zeros((1, 80, 80), dtype=torch.float32)
        mask[:, 8:72, 8:72] = 1.0
        image[:, 8:72, 8:72] = torch.tensor([0.20, 0.09, 0.04])
        image[:, 36:44, 36:44] = 0.72
        hair = torch.zeros_like(mask)
        hair[:, 20:60, 20:60] = 1.0

        _, without_hair = MODULE.refine_matte(
            image,
            mask,
            edge_radius=5,
            mask_clean=1.0,
            edge_feather=0.0,
            quality="精细",
        )
        _, with_hair = MODULE.refine_matte(
            image,
            mask,
            hair_region=hair,
            edge_radius=5,
            mask_clean=1.0,
            edge_feather=0.0,
            quality="精细",
        )

        self.assertEqual(float(without_hair[0, 40, 40]), 1.0)
        self.assertLess(float(with_hair[0, 40, 40]), 0.9)

    def test_body_edge_protection_prevents_excessive_alpha_erosion(self):
        image = torch.full((1, 64, 64, 3), 0.92, dtype=torch.float32)
        mask = torch.zeros((1, 64, 64), dtype=torch.float32)
        mask[:, 8:56, 8:56] = 1.0
        image[:, 8:56, 8:56] = torch.tensor([0.20, 0.09, 0.04])
        image[:, 8:56, 8:12] = 0.72

        _, refined_mask = MODULE.refine_matte(
            image,
            mask,
            edge_radius=8,
            mask_clean=1.0,
            body_edge_protect=0.85,
            edge_feather=0.0,
            quality="精细",
        )

        self.assertGreaterEqual(float(refined_mask[0, 32, 9]), 0.85)

    def test_auto_mask_converts_rgba_input_to_rgb_before_rmbg(self):
        captured = {}

        class FakeRmbgNode:
            def process_image(self, image, **_kwargs):
                captured["shape"] = tuple(image.shape)
                mask = torch.ones((image.shape[0], image.shape[1], image.shape[2]), dtype=image.dtype)
                return image, mask

        previous = MODULE._RMBG_NODE
        MODULE._RMBG_NODE = FakeRmbgNode()
        try:
            rgba = torch.rand((1, 16, 20, 4), dtype=torch.float32)
            mask = MODULE._rmbg_mask(rgba, process_res=512, sensitivity=1.0)
        finally:
            MODULE._RMBG_NODE = previous

        self.assertEqual(captured["shape"], (1, 16, 20, 3))
        self.assertEqual(tuple(mask.shape), (1, 16, 20))

    def test_connected_mask_is_used_without_running_rmbg_again(self):
        class FailingRmbgNode:
            def process_image(self, **_kwargs):
                raise AssertionError("连接遮罩后不应再次运行 RMBG")

        previous = MODULE._RMBG_NODE
        MODULE._RMBG_NODE = FailingRmbgNode()
        try:
            image = torch.rand((1, 20, 24, 3), dtype=torch.float32)
            mask = torch.ones((1, 20, 24), dtype=torch.float32)
            result = MODULE.MyMatteRefine.execute(
                image=image,
                mask=mask,
                mode="自动抠图并细化",
                internal_hair_refine="关闭",
                edge_feather=0.0,
            )
        finally:
            MODULE._RMBG_NODE = previous

        self.assertIsNotNone(result)

    def test_vitmatte_trimap_marks_a_wide_internal_band_as_unknown(self):
        mask = torch.zeros((1, 64, 64), dtype=torch.float32)
        mask[:, 8:56, 8:56] = 1.0

        trimap, uncertain = MODULE._vitmatte_trimap(mask, internal_radius=72)

        self.assertEqual(float(trimap[0, 32, 32]), 1.0)
        self.assertEqual(float(trimap[0, 12, 32]), 0.5)
        self.assertEqual(float(uncertain[0, 12, 32]), 1.0)
        self.assertEqual(float(trimap[0, 0, 0]), 0.0)

    def test_semantic_hair_does_not_unlock_unrelated_subject_interior(self):
        image = torch.rand((1, 80, 80, 3), dtype=torch.float32)
        mask = torch.zeros((1, 80, 80), dtype=torch.float32)
        mask[:, 8:72, 8:72] = 1.0
        hair = torch.zeros_like(mask)
        hair[:, 12:30, 12:30] = 1.0

        refined_image, refined_mask = MODULE.refine_matte(
            image,
            mask,
            hair_region=hair,
            edge_radius=6,
            mask_clean=1.0,
            edge_feather=0.0,
            quality="精细",
        )

        self.assertTrue(torch.equal(refined_image[:, 38:50, 38:50], image[:, 38:50, 38:50]))
        self.assertTrue(torch.equal(refined_mask[:, 38:50, 38:50], mask[:, 38:50, 38:50]))

    def test_vitmatte_trimap_marks_semantic_hair_inside_subject_as_unknown(self):
        mask = torch.zeros((1, 64, 64), dtype=torch.float32)
        mask[:, 4:60, 4:60] = 1.0
        hair = torch.zeros_like(mask)
        hair[:, 18:30, 18:30] = 1.0

        trimap, uncertain = MODULE._vitmatte_trimap(
            mask,
            internal_radius=6,
            hair_region=hair,
        )

        self.assertEqual(float(trimap[0, 24, 24]), 0.5)
        self.assertEqual(float(uncertain[0, 24, 24]), 1.0)
        self.assertEqual(float(trimap[0, 40, 40]), 1.0)


if __name__ == "__main__":
    unittest.main()
