from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock

from PIL import Image
import torch


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "image_saver.py"


class ImageSaverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.output = Path(self.temp.name) / "output"
        self.output.mkdir()
        folder_paths = types.ModuleType("folder_paths")
        folder_paths.get_output_directory = lambda: str(self.output)
        folder_paths.get_temp_directory = lambda: str(self.output.parent / "temp")
        self.previous = sys.modules.get("folder_paths")
        sys.modules["folder_paths"] = folder_paths
        spec = importlib.util.spec_from_file_location("image_saver_under_test", MODULE_PATH)
        self.module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(self.module)

    def tearDown(self):
        if self.previous is None:
            sys.modules.pop("folder_paths", None)
        else:
            sys.modules["folder_paths"] = self.previous
        self.temp.cleanup()

    def _save(self, images, **overrides):
        values = {
            "图像": images,
            "保存格式": "JPG",
            "原图源名称接入点": "原图名",
            "文件名前缀": "",
            "保存路径": str(self.output),
            "新建文件夹": "不新建",
            "自定义文件夹名": "",
            "JPG质量（95推荐；越高越清晰、文件越大）": 95,
            "PNG压缩（4推荐；越高文件越小、保存越慢）": 4,
        }
        values.update(overrides)
        return self.module.MyImageSaver().save_images(**values)

    def test_interface_uses_chinese_connectable_prefix(self):
        node = self.module.MyImageSaver()
        required = node.INPUT_TYPES()["required"]
        self.assertEqual(required["图像"][0], "IMAGE")
        self.assertEqual(required["原图源名称接入点"][0], "STRING")
        self.assertEqual(required["文件名前缀"][0], "STRING")
        self.assertEqual(required["保存格式"][0], ["PNG", "JPG"])
        self.assertTrue(node.OUTPUT_NODE)
        self.assertIn("透明遮罩（白色透明）", node.INPUT_TYPES()["optional"])

    def test_jpg_batch_uses_two_digit_sequence_and_skips_existing(self):
        Image.new("RGB", (2, 2), "red").save(self.output / "原图名01.jpg")
        result = self._save(torch.rand(2, 12, 16, 3))

        saved = sorted(self.output.glob("原图名*.jpg"))
        self.assertEqual([path.name for path in saved], ["原图名01.jpg", "原图名02.jpg", "原图名03.jpg"])
        self.assertEqual(len(result["ui"]["images"]), 2)
        with Image.open(self.output / "原图名02.jpg") as opened:
            self.assertEqual(opened.format, "JPEG")
            self.assertEqual(opened.size, (16, 12))

    def test_manual_prefix_is_added_before_source_name(self):
        self._save(
            torch.rand(1, 8, 8, 3),
            **{"原图源名称接入点": "051", "文件名前缀": "AI_"},
        )
        self.assertTrue((self.output / "AI_05101.jpg").is_file())

    def test_empty_manual_prefix_is_ignored(self):
        self._save(
            torch.rand(1, 8, 8, 3),
            **{"原图源名称接入点": "051", "文件名前缀": ""},
        )
        self.assertTrue((self.output / "05101.jpg").is_file())

    def test_legacy_filename_prefix_request_remains_compatible(self):
        values = {
            "图像": torch.rand(1, 8, 8, 3),
            "保存格式": "JPG",
            "文件名前缀": "旧名称",
            "保存路径": str(self.output),
            "新建文件夹": "不新建",
            "自定义文件夹名": "",
            "JPG质量（95推荐；越高越清晰、文件越大）": 95,
            "PNG压缩（4推荐；越高文件越小、保存越慢）": 4,
        }
        self.module.MyImageSaver().save_images(**values)
        self.assertTrue((self.output / "旧名称01.jpg").is_file())

    def test_png_can_save_to_relative_custom_folder(self):
        self._save(
            torch.rand(1, 10, 14, 4),
            **{
                "保存格式": "PNG",
                "保存路径": "客户图",
                "新建文件夹": "自定义名称",
                "自定义文件夹名": "成品",
            },
        )
        saved = self.output / "客户图" / "成品" / "原图名01.png"
        self.assertTrue(saved.is_file())
        with Image.open(saved) as opened:
            self.assertEqual(opened.format, "PNG")
            self.assertEqual(opened.mode, "RGBA")

    def test_date_folder_uses_mmdd(self):
        with mock.patch.object(self.module, "datetime") as fake_datetime:
            fake_datetime.now.return_value.strftime.return_value = "0820"
            self._save(
                torch.rand(1, 8, 8, 3),
                **{"新建文件夹": "按当天日期(MMDD)"},
            )
        self.assertTrue((self.output / "0820" / "原图名01.jpg").is_file())

    def test_date_folder_uses_custom_name_as_prefix(self):
        with mock.patch.object(self.module, "datetime") as fake_datetime:
            fake_datetime.now.return_value.strftime.return_value = "0820"
            self._save(
                torch.rand(1, 8, 8, 3),
                **{
                    "新建文件夹": "按当天日期(MMDD)",
                    "自定义文件夹名": "项目A",
                },
            )
        self.assertTrue((self.output / "项目A0820" / "原图名01.jpg").is_file())

    def test_png_transparency_mask_is_saved_as_alpha_and_preview_is_created(self):
        mask = torch.zeros(1, 10, 14)
        mask[:, :, 7:] = 1.0
        result = self._save(
            torch.ones(1, 10, 14, 3),
            **{"保存格式": "PNG", "透明遮罩（白色透明）": mask},
        )
        saved = self.output / "原图名01.png"
        with Image.open(saved) as opened:
            self.assertEqual(opened.mode, "RGBA")
            self.assertEqual(opened.getchannel("A").getpixel((2, 2)), 255)
            self.assertEqual(opened.getchannel("A").getpixel((12, 2)), 0)
        preview = result["ui"]["images"][0]
        self.assertEqual(preview["type"], "temp")
        self.assertTrue(
            (Path(self.temp.name) / "temp" / preview["subfolder"] / preview["filename"]).is_file()
        )

    def test_custom_folder_rejects_nested_path(self):
        with self.assertRaisesRegex(ValueError, "单层文件夹"):
            self._save(
                torch.rand(1, 8, 8, 3),
                **{"新建文件夹": "自定义名称", "自定义文件夹名": "a/b"},
            )


if __name__ == "__main__":
    unittest.main()
