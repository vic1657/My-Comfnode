import importlib.util
import sys
from pathlib import Path


WEB_DIRECTORY = "./web"
_ROOT = Path(__file__).resolve().parent


def _load_local_module(name):
    path = _ROOT / f"{name}.py"
    is_extension = False
    if not path.exists():
        matches = sorted(_ROOT.glob(f"{name}.*.so")) + sorted(_ROOT.glob(f"{name}.*.pyd"))
        if not matches:
            raise ImportError(f"Missing protected module for {name}")
        path = matches[0]
        is_extension = True
    module_name = name if is_extension else f"_my_comfnode_{name}"
    spec = importlib.util.spec_from_file_location(module_name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


_fixed_size_crop = _load_local_module("fixed_size_crop")
_canvas_paint_node = _load_local_module("canvas_paint_node")
_three_d_reference = _load_local_module("three_d_reference")
_batch_image_loader = _load_local_module("batch_image_loader")
_image_preview_selector = _load_local_module("image_preview_selector")
_original_color_relight = _load_local_module("original_color_relight")
_detail_light_preserve = _load_local_module("detail_light_preserve")
_high_fidelity_detail_restore = _load_local_module("high_fidelity_detail_restore")
_image_saver = _load_local_module("image_saver")
_custom_light_render = _load_local_module("custom_light_render")
_mask_priority_selector = _load_local_module("mask_priority_selector")
_image_mask_brush = _load_local_module("image_mask_brush")
_matte_refine = _load_local_module("matte_refine")
_element_separation_mask = _load_local_module("element_separation_mask")
_light_element_separation_mask = _load_local_module("light_element_separation_mask")
_material_aware_shadow_reconstruction = _load_local_module("material_aware_shadow_reconstruction")
_light_redemption = _load_local_module("light_redemption")
_nano_banana2_api = _load_local_module("nano_banana2_api")
_rh_big_banana = _load_local_module("rh_big_banana")
_rh_all_g = _load_local_module("rh_all_g")
_api_lutong = _load_local_module("api_lutong")
_pixel_image_alignment = _load_local_module("pixel_image_alignment")
_my_texture = _load_local_module("my_texture")

_my_fog_mask = _load_local_module("my_fog_mask")
_my_sequential_queue = _load_local_module("my_sequential_queue")
_rh_banana_concurrent = _load_local_module("rh_banana_concurrent")
_my_batch_sort = _load_local_module("my_batch_sort")
_rh_gpt25 = _load_local_module("rh_gpt25")
_my_clothing_difference_mask = _load_local_module("my_clothing_difference_mask")
_my_disable_group = _load_local_module("my_disable_group")
_green_spill_remove = _load_local_module("green_spill_remove")
_chroma_key = _load_local_module("chroma_key")

_my_chroma_key_vis = _load_local_module("my_chroma_key_vis")
_my_video_frames = _load_local_module("my_video_frames")
_image_mask_brush_v2 = _load_local_module("image_mask_brush_v2")
_dream_actor_v2 = _load_local_module("dream_actor_v2")

# 光影细节融合：独立模块，加载失败时只跳过它自己，不影响本包其他节点
try:
    _light_detail_fusion = _load_local_module("light_detail_fusion")
except Exception as _exc:  # pragma: no cover - 保护其他节点
    _light_detail_fusion = None
    print(f"[My-Comfnode] light_detail_fusion 加载失败: {_exc}")

# 自动景别选K（人脸 / 产品）：独立模块，加载失败只跳过自己
try:
    _face_ratio_k = _load_local_module("face_ratio_k")
except Exception as _exc:  # pragma: no cover
    _face_ratio_k = None
    print(f"[My-Comfnode] face_ratio_k 加载失败: {_exc}")

try:
    _product_ratio_k = _load_local_module("product_ratio_k")
except Exception as _exc:  # pragma: no cover
    _product_ratio_k = None
    print(f"[My-Comfnode] product_ratio_k 加载失败: {_exc}")

# MyPTT 工具集（基于 TTPlanet TTP Toolset，MIT，已修正奇数重叠混合偏移）
try:
    _ttp_toolsets = _load_local_module("ttp_toolsets")
except Exception as _exc:  # pragma: no cover
    _ttp_toolsets = None
    print(f"[My-Comfnode] ttp_toolsets 加载失败: {_exc}")

NODE_CLASS_MAPPINGS = {}
NODE_CLASS_MAPPINGS.update(_fixed_size_crop.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_canvas_paint_node.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_three_d_reference.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_batch_image_loader.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_image_preview_selector.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_original_color_relight.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_detail_light_preserve.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_high_fidelity_detail_restore.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_image_saver.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_custom_light_render.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_mask_priority_selector.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_image_mask_brush.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_matte_refine.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_element_separation_mask.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_light_element_separation_mask.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_material_aware_shadow_reconstruction.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_light_redemption.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_nano_banana2_api.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_rh_big_banana.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_rh_all_g.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_api_lutong.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_pixel_image_alignment.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_my_texture.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_my_fog_mask.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_my_sequential_queue.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_rh_banana_concurrent.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_my_batch_sort.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_rh_gpt25.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_my_clothing_difference_mask.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_my_disable_group.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_green_spill_remove.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_chroma_key.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_my_chroma_key_vis.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_my_video_frames.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_image_mask_brush_v2.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(_dream_actor_v2.NODE_CLASS_MAPPINGS)
if _light_detail_fusion is not None:
    NODE_CLASS_MAPPINGS.update(_light_detail_fusion.NODE_CLASS_MAPPINGS)
if _face_ratio_k is not None:
    NODE_CLASS_MAPPINGS.update(_face_ratio_k.NODE_CLASS_MAPPINGS)
if _product_ratio_k is not None:
    NODE_CLASS_MAPPINGS.update(_product_ratio_k.NODE_CLASS_MAPPINGS)
if _ttp_toolsets is not None:
    NODE_CLASS_MAPPINGS.update(_ttp_toolsets.NODE_CLASS_MAPPINGS)

NODE_DISPLAY_NAME_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS.update(_fixed_size_crop.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_canvas_paint_node.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_three_d_reference.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_batch_image_loader.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_image_preview_selector.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_original_color_relight.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_detail_light_preserve.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_high_fidelity_detail_restore.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_image_saver.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_custom_light_render.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_mask_priority_selector.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_image_mask_brush.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_matte_refine.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_element_separation_mask.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_light_element_separation_mask.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_material_aware_shadow_reconstruction.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_light_redemption.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_nano_banana2_api.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_rh_big_banana.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_rh_all_g.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_api_lutong.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_pixel_image_alignment.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_my_texture.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_my_fog_mask.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_my_sequential_queue.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_rh_banana_concurrent.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_my_batch_sort.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_rh_gpt25.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_my_clothing_difference_mask.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_my_disable_group.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_green_spill_remove.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_chroma_key.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_my_chroma_key_vis.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_my_video_frames.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_image_mask_brush_v2.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(_dream_actor_v2.NODE_DISPLAY_NAME_MAPPINGS)
if _light_detail_fusion is not None:
    NODE_DISPLAY_NAME_MAPPINGS.update(_light_detail_fusion.NODE_DISPLAY_NAME_MAPPINGS)
if _face_ratio_k is not None:
    NODE_DISPLAY_NAME_MAPPINGS.update(_face_ratio_k.NODE_DISPLAY_NAME_MAPPINGS)
if _product_ratio_k is not None:
    NODE_DISPLAY_NAME_MAPPINGS.update(_product_ratio_k.NODE_DISPLAY_NAME_MAPPINGS)
if _ttp_toolsets is not None:
    NODE_DISPLAY_NAME_MAPPINGS.update(_ttp_toolsets.NODE_DISPLAY_NAME_MAPPINGS)

# 兼容旧工作流：旧版本插件使用中文显示名作为节点类型注册，
# 这里把中文显示名也注册为别名，保证旧工作流在任意机器上都能直接运行。
for _cls_name, _disp_name in list(NODE_DISPLAY_NAME_MAPPINGS.items()):
    if _cls_name in NODE_CLASS_MAPPINGS and _disp_name not in NODE_CLASS_MAPPINGS:
        NODE_CLASS_MAPPINGS[_disp_name] = NODE_CLASS_MAPPINGS[_cls_name]

# 兼容旧工作流：旧版本插件使用中文显示名作为节点类型注册，
# 这里把中文显示名也注册为别名，保证旧工作流在任意机器上都能直接运行。
for _cls_name, _disp_name in list(NODE_DISPLAY_NAME_MAPPINGS.items()):
    if _cls_name in NODE_CLASS_MAPPINGS and _disp_name not in NODE_CLASS_MAPPINGS:
        NODE_CLASS_MAPPINGS[_disp_name] = NODE_CLASS_MAPPINGS[_cls_name]

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
