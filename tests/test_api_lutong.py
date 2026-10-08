import base64
import importlib.util
import io
from pathlib import Path
from unittest import mock

from PIL import Image


MODULE_PATH = Path(__file__).resolve().parents[1] / "api_lutong.py"
SPEC = importlib.util.spec_from_file_location("api_lutong_test", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FakeResponse:
    ok = True
    status_code = 200

    def json(self):
        return {"status": "ok"}


class FakeImageDownloadResponse:
    def __init__(self, content):
        self.content = content

    def raise_for_status(self):
        return None


def test_image_url_normalization():
    assert MODULE._resolve_image_url("https://example.com") == "https://example.com/v1/images/generations"
    assert MODULE._resolve_image_url("https://example.com/v1") == "https://example.com/v1/images/generations"
    assert MODULE._resolve_image_url("https://example.com/v1/api/generate") == "https://example.com/v1/api/generate"


def test_standard_image_request_is_platform_independent():
    node = MODULE.APILuLuTong()
    with mock.patch.object(MODULE.requests, "post", return_value=FakeResponse()) as post:
        image, raw = node.run(
            "https://example.com/v1",
            "any-image-model",
            "test-key",
            "draw an image",
        )
    assert tuple(image.shape) == (1, 1, 1, 3)
    assert '"status": "ok"' in raw
    assert post.call_args.args[0] == "https://example.com/v1/images/generations"
    assert post.call_args.kwargs["headers"]["Authorization"] == "Bearer test-key"
    assert post.call_args.kwargs["json"]["model"] == "any-image-model"
    assert "messages" not in post.call_args.kwargs["json"]
    assert "temperature" not in post.call_args.kwargs["json"]
    assert "max_tokens" not in post.call_args.kwargs["json"]


def test_image_response_becomes_image_output():
    buffer = io.BytesIO()
    Image.new("RGB", (2, 1), (255, 0, 0)).save(buffer, format="PNG")

    class ImageResponse(FakeResponse):
        def json(self):
            return {"data": [{"b64_json": base64.b64encode(buffer.getvalue()).decode("ascii")}]}

    node = MODULE.APILuLuTong()
    with mock.patch.object(MODULE.requests, "post", return_value=ImageResponse()) as post:
        image, _raw = node.run(
            "https://example.com/v1/images/generations",
            "any-image-model",
            "test-key",
            "draw a red pixel",
        )
    assert tuple(image.shape) == (1, 1, 2, 3)
    assert image[0, 0, 0, 0].item() == 1.0
    assert post.call_args.kwargs["json"]["prompt"] == "draw a red pixel"


def test_image_parameters_only_send_when_user_selects_them():
    node = MODULE.APILuLuTong()
    with mock.patch.object(MODULE.requests, "post", return_value=FakeResponse()) as post:
        node.run(
            "https://example.com/v1/images/generations",
            "any-image-model",
            "test-key",
            "draw",
            42,
            2,
            "1536x1024",
            "3:2",
            "2k",
            "high",
            "png",
            "transparent",
        )
    body = post.call_args.kwargs["json"]
    assert body["seed"] == 42
    assert body["n"] == 2
    assert body["size"] == "1536x1024"
    assert body["aspectRatio"] == "3:2"
    assert body["resolution"] == "2k"
    assert body["quality"] == "high"
    assert body["output_format"] == "png"
    assert body["background"] == "transparent"


def test_url_image_download_uses_response_bytes():
    buffer = io.BytesIO()
    Image.new("RGB", (3, 2), (0, 255, 0)).save(buffer, format="PNG")
    payload = {"data": [{"url": "https://cdn.example.com/result.png"}]}

    with mock.patch.object(
        MODULE.requests,
        "get",
        return_value=FakeImageDownloadResponse(buffer.getvalue()),
    ) as get:
        image = MODULE._images_from_payload(payload, 10)

    assert tuple(image.shape) == (1, 2, 3, 3)
    assert get.call_args.kwargs["headers"]["Accept"].startswith("image/")


def test_url_image_download_falls_back_without_environment_proxy():
    buffer = io.BytesIO()
    Image.new("RGB", (2, 2), (0, 0, 255)).save(buffer, format="PNG")
    payload = {"results": [{"url": "https://cdn.example.com/result.png"}]}

    session = mock.MagicMock()
    session.__enter__.return_value = session
    session.get.return_value = FakeImageDownloadResponse(buffer.getvalue())
    with mock.patch.object(MODULE.requests, "get", side_effect=RuntimeError("transport failed")):
        with mock.patch.object(MODULE.requests, "Session", return_value=session):
            image = MODULE._images_from_payload(payload, 10)

    assert tuple(image.shape) == (1, 2, 2, 3)
    assert session.trust_env is False
