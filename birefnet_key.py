"""BiRefNet 高分辨率二分图像分割抠图（MIT 许可，可商用）

来源: https://github.com/ZhengPeng7/BiRefNet (MIT)
通过 transformers 加载官方通用权重 ZhengPeng7/BiRefNet（约 1GB，首次运行自动下载），
1024x1024 推理后缩放回原分辨率，是目前细节边缘最强的开源分割模型之一。
"""

from __future__ import annotations

from pathlib import Path

import folder_paths
import numpy as np
import torch
from PIL import Image

_model = None
_device = None


def _get_model():
    global _model, _device
    if _model is None:
        from transformers import AutoModelForImageSegmentation
        _device = "cuda" if torch.cuda.is_available() else "cpu"
        # 优先本地目录（curl 预下载，绕过 HF 缓存下载损坏问题）
        local = Path(folder_paths.models_dir) / "BiRefNet_local"
        src = str(local) if (local / "config.json").exists() else "ZhengPeng7/BiRefNet"
        _model = AutoModelForImageSegmentation.from_pretrained(src, trust_remote_code=True)
        _model.to(_device).eval()
    return _model, _device


class MyBiRefNetKey:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "待抠图图像"}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "remove"
    CATEGORY = "My-Comfnode/图像"
    DESCRIPTION = (
        "BiRefNet AI 抠图（MIT 可商用）：1024 分辨率二分图像分割，"
        "细节边缘强。首次运行会从 HuggingFace 下载约 1GB 权重。"
    )

    @torch.no_grad()
    def remove(self, image):
        model, device = _get_model()
        outs = []
        for i in range(image.shape[0]):
            arr = (image[i].detach().cpu().numpy() * 255.0 + 0.5).clip(0, 255).astype(np.uint8)
            pil = Image.fromarray(arr[..., :3]).convert("RGB")
            W, H = pil.size
            im = pil.resize((1024, 1024), Image.LANCZOS)
            x = torch.from_numpy(
                (np.asarray(im).astype(np.float32) / 255.0 - 0.5) / 1.0
            ).permute(2, 0, 1)[None].to(device)
            pred = model(x)[-1].sigmoid()[0, 0].float().cpu()
            mask = torch.nn.functional.interpolate(
                pred[None, None], size=(H, W), mode="bilinear", align_corners=False
            )[0, 0].numpy()
            rgba = np.concatenate(
                [arr[..., :3].astype(np.float32) / 255.0, mask[..., None]], axis=-1
            )
            outs.append(rgba)  # 4 通道 RGBA
        out = torch.from_numpy(np.stack(outs)).to(image.device, image.dtype)
        mask = out[..., 3].clamp(0.0, 1.0)
        return (out, mask)


NODE_CLASS_MAPPINGS = {"MyBiRefNetKey": MyBiRefNetKey}
NODE_DISPLAY_NAME_MAPPINGS = {"MyBiRefNetKey": "MyBiRefNet抠图(AI)"}
