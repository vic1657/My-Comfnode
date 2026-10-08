from __future__ import annotations

import re

import torch

from comfy_api.latest import io


_MASK_INDEX_RE = re.compile(r"(\d+)$")


def _mask_index(name: str) -> tuple[int, str]:
    match = _MASK_INDEX_RE.search(str(name))
    if match is None:
        return (10_000, str(name))
    return (int(match.group(1)), str(name))


def _normalize_mask(mask: torch.Tensor) -> torch.Tensor:
    if not isinstance(mask, torch.Tensor):
        raise TypeError("遮罩输入必须是 ComfyUI MASK 张量")
    if mask.ndim == 2:
        mask = mask.unsqueeze(0)
    elif mask.ndim == 4 and mask.shape[-1] == 1:
        mask = mask[..., 0]
    elif mask.ndim == 4 and mask.shape[1] == 1:
        mask = mask[:, 0]
    if mask.ndim != 3 or min(mask.shape) < 1:
        raise ValueError(f"遮罩必须是 BHW 张量，当前形状为 {tuple(mask.shape)}")
    return mask


def _has_painted_area(mask: torch.Tensor) -> bool:
    finite = torch.nan_to_num(mask.detach(), nan=0.0, posinf=1.0, neginf=0.0)
    return bool(torch.any(finite > 1e-6).item())


def select_priority_mask(masks: dict[str, torch.Tensor] | None) -> torch.Tensor:
    connected: list[torch.Tensor] = []
    for _, value in sorted((masks or {}).items(), key=lambda item: _mask_index(item[0])):
        if value is None:
            continue
        mask = _normalize_mask(value)
        connected.append(mask)
        if _has_painted_area(mask):
            return mask
    if connected:
        return connected[0]
    return torch.zeros((1, 64, 64), dtype=torch.float32)


class MyMaskPrioritySelector(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        template = io.Autogrow.TemplatePrefix(
            input=io.Mask.Input(
                "mask",
                optional=True,
                tooltip="空白遮罩会自动跳过；数字越小优先级越高",
            ),
            prefix="mask",
            min=1,
            max=50,
        )
        return io.Schema(
            node_id="MyMaskPrioritySelector",
            display_name="遮罩先后判断",
            category="My-Comfnode/遮罩",
            description=(
                "按接口顺序输出第一个实际非空的遮罩。"
                "连接最后一个接口后会自动增加下一个；未连接和空白接口不会报错。"
            ),
            inputs=[
                io.Autogrow.Input(
                    "masks",
                    template=template,
                    optional=True,
                    tooltip="mask0 优先级最高，随后依次为 mask1、mask2……",
                )
            ],
            outputs=[
                io.Mask.Output(
                    display_name="优先遮罩",
                    tooltip="第一个有实际内容的遮罩",
                )
            ],
        )

    @classmethod
    def execute(cls, masks: io.Autogrow.Type | None = None) -> io.NodeOutput:
        return io.NodeOutput(select_priority_mask(masks))


NODE_CLASS_MAPPINGS = {
    "MyMaskPrioritySelector": MyMaskPrioritySelector,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MyMaskPrioritySelector": "遮罩先后判断",
}
