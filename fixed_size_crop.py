import math

import comfy.utils
import nodes
import torch


MAX_RESOLUTION = nodes.MAX_RESOLUTION


BASE_RESOLUTIONS = {
    "1:1": (1024, 1024),
    "3:2": (768, 512),
    "4:3": (768, 576),
    "16:9": (768, 432),
    "2:3": (688, 1027),
    "3:4": (576, 768),
    "9:16": (576, 1024),
}

MULTIPLIERS = {
    "base": 1,
    "2x": 2,
    "4x": 4,
    "6x": 6,
    "8x": 8,
}

RATIO_PRESETS = ["自动"] + list(BASE_RESOLUTIONS.keys())

RESOLUTION_LABELS = {
    "auto_long_edge": "自动按长边",
    "auto_short_edge": "自动按短边",
    "base": "原始",
    "2x": "2倍",
    "4x": "4倍",
    "6x": "6倍",
    "8x": "8倍",
}
RESOLUTION_PRESETS = [RESOLUTION_LABELS["auto_long_edge"], RESOLUTION_LABELS["auto_short_edge"]] + [
    RESOLUTION_LABELS[name] for name in MULTIPLIERS
]

ANCHOR_LABELS = {
    "center": "居中",
    "top_left": "左上",
    "top": "上",
    "top_right": "右上",
    "left": "左",
    "right": "右",
    "bottom_left": "左下",
    "bottom": "下",
    "bottom_right": "右下",
}
ANCHORS = [ANCHOR_LABELS[name] for name in ANCHOR_LABELS]

UPSCALE_METHOD_LABELS = {
    "nearest-exact": "最近邻",
    "bilinear": "双线性",
    "area": "面积",
    "bicubic": "双三次",
    "lanczos": "Lanczos",
}
UPSCALE_METHODS = [UPSCALE_METHOD_LABELS[name] for name in UPSCALE_METHOD_LABELS]

COLOR_LABELS = {
    "white": "白色",
    "black": "黑色",
    "gray": "灰色",
    "custom": "自定义",
}
FILL_COLORS = [COLOR_LABELS[name] for name in COLOR_LABELS]
BACKGROUND_COLORS = FILL_COLORS

RESOLUTION_ALIASES = {value: key for key, value in RESOLUTION_LABELS.items()}
RESOLUTION_ALIASES.update({key: key for key in RESOLUTION_LABELS})
ANCHOR_ALIASES = {value: key for key, value in ANCHOR_LABELS.items()}
ANCHOR_ALIASES.update({key: key for key in ANCHOR_LABELS})
UPSCALE_METHOD_ALIASES = {value: key for key, value in UPSCALE_METHOD_LABELS.items()}
UPSCALE_METHOD_ALIASES.update({key: key for key in UPSCALE_METHOD_LABELS})
COLOR_ALIASES = {value: key for key, value in COLOR_LABELS.items()}
COLOR_ALIASES.update({key: key for key in COLOR_LABELS})


def _normalize_ratio_preset(value):
    if value in ("auto", "自动"):
        return "auto"
    return value


def _normalize_resolution_preset(value):
    return RESOLUTION_ALIASES.get(value, value)


def _normalize_anchor(value):
    return ANCHOR_ALIASES.get(value, value)


def _normalize_upscale_method(value):
    return UPSCALE_METHOD_ALIASES.get(value, value)


def _normalize_color(value):
    return COLOR_ALIASES.get(value, value)


def _display_resolution(value):
    return RESOLUTION_LABELS.get(value, value)


def _display_color(value):
    return COLOR_LABELS.get(value, value)


def _display_anchor(value):
    return ANCHOR_LABELS.get(value, value)


def _display_upscale_method(value):
    return UPSCALE_METHOD_LABELS.get(value, value)


def _target_for_ratio(ratio_name, multiplier_name):
    width, height = BASE_RESOLUTIONS[ratio_name]
    multiplier = MULTIPLIERS[multiplier_name]
    return width * multiplier, height * multiplier


def _choose_ratio(width, height):
    source_ratio = width / height
    return min(
        BASE_RESOLUTIONS,
        key=lambda name: abs(math.log(source_ratio / (BASE_RESOLUTIONS[name][0] / BASE_RESOLUTIONS[name][1]))),
    )


def _choose_multiplier(width, height, ratio_name, mode):
    source_edge = max(width, height) if mode == "auto_long_edge" else min(width, height)

    def distance(multiplier_name):
        target_width, target_height = _target_for_ratio(ratio_name, multiplier_name)
        target_edge = max(target_width, target_height) if mode == "auto_long_edge" else min(target_width, target_height)
        return abs(target_edge - source_edge)

    return min(MULTIPLIERS, key=distance)


def _choose_padding_multiplier(width, height, ratio_name, mode):
    edge = max(width, height) if mode == "auto_long_edge" else min(width, height)

    for multiplier_name in MULTIPLIERS:
        target_width, target_height = _target_for_ratio(ratio_name, multiplier_name)
        target_edge = max(target_width, target_height) if mode == "auto_long_edge" else min(target_width, target_height)
        if target_width >= width and target_height >= height and target_edge >= edge:
            return multiplier_name

    return list(MULTIPLIERS.keys())[-1]


def _anchor_offset(extra_space, low_side, high_side):
    if low_side:
        return 0
    if high_side:
        return extra_space
    return extra_space // 2


def _crop_box(source_width, source_height, target_width, target_height, anchor):
    target_ratio = target_width / target_height
    source_ratio = source_width / source_height

    if source_ratio > target_ratio:
        crop_height = source_height
        crop_width = max(1, min(source_width, round(source_height * target_ratio)))
    else:
        crop_width = source_width
        crop_height = max(1, min(source_height, round(source_width / target_ratio)))

    extra_x = source_width - crop_width
    extra_y = source_height - crop_height
    low_x = anchor in ("top_left", "left", "bottom_left")
    high_x = anchor in ("top_right", "right", "bottom_right")
    low_y = anchor in ("top_left", "top", "top_right")
    high_y = anchor in ("bottom_left", "bottom", "bottom_right")
    x = _anchor_offset(extra_x, low_x, high_x)
    y = _anchor_offset(extra_y, low_y, high_y)
    return x, y, crop_width, crop_height


def _color_tensor(color_name, custom_red, custom_green, custom_blue, image):
    if color_name == "white":
        rgb = (1.0, 1.0, 1.0)
    elif color_name == "black":
        rgb = (0.0, 0.0, 0.0)
    elif color_name == "gray":
        rgb = (0.5, 0.5, 0.5)
    else:
        rgb = (custom_red / 255.0, custom_green / 255.0, custom_blue / 255.0)

    return torch.tensor(rgb, device=image.device, dtype=image.dtype)


def _placement_offset(extra_space, anchor, axis):
    if axis == "x":
        low_side = anchor in ("top_left", "left", "bottom_left")
        high_side = anchor in ("top_right", "right", "bottom_right")
    else:
        low_side = anchor in ("top_left", "top", "top_right")
        high_side = anchor in ("bottom_left", "bottom", "bottom_right")
    return _anchor_offset(extra_space, low_side, high_side)


def _fit_inside(width, height, target_width, target_height, allow_upscale=False):
    scale = min(target_width / width, target_height / height)
    if not allow_upscale:
        scale = min(scale, 1.0)
    fitted_width = max(1, min(target_width, round(width * scale)))
    fitted_height = max(1, min(target_height, round(height * scale)))
    return fitted_width, fitted_height, scale


def _clamp_crop_box(x0, y0, x1, y1, source_width, source_height):
    x0 = max(min(int(round(x0)), source_width), 0)
    y0 = max(min(int(round(y0)), source_height), 0)
    x1 = max(min(int(round(x1)), source_width), 0)
    y1 = max(min(int(round(y1)), source_height), 0)
    if x1 <= x0 or y1 <= y0:
        return None
    return x0, y0, x1, y1


def _coordinate_crop_box(source_width, source_height, crop_x, crop_y, crop_width, crop_height, padding):
    crop_x = int(crop_x)
    crop_y = int(crop_y)
    crop_width = int(crop_width)
    crop_height = int(crop_height)
    padding = max(int(padding), 0)

    if crop_y <= 0 and crop_height > source_height:
        scale = source_height / crop_height
        box = _clamp_crop_box(
            crop_x * scale - padding,
            0,
            (crop_x + crop_width) * scale + padding,
            source_height,
            source_width,
            source_height,
        )
        if box:
            return (*box, "坐标按高度缩放")

    if crop_x <= 0 and crop_width > source_width:
        scale = source_width / crop_width
        box = _clamp_crop_box(
            0,
            crop_y * scale - padding,
            source_width,
            (crop_y + crop_height) * scale + padding,
            source_width,
            source_height,
        )
        if box:
            return (*box, "坐标按宽度缩放")

    box = _clamp_crop_box(
        crop_x - padding,
        crop_y - padding,
        crop_x + crop_width + padding,
        crop_y + crop_height + padding,
        source_width,
        source_height,
    )
    if box:
        return (*box, "坐标裁剪")

    return None


def _resize_image(image, width, height, method="area"):
    samples = image.movedim(-1, 1)
    resized = comfy.utils.common_upscale(samples, width, height, method, "disabled")
    return resized.movedim(1, -1)


class FixedSizeImageCrop:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "size_preset": (RATIO_PRESETS,),
                "resolution_preset": (RESOLUTION_PRESETS,),
                "crop_anchor": (ANCHORS,),
                "upscale_method": (UPSCALE_METHODS,),
            },
        }

    RETURN_TYPES = ("IMAGE", "INT", "INT", "STRING")
    RETURN_NAMES = ("图像", "宽度", "高度", "已选预设")
    FUNCTION = "crop_to_fixed_size"
    CATEGORY = "My-Comfnode/图像"

    def crop_to_fixed_size(self, image, size_preset, resolution_preset, crop_anchor, upscale_method):
        source_height = image.shape[1]
        source_width = image.shape[2]
        size_preset = _normalize_ratio_preset(size_preset)
        resolution_preset = _normalize_resolution_preset(resolution_preset)
        crop_anchor = _normalize_anchor(crop_anchor)
        upscale_method = _normalize_upscale_method(upscale_method)

        ratio_name = _choose_ratio(source_width, source_height) if size_preset == "auto" else size_preset
        multiplier_name = (
            _choose_multiplier(source_width, source_height, ratio_name, resolution_preset)
            if resolution_preset.startswith("auto_")
            else resolution_preset
        )
        target_width, target_height = _target_for_ratio(ratio_name, multiplier_name)

        if target_width > MAX_RESOLUTION or target_height > MAX_RESOLUTION:
            raise ValueError(f"目标分辨率 {target_width}x{target_height} 超过 MAX_RESOLUTION {MAX_RESOLUTION}。")

        x, y, crop_width, crop_height = _crop_box(
            source_width,
            source_height,
            target_width,
            target_height,
            crop_anchor,
        )
        cropped = image[:, y : y + crop_height, x : x + crop_width, :].contiguous()
        samples = cropped.movedim(-1, 1)
        output = comfy.utils.common_upscale(samples, target_width, target_height, upscale_method, "disabled")
        output = output.movedim(1, -1)

        info = (
            f"{ratio_name} {_display_resolution(multiplier_name)} -> {target_width}x{target_height}; "
            f"原图 {source_width}x{source_height}; 裁剪 x={x}, y={y}, 宽={crop_width}, 高={crop_height}; "
            f"锚点={_display_anchor(crop_anchor)}; 缩放={_display_upscale_method(upscale_method)}"
        )
        return (output, target_width, target_height, info)


class FixedSizeImagePad:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "size_preset": (RATIO_PRESETS,),
                "resolution_preset": (RESOLUTION_PRESETS,),
                "placement": (ANCHORS,),
                "fill_color": (FILL_COLORS,),
                "custom_red": ("INT", {"default": 255, "min": 0, "max": 255, "step": 1}),
                "custom_green": ("INT", {"default": 255, "min": 0, "max": 255, "step": 1}),
                "custom_blue": ("INT", {"default": 255, "min": 0, "max": 255, "step": 1}),
            }
        }

    RETURN_TYPES = ("IMAGE", "INT", "INT", "STRING", "INT", "INT", "INT", "INT")
    RETURN_NAMES = ("图像", "宽度", "高度", "已选预设", "内容X", "内容Y", "内容宽度", "内容高度")
    FUNCTION = "pad_to_fixed_size"
    CATEGORY = "My-Comfnode/图像"

    def pad_to_fixed_size(
        self,
        image,
        size_preset,
        resolution_preset,
        placement,
        fill_color,
        custom_red,
        custom_green,
        custom_blue,
    ):
        source_height = image.shape[1]
        source_width = image.shape[2]
        size_preset = _normalize_ratio_preset(size_preset)
        resolution_preset = _normalize_resolution_preset(resolution_preset)
        placement = _normalize_anchor(placement)
        fill_color = _normalize_color(fill_color)

        ratio_name = _choose_ratio(source_width, source_height) if size_preset == "auto" else size_preset
        multiplier_name = (
            _choose_padding_multiplier(source_width, source_height, ratio_name, resolution_preset)
            if resolution_preset.startswith("auto_")
            else resolution_preset
        )
        target_width, target_height = _target_for_ratio(ratio_name, multiplier_name)

        if target_width > MAX_RESOLUTION or target_height > MAX_RESOLUTION:
            raise ValueError(f"目标分辨率 {target_width}x{target_height} 超过 MAX_RESOLUTION {MAX_RESOLUTION}。")

        fitted_width, fitted_height, scale = _fit_inside(
            source_width,
            source_height,
            target_width,
            target_height,
            allow_upscale=True,
        )
        fitted_image = image
        if fitted_width != source_width or fitted_height != source_height:
            resize_method = "lanczos" if scale > 1.0 else "area"
            fitted_image = _resize_image(image, fitted_width, fitted_height, resize_method)

        x = _placement_offset(target_width - fitted_width, placement, "x")
        y = _placement_offset(target_height - fitted_height, placement, "y")
        fill = _color_tensor(fill_color, custom_red, custom_green, custom_blue, image)
        output = fill.view(1, 1, 1, 3).repeat(image.shape[0], target_height, target_width, 1)
        output[:, y : y + fitted_height, x : x + fitted_width, :] = fitted_image

        info = (
            f"{ratio_name} {_display_resolution(multiplier_name)} -> {target_width}x{target_height}; "
            f"原图 {source_width}x{source_height}; 适配 {fitted_width}x{fitted_height}; "
            f"缩放={scale:.6f}; 放置 x={x}, y={y}; 填充={_display_color(fill_color)}"
        )
        return (output, target_width, target_height, info, x, y, fitted_width, fitted_height)


class CropBackgroundBorder:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "background_color": (BACKGROUND_COLORS,),
                "tolerance": ("FLOAT", {"default": 0.02, "min": 0.0, "max": 1.0, "step": 0.001}),
                "padding": ("INT", {"default": 0, "min": 0, "max": MAX_RESOLUTION, "step": 1}),
                "custom_red": ("INT", {"default": 255, "min": 0, "max": 255, "step": 1}),
                "custom_green": ("INT", {"default": 255, "min": 0, "max": 255, "step": 1}),
                "custom_blue": ("INT", {"default": 255, "min": 0, "max": 255, "step": 1}),
            },
            "optional": {
                "crop_x": ("INT", {"default": -1, "min": -1, "max": MAX_RESOLUTION, "step": 1, "forceInput": True}),
                "crop_y": ("INT", {"default": -1, "min": -1, "max": MAX_RESOLUTION, "step": 1, "forceInput": True}),
                "crop_width": ("INT", {"default": 0, "min": 0, "max": MAX_RESOLUTION, "step": 1, "forceInput": True}),
                "crop_height": ("INT", {"default": 0, "min": 0, "max": MAX_RESOLUTION, "step": 1, "forceInput": True}),
            },
        }

    RETURN_TYPES = ("IMAGE", "INT", "INT", "STRING")
    RETURN_NAMES = ("图像", "宽度", "高度", "裁剪信息")
    FUNCTION = "crop_background_border"
    CATEGORY = "My-Comfnode/图像"

    def crop_background_border(
        self,
        image,
        background_color,
        tolerance,
        padding,
        custom_red,
        custom_green,
        custom_blue,
        crop_x=-1,
        crop_y=-1,
        crop_width=0,
        crop_height=0,
    ):
        source_height = image.shape[1]
        source_width = image.shape[2]
        if crop_x >= 0 and crop_y >= 0 and crop_width > 0 and crop_height > 0:
            crop_box = _coordinate_crop_box(
                source_width,
                source_height,
                crop_x,
                crop_y,
                crop_width,
                crop_height,
                padding,
            )
            if crop_box:
                x0, y0, x1, y1, crop_mode = crop_box
                output = image[:, y0:y1, x0:x1, :].contiguous()
                width = x1 - x0
                height = y1 - y0
                info = f"{crop_mode} x={x0}, y={y0}, 宽={width}, 高={height}; 原图 {source_width}x{source_height}"
                return (output, width, height, info)

        background_color = _normalize_color(background_color)
        background = _color_tensor(background_color, custom_red, custom_green, custom_blue, image)
        difference = (image[..., :3] - background.view(1, 1, 1, 3)).abs()
        content = (difference > tolerance).any(dim=-1).any(dim=0)

        if not content.any():
            info = f"未找到非{_display_color(background_color)}内容；保留 {source_width}x{source_height}。"
            return (image, source_width, source_height, info)

        ys, xs = torch.where(content)
        x0 = max(int(xs.min().item()) - padding, 0)
        x1 = min(int(xs.max().item()) + 1 + padding, source_width)
        y0 = max(int(ys.min().item()) - padding, 0)
        y1 = min(int(ys.max().item()) + 1 + padding, source_height)
        output = image[:, y0:y1, x0:x1, :].contiguous()
        width = x1 - x0
        height = y1 - y0
        info = (
            f"原图 {source_width}x{source_height}; 裁剪 x={x0}, y={y0}, "
            f"宽={width}, 高={height}; 背景={_display_color(background_color)}; 容差={tolerance}"
        )
        return (output, width, height, info)


NODE_CLASS_MAPPINGS = {
    "MyFixedSizeImageCrop": FixedSizeImageCrop,
    "MyFixedSizeImagePad": FixedSizeImagePad,
    "MyCropBackgroundBorder": CropBackgroundBorder,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MyFixedSizeImageCrop": "固定尺寸图像裁剪",
    "MyFixedSizeImagePad": "固定尺寸图像填充",
    "MyCropBackgroundBorder": "裁剪背景边框",
}
