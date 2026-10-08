from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import tempfile
import types
import unittest

import numpy as np
from PIL import Image
import torch


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "image_mask_brush.py"


class FakeLoadImage:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"image": (("sample.png",), {"image_upload": True})}}

    def load_image(self, image):
        return torch.full((2, 3, 4, 3), 0.25), torch.zeros((2, 3, 4))

    @classmethod
    def IS_CHANGED(cls, image):
        return f"image:{image}"

    @classmethod
    def VALIDATE_INPUTS(cls, image):
        return True


FOLDER_PATHS = types.ModuleType("folder_paths")
FOLDER_PATHS.root = Path(".")
FOLDER_PATHS.get_annotated_filepath = lambda value: str(FOLDER_PATHS.root / str(value).split(" [", 1)[0])
FOLDER_PATHS.exists_annotated_filepath = lambda value: Path(FOLDER_PATHS.get_annotated_filepath(value)).is_file()

NODE_HELPERS = types.ModuleType("node_helpers")
NODE_HELPERS.pillow = lambda function, *args, **kwargs: function(*args, **kwargs)

NODES = types.ModuleType("nodes")
NODES.LoadImage = FakeLoadImage

PREVIOUS_MODULES = {name: sys.modules.get(name) for name in ("folder_paths", "node_helpers", "nodes")}
sys.modules["folder_paths"] = FOLDER_PATHS
sys.modules["node_helpers"] = NODE_HELPERS
sys.modules["nodes"] = NODES
try:
    SPEC = importlib.util.spec_from_file_location("image_mask_brush_under_test", MODULE_PATH)
    MODULE = importlib.util.module_from_spec(SPEC)
    assert SPEC.loader is not None
    SPEC.loader.exec_module(MODULE)
finally:
    for name, previous in PREVIOUS_MODULES.items():
        if previous is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = previous


class ImageMaskBrushTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        FOLDER_PATHS.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_interface_keeps_native_image_upload_and_appends_original_name(self):
        inputs = MODULE.MyImageMaskBrush.INPUT_TYPES()["required"]

        self.assertTrue(inputs["image"][1]["image_upload"])
        self.assertEqual(inputs["mask_file"][0], "STRING")
        self.assertEqual(inputs["inverse_mask_file"][0], "STRING")
        self.assertEqual(MODULE.MyImageMaskBrush.RETURN_TYPES, ("IMAGE", "MASK", "MASK", "STRING"))
        self.assertEqual(MODULE.MyImageMaskBrush.RETURN_NAMES, ("图像", "手绘遮罩", "反向遮罩", "原图原名称"))
        self.assertEqual(MODULE.MyImageMaskBrush.CATEGORY, "My-Comfnode/图像")

    def test_explicit_original_name_survives_edited_image_filename(self):
        result = MODULE.MyImageMaskBrush().load_image_with_mask(
            "edited-image-123.jpg",
            original_name="原图名称",
        )
        self.assertEqual(result[3], "原图名称")

    def test_legacy_upload_widget_value_is_not_used_as_original_name(self):
        result = MODULE.MyImageMaskBrush().load_image_with_mask(
            "051.jpg",
            original_name="image",
        )
        self.assertEqual(result[3], "051")

    def test_real_image_filename_still_keeps_image_name(self):
        result = MODULE.MyImageMaskBrush().load_image_with_mask(
            "image.jpg",
            original_name="image",
        )
        self.assertEqual(result[3], "image")

    def test_transparent_png_alpha_becomes_mask_intensity(self):
        rgba = np.zeros((3, 4, 4), dtype=np.uint8)
        rgba[1, 2, :3] = 255
        rgba[1, 2, 3] = 128
        path = FOLDER_PATHS.root / "mask.png"
        Image.fromarray(rgba).save(path)

        mask = MODULE._load_mask_image(str(path), 4, 3)

        self.assertEqual(tuple(mask.shape), (3, 4))
        self.assertAlmostEqual(float(mask[1, 2]), 128 / 255, places=5)
        self.assertEqual(int(torch.count_nonzero(mask)), 1)

    def test_opaque_grayscale_png_uses_luminance_instead_of_full_alpha(self):
        grayscale = np.array([[0, 128, 255]], dtype=np.uint8)
        rgba = np.repeat(grayscale[:, :, None], 4, axis=2)
        rgba[:, :, 3] = 255
        path = FOLDER_PATHS.root / "opaque-mask.png"
        Image.fromarray(rgba).save(path)

        mask = MODULE._load_mask_image(str(path), 3, 1)

        self.assertTrue(torch.allclose(mask[0], torch.tensor([0.0, 128 / 255, 1.0]), atol=1e-5))

    def test_blank_mask_matches_loaded_image_batch_and_size(self):
        image, mask, inverse_mask, original_name = MODULE.MyImageMaskBrush().load_image_with_mask(
            "folder/sample.photo.png [input]", ""
        )

        self.assertEqual(tuple(image.shape), (2, 3, 4, 3))
        self.assertEqual(tuple(mask.shape), (2, 3, 4))
        self.assertEqual(tuple(inverse_mask.shape), (2, 3, 4))
        self.assertEqual(int(torch.count_nonzero(mask)), 0)
        self.assertEqual(float(inverse_mask.min()), 1.0)
        self.assertEqual(original_name, "sample.photo")

    def test_saved_mask_is_repeated_for_every_loaded_frame(self):
        rgba = np.zeros((3, 4, 4), dtype=np.uint8)
        rgba[:, :2, :3] = 255
        rgba[:, :2, 3] = 255
        Image.fromarray(rgba).save(FOLDER_PATHS.root / "painted.png")

        _, mask, inverse_mask, _ = MODULE.MyImageMaskBrush().load_image_with_mask(
            "sample.png",
            "painted.png [input]",
        )

        self.assertEqual(tuple(mask.shape), (2, 3, 4))
        self.assertTrue(torch.equal(mask[0], mask[1]))
        self.assertEqual(float(mask[0, :, :2].min()), 1.0)
        self.assertEqual(float(mask[0, :, 2:].max()), 0.0)
        self.assertEqual(float(inverse_mask[0, :, :2].max()), 0.0)
        self.assertEqual(float(inverse_mask[0, :, 2:].min()), 1.0)

    def test_independent_inverse_mask_file_can_override_auto_inverse(self):
        normal = np.zeros((3, 4, 4), dtype=np.uint8)
        normal[:, :2, :3] = 255
        normal[:, :2, 3] = 255
        Image.fromarray(normal).save(FOLDER_PATHS.root / "normal.png")

        inverse = np.zeros((3, 4, 4), dtype=np.uint8)
        inverse[1:3, :, :3] = 255
        inverse[1:3, :, 3] = 255
        Image.fromarray(inverse).save(FOLDER_PATHS.root / "inverse.png")

        _, mask, inverse_mask, _ = MODULE.MyImageMaskBrush().load_image_with_mask(
            "sample.png",
            "normal.png [input]",
            "inverse.png [input]",
        )

        self.assertEqual(float(mask[0, :, :2].min()), 1.0)
        self.assertEqual(float(inverse_mask[0, 1:3, :].min()), 1.0)
        self.assertEqual(float(inverse_mask[0, :1, :].max()), 0.0)


if __name__ == "__main__":
    unittest.main()
