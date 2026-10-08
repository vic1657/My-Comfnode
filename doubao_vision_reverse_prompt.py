"""豆包视觉模型图片反推提示词节点。"""

from __future__ import annotations

import base64
import io
import json
import os
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import numpy as np
import torch
from PIL import Image


API_ENDPOINT = "https://ark.cn-beijing.volces.com/api/v3/responses"
DEFAULT_MODEL = "doubao-seed-2-0-mini-260428"
DEFAULT_PROMPT = (
    "请详细分析这张图片，并反推适合图像生成模型使用的提示词。"
    "请描述主体、构图、视角、环境、色彩、光影、材质、风格和画面细节，"
    "最后给出一段可直接使用的中文提示词。"
)
DEFAULT_TIMEOUT = 120
MAX_IMAGE_EDGE = 2048


def _image_to_data_url(image: torch.Tensor) -> str:
    """将 ComfyUI 的单张 IMAGE 张量编码为豆包支持的数据 URL。"""
    array = image.detach().float().cpu().clamp(0, 1).numpy()
    if array.ndim != 3 or array.shape[-1] not in (1, 3, 4):
        raise ValueError("IMAGE 输入格式无效，应为 H x W x 1/3/4")

    if array.shape[-1] == 1:
        array = np.repeat(array, 3, axis=-1)
    array = (array[..., :3] * 255.0 + 0.5).astype(np.uint8)
    pil_image = Image.fromarray(array, "RGB")
    if max(pil_image.size) > MAX_IMAGE_EDGE:
        scale = MAX_IMAGE_EDGE / max(pil_image.size)
        size = (max(1, round(pil_image.width * scale)), max(1, round(pil_image.height * scale)))
        pil_image = pil_image.resize(size, Image.Resampling.LANCZOS)

    buffer = io.BytesIO()
    pil_image.save(buffer, format="JPEG", quality=92, optimize=True)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


def _response_text(payload: Any) -> str:
    if not isinstance(payload, dict):
        raise RuntimeError("豆包 API 返回的不是 JSON 对象")

    # Responses API 的标准结果通常位于 output[].content[].text。
    output = payload.get("output")
    if isinstance(output, list):
        parts = []
        for item in output:
            if not isinstance(item, dict):
                continue
            content = item.get("content")
            if isinstance(content, str) and content.strip():
                parts.append(content.strip())
            elif isinstance(content, list):
                for content_item in content:
                    if isinstance(content_item, dict):
                        text = content_item.get("text")
                        if isinstance(text, str) and text.strip():
                            parts.append(text.strip())
        if parts:
            return "\n".join(parts).strip()

    # 保留兼容解析，便于部分网关返回 Chat Completions 风格结果。
    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
        message = choices[0].get("message", {})
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, str) and content.strip():
            return content.strip()
        if isinstance(content, list):
            parts = []
            for item in content:
                if isinstance(item, dict) and isinstance(item.get("text"), str):
                    parts.append(item["text"])
            if parts:
                return "\n".join(parts).strip()

    error = payload.get("error")
    if isinstance(error, dict):
        message = error.get("message") or error.get("code")
        if message:
            raise RuntimeError(f"豆包 API 错误：{message}")
    raise RuntimeError("豆包 API 返回中没有可读取的文字结果")


def _call_doubao(api_key: str, model: str, prompt: str, image_url: str) -> str:
    body = {
        "model": model,
        "input": [
            {
                "role": "user",
                "content": [
                    {"type": "input_image", "image_url": image_url},
                    {"type": "input_text", "text": prompt},
                ],
            }
        ],
    }
    request = Request(
        API_ENDPOINT,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=DEFAULT_TIMEOUT) as response:
            raw = response.read()
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace").strip()
        try:
            detail = json.loads(detail).get("error", {}).get("message", detail)
        except json.JSONDecodeError:
            pass
        raise RuntimeError(f"豆包 API HTTP {error.code}：{detail}") from error
    except URLError as error:
        raise RuntimeError(f"无法连接豆包 API：{error.reason}") from error
    except TimeoutError as error:
        raise RuntimeError("豆包 API 请求超时") from error

    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("豆包 API 返回了无法解析的内容") from error
    return _response_text(payload)


class DoubaoVisionReversePrompt:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "需要让豆包视觉模型分析的图片"}),
                "prompt": (
                    "STRING",
                    {
                        "default": DEFAULT_PROMPT,
                        "multiline": True,
                        "dynamicPrompts": False,
                        "tooltip": "给豆包视觉模型的分析要求",
                    },
                ),
                "api_key": (
                    "STRING",
                    {
                        "default": os.environ.get("ARK_API_KEY", ""),
                        "multiline": False,
                        "defaultInput": True,
                        "tooltip": "火山方舟 API Key，也可留空并使用 ARK_API_KEY 环境变量",
                    },
                ),
            },
            "optional": {
                "model": (
                    "STRING",
                    {
                        "default": DEFAULT_MODEL,
                        "multiline": False,
                        "tooltip": "火山方舟视觉模型 ID",
                    },
                ),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("反推提示词",)
    FUNCTION = "reverse_prompt"
    CATEGORY = "My-Comfnode/豆包"
    DESCRIPTION = "调用豆包视觉模型，根据输入图片反推可用于图像生成的提示词。"

    def reverse_prompt(
        self,
        image: torch.Tensor,
        prompt: str,
        api_key: str,
        model: str = DEFAULT_MODEL,
    ):
        key = (api_key or os.environ.get("ARK_API_KEY", "")).strip()
        if not key:
            raise ValueError("请填写 API key，或设置 ARK_API_KEY 环境变量")

        instruction = (prompt or "").strip() or DEFAULT_PROMPT
        model_name = (model or DEFAULT_MODEL).strip() or DEFAULT_MODEL
        if not isinstance(image, torch.Tensor) or image.ndim != 4 or image.shape[0] < 1:
            raise ValueError("IMAGE 输入为空或格式无效")

        results = []
        total = int(image.shape[0])
        for index in range(total):
            result = _call_doubao(key, model_name, instruction, _image_to_data_url(image[index]))
            results.append(result if total == 1 else f"【第 {index + 1} 张图片】\n{result}")
        return ("\n\n" if total > 1 else "").join(results),


NODE_CLASS_MAPPINGS = {
    "DoubaoVisionReversePrompt": DoubaoVisionReversePrompt,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "DoubaoVisionReversePrompt": "doubao图像反推提示词",
}
