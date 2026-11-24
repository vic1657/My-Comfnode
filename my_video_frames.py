from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
import uuid
import wave
from pathlib import Path

import numpy as np
import torch

import folder_paths
from comfy_api.input_impl import VideoFromFile


def _ffmpeg() -> str:
    executable = shutil.which("ffmpeg")
    if not executable:
        raise RuntimeError("找不到 ffmpeg，请先安装 FFmpeg 并将其加入 PATH")
    return executable


def _write_audio_wav(audio: dict, destination: Path) -> None:
    waveform = audio.get("waveform") if isinstance(audio, dict) else None
    sample_rate = int(audio.get("sample_rate", 0)) if isinstance(audio, dict) else 0
    if not isinstance(waveform, torch.Tensor) or waveform.ndim != 3 or sample_rate <= 0:
        raise ValueError("audio 必须是 ComfyUI 的 AUDIO 输出")
    samples = waveform.detach().cpu().float().numpy()[0]
    samples = np.clip(samples, -1.0, 1.0)
    pcm = (samples.T * 32767.0).round().astype(np.int16)
    if pcm.ndim == 1:
        pcm = pcm[:, None]
    with wave.open(str(destination), "wb") as writer:
        writer.setnchannels(int(pcm.shape[1]))
        writer.setsampwidth(2)
        writer.setframerate(sample_rate)
        writer.writeframes(pcm.tobytes())


def _safe_prefix(value: str) -> str:
    prefix = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(value)).strip(" .")
    return prefix or "MY视频"


def _trim_audio(audio, start_frame: int, frame_count: int, frame_rate: float):
    if audio is None or not isinstance(audio, dict):
        return audio
    waveform = audio.get("waveform")
    sample_rate = int(audio.get("sample_rate", 0))
    if not isinstance(waveform, torch.Tensor) or waveform.ndim != 3 or sample_rate <= 0:
        return audio
    start_sample = max(0, int(round(start_frame * sample_rate / frame_rate)))
    end_sample = start_sample + max(0, int(round(frame_count * sample_rate / frame_rate)))
    trimmed = dict(audio)
    trimmed["waveform"] = waveform[..., start_sample:end_sample]
    return trimmed


def _int_option(value, default=0):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if not np.isfinite(number):
        return default
    return max(0, int(number))


def _clean_alpha_edge_colors(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Remove matte-colored RGB fringes while keeping the supplied alpha.

    Transparent/anti-aliased pixels often retain the color of the original
    matte (for example brown). Video encoders preserve that RGB value, so it
    becomes a visible halo when the video is composited on another
    background. Propagating nearby opaque foreground colors into those pixels
    fixes the color contamination without changing their opacity.
    """
    if rgb.ndim != 3 or rgb.shape[-1] != 3 or alpha.ndim != 2:
        return rgb
    if not np.any(alpha < 255):
        return rgb

    cleaned = rgb.copy()
    # Expand known foreground colors into transparent/anti-aliased pixels.
    known = alpha >= 250
    pending = ~known
    for _ in range(8):
        if not np.any(pending):
            break
        found = np.zeros_like(known)
        candidate = np.zeros_like(cleaned)
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1),
                       (-1, -1), (-1, 1), (1, -1), (1, 1)):
            shifted_known = np.zeros_like(known)
            shifted_color = np.zeros_like(cleaned)
            src_y = slice(max(0, -dy), min(known.shape[0], known.shape[0] - dy))
            src_x = slice(max(0, -dx), min(known.shape[1], known.shape[1] - dx))
            dst_y = slice(max(0, dy), min(known.shape[0], known.shape[0] + dy))
            dst_x = slice(max(0, dx), min(known.shape[1], known.shape[1] + dx))
            shifted_known[dst_y, dst_x] = known[src_y, src_x]
            shifted_color[dst_y, dst_x] = cleaned[src_y, src_x]
            take = pending & shifted_known & ~found
            candidate[take] = shifted_color[take]
            found |= take
        if not np.any(found):
            break
        cleaned[found] = candidate[found]
        known |= found
        pending = ~known
    return cleaned


class MYVideoToFrames:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "video": ("VIDEO", {"forceInput": True}),
            "skip_first_frames": ("INT", {"default": 0, "min": 0, "max": 1000000}),
            "max_frames": ("INT", {"default": 0, "min": 0, "max": 1000000}),
        }}

    RETURN_TYPES = ("IMAGE", "AUDIO", "MASK", "FLOAT", "INT")
    RETURN_NAMES = ("逐帧图片", "原视频音频", "透明图层", "帧率", "帧数")
    FUNCTION = "extract"
    CATEGORY = "My-Comfnode/视频"

    def extract(self, video, skip_first_frames=0, max_frames=0):
        if not hasattr(video, "get_components"):
            raise ValueError("video 必须连接到加载视频节点的 VIDEO 输出")
        components = video.get_components()
        start = _int_option(skip_first_frames)
        limit = _int_option(max_frames)
        images = components.images[start:]
        alpha = components.alpha[start:] if components.alpha is not None else None
        if limit:
            images = images[:limit]
            if alpha is not None:
                alpha = alpha[:limit]
        if images.ndim != 4 or images.shape[0] == 0:
            raise ValueError("视频没有可读取的帧，请检查视频输入或裁剪范围")
        if alpha is None:
            alpha = torch.ones((images.shape[0], images.shape[1], images.shape[2]), dtype=images.dtype)
        elif alpha.ndim == 4:
            alpha = alpha[..., 0]
        frame_rate = float(components.frame_rate)
        audio = _trim_audio(components.audio, start, int(images.shape[0]), frame_rate)
        return (images, audio, alpha, frame_rate, int(images.shape[0]))


class MYFramesToVideo:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE",),
            "frame_rate": ("FLOAT", {"default": 24.0, "min": 0.001, "max": 240.0, "step": 0.001}),
            "filename_prefix": ("STRING", {"default": "MY视频"}),
            "format": (["mp4", "mov", "webm", "mkv"], {"default": "mp4"}),
            "quality_crf": ("INT", {"default": 18, "min": 0, "max": 51}),
            "保留原声": ("BOOLEAN", {"default": True}),
        }, "optional": {"audio": ("AUDIO",), "透明图层": ("MASK",)}}

    RETURN_TYPES = ("VIDEO", "INT")
    RETURN_NAMES = ("视频", "帧数")
    FUNCTION = "combine"
    CATEGORY = "My-Comfnode/视频"

    def combine(self, images, frame_rate, filename_prefix, format, quality_crf, 保留原声=True, audio=None, 透明图层=None):
        if not isinstance(images, torch.Tensor) or images.ndim != 4 or images.shape[0] < 1:
            raise ValueError("images 必须是非空的 IMAGE 批次 [N,H,W,C]")
        if images.shape[-1] < 3:
            raise ValueError("images 至少需要 RGB 三个通道")
        if format not in {"mp4", "mov", "webm", "mkv"}:
            raise ValueError("不支持的视频输出格式")
        if float(frame_rate) <= 0:
            raise ValueError("帧率必须大于 0")
        count, height, width = (int(v) for v in images.shape[:3])
        if width < 2 or height < 2:
            raise ValueError("图片宽高必须至少为 2")
        alpha = 透明图层
        if alpha is not None:
            if not isinstance(alpha, torch.Tensor) or alpha.ndim not in (3, 4):
                raise ValueError("透明图层必须是 MASK 类型")
            if alpha.ndim == 4:
                alpha = alpha[..., 0]
            if tuple(alpha.shape) != (count, height, width):
                raise ValueError("透明图层必须与图片的帧数和尺寸一致")
        output_dir = Path(folder_paths.get_output_directory()) / "my_video"
        output_dir.mkdir(parents=True, exist_ok=True)
        target = output_dir / f"{_safe_prefix(filename_prefix)}_{uuid.uuid4().hex[:8]}.{format}"
        # WebM/VP9 can carry an alpha channel. Other formats (including MP4)
        # cannot, so composite the cleaned foreground onto black below.
        has_alpha = alpha is not None and format == "webm"
        codec = "libvpx-vp9" if format == "webm" else "libx264"
        command = [_ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo",
                   "-pixel_format", "rgba" if has_alpha else "rgb24", "-video_size", f"{width}x{height}",
                   "-framerate", str(float(frame_rate)), "-i", "pipe:0"]
        with tempfile.TemporaryDirectory(prefix="my_video_audio_") as temporary:
            audio_path = None
            if 保留原声 and audio is not None:
                audio_path = Path(temporary) / "audio.wav"
                _write_audio_wav(audio, audio_path)
                command.extend(["-i", str(audio_path)])
            command.extend(["-map", "0:v:0"])
            if audio_path is not None:
                command.extend(["-map", "1:a:0", "-c:a", "libopus" if format == "webm" else "aac"])
            command.extend(["-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", codec,
                            "-crf", str(int(quality_crf)), "-pix_fmt", "yuva420p" if has_alpha else "yuv420p"])
            if format == "webm":
                command.extend(["-b:v", "0"])
                if has_alpha:
                    # VP9 alpha requires disabling alternate reference frames.
                    command.extend(["-auto-alt-ref", "0"])
            elif format == "mp4":
                command.extend(["-movflags", "+faststart"])
            command.append(str(target))
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            try:
                for index, frame in enumerate(images):
                    pixels = (frame[..., :3].detach().cpu().float().clamp(0, 1).numpy() * 255.0 + 0.5).astype(np.uint8)
                    if alpha is not None:
                        mask = (alpha[index].detach().cpu().float().clamp(0, 1).numpy() * 255.0 + 0.5).astype(np.uint8)[..., None]
                        pixels = _clean_alpha_edge_colors(pixels, mask[..., 0])
                        if has_alpha:
                            pixels = np.concatenate((pixels, mask), axis=-1)
                        else:
                            # MP4/MOV/MKV have no portable alpha stream.
                            # Premultiply onto black after edge-color cleanup
                            # to avoid exposing matte-colored RGB fringes.
                            pixels = ((pixels.astype(np.uint16) * mask.astype(np.uint16) + 127) // 255).astype(np.uint8)
                    process.stdin.write(pixels.tobytes())
                process.stdin.close()
                stderr = process.stderr.read().decode("utf-8", errors="replace")
                if process.wait() != 0:
                    raise RuntimeError(f"FFmpeg 合并失败：{stderr[-2500:]}")
            except BaseException:
                if process.stdin and not process.stdin.closed:
                    process.stdin.close()
                if process.poll() is None:
                    process.kill()
                process.wait()
                target.unlink(missing_ok=True)
                raise
        return (VideoFromFile(str(target)), count)


NODE_CLASS_MAPPINGS = {"MYVideoToFrames": MYVideoToFrames, "MYFramesToVideo": MYFramesToVideo}
NODE_DISPLAY_NAME_MAPPINGS = {"MYVideoToFrames": "MY视频转逐帧图(兼容市面上主流所有视频格式)", "MYFramesToVideo": "MY逐帧图合并为视频"}
