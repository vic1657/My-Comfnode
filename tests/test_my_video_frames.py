import importlib.util
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SAMPLE = Path("G:/Users/Administrator/Desktop/8e256019-4ac8-45f0-80a0-44ee1179311d.mov")
spec = importlib.util.spec_from_file_location("my_video_frames_under_test", ROOT / "my_video_frames.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class VideoFrameTests(unittest.TestCase):
    @unittest.skipUnless(SAMPLE.is_file() and shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "需要提供的 MOV 文件和 FFmpeg")
    def test_mov_roundtrip_and_audio(self):
        with tempfile.TemporaryDirectory() as output:
            with patch.object(module.folder_paths, "get_output_directory", return_value=output):
                frames, fps, count, source = module.MYVideoToFrames().extract(str(SAMPLE))
                self.assertEqual((count, fps), (38, 25.0))
                self.assertEqual(tuple(frames.shape), (38, 694, 1230, 3))
                result = module.MYFramesToVideo().combine(frames, fps, "roundtrip", "mp4", 18, source)
                video = Path(result["result"][0])
                self.assertTrue(video.is_file())
                self.assertEqual(result["result"][1], count)
                probe = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-show_entries",
                                        "stream=codec_type,nb_read_frames", "-of", "json", str(video)],
                                       capture_output=True, text=True, check=True)
                streams = json.loads(probe.stdout)["streams"]
                self.assertEqual(next(s for s in streams if s["codec_type"] == "video")["nb_read_frames"], "38")
                self.assertTrue(any(s["codec_type"] == "audio" for s in streams))

                limited, limited_fps, limited_count, _ = module.MYVideoToFrames().extract(str(SAMPLE), 5, 3)
                self.assertEqual((limited_count, limited_fps), (3, fps))
                self.assertEqual(tuple(limited.shape[1:]), tuple(frames.shape[1:]))

    def test_video_input_rejects_parent_traversal(self):
        with tempfile.TemporaryDirectory() as input_dir:
            with patch.object(module.folder_paths, "get_input_directory", return_value=input_dir):
                with self.assertRaisesRegex(ValueError, "超出"):
                    module._video_path("../outside.mov")

    def test_node_names(self):
        self.assertEqual(set(module.NODE_CLASS_MAPPINGS), {"MYVideoToFrames", "MYFramesToVideo"})
        self.assertEqual(module.NODE_DISPLAY_NAME_MAPPINGS["MYVideoToFrames"],
                         "MY视频转逐帧图(兼容市面上主流所有视频格式)")
        self.assertEqual(module.NODE_DISPLAY_NAME_MAPPINGS["MYFramesToVideo"], "MY逐帧图合并为视频")


if __name__ == "__main__":
    unittest.main()
