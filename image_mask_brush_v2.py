from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageOps

import folder_paths


_ROOT = Path(__file__).resolve().parent


def _load_sibling(module_key: str, filename: str):
    module = sys.modules.get(module_key)
    if module is not None:
        return module
    spec = importlib.util.spec_from_file_location(module_key, _ROOT / filename)
    if spec is None or spec.loader is None:
        raise ImportError(f"Unable to load {filename}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_key] = module
    spec.loader.exec_module(module)
    return module


_brush_module = _load_sibling("_my_comfnode_image_mask_brush", "image_mask_brush.py")
_texture_module = _load_sibling("_my_comfnode_my_texture", "my_texture.py")
MyImageMaskBrush = _brush_module.MyImageMaskBrush
MyTexture = _texture_module.MyTexture

_AUTO_DEPTH_MODEL = None
_AUTO_DEPTH_MODEL_NAME = "depth_anything_v2_vitl_fp16.safetensors"
_AUTO_RMBG_NODE = None
_AUTO_SUBJECT_CACHE_KEY = None
_AUTO_SUBJECT_CACHE_MASK = None


def _generate_depth_map(background: torch.Tensor) -> torch.Tensor:
    """Run the same Depth Anything V2 path used by the supplied workflow."""
    global _AUTO_DEPTH_MODEL
    import nodes as comfy_nodes

    loader_cls = comfy_nodes.NODE_CLASS_MAPPINGS.get("DownloadAndLoadDepthAnythingV2Model")
    processor_cls = comfy_nodes.NODE_CLASS_MAPPINGS.get("DepthAnything_V2")
    if loader_cls is None or processor_cls is None:
        raise RuntimeError(
            "Depth Anything V2 nodes are unavailable. Install/enable ComfyUI-DepthAnythingV2."
        )
    if _AUTO_DEPTH_MODEL is None:
        _AUTO_DEPTH_MODEL = loader_cls().loadmodel(_AUTO_DEPTH_MODEL_NAME, "auto")[0]

    # The reference workflow limits the depth branch to a 1024px long side.
    # Keeping that limit prevents a portrait source from exhausting VRAM.
    height, width = int(background.shape[1]), int(background.shape[2])
    scale = min(1.0, 1024.0 / max(height, width))
    depth_input = background
    if scale < 1.0:
        target_height = max(28, int(round(height * scale / 14.0)) * 14)
        target_width = max(28, int(round(width * scale / 14.0)) * 14)
        depth_input = torch.nn.functional.interpolate(
            background.permute(0, 3, 1, 2),
            size=(target_height, target_width),
            mode="bilinear",
            align_corners=False,
        ).permute(0, 2, 3, 1)
    return processor_cls().process(_AUTO_DEPTH_MODEL, depth_input)[0]


def _generate_subject_mask(background: torch.Tensor) -> torch.Tensor:
    """Generate the same strict foreground mask used by the supplied workflow."""
    global _AUTO_RMBG_NODE, _AUTO_SUBJECT_CACHE_KEY, _AUTO_SUBJECT_CACHE_MASK
    import nodes as comfy_nodes

    preview = torch.nn.functional.interpolate(
        background[..., :3].permute(0, 3, 1, 2),
        size=(32, 32),
        mode="bilinear",
        align_corners=False,
    )
    digest = hashlib.sha256()
    digest.update(str(tuple(background.shape)).encode("utf-8"))
    digest.update(preview.detach().cpu().contiguous().numpy().tobytes())
    cache_key = digest.hexdigest()
    if _AUTO_SUBJECT_CACHE_KEY == cache_key and _AUTO_SUBJECT_CACHE_MASK is not None:
        return _AUTO_SUBJECT_CACHE_MASK.to(device=background.device, dtype=background.dtype)

    rmbg_cls = comfy_nodes.NODE_CLASS_MAPPINGS.get("RMBG")
    if rmbg_cls is None:
        raise RuntimeError("RMBG node is unavailable. Install/enable ComfyUI-RMBG.")
    if _AUTO_RMBG_NODE is None:
        _AUTO_RMBG_NODE = rmbg_cls()
    result = _AUTO_RMBG_NODE.process_image(
        background,
        "RMBG-2.0",
        sensitivity=1.0,
        process_res=1024,
        mask_blur=1,
        mask_offset=1,
        invert_output=False,
        refine_foreground=False,
        background="Alpha",
        background_color="#222222",
    )
    subject_mask = result[1]
    if subject_mask is None or float(subject_mask.max().detach().cpu()) <= 0.01:
        raise RuntimeError("RMBG returned an empty person mask.")
    _AUTO_SUBJECT_CACHE_KEY = cache_key
    _AUTO_SUBJECT_CACHE_MASK = subject_mask.detach().cpu()
    return subject_mask.to(device=background.device, dtype=background.dtype)


def _load_texture_image(texture_file: str) -> tuple[torch.Tensor, torch.Tensor]:
    """Load an editable sticker as RGB plus ComfyUI-compatible transparent mask."""
    path = folder_paths.get_annotated_filepath(texture_file)
    image = ImageOps.exif_transpose(Image.open(path)).convert("RGBA")
    rgba = np.asarray(image, dtype=np.float32) / 255.0
    rgb = torch.from_numpy(rgba[..., :3].copy()).unsqueeze(0)
    # LoadImage emits white for transparent pixels, which is the convention
    # expected by MyTexture's fg_alpha_mask_1 input.
    transparent_mask = torch.from_numpy((1.0 - rgba[..., 3]).copy()).unsqueeze(0)
    return rgb, transparent_mask


def _texture_settings(value: str) -> dict:
    try:
        data = json.loads(value) if str(value or "").strip() else {}
    except json.JSONDecodeError:
        data = {}
    return data if isinstance(data, dict) else {}


def _resolve_original_image_reference(
    edited_image: str,
    original_image: str = "",
    original_name: str = "",
) -> str:
    stored_reference = str(original_image or "").strip()
    if stored_reference and folder_paths.exists_annotated_filepath(stored_reference):
        return stored_reference

    stored_name = str(original_name or "").strip()
    if stored_name:
        input_root = Path(folder_paths.get_input_directory())
        candidates = sorted(
            (
                path
                for path in input_root.rglob("*")
                if path.is_file()
                and path.stem == stored_name
                and path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
            ),
            key=lambda path: (len(path.relative_to(input_root).parts), path.as_posix()),
        )
        if candidates:
            return candidates[0].relative_to(input_root).as_posix()
    return edited_image


def _load_original_image(edited_image: str, original_image: str, original_name: str) -> torch.Tensor:
    reference = _resolve_original_image_reference(edited_image, original_image, original_name)
    loaded, _ = MyImageMaskBrush().load_image(reference)
    return loaded


def _render_depth_texture(
    background: torch.Tensor,
    texture_file: str = "",
    texture_transform: str = "",
    depth_map: torch.Tensor | None = None,
) -> tuple[torch.Tensor, torch.Tensor]:
    """Render the sticker branch without depending on any hand-painted mask."""
    texture_file = str(texture_file or "").strip()
    if not texture_file:
        empty = torch.zeros(
            (background.shape[0], background.shape[1], background.shape[2]),
            dtype=background.dtype,
            device=background.device,
        )
        return background, empty

    texture, transparent_mask = _load_texture_image(texture_file)
    texture = texture.to(dtype=background.dtype, device=background.device)
    transparent_mask = transparent_mask.to(dtype=background.dtype, device=background.device)
    settings = _texture_settings(texture_transform)
    if depth_map is None:
        depth_map = _generate_depth_map(background)
    target_mask = _generate_subject_mask(background)
    texture_keys = list(MyTexture.INPUT_TYPES()["required"].keys())
    kwargs = {
        "bg_img": background,
        "bg_depth_map": depth_map,
        "bg_mask": target_mask,
        "fg_img_1": texture,
        "fg_alpha_mask_1": transparent_mask,
        "t_data": texture_transform,
    }
    control_values = [
        float(settings.get("depth_strength", 0.30)),
        float(settings.get("opacity", 1.0)),
        float(settings.get("skew_x", 0.0)),
        float(settings.get("skew_y", 0.0)),
        float(settings.get("stretch_x", 1.0)),
        float(settings.get("stretch_y", 1.0)),
        str(settings.get("blend_mode", "normal")),
    ]
    for key, value in zip(texture_keys[4:11], control_values):
        kwargs[key] = value
    composited, _, texture_mask = MyTexture().apply_texture(**kwargs)["result"]
    return composited, texture_mask


def _source_fingerprint(
    image: str,
    original_name: str = "",
    texture_file: str = "",
    texture_transform: str = "",
    original_image: str = "",
    depth_map: torch.Tensor | None = None,
) -> str:
    """Fingerprint only image/sticker inputs, deliberately excluding brush masks."""
    image_hash = MyImageMaskBrush.IS_CHANGED(image, "", "", original_name)
    original_reference = _resolve_original_image_reference(image, original_image, original_name)
    digest = hashlib.sha256(f"{image_hash}:{texture_transform}:{original_reference}".encode("utf-8"))
    original_path = folder_paths.get_annotated_filepath(original_reference)
    with open(original_path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    texture_file = str(texture_file or "").strip()
    if texture_file:
        path = folder_paths.get_annotated_filepath(texture_file)
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    if depth_map is not None:
        digest.update(str(tuple(depth_map.shape)).encode("utf-8"))
    return digest.hexdigest()


class MyImageMaskBrushV2(MyImageMaskBrush):
    """V2 keeps V1's mask outputs and adds a non-destructive depth sticker."""

    @classmethod
    def INPUT_TYPES(cls):
        inputs = super().INPUT_TYPES()
        required = dict(inputs["required"])
        required.update(
            {
                "texture_file": ("STRING", {"default": "", "multiline": False}),
                "texture_transform": ("STRING", {"default": "", "multiline": False}),
                # Appended after the existing V2 widgets so older workflows do
                # not shift their positional texture values during migration.
                "original_image": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "tooltip": "首次导入的原图文件，由节点自动保存。",
                    },
                ),
            }
        )
        return {
            "required": required,
            "optional": {
                # Connect the IMAGE output of DepthAnything_V2 here.  Leaving
                # it empty keeps the sticker planar while retaining lighting.
                "depth_map": ("IMAGE",),
            },
        }

    CATEGORY = "My-Comfnode/图像"
    # Keep the five existing slots in place so saved links remain valid.  The
    # untouched source is appended as a new IMAGE output.
    RETURN_TYPES = ("IMAGE", "MASK", "MASK", "MASK", "STRING", "IMAGE")
    RETURN_NAMES = ("绘画图像", "手绘遮罩", "反向遮罩", "贴图遮罩", "原图原名称", "原图")
    FUNCTION = "load_image_with_mask"
    DESCRIPTION = "图像遮罩画笔 V2：保留 V1 遮罩能力，并可在编辑器中把素材图层转为深度贴图。"

    def load_image_with_mask(
        self,
        image: str,
        mask_file: str = "",
        inverse_mask_file: str = "",
        original_name: str = "",
        texture_file: str = "",
        texture_transform: str = "",
        original_image: str = "",
        depth_map: torch.Tensor | None = None,
    ):
        background, mask, inverse_mask, name = super().load_image_with_mask(
            image, mask_file, inverse_mask_file, original_name
        )
        untouched_original = _load_original_image(image, original_image, original_name)
        composited, texture_mask = _render_depth_texture(
            background, texture_file, texture_transform, depth_map
        )
        return composited, mask, inverse_mask, texture_mask, name, untouched_original

    @classmethod
    def IS_CHANGED(cls, image, mask_file="", inverse_mask_file="", original_name="", texture_file="", texture_transform="", original_image="", depth_map=None):
        source = _source_fingerprint(
            image, original_name, texture_file, texture_transform, original_image, depth_map
        )
        mask = super().IS_CHANGED(image, mask_file, inverse_mask_file, original_name)
        return hashlib.sha256(f"{source}:{mask}".encode("utf-8")).hexdigest()

    @classmethod
    def VALIDATE_INPUTS(cls, image, mask_file="", inverse_mask_file="", original_name="", texture_file="", texture_transform="", original_image="", depth_map=None):
        result = super().VALIDATE_INPUTS(image, mask_file, inverse_mask_file, original_name)
        if result is not True:
            return result
        texture_file = str(texture_file or "").strip()
        if texture_file and not folder_paths.exists_annotated_filepath(texture_file):
            return f"贴图文件不存在: {texture_file}"
        original_image = str(original_image or "").strip()
        if original_image and not folder_paths.exists_annotated_filepath(original_image):
            return f"原图文件不存在: {original_image}"
        del texture_transform, depth_map
        return True


class MyImageMaskBrushV2Source:
    """Internal prompt node: stable image outputs, independent from brush masks."""

    @classmethod
    def INPUT_TYPES(cls):
        v2_inputs = MyImageMaskBrushV2.INPUT_TYPES()
        required = v2_inputs["required"]
        return {
            "required": {
                "image": required["image"],
                "original_name": required["original_name"],
                "texture_file": required["texture_file"],
                "texture_transform": required["texture_transform"],
                "original_image": required["original_image"],
            },
            "optional": {"depth_map": ("IMAGE",)},
        }

    CATEGORY = "My-Comfnode/internal"
    RETURN_TYPES = ("IMAGE", "MASK", "STRING", "IMAGE")
    RETURN_NAMES = ("绘画图像", "贴图遮罩", "原图原名称", "原图")
    FUNCTION = "load_source"

    def load_source(
        self,
        image: str,
        original_name: str = "",
        texture_file: str = "",
        texture_transform: str = "",
        original_image: str = "",
        depth_map: torch.Tensor | None = None,
    ):
        background, _ = MyImageMaskBrush().load_image(image)
        untouched_original = _load_original_image(image, original_image, original_name)
        composited, texture_mask = _render_depth_texture(
            background, texture_file, texture_transform, depth_map
        )
        resolved_name = _brush_module._resolved_original_name(image, original_name)
        return composited, texture_mask, resolved_name, untouched_original

    @classmethod
    def IS_CHANGED(cls, image, original_name="", texture_file="", texture_transform="", original_image="", depth_map=None):
        return _source_fingerprint(
            image, original_name, texture_file, texture_transform, original_image, depth_map
        )

    @classmethod
    def VALIDATE_INPUTS(cls, image, original_name="", texture_file="", texture_transform="", original_image="", depth_map=None):
        return MyImageMaskBrushV2.VALIDATE_INPUTS(
            image,
            "",
            "",
            original_name,
            texture_file,
            texture_transform,
            original_image,
            depth_map,
        )


class MyImageMaskBrushV2Masks:
    """Internal prompt node: hand masks, independent from all image outputs."""

    @classmethod
    def INPUT_TYPES(cls):
        required = MyImageMaskBrush.INPUT_TYPES()["required"]
        return {
            "required": {
                "image": required["image"],
                "mask_file": required["mask_file"],
                "inverse_mask_file": required["inverse_mask_file"],
                "original_name": required["original_name"],
            }
        }

    CATEGORY = "My-Comfnode/internal"
    RETURN_TYPES = ("MASK", "MASK", "STRING")
    RETURN_NAMES = ("手绘遮罩", "反向遮罩", "原图原名称")
    FUNCTION = "load_masks"

    def load_masks(self, image: str, mask_file: str = "", inverse_mask_file: str = "", original_name: str = ""):
        _, mask, inverse_mask, resolved_name = MyImageMaskBrush().load_image_with_mask(
            image, mask_file, inverse_mask_file, original_name
        )
        return mask, inverse_mask, resolved_name

    IS_CHANGED = MyImageMaskBrush.IS_CHANGED
    VALIDATE_INPUTS = MyImageMaskBrush.VALIDATE_INPUTS


NODE_CLASS_MAPPINGS = {
    "MyComfnodeImageMaskBrushV2": MyImageMaskBrushV2,
    "MyComfnodeImageMaskBrushV2Source": MyImageMaskBrushV2Source,
    "MyComfnodeImageMaskBrushV2Masks": MyImageMaskBrushV2Masks,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "MyComfnodeImageMaskBrushV2": "图像遮罩画笔 V2（深度贴图）",
    "MyComfnodeImageMaskBrushV2Source": "V2 图像输出（内部）",
    "MyComfnodeImageMaskBrushV2Masks": "V2 遮罩输出（内部）",
}
