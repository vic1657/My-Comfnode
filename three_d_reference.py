import base64
import hashlib
import io
import json
import os
import urllib.parse
from pathlib import Path
from typing import Optional, Tuple

import numpy as np
import torch
from PIL import Image, ImageDraw

try:
    import aiohttp.web
    import server
except Exception:
    aiohttp = None
    server = None


MODEL_ROOT = Path(r"G:\3D模型文件")
SUPPORTED_MODEL_EXTENSIONS = {".glb", ".gltf"}
PLACEHOLDER_MODEL = "未找到模型"


def _normalize_rel(path: Path) -> str:
    return path.as_posix().replace("\\", "/")


def list_model_files() -> list[str]:
    if not MODEL_ROOT.exists():
        return []

    files = []
    for file_path in MODEL_ROOT.rglob("*"):
        if file_path.is_file() and file_path.suffix.lower() in SUPPORTED_MODEL_EXTENSIONS:
            try:
                files.append(_normalize_rel(file_path.relative_to(MODEL_ROOT)))
            except ValueError:
                continue
    return sorted(files, key=lambda value: value.lower())


def model_id(relative_path: str) -> str:
    return hashlib.sha1(relative_path.encode("utf-8")).hexdigest()[:16]


def model_map() -> dict[str, str]:
    return {model_id(relative_path): relative_path for relative_path in list_model_files()}


def resolve_model_path(relative_path: str) -> Optional[Path]:
    if not relative_path or relative_path == PLACEHOLDER_MODEL:
        return None

    candidate = (MODEL_ROOT / relative_path).resolve()
    root = MODEL_ROOT.resolve()
    try:
        if os.path.commonpath([str(root), str(candidate)]) != str(root):
            return None
    except ValueError:
        return None

    if candidate.is_file() and candidate.suffix.lower() in SUPPORTED_MODEL_EXTENSIONS:
        return candidate
    return None


def image_to_tensor(img: Image.Image) -> torch.Tensor:
    rgb = img.convert("RGB")
    arr = np.asarray(rgb, dtype=np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)


def decode_data_url(value: str) -> Optional[Image.Image]:
    if not value or not isinstance(value, str):
        return None
    value = value.strip()
    if not value:
        return None
    try:
        if value.startswith("{"):
            payload = json.loads(value)
            value = payload.get("image", "")
        if "," in value:
            value = value.split(",", 1)[1]
        raw = base64.b64decode(value)
        with Image.open(io.BytesIO(raw)) as image:
            return image.convert("RGBA")
    except Exception as exc:
        print(f"[3DReference] image decode failed: {exc}")
        return None


def placeholder_image(width: int, height: int, message: str) -> Image.Image:
    width = max(64, int(width))
    height = max(64, int(height))
    image = Image.new("RGB", (width, height), (245, 245, 245))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, width - 1, height - 1), outline=(190, 190, 190))
    text = message.encode("ascii", errors="ignore").decode("ascii") or "3D reference preview is empty"
    draw.text((24, 24), text, fill=(40, 40, 40))
    return image


def extract_camera_info(render_image_data: str, model_file: str, width: int, height: int) -> str:
    info = {
        "model_file": model_file,
        "width": int(width),
        "height": int(height),
    }
    if isinstance(render_image_data, str) and render_image_data.strip().startswith("{"):
        try:
            payload = json.loads(render_image_data)
            for key in ("camera", "target", "rotation", "elevation", "intensity", "shadow_opacity", "distance", "fov"):
                if key in payload:
                    info[key] = payload[key]
        except Exception:
            pass
    return json.dumps(info, ensure_ascii=False)


class ThreeDReferenceNode:
    @classmethod
    def INPUT_TYPES(cls):
        models = list_model_files()
        if not models:
            models = [PLACEHOLDER_MODEL]
        return {
            "required": {
                "model_file": (models,),
                "width": ("INT", {"default": 1024, "min": 256, "max": 4096, "step": 64}),
                "height": ("INT", {"default": 1024, "min": 256, "max": 4096, "step": 64}),
                "background": ("STRING", {"default": "#ffffff", "multiline": False}),
                "rotation": ("FLOAT", {"default": -108.0, "min": -180, "max": 180, "step": 1, "display": "slider"}),
                "elevation": ("FLOAT", {"default": 47.0, "min": 5, "max": 85, "step": 1, "display": "slider"}),
                "intensity": ("FLOAT", {"default": 2.6, "min": 0.2, "max": 4.0, "step": 0.1, "display": "slider"}),
                "shadow_opacity": ("FLOAT", {"default": 0.18, "min": 0.0, "max": 0.5, "step": 0.01, "display": "slider"}),
                "render_image_data": ("STRING", {"default": "", "multiline": True}),
            }
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("图像", "控制信息")
    FUNCTION = "render"
    CATEGORY = "My-Comfnode/3D"
    OUTPUT_NODE = False

    def render(
        self,
        model_file: str,
        width: int = 1024,
        height: int = 1024,
        background: str = "#ffffff",
        rotation: float = -108.0,
        elevation: float = 47.0,
        intensity: float = 2.6,
        shadow_opacity: float = 0.18,
        render_image_data: str = "",
    ) -> Tuple[torch.Tensor, str]:
        image = decode_data_url(render_image_data)
        if image is None:
            image = placeholder_image(width, height, "Run once after the 3D view finishes loading.")
        else:
            background_rgb = (255, 255, 255)
            if isinstance(background, str) and background.startswith("#") and len(background) == 7:
                try:
                    background_rgb = tuple(int(background[i : i + 2], 16) for i in (1, 3, 5))
                except Exception:
                    background_rgb = (255, 255, 255)
            base = Image.new("RGBA", image.size, (*background_rgb, 255))
            image = Image.alpha_composite(base, image).convert("RGB")

        return image_to_tensor(image), extract_camera_info(render_image_data, model_file, width, height)


def _register_routes() -> None:
    if server is None or aiohttp is None or getattr(server.PromptServer, "instance", None) is None:
        return

    routes = server.PromptServer.instance.routes

    @routes.get("/my_comfnode/3d_reference/models")
    async def get_models(request):
        models = []
        for relative_path in list_model_files():
            encoded = urllib.parse.quote(relative_path)
            mid = model_id(relative_path)
            models.append(
                {
                    "id": mid,
                    "name": Path(relative_path).stem,
                    "relative": relative_path,
                    "url": f"/my_comfnode/3d_reference/model_id/{mid}",
                    "legacy_url": f"/my_comfnode/3d_reference/model/{encoded}",
                }
            )
        return aiohttp.web.json_response({"root": str(MODEL_ROOT), "models": models})

    @routes.get("/my_comfnode/3d_reference/model_id/{model_id}")
    async def get_model_by_id(request):
        mid = request.match_info.get("model_id", "")
        relative_path = model_map().get(mid)
        file_path = resolve_model_path(relative_path or "")
        if file_path is None:
            return aiohttp.web.Response(status=404, text="Model not found")
        return aiohttp.web.FileResponse(file_path)

    @routes.get("/my_comfnode/3d_reference/model/{relative_path:.*}")
    async def get_model(request):
        relative_path = urllib.parse.unquote(request.match_info.get("relative_path", ""))
        file_path = resolve_model_path(relative_path)
        if file_path is None:
            return aiohttp.web.Response(status=404, text="Model not found")
        return aiohttp.web.FileResponse(file_path)


_register_routes()


NODE_CLASS_MAPPINGS = {
    "MyComfnodeThreeDReferenceNode": ThreeDReferenceNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MyComfnodeThreeDReferenceNode": "3D多视角参考",
}
