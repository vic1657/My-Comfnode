import cv2
import numpy as np
from PIL import Image, ImageFilter, ImageChops, ImageEnhance
import node_helpers
import torch


def pil2tensor(image: Image) -> torch.Tensor:
    return torch.from_numpy(np.array(image).astype(np.float32) / 255.0).unsqueeze(0)

def tensor2pil(t_image: torch.Tensor) -> Image:
    return Image.fromarray(np.clip(255.0 * t_image.cpu().numpy().squeeze(), 0, 255).astype(np.uint8))

def apply_gaussian_blur(image_np, ksize=5, sigmaX=1.0):
    if ksize % 2 == 0:
        ksize += 1  # ksize must be odd
    blurred_image = cv2.GaussianBlur(image_np, (ksize, ksize), sigmaX=sigmaX)
    return blurred_image

        
class MyPTT_Tile_Preprocessor:
    def __init__(self, blur_strength=3.0):
        self.blur_strength = blur_strength

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "scale_factor": ("FLOAT", {"default": 2.00, "min": 1.00, "max": 8.00, "step": 0.05}),
                "blur_strength": ("FLOAT", {"default": 1.0, "min": 1.0, "max": 20.0, "step": 0.1}),
            },
            "optional": {}
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image_output",)
    FUNCTION = 'process_image'
    CATEGORY = "My-Comfnode/MyPTT"

    def process_image(self, image, scale_factor, blur_strength):
        ret_images = []
    
        for i in image:
            # Convert tensor to PIL for processing
            _canvas = tensor2pil(torch.unsqueeze(i, 0)).convert('RGB')
        
            # Convert PIL image to OpenCV format
            img_np = np.array(_canvas)[:, :, ::-1]  # RGB to BGR
        
            # Resize image first if you want blur to apply after resizing
            height, width = img_np.shape[:2]
            new_width = int(width / scale_factor)
            new_height = int(height / scale_factor)
            resized_down = cv2.resize(img_np, (new_width, new_height), interpolation=cv2.INTER_AREA)
            resized_img = cv2.resize(resized_down, (width, height), interpolation=cv2.INTER_LINEAR)
        
            # Apply Gaussian blur after resizing
            img_np = apply_gaussian_blur(resized_img, ksize=int(blur_strength), sigmaX=blur_strength / 2)
        
            # Convert OpenCV back to PIL and then to tensor
            _canvas = Image.fromarray(img_np[:, :, ::-1])  # BGR to RGB
            tensor_img = pil2tensor(_canvas)
            ret_images.append(tensor_img)
    
        return (torch.cat(ret_images, dim=0),)        


class MyPTT_Image_Tile_Batch:
    def __init__(self, *args, **kwargs):
        pass

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "tile_width": ("INT", {"default": 1024, "min": 1}),
                "tile_height": ("INT", {"default": 1024, "min": 1}),
            }
        }

    RETURN_TYPES = ("IMAGE", "LIST", "TUPLE", "TUPLE")
    RETURN_NAMES = ("IMAGES", "POSITIONS", "ORIGINAL_SIZE", "GRID_SIZE")
    FUNCTION = "tile_image"

    CATEGORY = "My-Comfnode/MyPTT"

    def tile_image(self, image, tile_width=1024, tile_height=1024):
        image = tensor2pil(image.squeeze(0))
        img_width, img_height = image.size

        if img_width <= tile_width and img_height <= tile_height:
            # [FIX] 返回与正常分支一致的 (N,H,W,C) 张量（原来返回 list 套 5 维张量）
            return (pil2tensor(image), [(0, 0, img_width, img_height)], (img_width, img_height), (1, 1))

        def calculate_step(size, tile_size):
            if size <= tile_size:
                return 1, 0
            else:
                num_tiles = (size + tile_size - 1) // tile_size
                overlap = (num_tiles * tile_size - size) // (num_tiles - 1)
                step = tile_size - overlap
                return num_tiles, step

        num_cols, step_x = calculate_step(img_width, tile_width)
        num_rows, step_y = calculate_step(img_height, tile_height)

        tiles = []
        positions = []
        for y in range(num_rows):
            for x in range(num_cols):
                left = x * step_x
                upper = y * step_y
                right = min(left + tile_width, img_width)
                lower = min(upper + tile_height, img_height)

                if right - left < tile_width:
                    left = max(0, img_width - tile_width)
                if lower - upper < tile_height:
                    upper = max(0, img_height - tile_height)

                tile = image.crop((left, upper, right, lower))
                tile_tensor = pil2tensor(tile)
                tiles.append(tile_tensor)
                positions.append((left, upper, right, lower))

        tiles = torch.stack(tiles, dim=0).squeeze(1)
        return (tiles, positions, (img_width, img_height), (num_cols, num_rows))


class MyPTT_Image_Assy:
    def __init__(self, *args, **kwargs):
        pass

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "tiles": ("IMAGE",),
                "positions": ("LIST",),
                "original_size": ("TUPLE",),
                "grid_size": ("TUPLE",),
                "padding": ("INT", {"default": 64, "min": 1}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("RECONSTRUCTED_IMAGE",)
    FUNCTION = "assemble_image"

    CATEGORY = "My-Comfnode/MyPTT"

    def create_gradient_mask(self, size, direction):
        """Create a gradient mask for blending."""
        mask = Image.new("L", size)
        for i in range(size[0] if direction == 'horizontal' else size[1]):
            value = int(255 * (1 - (i / size[0] if direction == 'horizontal' else i / size[1])))
            if direction == 'horizontal':
                mask.paste(value, (i, 0, i+1, size[1]))
            else:
                mask.paste(value, (0, i, size[0], i+1))
        return mask

    def blend_tiles(self, tile1, tile2, overlap_size, direction, padding):
        """Blend two tiles with a smooth transition."""
        blend_size = padding
        if blend_size > overlap_size:
            blend_size = overlap_size

        # Split the non-blended offset between both sides so the crop width is
        # exactly blend_size even when (overlap_size - blend_size) is odd.
        offset_total = overlap_size - blend_size
        offset_left = offset_total // 2
        offset_right = offset_total - offset_left

        size = (blend_size, tile1.height) if direction == 'horizontal' else (tile1.width, blend_size)
        mask = self.create_gradient_mask(size, direction)

        if direction == 'horizontal':
            crop_tile1 = tile1.crop((tile1.width - overlap_size + offset_left, 0, tile1.width - offset_right, tile1.height))
            crop_tile2 = tile2.crop((offset_left, 0, offset_left + blend_size, tile2.height))
            if crop_tile1.size != crop_tile2.size:
                # Fallback: force-align sizes instead of raising (safe for blending)
                crop_tile1 = crop_tile1.resize(crop_tile2.size)

            blended = Image.composite(crop_tile1, crop_tile2, mask)
            result = Image.new("RGB", (tile1.width + tile2.width - overlap_size, tile1.height))
            result.paste(tile1.crop((0, 0, tile1.width - overlap_size + offset_left, tile1.height)), (0, 0))
            result.paste(blended, (tile1.width - overlap_size + offset_left, 0))
            result.paste(tile2.crop((offset_left + blend_size, 0, tile2.width, tile2.height)), (tile1.width - offset_right, 0))
        else:
            offset_top = offset_left
            offset_bottom = offset_right
            crop_tile1 = tile1.crop((0, tile1.height - overlap_size + offset_top, tile1.width, tile1.height - offset_bottom))
            crop_tile2 = tile2.crop((0, offset_top, tile2.width, offset_top + blend_size))
            if crop_tile1.size != crop_tile2.size:
                # Fallback: force-align sizes instead of raising (safe for blending)
                crop_tile1 = crop_tile1.resize(crop_tile2.size)

            blended = Image.composite(crop_tile1, crop_tile2, mask)
            result = Image.new("RGB", (tile1.width, tile1.height + tile2.height - overlap_size))
            result.paste(tile1.crop((0, 0, tile1.width, tile1.height - overlap_size + offset_top)), (0, 0))
            result.paste(blended, (0, tile1.height - overlap_size + offset_top))
            result.paste(tile2.crop((0, offset_top + blend_size, tile2.width, tile2.height)), (0, tile1.height - offset_bottom))
        return result

    def assemble_image(self, tiles, positions, original_size, grid_size, padding):
        num_cols, num_rows = grid_size
        reconstructed_image = Image.new("RGB", original_size)

        # [FIX tile-space mismatch] If tiles were diffused at a reduced resolution
        # (e.g. scaled to 2048 before KSampler) while positions/original_size are
        # in the full-resolution space (e.g. 6000), blend windows would land on
        # non-shared content -> ghosting / pixel seams. Rescale tiles back to the
        # geometry described by `positions` before assembling.
        try:
            _px0, _py0, _px1, _py1 = positions[0]
            _tw, _th = int(_px1 - _px0), int(_py1 - _py0)
            _ch, _cw = int(tiles.shape[1]), int(tiles.shape[2])
            if _tw > 0 and _th > 0 and (_cw, _ch) != (_tw, _th):
                # Use the same tensor2pil/pil2tensor path as the rest of this node
                # to guarantee channel order (H,W,C) is preserved.
                _resized = []
                for _i in range(tiles.shape[0]):
                    _img = tensor2pil(tiles[_i].unsqueeze(0))
                    if _img.size != (_tw, _th):
                        _img = _img.resize((_tw, _th), Image.LANCZOS)
                    _resized.append(pil2tensor(_img))
                tiles = torch.cat(_resized, dim=0)
        except Exception:
            pass

        # First, blend each row independently
        row_images = []
        for row in range(num_rows):
            row_image = tensor2pil(tiles[row * num_cols].unsqueeze(0))
            for col in range(1, num_cols):
                index = row * num_cols + col
                tile_image = tensor2pil(tiles[index].unsqueeze(0))
                prev_right = positions[index - 1][2]
                left = positions[index][0]
                overlap_width = prev_right - left
                if overlap_width > 0:
                    row_image = self.blend_tiles(row_image, tile_image, overlap_width, 'horizontal', padding)
                else:
                    # [FIX] PIL pastes clip at the canvas edge, it does NOT grow the
                    # image. With zero overlap (image size is an exact multiple of
                    # the tile size) the old code silently dropped every tile after
                    # the first. Build a wide enough canvas explicitly.
                    canvas = Image.new(
                        "RGB",
                        (row_image.width + tile_image.width, max(row_image.height, tile_image.height)),
                    )
                    canvas.paste(row_image, (0, 0))
                    canvas.paste(tile_image, (row_image.width, 0))
                    row_image = canvas
            row_images.append(row_image)

        # Now, blend each row together vertically
        final_image = row_images[0]
        for row in range(1, num_rows):
            prev_lower = positions[(row - 1) * num_cols][3]
            upper = positions[row * num_cols][1]
            overlap_height = prev_lower - upper
            if overlap_height > 0:
                final_image = self.blend_tiles(final_image, row_images[row], overlap_height, 'vertical', padding)
            else:
                # [FIX] same as above: paste does not grow the canvas
                canvas = Image.new(
                    "RGB",
                    (max(final_image.width, row_images[row].width), final_image.height + row_images[row].height),
                )
                canvas.paste(final_image, (0, 0))
                canvas.paste(row_images[row], (0, final_image.height))
                final_image = canvas

        if final_image.size != tuple(original_size):
            # [FIX] keep the declared output geometry even if a tile was short
            final_image = final_image.crop((0, 0, original_size[0], original_size[1])) \
                if final_image.width >= original_size[0] and final_image.height >= original_size[1] \
                else final_image.resize(tuple(original_size), Image.LANCZOS)

        # [FIX] pil2tensor already returns (1,H,W,C); the extra unsqueeze produced a
        # 5-dim tensor that downstream nodes/save rarely expect.
        # [FIX] Must return a 1-tuple: ComfyUI unpacks non-tuple returns by iterating
        # the tensor, which turned (1,H,W,C) into (H,W,C) and made SaveImage emit one
        # file per image row.
        return (pil2tensor(final_image),)


class MyPTT_CoordinateSplitter:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "Positions": ("LIST", {"forceInput": True}),
            }
        }
        
    RETURN_TYPES = ("LIST",)
    RETURN_NAMES = ("Coordinates",)
    FUNCTION = "split_coordinates"

    CATEGORY = "My-Comfnode/MyPTT"
    
    def split_coordinates(self, Positions):
        coordinates = []
        for i, coords in enumerate(Positions):
            if len(coords) != 4:
                raise ValueError(f"Coordinate group {i+1} must contain exactly 4 values, but got {len(coords)}")
            
            x, y, x2, y2 = coords
            width = x2 - x
            height = y2 - y
            coordinates.append((x, y, width, height))  # Create a tuple for each coordinate group
        
        return (coordinates,)  # Return as a tuple containing a list of tuples



class MyPTT_condtobatch:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "conditionings": ("CONDITIONING", {"forceInput": True}),
            }
        }

    INPUT_IS_LIST = True

    RETURN_TYPES = ("CONDITIONING",)
    FUNCTION = "combine_to_batch"

    CATEGORY = "My-Comfnode/MyPTT"

    def combine_to_batch(self, conditionings):
        # 直接将所有conditioning组合在一起并返回
        combined_conditioning = sum(conditionings, [])
        return (combined_conditioning,)
        
        
class MyPTT_condsetarea_merge:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "conditioning_batch": ("CONDITIONING", {"forceInput": True}),
                "coordinates": ("LIST", {"forceInput": True}),
                "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.01}),
            }
        }

    RETURN_TYPES = ("CONDITIONING",)
    FUNCTION = "apply_coordinates_to_batch"

    CATEGORY = "My-Comfnode/MyPTT"

    def apply_coordinates_to_batch(self, conditioning_batch, coordinates, strength):
        # 确保coordinates和conditioning_batch的数量一致
        if len(coordinates) != len(conditioning_batch):
            raise ValueError(f"The number of coordinates ({len(coordinates)}) does not match the number of conditionings ({len(conditioning_batch)})")

        updated_conditionings = []

        # 遍历每个conditioning和相应的coordinate
        for conditioning, coord in zip(conditioning_batch, coordinates):
            if len(coord) != 4:
                raise ValueError(f"Each coordinate should have exactly 4 values, but got {len(coord)}")

            x, y, width, height = coord

            # 将每个 conditioning 处理为列表格式
            single_conditioning = [conditioning]

            # 使用标准的 node_helpers.conditioning_set_values 方法进行区域设置
            updated_conditioning = node_helpers.conditioning_set_values(
                single_conditioning,
                {
                    "area": (height // 8, width // 8, y // 8, x // 8),
                    "strength": strength,
                    "set_area_to_bounds": False,
                }
            )

            updated_conditionings.append(updated_conditioning)

        # 将所有更新后的conditioning重新组合为一个batch
        combined_conditioning = sum(updated_conditionings, [])
        return (combined_conditioning,)
        
class Tile_imageSize:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "width_factor": ("INT", {"default": 3, "min": 1, "max": 10, "step": 1}),   
                "height_factor": ("INT", {"default": 3, "min": 1, "max": 10, "step": 1}),
                "overlap_rate": ("FLOAT", {"default": 0.1, "min": 0.05, "max": 0.95, "step": 0.05}),                
            }
        }

    RETURN_TYPES = ("INT", "INT")
    RETURN_NAMES = ("tile_width", "tile_height")
    CATEGORY = "My-Comfnode/MyPTT"
    FUNCTION = "image_width_height"

    def image_width_height(self, image, width_factor, height_factor, overlap_rate):
        _, raw_H, raw_W, _ = image.shape

        # 应用输入的系数和0.9因子进行计算
        tile_width = int(raw_W / (width_factor * (1-overlap_rate)))
        tile_height = int(raw_H / (height_factor * (1-overlap_rate)))

        # 验证 tile_width 和 tile_height 是否可以被8整除
        if tile_width % 8 != 0:
            tile_width = (tile_width // 8) * 8  # 调整到最近的可被8整除的值
        if tile_height % 8 != 0:
            tile_height = (tile_height // 8) * 8  # 调整到最近的可被8整除的值

        # 返回结果
        return (tile_width, tile_height)
        
NODE_CLASS_MAPPINGS = {
    "MyPTT_Tile_Preprocessor": MyPTT_Tile_Preprocessor,
    "MyPTT_Image_Tile_Batch": MyPTT_Image_Tile_Batch,
    "MyPTT_Image_Assy": MyPTT_Image_Assy,
    "MyPTT_CoordinateSplitter": MyPTT_CoordinateSplitter,
    "MyPTT_condtobatch": MyPTT_condtobatch,
    "MyPTT_condsetarea_merge": MyPTT_condsetarea_merge,
    "MyPTT_Tile_image_size": Tile_imageSize
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MyPTT_Tile_Preprocessor": "🪐MyPTT Tile Preprocessor",
    "MyPTT_Image_Tile_Batch": "🪐MyPTT_Image_Tile_Batch",
    "MyPTT_Image_Assy": "🪐MyPTT_Image_Assy",
    "MyPTT_CoordinateSplitter": "🪐MyPTT_CoordinateSplitter",
    "MyPTT_condtobatch": "🪐MyPTT_cond to batch",
    "MyPTT_condsetarea_merge": "🪐MyPTT_condsetarea_merge",
    "MyPTT_Tile_image_size": "🪐MyPTT_Tile_image_size"
}
