"""通用 OpenAI 兼容 API 调用节点。

本模块不包含任何供应商地址、模型或密钥。用户可填写 API 基础地址，
也可以直接填写完整的 OpenAI 兼容端点地址。
"""

from __future__ import annotations

import base64
import io
import json
import ssl
from typing import Any
from urllib.parse import urlparse
from urllib.request import Request, urlopen

import numpy as np
import requests
import torch
from PIL import Image


DEFAULT_IMAGE_PATH = "/v1/images/generations"


def _json_object(value: str, label: str) -> dict[str, Any]:
    text = (value or "").strip()
    if not text:
        return {}
    try:
        result = json.loads(text)
    except json.JSONDecodeError as error:
        raise ValueError(f"{label} 必须是合法 JSON：{error.msg}") from error
    if not isinstance(result, dict):
        raise ValueError(f"{label} 必须是 JSON 对象")
    return result


def _resolve_image_url(api_url: str) -> str:
    base = (api_url or "").strip().rstrip("/")
    if not base or not urlparse(base).scheme or not urlparse(base).netloc:
        raise ValueError("调用网址必须是完整的 http:// 或 https:// 地址")
    parsed_path = urlparse(base).path.rstrip("/")
    if not parsed_path:
        return f"{base}{DEFAULT_IMAGE_PATH}"
    if parsed_path == "/v1":
        return f"{base}/images/generations"
    # 只要已经包含路径，就视为用户填写的完整图片接口地址。
    return base


def _image_data_url(image: torch.Tensor) -> str:
    value = image.detach().float().cpu().clamp(0, 1).numpy()
    if value.ndim != 3 or value.shape[-1] not in (1, 3, 4):
        raise ValueError("IMAGE 输入格式无效")
    if value.shape[-1] == 1:
        value = np.repeat(value, 3, axis=-1)
    array = (value[..., :3] * 255.0).round().astype(np.uint8)
    encoded = io.BytesIO()
    Image.fromarray(array, "RGB").save(encoded, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(encoded.getvalue()).decode("ascii")


def _tensor_from_image_bytes(data: bytes) -> torch.Tensor:
    try:
        with Image.open(io.BytesIO(data)) as image:
            array = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    except Exception as error:
        raise RuntimeError("API 返回的图片无法解码") from error
    return torch.from_numpy(array).unsqueeze(0)


def _blank_image() -> torch.Tensor:
    return torch.zeros((1, 1, 1, 3), dtype=torch.float32)


def _image_sources_from_payload(payload: Any) -> list[str]:
    if not isinstance(payload, dict):
        return []
    sources: list[str] = []
    for collection_name in ("data", "results"):
        collection = payload.get(collection_name)
        if isinstance(collection, list):
            for item in collection:
                if not isinstance(item, dict):
                    continue
                for field in ("url", "image_url", "b64_json", "base64"):
                    value = item.get(field)
                    if isinstance(value, str) and value:
                        sources.append(value)
                        break
    if sources:
        return sources
    for field in ("url", "image_url", "b64_json", "base64"):
        value = payload.get(field)
        if isinstance(value, str) and value:
            return [value]
    return []


def _download_image(url: str, timeout: int) -> bytes:
    """下载生成结果；兼容部分 Windows 环境中 requests/urllib3 的传输异常。"""
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    }
    errors: list[str] = []

    try:
        response = requests.get(url, headers=headers, timeout=timeout)
        response.raise_for_status()
        if response.content:
            return response.content
        errors.append("requests 返回空内容")
    except Exception as error:
        errors.append(f"requests: {type(error).__name__}: {error}")

    # 某些 ComfyUI 环境替换了 urllib3 后端，会在代理连接上抛出 ProtocolError(None)。
    # 关闭环境代理再试一次，避免影响正常环境的首选下载路径。
    try:
        with requests.Session() as session:
            session.trust_env = False
            response = session.get(url, headers=headers, timeout=timeout)
            response.raise_for_status()
            if response.content:
                return response.content
            errors.append("无代理 requests 返回空内容")
    except Exception as error:
        errors.append(f"无代理 requests: {type(error).__name__}: {error}")

    # 最后使用 Python 标准库，绕开 requests/urllib3 的自定义传输后端。
    try:
        request = Request(url, headers=headers)
        context = ssl.create_default_context()
        with urlopen(request, timeout=timeout, context=context) as response:
            content = response.read()
        if content:
            return content
        errors.append("urllib 返回空内容")
    except Exception as error:
        errors.append(f"urllib: {type(error).__name__}: {error}")

    raise RuntimeError("生成结果图片下载失败：" + "；".join(errors))


def _images_from_payload(payload: Any, timeout: int) -> torch.Tensor | None:
    sources = _image_sources_from_payload(payload)
    if not sources:
        return None
    images: list[torch.Tensor] = []
    for source in sources:
        if source.startswith("data:image/"):
            source = source.split(",", 1)[-1]
        if source.startswith("http://") or source.startswith("https://"):
            images.append(_tensor_from_image_bytes(_download_image(source, timeout)))
            continue
        try:
            images.append(_tensor_from_image_bytes(base64.b64decode(source, validate=True)))
        except Exception as error:
            raise RuntimeError("生成结果中的 Base64 图片无效") from error
    return torch.cat(images, dim=0)


def _error_message(response: requests.Response) -> str:
    try:
        data = response.json()
    except ValueError:
        data = response.text
    if isinstance(data, dict):
        error = data.get("error")
        if isinstance(error, dict):
            message = error.get("message") or error.get("code")
            if message:
                return str(message)
        if isinstance(error, str):
            return error
    return str(data)[:600]


class APILuLuTong:
    """使用标准 Bearer 鉴权调用 OpenAI 兼容 HTTP API。"""

    CATEGORY = "My-Comfnode/API"
    FUNCTION = "run"
    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("图片", "原始响应")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "调用网址": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "填写完整图片接口；只填域名时默认使用 /v1/images/generations",
                }),
                "模型名称": ("STRING", {"default": "", "multiline": False, "placeholder": "填写图片生成模型名称"}),
                "API_KEY": ("STRING", {"default": "", "multiline": False, "password": True}),
                "提示词": ("STRING", {"default": "", "multiline": True}),
                "种子": ("INT", {"default": -1, "min": -1, "max": 2147483647, "step": 1}),
                "生成数量": ("INT", {"default": 1, "min": 1, "max": 10, "step": 1}),
                "图像尺寸": (["auto", "1024x1024", "1536x1024", "1024x1536", "1792x1024", "1024x1792", "2048x2048"], {"default": "auto"}),
                "画面比例": (["auto", "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "9:21"], {"default": "auto"}),
                "分辨率": (["auto", "1k", "2k", "4k"], {"default": "auto"}),
                "质量": (["auto", "low", "medium", "high"], {"default": "auto"}),
                "输出格式": (["auto", "png", "jpeg", "webp"], {"default": "auto"}),
                "背景": (["auto", "opaque", "transparent"], {"default": "auto"}),
            },
            "optional": {
                **{f"参考图{index}": ("IMAGE",) for index in range(1, 11)},
                "额外请求头JSON": ("STRING", {
                    "default": "{}",
                    "multiline": True,
                    "placeholder": "例如 {\"X-Provider-Option\": \"value\"}",
                }),
                "自定义请求体JSON": ("STRING", {
                    "default": "{}",
                    "multiline": True,
                    "placeholder": "会覆盖/补充标准请求体；用于 embeddings、images、responses 等其他 OpenAI 路径",
                }),
            },
        }

    def run(
        self,
        调用网址: str,
        模型名称: str,
        API_KEY: str,
        提示词: str,
        种子: int = -1,
        生成数量: int = 1,
        图像尺寸: str = "auto",
        画面比例: str = "auto",
        分辨率: str = "auto",
        质量: str = "auto",
        输出格式: str = "auto",
        背景: str = "auto",
        参考图1: torch.Tensor | None = None,
        参考图2: torch.Tensor | None = None,
        参考图3: torch.Tensor | None = None,
        参考图4: torch.Tensor | None = None,
        参考图5: torch.Tensor | None = None,
        参考图6: torch.Tensor | None = None,
        参考图7: torch.Tensor | None = None,
        参考图8: torch.Tensor | None = None,
        参考图9: torch.Tensor | None = None,
        参考图10: torch.Tensor | None = None,
        额外请求头JSON: str = "{}",
        自定义请求体JSON: str = "{}",
    ):
        key = (API_KEY or "").strip()
        if not key:
            raise ValueError("请填写 API Key")
        model = (模型名称 or "").strip()
        if not model:
            raise ValueError("请填写模型名称")

        url = _resolve_image_url(调用网址)
        headers: dict[str, str] = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }
        headers.update({str(name): str(value) for name, value in _json_object(额外请求头JSON, "额外请求头JSON").items()})

        reference_inputs = (
            参考图1, 参考图2, 参考图3, 参考图4, 参考图5,
            参考图6, 参考图7, 参考图8, 参考图9, 参考图10,
        )
        reference_images = [image for image in reference_inputs if image is not None]
        reference_data_urls = [
            _image_data_url(image_batch[0])
            for image_batch in reference_images
            if int(image_batch.shape[0]) > 0
        ]

        body: dict[str, Any] = {
            "model": model,
            "prompt": str(提示词 or ""),
            "n": int(生成数量),
        }
        if 图像尺寸 != "auto":
            body["size"] = 图像尺寸
        if 质量 != "auto":
            body["quality"] = 质量
        if 输出格式 != "auto":
            body["output_format"] = 输出格式
        if 背景 != "auto":
            body["background"] = 背景
        if int(种子) >= 0:
            body["seed"] = int(种子)
        if 画面比例 != "auto":
            body["aspectRatio"] = 画面比例
        if 分辨率 != "auto":
            body["resolution"] = 分辨率
        if reference_data_urls:
            body["images"] = reference_data_urls
        body.update(_json_object(自定义请求体JSON, "自定义请求体JSON"))
        body.setdefault("model", model)

        try:
            response = requests.post(url, headers=headers, json=body, timeout=300)
        except requests.RequestException as error:
            raise RuntimeError(f"API 请求失败：{error}") from error
        if not response.ok:
            raise RuntimeError(f"API 返回 HTTP {response.status_code}：{_error_message(response)}")
        try:
            payload = response.json()
        except ValueError as error:
            raise RuntimeError("API 未返回 JSON；请确认该地址是 OpenAI 兼容接口") from error

        image = _images_from_payload(payload, 300)
        if image is None:
            image = _blank_image()
        return (image, json.dumps(payload, ensure_ascii=False, indent=2))


NODE_CLASS_MAPPINGS = {"APILuLuTong": APILuLuTong}
NODE_DISPLAY_NAME_MAPPINGS = {"APILuLuTong": "API路路通"}
