from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import types
import unittest

import numpy as np
import torch


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "my_texture.py"


class MyTextureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.previous_nodes = sys.modules.get("nodes")
        nodes = types.ModuleType("nodes")
        nodes.MAX_RESOLUTION = 8192
        sys.modules["nodes"] = nodes
        spec = importlib.util.spec_from_file_location("my_texture_under_test", MODULE_PATH)
        cls.module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(cls.module)

    @classmethod
    def tearDownClass(cls):
        if cls.previous_nodes is None:
            sys.modules.pop("nodes", None)
        else:
            sys.modules["nodes"] = cls.previous_nodes

    def test_node_interface_is_chinese_and_connectable(self):
        required = self.module.MyTexture.INPUT_TYPES()["required"]
        optional = self.module.MyTexture.INPUT_TYPES()["optional"]
        self.assertIn("bg_img", required)
        self.assertIn("bg_depth_map", required)
        self.assertIn("bg_mask", required)
        self.assertIn("fg_img_1", required)
        self.assertIn("t_data", required)
        self.assertIn("fg_img_2", optional)
        self.assertEqual(list(optional), ["fg_img_2", "fg_alpha_mask_1", "fg_alpha_mask_2"])
        self.assertNotIn("中心X", required)
        self.assertNotIn("缩放(%)", required)
        self.assertIn("混合模式", required)
        self.assertEqual(self.module.MyTexture.RETURN_TYPES, ("IMAGE", "STRING", "MASK"))
        self.assertEqual(self.module.NODE_DISPLAY_NAME_MAPPINGS["MyComfnodeTexture"], "My贴图")

    def test_reference_texture_controls_are_exposed(self):
        required = self.module.MyTexture.INPUT_TYPES()["required"]
        controls = ["形变强度", "透明度", "水平倾斜", "垂直倾斜", "水平拉伸", "垂直拉伸", "混合模式"]
        # t_data is a serialized widget hidden by the frontend; only the seven
        # visual controls are exposed to the user.
        self.assertEqual(list(required)[4:-1], controls)
        self.assertEqual(list(required)[-1], "t_data")
        self.assertEqual(required["形变强度"][1], {"default": 0.3, "min": 0.0, "max": 1.0, "step": 0.01})
        self.assertEqual(required["透明度"][1]["default"], 1.0)
        self.assertEqual(required["水平倾斜"][1]["min"], -1.0)
        self.assertEqual(required["垂直倾斜"][1]["max"], 1.0)
        self.assertEqual(required["水平拉伸"][1]["min"], 0.1)
        self.assertEqual(required["垂直拉伸"][1]["max"], 3.0)
        self.assertIn("hologram", required["混合模式"][0])

    def test_normal_blend_places_texture_and_outputs_mask(self):
        background = torch.zeros(1, 64, 80, 3)
        texture = torch.zeros(1, 20, 20, 3)
        texture[..., 0] = 1.0
        result = self.module.MyTexture().apply_texture(
            bg_img=background,
            bg_depth_map=background,
            t_data='{"currentLayer_1":{"offset":[0.3,0.3],"scale":[0.4,0.4],"rotation":0}}',
            bg_mask=torch.ones(1, 64, 80),
            fg_img_1=texture,
            
        )
        image, layer_data, mask = result["result"]
        self.assertEqual(tuple(image.shape), (1, 64, 80, 3))
        self.assertEqual(tuple(mask.shape), (1, 64, 80))
        self.assertGreater(float(image[:, 30:34, 38:42, 0].mean()), 0.9)
        self.assertLess(float(image[:, :8, :8, 0].max()), 0.01)
        self.assertGreater(float(mask[:, 30:34, 38:42].mean()), 0.9)
        self.assertIn("my_texture_preview", result["ui"])
        self.assertIn("currentLayer_1", layer_data)

    def test_mask_and_batch_broadcast_are_respected(self):
        background = torch.zeros(2, 40, 40, 3)
        texture = torch.ones(1, 20, 20, 3)
        background_mask = torch.zeros(2, 40, 40)
        background_mask[:, :, 20:] = 1.0
        result = self.module.MyTexture().apply_texture(
            bg_img=background,
            bg_depth_map=background,
            t_data='{"offset":[0.3,0.3],"scale":[0.4,0.4]}',
            bg_mask=background_mask,
            fg_img_1=texture,
            
        )
        image, _, mask = result["result"]
        self.assertEqual(tuple(image.shape), (2, 40, 40, 3))
        self.assertLess(float(mask[:, 19:21, 11:15].max()), 0.01)
        self.assertGreater(float(mask[:, 19:21, 24:27].mean()), 0.9)

    def test_load_image_style_mask_treats_white_as_transparent_by_default(self):
        background = torch.zeros(1, 40, 40, 3)
        texture = torch.ones(1, 20, 20, 3)
        background_mask = torch.zeros(1, 40, 40)
        background_mask[:, :, 20:] = 1.0
        result = self.module.MyTexture().apply_texture(
            bg_img=background,
            bg_depth_map=background,
            t_data='{"offset":[0.3,0.3],"scale":[0.4,0.4]}',
            bg_mask=background_mask,
            fg_img_1=texture,
            
        )
        _, _, mask = result["result"]
        self.assertLess(float(mask[:, 19:21, 11:15].max()), 0.01)
        self.assertGreater(float(mask[:, 19:21, 24:27].mean()), 0.9)

    def test_t_data_drives_two_layer_positions(self):
        background = torch.zeros(1, 32, 32, 3)
        depth = torch.full((1, 32, 32, 3), 0.5)
        first = torch.zeros(1, 8, 8, 3)
        first[..., 0] = 1.0
        second = torch.zeros(1, 8, 8, 3)
        second[..., 1] = 1.0
        result = self.module.MyTexture().apply_texture(
            bg_img=background,
            bg_depth_map=depth,
            bg_mask=torch.ones(1, 32, 32),
            fg_img_1=first,
            fg_img_2=second,
            t_data='{"currentLayer_1":{"offset":[0.1,0.1],"scale":[0.25,0.25]},'
                    '"currentLayer_2":{"offset":[0.6,0.6],"scale":[0.25,0.25]}}',
        )
        image, layer_data, mask = result["result"]
        self.assertGreater(float(image[:, 4:10, 4:10, 0].mean()), 0.9)
        self.assertGreater(float(image[:, 20:26, 20:26, 1].mean()), 0.9)
        self.assertEqual(tuple(mask.shape), (1, 32, 32))
        self.assertIn("currentLayer_1", layer_data)

    def test_reference_controls_change_composite(self):
        background = torch.full((1, 48, 48, 3), 0.5)
        depth = torch.linspace(0, 1, 48).view(1, 1, 48, 1).expand(1, 48, 48, 3)
        texture = torch.zeros(1, 16, 16, 3)
        texture[..., 0] = 1.0
        common = dict(
            bg_img=background,
            bg_depth_map=depth,
            bg_mask=torch.ones(1, 48, 48),
            fg_img_1=texture,
            t_data='{"offset":[0.25,0.25],"scale":[0.5,0.5]}',
        )
        transparent = self.module.MyTexture().apply_texture(**common, 透明度=0.0)["result"][0]
        transformed = self.module.MyTexture().apply_texture(
            **common,
            形变强度=0.8,
            透明度=1.0,
            水平倾斜=0.3,
            垂直倾斜=-0.2,
            水平拉伸=1.5,
            垂直拉伸=0.7,
            混合模式="multiply",
        )["result"][0]
        self.assertTrue(torch.allclose(transparent, background))
        self.assertGreater(float(torch.abs(transformed - background).mean()), 0.01)

    def test_transparent_png_mask_and_source_aspect_are_preserved(self):
        background = torch.zeros(1, 100, 100, 3)
        texture = torch.zeros(1, 10, 40, 3)
        texture[..., 0] = 1.0
        # Core LoadImage emits white for source-transparent pixels.
        transparent_mask = torch.zeros(1, 10, 40)
        transparent_mask[:, :, :20] = 1.0
        image, _, mask = self.module.MyTexture().apply_texture(
            bg_img=background,
            bg_depth_map=background,
            bg_mask=torch.ones(1, 100, 100),
            fg_img_1=texture,
            fg_alpha_mask_1=transparent_mask,
            t_data='{"offset":[0.1,0.1],"scale":[0.5,0.5]}',
        )["result"]
        # 4:1 source stays 4:1, and its transparent half remains invisible.
        # Lanczos interpolation can leave a sub-pixel edge halo; it must not
        # become an opaque rectangular background.
        self.assertLess(float(mask[:, 12:22, 12:35].max()), 0.1)
        self.assertGreater(float(mask[:, 12:22, 38:58].mean()), 0.9)
        self.assertGreater(float(image[:, 12:22, 38:58, 0].mean()), 0.9)

    def test_surface_crop_uses_the_texture_placement_region(self):
        surface = np.arange(48, dtype=np.float32).reshape(6, 8) / 47.0
        cropped = self.module._surface_crop(surface, 3, 2, 3, 2, 8, 6)
        np.testing.assert_allclose(cropped, surface[2:4, 3:6])

    def test_surface_shading_transfers_garment_light_variation(self):
        overlay = np.ones((8, 12, 4), dtype=np.float32) * 0.6
        overlay[..., 3] = 1.0
        luminance = np.tile(np.linspace(0.1, 0.9, 12, dtype=np.float32), (8, 1))
        shaded = self.module._apply_surface_shading(overlay, luminance, 1.0)
        self.assertLess(float(shaded[:, :3, :3].mean()), float(shaded[:, -3:, :3].mean()))
        np.testing.assert_allclose(shaded[..., 3], overlay[..., 3])

    def test_surface_shading_adds_fold_detail_without_changing_alpha(self):
        overlay = np.ones((24, 36, 4), dtype=np.float32) * 0.7
        overlay[..., 3] = 1.0
        luminance = np.full((24, 36), 0.72, dtype=np.float32)
        luminance[:, 17:19] = 0.40
        shaded = self.module._apply_surface_shading(overlay, luminance, 0.6)
        self.assertEqual(shaded.shape, overlay.shape)
        self.assertLess(float(shaded[:, 17:19, :3].mean()), float(shaded[:, 10:14, :3].mean()))
        np.testing.assert_allclose(shaded[..., 3], overlay[..., 3])

    def test_depth_warp_is_smooth_and_keeps_premultiplied_alpha_intact(self):
        overlay = np.zeros((48, 64, 4), dtype=np.float32)
        overlay[..., :3] = (0.9, 0.2, 0.1)
        overlay[..., 3] = 1.0
        yy, xx = np.mgrid[0:48, 0:64].astype(np.float32)
        depth = np.clip((xx / 64.0) * 0.7 + (yy / 48.0) * 0.3, 0.0, 1.0)
        warped = self.module._depth_warp_overlay(overlay, depth, 0.8)
        self.assertEqual(warped.shape, overlay.shape)
        self.assertGreater(float(warped[..., 3].mean()), 0.95)
        self.assertLess(float(np.abs(np.diff(warped[2:-2, 2:-2, 0], axis=0)).max()), 0.2)
        self.assertLess(float(np.abs(np.diff(warped[2:-2, 2:-2, 1], axis=1)).max()), 0.2)

    def test_free_transform_state_and_quad_warp_are_preserved(self):
        payload = (
            '{"currentLayer_1":{"offset":[0.2,0.2],"scale":[0.4,0.4],'
            '"rotation":0,"free_transform":true,'
            '"corners":[[0.2,0.2],[0.8,0.3],[0.7,0.8],[0.25,0.7]]}}'
        )
        state = self.module._layer_transform(payload, 1, 100, 100)
        self.assertTrue(state["free_transform"])
        self.assertEqual(len(state["corners"]), 4)

        texture = np.ones((20, 40, 4), dtype=np.float32)
        texture[..., 1:3] = 0.0
        warped, left, top = self.module._warp_overlay_to_quad(texture, state["corners"], 100, 100)
        self.assertEqual((left, top), (20, 20))
        self.assertGreater(float(warped[..., 3].mean()), 0.45)
        self.assertGreater(float(warped[warped.shape[0] // 2, warped.shape[1] // 2, 0]), 0.9)

    def test_apply_texture_uses_free_transform_corners(self):
        background = torch.zeros(1, 100, 100, 3)
        texture = torch.zeros(1, 20, 40, 3)
        texture[..., 0] = 1.0
        payload = (
            '{"currentLayer_1":{"free_transform":true,'
            '"corners":[[0.2,0.2],[0.8,0.3],[0.7,0.8],[0.25,0.7]]}}'
        )
        image, layer_data, mask = self.module.MyTexture().apply_texture(
            bg_img=background,
            bg_depth_map=background,
            bg_mask=torch.ones(1, 100, 100),
            fg_img_1=texture,
            t_data=payload,
        )["result"]
        self.assertGreater(float(mask[0, 50, 50]), 0.8)
        self.assertLess(float(mask[0, 10, 10]), 0.01)
        self.assertGreater(float(image[0, 50, 50, 0]), 0.8)
        self.assertIn('"free_transform":true', layer_data)


if __name__ == "__main__":
    unittest.main()
