import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import "../../scripts/domWidget.js";
import "./okaypixels_image_editor.js?v=7";

const NODE_CLASS = "MyComfnodeImageMaskBrush";
const IMAGE_WIDGET = "image";
const MASK_WIDGET = "mask_file";
const INVERSE_MASK_WIDGET = "inverse_mask_file";
const ORIGINAL_NAME_WIDGET = "original_name";
const ORIGINAL_IMAGE_WIDGET = "original_image";
const TEXTURE_FILE_WIDGET = "texture_file";
const TEXTURE_TRANSFORM_WIDGET = "texture_transform";
const VIEW_HEIGHT = 590;
const MIN_NODE_WIDTH = 500;
const MIN_NODE_HEIGHT = VIEW_HEIGHT;
const NODE_SHELL_HEIGHT = 132;
const DEFAULT_NODE_HEIGHT = VIEW_HEIGHT + NODE_SHELL_HEIGHT;
const MAX_NODE_HEIGHT = 1800;
const MIN_PREVIEW_ZOOM = 1;
const MAX_PREVIEW_ZOOM = 6;
const MASK_SUBFOLDER = "my-mask-brush";
const EDIT_PROJECT_PROP = "maskBrushImageEditProject";
const V2_NODE_CLASS = "MyComfnodeImageMaskBrushV2";
const V2_SOURCE_CLASS = "MyComfnodeImageMaskBrushV2Source";
const V2_MASKS_CLASS = "MyComfnodeImageMaskBrushV2Masks";

function base64ToBlob(value, fallbackMime = "image/png") {
  const source = String(value || "");
  if (!source) return null;

  const commaIndex = source.indexOf(",");
  const header = commaIndex >= 0 ? source.slice(0, commaIndex) : "";
  const payload = commaIndex >= 0 ? source.slice(commaIndex + 1) : source;
  const mimeMatch = header.match(/^data:([^;,]+)/i);
  const mime = mimeMatch?.[1] || fallbackMime;
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}

function findWidget(node, name) {
  return node.widgets?.find((widget) => widget.name === name);
}

function hideWidget(node, name) {
  const widget = findWidget(node, name);
  if (!widget || widget._imageMaskBrushHidden) return widget;
  widget._imageMaskBrushHidden = true;
  widget.hidden = true;
  widget.type = "converted-widget";
  widget.computeSize = () => [0, -4];
  widget.draw = () => {};
  if (widget.options) widget.options.hidden = true;
  if (widget.inputEl) widget.inputEl.style.display = "none";
  if (widget.element) widget.element.style.display = "none";
  return widget;
}

function parseAnnotatedFile(value, fallbackType = "input") {
  if (value && typeof value === "object") {
    const filename = String(value.filename || value.name || "");
    if (!filename) return null;
    return {
      filename,
      subfolder: String(value.subfolder || ""),
      type: String(value.type || fallbackType),
    };
  }

  const raw = String(value || "").trim();
  if (!raw) return null;
  const match = raw.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
  const path = (match ? match[1] : raw).replaceAll("\\", "/");
  const type = match ? match[2] : fallbackType;
  const slash = path.lastIndexOf("/");
  return {
    filename: slash >= 0 ? path.slice(slash + 1) : path,
    subfolder: slash >= 0 ? path.slice(0, slash) : "",
    type,
  };
}

function annotatedFileValue(file) {
  const path = file.subfolder ? `${file.subfolder}/${file.filename}` : file.filename;
  return `${path} [${file.type || "input"}]`;
}

function imageValueKey(value) {
  if (value && typeof value === "object") {
    return JSON.stringify({
      filename: value.filename || value.name || "",
      subfolder: value.subfolder || "",
      type: value.type || "input",
    });
  }
  return String(value || "");
}

function originalNameFromImage(value) {
  const file = parseAnnotatedFile(value);
  const filename = String(file?.filename || "");
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

function annotatedImageValue(value) {
  const file = parseAnnotatedFile(value, "input");
  return file ? annotatedFileValue(file) : "";
}

function findOriginalImageValue(imageWidget, originalName) {
  const expectedName = String(originalName || "").trim();
  const values = imageWidget?.options?.values;
  if (!expectedName || !Array.isArray(values)) return "";
  const candidate = values.find(value => originalNameFromImage(value) === expectedName);
  return candidate == null ? "" : annotatedImageValue(candidate);
}

function viewUrl(file, cacheBust = false) {
  if (!file) return "";
  const query = new URLSearchParams({
    filename: file.filename,
    subfolder: file.subfolder || "",
    type: file.type || "input",
  });
  if (cacheBust) query.set("t", String(Date.now()));
  return `/view?${query.toString()}`;
}

function isImageFile(file) {
  if (!file) return false;
  if (file.type?.startsWith("image/")) return true;
  return /\.(png|jpe?g|webp|gif|bmp|tiff?|avif|heic)$/i.test(file.name || "");
}

async function uploadDroppedImage(node, file) {
  if (!isImageFile(file) || node._maskBrushImageUploading) return false;
  node._maskBrushImageUploading = true;
  setStatus(node, "正在上传图像…", "saving");
  try {
    const form = new FormData();
    form.append("image", file, file.name);
    form.append("type", "input");
    form.append("overwrite", "false");
    const response = await fetch("/upload/image", { method: "POST", body: form });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(detail || `HTTP ${response.status}`);
    }
    const result = await response.json();
    const widget = findWidget(node, IMAGE_WIDGET);
    if (!widget) throw new Error("找不到图像加载控件");
    const path = result.subfolder ? `${result.subfolder}/${result.name || file.name}` : (result.name || file.name);
    const values = widget.options?.values;
    if (Array.isArray(values) && !values.includes(path)) values.push(path);
    widget.value = path;
    widget.callback?.(path);
    node._maskBrushObservedImage = imageValueKey(path);
    loadSelectedImage(node, true);
    return true;
  } catch (error) {
    console.error("[ImageMaskBrush] image upload failed", error);
    setStatus(node, `图像上传失败：${error.message || error}`, "error");
    return false;
  } finally {
    node._maskBrushImageUploading = false;
    node._maskBrushRoot?.classList.remove("is-dragging");
  }
}

function makeEditedImageName() {
  return `edited-image-${Date.now()}.jpg`;
}

function makeEditedMaskName() {
  return `edited-mask-${Date.now()}.png`;
}

function makeEditedInverseMaskName() {
  return `edited-inverse-mask-${Date.now()}.png`;
}

async function uploadInputImageBlob(blob, filename = makeEditedImageName(), subfolder = "") {
  if (!blob) throw new Error("没有可保存的编辑图片");
  const form = new FormData();
  form.append("image", blob, filename);
  form.append("type", "input");
  if (subfolder) form.append("subfolder", subfolder);
  form.append("overwrite", "true");
  const response = await fetch("/upload/image", {
    method: "POST",
    body: form,
  });
  if (!response.ok) throw new Error(`图片上传失败：${response.status}`);
  const data = await response.json();
  return {
    filename: data.name || filename,
    subfolder: data.subfolder || subfolder,
    type: data.type || "input",
  };
}

function imageSignatureFromSource(src) {
  const text = String(src || "");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return `${text.length}:${hash}`;
}

function addImageWidgetValue(widget, path) {
  const values = widget?.options?.values;
  if (Array.isArray(values) && path && !values.includes(path)) values.push(path);
}

function editorAssetExtension(mimeType) {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.includes("jpeg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  return "png";
}

async function editorAssetBlob(source) {
  const value = String(source || "");
  if (value.startsWith("data:image/")) return base64ToBlob(value);
  if (value.startsWith("blob:")) {
    const response = await fetch(value);
    if (!response.ok) throw new Error(`编辑素材读取失败：${response.status}`);
    return response.blob();
  }
  return null;
}

async function externalizeEditorProject(project) {
  if (!project?.layers?.length) return project;
  const cache = new Map();
  let assetIndex = 0;
  const externalize = async (source) => {
    const key = String(source || "");
    if (!key.startsWith("data:image/") && !key.startsWith("blob:")) return source;
    if (!cache.has(key)) {
      cache.set(key, (async () => {
        const blob = await editorAssetBlob(key);
        assetIndex += 1;
        const filename = `editor-asset-${Date.now()}-${assetIndex}.${editorAssetExtension(blob?.type)}`;
        const file = await uploadInputImageBlob(blob, filename, `${MASK_SUBFOLDER}/editor-assets`);
        return viewUrl(file, false);
      })());
    }
    return cache.get(key);
  };
  const layers = await Promise.all(project.layers.map(async (layer) => ({
    ...layer,
    src: await externalize(layer.src),
    maskSrc: await externalize(layer.maskSrc),
  })));
  return { ...project, layers };
}

async function openImageEditor(node) {
  const imageWidget = findWidget(node, IMAGE_WIDGET);
  const maskWidget = findWidget(node, MASK_WIDGET);
  const inverseMaskWidget = findWidget(node, INVERSE_MASK_WIDGET);
  const textureFileWidget = findWidget(node, TEXTURE_FILE_WIDGET);
  const textureTransformWidget = findWidget(node, TEXTURE_TRANSFORM_WIDGET);
  const originalImageWidget = findWidget(node, ORIGINAL_IMAGE_WIDGET);
  const textureV2 = node._maskBrushVariant === "v2";
  const file = parseAnnotatedFile(imageWidget?.value, "input");
  if (!file) {
    setStatus(node, "请先选择一张图片再编辑", "error");
    return;
  }

  const editorApi = textureV2 ? window.OkayPixelsComfyTextureEditor : window.OkayPixelsComfyImageEditor;
  if (!editorApi?.open) {
    setStatus(node, "图片编辑器不可用", "error");
    console.error("[ImageMaskBrush] OkayPixels image editor is not loaded");
    return;
  }

  const imageData = viewUrl(file, true);
  const inputSignature = imageSignatureFromSource(imageValueKey(imageWidget?.value));
  const projectRecord = node.properties?.[EDIT_PROJECT_PROP] || null;
  const project = projectRecord?.inputSignature === inputSignature ? projectRecord.project : null;

  try {
    setStatus(node, "正在打开图片编辑器…", "saving");
    let editor;
    editor = await editorApi.open({
      node,
      imageData,
      project,
      inputSignature,
      imageMimeType: "image/jpeg",
      imageQuality: 0.9,
      includeImageBase64: false,
      includeMaskBase64: false,
      alphaMask: true,
      onSave: async ({ imageBase64, imageBlob, maskBase64, maskBlob, inverseMaskBase64, inverseMaskBlob, width, height, project: savedProject, textureBaseBlob, textureBlob, textureTransform }) => {
        const editedBlob = textureBaseBlob || imageBlob || base64ToBlob(imageBase64);
        const editedFilePromise = uploadInputImageBlob(editedBlob, makeEditedImageName());
        const compactProjectPromise = externalizeEditorProject(savedProject);
        const maskFilePromise = (maskBase64 || maskBlob) ? (async () => {
          const editedMaskBlob = maskBlob || base64ToBlob(maskBase64);
          return uploadInputImageBlob(editedMaskBlob, makeEditedMaskName(), MASK_SUBFOLDER);
        })() : Promise.resolve(null);
        const inverseMaskFilePromise = (inverseMaskBase64 || inverseMaskBlob) ? (async () => {
          const editedInverseMaskBlob = inverseMaskBlob || base64ToBlob(inverseMaskBase64);
          return uploadInputImageBlob(editedInverseMaskBlob, makeEditedInverseMaskName(), MASK_SUBFOLDER);
        })() : Promise.resolve(null);
        const textureFilePromise = textureV2 && textureBlob
          ? uploadInputImageBlob(textureBlob, `sticker-${Date.now()}.png`, `${MASK_SUBFOLDER}/stickers`)
          : Promise.resolve(null);
        const [editedFile, editedMask, editedInverseMask, compactProject, textureFile] = await Promise.all([
          editedFilePromise,
          maskFilePromise,
          inverseMaskFilePromise,
          compactProjectPromise,
          textureFilePromise,
        ]);
        const editedPath = editedFile.subfolder ? `${editedFile.subfolder}/${editedFile.filename}` : editedFile.filename;
        const maskValue = editedMask ? annotatedFileValue(editedMask) : "";
        const inverseMaskValue = editedInverseMask ? annotatedFileValue(editedInverseMask) : "";

        addImageWidgetValue(imageWidget, editedPath);
        if (maskWidget) maskWidget.value = maskValue;
        if (inverseMaskWidget) inverseMaskWidget.value = inverseMaskValue;
        if (textureFileWidget) textureFileWidget.value = textureFile ? annotatedFileValue(textureFile) : "";
        if (textureTransformWidget) textureTransformWidget.value = textureFile ? String(textureTransform || "") : "";
        imageWidget.value = editedPath;
        node._maskBrushObservedImage = imageValueKey(editedPath);
        node.properties[EDIT_PROJECT_PROP] = {
          project: compactProject,
          inputSignature: imageSignatureFromSource(imageValueKey(editedPath)),
          width,
          height,
          maskFile: maskValue,
          inverseMaskFile: inverseMaskValue,
        };
        node._maskBrushPreserveOriginalNameOnce = true;
        node._maskBrushPreserveOriginalImageOnce = true;
        imageWidget.callback?.(editedPath);
        loadSelectedImage(node, false);
        setStatus(node, `已更新图片：${editedPath}${maskValue || inverseMaskValue ? "，遮罩已写入工作流" : ""}`, "saved");
        node.graph?.setDirtyCanvas?.(true, true);
      },
    });
    if (node._maskBrushImageReady) setStatus(node, "图片编辑完成", "saved");
  } catch (error) {
    console.error("[ImageMaskBrush] image edit failed", error);
    setStatus(node, error.message || "图片编辑失败", "error");
  }
}

function setStatus(node, text, tone = "normal") {
  if (!node._maskBrushStatus) return;
  node._maskBrushStatus.textContent = text;
  node._maskBrushStatus.dataset.tone = tone;
}

function setPaintingActive(node, active) {
  const root = node._maskBrushRoot;
  if (!root) return;
  root.classList.toggle("is-painting", active && !!node._maskBrushImageReady);
}

function layoutImageFrame(node) {
  const stage = node._maskBrushStage;
  const frame = node._maskBrushFrame;
  const image = node._maskBrushImage;
  if (!stage || !frame || !image?.naturalWidth || !image?.naturalHeight) return;

  const width = stage.clientWidth;
  const height = stage.clientHeight;
  if (!width || !height) return;
  const fitScale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
  const zoom = Math.max(
    MIN_PREVIEW_ZOOM,
    Math.min(MAX_PREVIEW_ZOOM, Number(node.properties?.maskBrushZoom) || MIN_PREVIEW_ZOOM),
  );
  const frameWidth = Math.max(1, image.naturalWidth * fitScale * zoom);
  const frameHeight = Math.max(1, image.naturalHeight * fitScale * zoom);
  const maxPanX = Math.max(0, (frameWidth - width) / 2);
  const maxPanY = Math.max(0, (frameHeight - height) / 2);
  node._maskBrushPanX = Math.max(-maxPanX, Math.min(maxPanX, Number(node._maskBrushPanX) || 0));
  node._maskBrushPanY = Math.max(-maxPanY, Math.min(maxPanY, Number(node._maskBrushPanY) || 0));

  frame.style.width = `${frameWidth}px`;
  frame.style.height = `${frameHeight}px`;
  frame.style.left = `calc(50% + ${node._maskBrushPanX}px)`;
  frame.style.top = `calc(50% + ${node._maskBrushPanY}px)`;
  if (node._maskBrushDimensions) {
    node._maskBrushDimensions.textContent = `${image.naturalWidth} × ${image.naturalHeight} · ${Math.round(zoom * 100)}%`;
  }
}

function restoreMaskBrushDom(node) {
  const widget = node?._maskBrushWidget;
  const root = node?._maskBrushRoot;
  if (!widget?.element || !root || widget.element.contains(root)) return;
  widget.element.replaceChildren(root);
  layoutImageFrame(node);
}

function canvasPoint(node, event) {
  const canvas = node._maskBrushOverlay;
  if (!canvas?.width || !canvas?.height) return null;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) / rect.width * canvas.width)),
    y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) / rect.height * canvas.height)),
  };
}

function stampSquare(ctx, point, size) {
  const half = size / 2;
  ctx.fillRect(point.x - half, point.y - half, size, size);
}

function drawSquareSegment(ctx, from, to, size) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(distance / Math.max(1, size * 0.22)));
  for (let index = 1; index <= steps; index += 1) {
    const progress = index / steps;
    stampSquare(ctx, {
      x: from.x + dx * progress,
      y: from.y + dy * progress,
    }, size);
  }
}

function drawCircleStamp(ctx, point, size) {
  ctx.beginPath();
  ctx.arc(point.x, point.y, size / 2, 0, Math.PI * 2);
  ctx.fill();
}

function drawCircleSegment(ctx, from, to, size) {
  ctx.lineWidth = size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  drawCircleStamp(ctx, to, size);
}

function drawStrokeGeometry(ctx, stroke, color) {
  const points = stroke.points || [];
  if (!points.length) return;
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  if (stroke.shape === "square") {
    stampSquare(ctx, points[0], stroke.size);
  } else {
    drawCircleStamp(ctx, points[0], stroke.size);
  }
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    if (stroke.shape === "square") drawSquareSegment(ctx, from, to, stroke.size);
    else drawCircleSegment(ctx, from, to, stroke.size);
  }
  ctx.restore();
}

function ensureStrokeCanvas(node) {
  const maskCanvas = node._maskBrushMaskCanvas;
  if (!maskCanvas) return null;
  if (!node._maskBrushStrokeCanvas) node._maskBrushStrokeCanvas = document.createElement("canvas");
  const strokeCanvas = node._maskBrushStrokeCanvas;
  if (strokeCanvas.width !== maskCanvas.width || strokeCanvas.height !== maskCanvas.height) {
    strokeCanvas.width = maskCanvas.width;
    strokeCanvas.height = maskCanvas.height;
  }
  return strokeCanvas;
}

function clearStrokeCanvas(node) {
  const strokeCanvas = ensureStrokeCanvas(node);
  strokeCanvas?.getContext("2d")?.clearRect(0, 0, strokeCanvas.width, strokeCanvas.height);
  const liveCanvas = node._maskBrushLiveOverlay;
  liveCanvas?.getContext("2d")?.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
}

function compositeStroke(node, targetContext, stroke) {
  const strokeCanvas = ensureStrokeCanvas(node);
  if (!strokeCanvas || !targetContext) return;
  clearStrokeCanvas(node);
  drawStrokeGeometry(strokeCanvas.getContext("2d"), stroke, "#ffffff");
  targetContext.save();
  targetContext.globalCompositeOperation = "source-over";
  targetContext.globalAlpha = Math.max(0.01, Math.min(1, stroke.opacity));
  targetContext.drawImage(strokeCanvas, 0, 0);
  targetContext.restore();
}

function renderOverlay(node) {
  const maskCanvas = node._maskBrushMaskCanvas;
  const overlay = node._maskBrushOverlay;
  if (!maskCanvas || !overlay) return;
  const overlayContext = overlay.getContext("2d");
  overlayContext.clearRect(0, 0, overlay.width, overlay.height);
  overlayContext.globalCompositeOperation = "source-over";
  overlayContext.globalAlpha = 1;
  overlayContext.drawImage(maskCanvas, 0, 0);
  overlayContext.globalCompositeOperation = "source-in";
  overlayContext.fillStyle = "#ef3f55";
  overlayContext.fillRect(0, 0, overlay.width, overlay.height);
  overlayContext.globalCompositeOperation = "source-over";
}

function drawIncrement(node, stroke, from, to) {
  const strokeCanvas = ensureStrokeCanvas(node);
  const strokeContext = strokeCanvas?.getContext("2d");
  const liveContext = node._maskBrushLiveOverlay?.getContext("2d");
  if (!strokeContext || !liveContext) return;

  const fragment = { ...stroke, points: from && to ? [from, to] : [to || from] };
  drawStrokeGeometry(strokeContext, fragment, "#ffffff");
  drawStrokeGeometry(liveContext, fragment, "#ef3f55");
}

function redrawMask(node) {
  const maskCanvas = node._maskBrushMaskCanvas;
  const overlay = node._maskBrushOverlay;
  if (!maskCanvas || !overlay) return;
  const maskContext = maskCanvas.getContext("2d");
  const overlayContext = overlay.getContext("2d");
  maskContext.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  overlayContext.clearRect(0, 0, overlay.width, overlay.height);

  if (node._maskBrushBaseMask) {
    maskContext.drawImage(node._maskBrushBaseMask, 0, 0, maskCanvas.width, maskCanvas.height);
  }
  for (const stroke of node._maskBrushStrokes || []) {
    compositeStroke(node, maskContext, stroke);
  }
  clearStrokeCanvas(node);
  renderOverlay(node);
  updateActionState(node);
}

function updateActionState(node) {
  if (node._maskBrushUndoButton) {
    node._maskBrushUndoButton.disabled = !(node._maskBrushStrokes?.length > 0);
  }
  if (node._maskBrushClearButton) {
    node._maskBrushClearButton.disabled = !node._maskBrushBaseMask && !(node._maskBrushStrokes?.length > 0);
  }
}

function resetMaskState(node, clearStoredValue = true) {
  node._maskBrushSaveGeneration = (node._maskBrushSaveGeneration || 0) + 1;
  node._maskBrushBaseMask = null;
  node._maskBrushStrokes = [];
  node._maskBrushCurrentStroke = null;
  if (node._maskBrushMaskCanvas) {
    node._maskBrushMaskCanvas.getContext("2d").clearRect(
      0, 0, node._maskBrushMaskCanvas.width, node._maskBrushMaskCanvas.height,
    );
  }
  if (node._maskBrushOverlay) {
    node._maskBrushOverlay.getContext("2d").clearRect(
      0, 0, node._maskBrushOverlay.width, node._maskBrushOverlay.height,
    );
  }
  clearStrokeCanvas(node);
  if (clearStoredValue) {
    const widget = findWidget(node, MASK_WIDGET);
    if (widget) widget.value = "";
    const inverseWidget = findWidget(node, INVERSE_MASK_WIDGET);
    if (inverseWidget) inverseWidget.value = "";
  }
  updateActionState(node);
}

async function uploadMask(node) {
  const canvas = node._maskBrushMaskCanvas;
  const widget = findWidget(node, MASK_WIDGET);
  if (!canvas || !widget || !node._maskBrushImageReady) return widget?.value || "";
  if (!node._maskBrushBaseMask && !(node._maskBrushStrokes?.length > 0)) {
    widget.value = "";
    setStatus(node, "遮罩为空");
    return "";
  }

  const generation = (node._maskBrushSaveGeneration || 0) + 1;
  node._maskBrushSaveGeneration = generation;
  setStatus(node, "正在保存遮罩…", "saving");
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("无法生成遮罩 PNG");

  const filename = `mask-brush-${node.id ?? "node"}-${Date.now()}.png`;
  const form = new FormData();
  form.append("image", blob, filename);
  form.append("type", "input");
  form.append("subfolder", MASK_SUBFOLDER);
  form.append("overwrite", "false");
  const response = await fetch("/upload/image", { method: "POST", body: form });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `HTTP ${response.status}`);
  }
  const result = await response.json();
  if (generation !== node._maskBrushSaveGeneration) return widget.value || "";
  widget.value = annotatedFileValue({
    filename: result.name || filename,
    subfolder: result.subfolder || MASK_SUBFOLDER,
    type: result.type || "input",
  });
  setStatus(node, "遮罩已保存", "saved");
  node.graph?.setDirtyCanvas?.(true, true);
  return widget.value;
}

function queueMaskUpload(node) {
  const operation = uploadMask(node).catch((error) => {
    console.error("[ImageMaskBrush] mask upload failed", error);
    setStatus(node, `保存失败：${error.message || error}`, "error");
    return findWidget(node, MASK_WIDGET)?.value || "";
  });
  node._maskBrushSavePromise = operation;
  return operation;
}

async function restoreMask(node) {
  const widget = findWidget(node, MASK_WIDGET);
  const file = parseAnnotatedFile(widget?.value, "input");
  if (!file || !node._maskBrushMaskCanvas) {
    redrawMask(node);
    return;
  }

  const token = node._maskBrushLoadToken;
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.onload = () => {
    if (token !== node._maskBrushLoadToken) return;
    node._maskBrushBaseMask = image;
    node._maskBrushStrokes = [];
    redrawMask(node);
    setStatus(node, "已恢复工作流遮罩", "saved");
  };
  image.onerror = () => {
    if (token !== node._maskBrushLoadToken) return;
    setStatus(node, "遮罩文件读取失败，请重新绘制", "error");
  };
  image.src = viewUrl(file, true);
}

function configureCanvases(node, width, height) {
  const maskCanvas = node._maskBrushMaskCanvas;
  const overlay = node._maskBrushOverlay;
  if (!maskCanvas || !overlay) return;
  maskCanvas.width = overlay.width = Math.max(1, width);
  maskCanvas.height = overlay.height = Math.max(1, height);
  if (node._maskBrushLiveOverlay) {
    node._maskBrushLiveOverlay.width = Math.max(1, width);
    node._maskBrushLiveOverlay.height = Math.max(1, height);
  }
  ensureStrokeCanvas(node);
  clearStrokeCanvas(node);
  node._maskBrushStrokes = [];
  node._maskBrushBaseMask = null;
}

function loadSelectedImage(node, clearMask) {
  const widget = findWidget(node, IMAGE_WIDGET);
  const file = parseAnnotatedFile(widget?.value, "input");
  const token = (node._maskBrushLoadToken || 0) + 1;
  node._maskBrushLoadToken = token;
  node._maskBrushImageReady = false;
  setPaintingActive(node, false);

  if (clearMask) {
    resetMaskState(node, true);
    node.properties.maskBrushZoom = MIN_PREVIEW_ZOOM;
    node._maskBrushPanX = 0;
    node._maskBrushPanY = 0;
  }
  if (!file) {
    node._maskBrushImage?.removeAttribute("src");
    node._maskBrushFrame?.classList.add("is-empty");
    setStatus(node, "请先加载一张图像");
    return;
  }

  setStatus(node, "正在加载图像…", "saving");
  const image = node._maskBrushImage;
  const imageData = viewUrl(file, true);
  image.onload = async () => {
    if (token !== node._maskBrushLoadToken) return;
    node._maskBrushImageReady = true;
    node._maskBrushFrame.classList.remove("is-empty");
    configureCanvases(node, image.naturalWidth, image.naturalHeight);
    layoutImageFrame(node);
    setPaintingActive(node, true);
    await restoreMask(node);
    if (node._maskBrushVariant === "v2") {
      const inputSignature = imageSignatureFromSource(imageValueKey(widget?.value));
      window.OkayPixelsComfyTextureEditor?.preload?.({ imageData, inputSignature });
    }
    if (!findWidget(node, MASK_WIDGET)?.value) setStatus(node, "可直接在图像上绘制遮罩，滚轮可缩放");
  };
  image.onerror = () => {
    if (token !== node._maskBrushLoadToken) return;
    node._maskBrushFrame?.classList.add("is-empty");
    setStatus(node, "图像读取失败，请重新选择", "error");
  };
  image.src = imageData;
}

function suppressNativePreview(node) {
  const hadNativePreview = !!node.imgs?.length || node.imageIndex != null || node.imageRects != null;
  node.hideOutputImages = true;
  if (node.imgs?.length) node.imgs = [];
  node.imageIndex = null;
  node.overIndex = null;
  node.imageRects = null;
  if (hadNativePreview) node.graph?.setDirtyCanvas?.(true, false);
}

function fitNodeToContent(node) {
  suppressNativePreview(node);
  const width = Math.max(MIN_NODE_WIDTH, node.size?.[0] || MIN_NODE_WIDTH);
  const minHeight = DEFAULT_NODE_HEIGHT;
  const requestedHeight = Number(node.size?.[1]) || minHeight;
  const height = requestedHeight > MAX_NODE_HEIGHT
    ? minHeight
    : Math.max(minHeight, requestedHeight);
  node.min_size = [MIN_NODE_WIDTH, minHeight];
  if (node.size && Math.abs(node.size[0] - width) < 0.5 && Math.abs(node.size[1] - height) < 0.5) return;
  node.setSize?.([width, height]);
  if (node.size) {
    node.size[0] = width;
    node.size[1] = height;
  }
  node.graph?.setDirtyCanvas?.(true, true);
}

function createRangeControl(labelText, min, max, value) {
  const row = document.createElement("label");
  row.className = "mcimb-range-row";
  const label = document.createElement("span");
  label.textContent = labelText;
  const range = document.createElement("input");
  range.type = "range";
  range.min = String(min);
  range.max = String(max);
  range.step = "1";
  range.value = String(value);
  const output = document.createElement("output");
  output.value = String(value);
  output.textContent = String(value);
  row.append(label, range, output);
  return { row, range, output };
}

function createInterface(node) {
  const root = document.createElement("div");
  root.className = "mcimb-root";
  root.innerHTML = `
    <style>
      .mcimb-root { position: relative; box-sizing: border-box; width: 100%; height: 100%; min-height: ${VIEW_HEIGHT}px; display: flex; flex-direction: column; gap: 7px; padding: 8px; color: #f1f5f9; background: #15171b; border: 1px solid #3b4049; border-radius: 7px; font: 12px/1.35 Arial, sans-serif; overflow: hidden; }
      .mcimb-root * { box-sizing: border-box; letter-spacing: 0; }
      .mcimb-stage { position: relative; flex: 1 1 auto; min-height: 300px; overflow: hidden; border: 1px solid #343a43; border-radius: 6px; background: #0b0d10; }
      .mcimb-root.is-dragging .mcimb-stage { border-color: #7dd3fc; box-shadow: inset 0 0 0 2px rgba(125, 211, 252, .24); }
      .mcimb-frame { position: absolute; left: 50%; top: 50%; overflow: hidden; translate: -50% -50%; background: #101217; }
      .mcimb-frame.is-empty { width: 100% !important; height: 100% !important; }
      .mcimb-frame img, .mcimb-frame canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
      .mcimb-frame img { object-fit: fill; user-select: none; pointer-events: none; }
      .mcimb-live-overlay { pointer-events: none; }
      .mcimb-overlay { cursor: crosshair; touch-action: none; pointer-events: none; }
      .mcimb-root.is-painting .mcimb-overlay { pointer-events: auto; }
      .mcimb-empty { position: absolute; inset: 0; display: grid; place-items: center; color: #8f96a3; text-align: center; pointer-events: none; }
      .mcimb-frame:not(.is-empty) .mcimb-empty { display: none; }
      .mcimb-edit-anchor { position: absolute; left: 10px; top: 10px; z-index: 4; width: 68px; min-height: 36px; }
      .mcimb-edit-button { width: 62px; height: 34px; border: 1px solid #3b82f6; border-radius: 5px; padding: 0 10px; color: #fff; background: rgba(37, 99, 235, .94); cursor: pointer; font-weight: 600; opacity: 0; transform: translateY(-4px); pointer-events: auto; transition: opacity 160ms ease-out, transform 160ms ease-out, border-color 160ms ease-out, background 160ms ease-out; }
      .mcimb-edit-anchor:hover .mcimb-edit-button, .mcimb-edit-anchor:focus-within .mcimb-edit-button { opacity: 1; transform: translateY(0); }
      .mcimb-edit-button:hover { border-color: #93c5fd; background: #1d4ed8; }
      .mcimb-edit-button:focus-visible { outline: 2px solid #7dd3fc; outline-offset: 2px; }
      .mcimb-brush-panel { flex: 0 0 auto; display: grid; grid-template-columns: minmax(0, .95fr) minmax(0, 1.25fr); gap: 12px; padding: 10px 12px; border: 1px solid #3b424d; border-radius: 6px; background: #1b1e24; }
      .mcimb-brush-left, .mcimb-brush-ranges { min-width: 0; display: grid; gap: 8px; align-content: start; }
      .mcimb-field-label { color: #bdc4cf; font-size: 11px; font-weight: 600; }
      .mcimb-shapes { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
      .mcimb-shape, .mcimb-action { height: 32px; border: 1px solid #4c5562; border-radius: 5px; color: #dce2ea; background: #292e36; cursor: pointer; }
      .mcimb-shape:hover, .mcimb-action:hover:not(:disabled) { color: #fff; border-color: #737e8e; background: #343b45; }
      .mcimb-shape:focus-visible, .mcimb-action:focus-visible, .mcimb-range-row input:focus-visible { outline: 2px solid #7dd3fc; outline-offset: 2px; }
      .mcimb-shape.is-active { color: #fff; border-color: #fb7185; background: #4a2931; }
      .mcimb-range-row { display: grid; grid-template-columns: 64px minmax(0, 1fr) 42px; align-items: center; gap: 8px; color: #bdc4cf; }
      .mcimb-range-row input { width: 100%; accent-color: #fb7185; cursor: pointer; }
      .mcimb-range-row output { min-width: 42px; color: #f8fafc; text-align: right; font-variant-numeric: tabular-nums; }
      .mcimb-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
      .mcimb-action.danger { color: #fecdd3; border-color: #70404a; }
      .mcimb-action:disabled { opacity: .4; cursor: default; }
      .mcimb-footer { min-height: 18px; display: flex; align-items: center; justify-content: space-between; gap: 8px; color: #9ca3af; }
      .mcimb-status { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .mcimb-status[data-tone="saving"] { color: #fde68a; }
      .mcimb-status[data-tone="saved"] { color: #86efac; }
      .mcimb-status[data-tone="error"] { color: #fda4af; }
      .mcimb-dimensions { flex: 0 0 auto; color: #7f8793; font-variant-numeric: tabular-nums; }
      .mcimb-resize-handle { position: absolute; z-index: 20; touch-action: none; }
      .mcimb-resize-handle.right { top: 18px; right: 0; bottom: 18px; width: 8px; cursor: ew-resize; }
      .mcimb-resize-handle.bottom { right: 18px; bottom: 0; left: 18px; height: 8px; cursor: ns-resize; }
      .mcimb-resize-handle.corner { right: 0; bottom: 0; width: 18px; height: 18px; cursor: nwse-resize; }
      @media (prefers-reduced-motion: reduce) { .mcimb-edit-button { transition: none; } }
    </style>
    <div class="mcimb-stage">
      <div class="mcimb-frame is-empty">
        <img alt="遮罩绘制图像" draggable="false">
        <canvas class="mcimb-overlay" aria-label="图像遮罩绘制区域"></canvas>
        <canvas class="mcimb-live-overlay" aria-hidden="true"></canvas>
        <div class="mcimb-empty">加载图像后可直接绘制遮罩</div>
      </div>
      <div class="mcimb-edit-anchor">
        <button class="mcimb-edit-button" type="button" title="图片编辑">编辑</button>
      </div>
    </div>
    <div class="mcimb-brush-panel" role="group" aria-label="遮罩画笔设置">
      <div class="mcimb-brush-left">
        <span class="mcimb-field-label">画笔形状</span>
        <div class="mcimb-shapes">
          <button class="mcimb-shape is-active" type="button" data-shape="circle">圆形画笔</button>
          <button class="mcimb-shape" type="button" data-shape="square">方形画笔</button>
        </div>
        <div class="mcimb-actions">
          <button class="mcimb-action undo" type="button" disabled>撤销</button>
          <button class="mcimb-action danger clear" type="button" disabled>清除</button>
        </div>
      </div>
      <div class="mcimb-brush-ranges">
        <div class="mcimb-range-slot size"></div>
        <div class="mcimb-range-slot opacity"></div>
      </div>
    </div>
    <div class="mcimb-footer">
      <span class="mcimb-status">请先加载一张图像</span>
      <span class="mcimb-dimensions"></span>
    </div>
    <div class="mcimb-resize-handle right" data-resize-axis="x" aria-hidden="true"></div>
    <div class="mcimb-resize-handle bottom" data-resize-axis="y" aria-hidden="true"></div>
    <div class="mcimb-resize-handle corner" data-resize-axis="xy" aria-hidden="true"></div>
  `;

  const stage = root.querySelector(".mcimb-stage");
  const frame = root.querySelector(".mcimb-frame");
  const image = root.querySelector("img");
  const overlay = root.querySelector(".mcimb-overlay");
  const liveOverlay = root.querySelector(".mcimb-live-overlay");
  const editButton = root.querySelector(".mcimb-edit-button");
  const dimensions = root.querySelector(".mcimb-dimensions");
  const sizeControl = createRangeControl("画笔大小", 1, 512, node.properties.maskBrushSize || 80);
  const opacityControl = createRangeControl("透明度", 1, 100, Math.round((node.properties.maskBrushOpacity || 0.85) * 100));
  root.querySelector(".mcimb-range-slot.size").append(sizeControl.row);
  root.querySelector(".mcimb-range-slot.opacity").append(opacityControl.row);

  node._maskBrushRoot = root;
  node._maskBrushStage = stage;
  node._maskBrushFrame = frame;
  node._maskBrushImage = image;
  node._maskBrushOverlay = overlay;
  node._maskBrushLiveOverlay = liveOverlay;
  node._maskBrushMaskCanvas = document.createElement("canvas");
  node._maskBrushEditButton = editButton;
  node._maskBrushDimensions = dimensions;
  node._maskBrushStatus = root.querySelector(".mcimb-status");
  node._maskBrushUndoButton = root.querySelector(".undo");
  node._maskBrushClearButton = root.querySelector(".clear");

  for (const handle of root.querySelectorAll(".mcimb-resize-handle")) {
    const axis = handle.dataset.resizeAxis || "xy";
    let resizePointerId = null;
    let resizeStartX = 0;
    let resizeStartY = 0;
    let resizeStartWidth = 0;
    let resizeStartHeight = 0;

    const moveResize = (event) => {
      if (event.pointerId !== resizePointerId) return;
      event.preventDefault();
      event.stopPropagation();
      const canvasScale = Math.max(0.05, Number(app.canvas?.ds?.scale) || 1);
      const nextWidth = axis.includes("x")
        ? Math.max(MIN_NODE_WIDTH, resizeStartWidth + (event.clientX - resizeStartX) / canvasScale)
        : resizeStartWidth;
      const nextHeight = axis.includes("y")
        ? Math.max(DEFAULT_NODE_HEIGHT, Math.min(MAX_NODE_HEIGHT, resizeStartHeight + (event.clientY - resizeStartY) / canvasScale))
        : resizeStartHeight;
      node.setSize?.([nextWidth, nextHeight]);
      if (node.size) {
        node.size[0] = nextWidth;
        node.size[1] = nextHeight;
      }
      node.graph?.setDirtyCanvas?.(true, true);
      layoutImageFrame(node);
    };
    const finishResize = (event) => {
      if (event.pointerId !== resizePointerId) return;
      event.preventDefault();
      event.stopPropagation();
      resizePointerId = null;
      document.removeEventListener("pointermove", moveResize, true);
      document.removeEventListener("pointerup", finishResize, true);
      document.removeEventListener("pointercancel", finishResize, true);
    };
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      resizePointerId = event.pointerId;
      resizeStartX = event.clientX;
      resizeStartY = event.clientY;
      resizeStartWidth = node.size?.[0] || MIN_NODE_WIDTH;
      resizeStartHeight = node.size?.[1] || DEFAULT_NODE_HEIGHT;
      document.addEventListener("pointermove", moveResize, true);
      document.addEventListener("pointerup", finishResize, true);
      document.addEventListener("pointercancel", finishResize, true);
    });
  }

  image.addEventListener("load", () => {
    layoutImageFrame(node);
  });

  editButton.addEventListener("click", (event) => {
    event.stopPropagation();
    openImageEditor(node);
  });

  stage.addEventListener("wheel", (event) => {
    if (!node._maskBrushImageReady) return;
    event.preventDefault();
    event.stopPropagation();

    const oldZoom = Math.max(
      MIN_PREVIEW_ZOOM,
      Math.min(MAX_PREVIEW_ZOOM, Number(node.properties.maskBrushZoom) || MIN_PREVIEW_ZOOM),
    );
    const wheelDelta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    const nextZoom = Math.max(
      MIN_PREVIEW_ZOOM,
      Math.min(MAX_PREVIEW_ZOOM, oldZoom * Math.exp(-wheelDelta * 0.0015)),
    );
    if (Math.abs(nextZoom - oldZoom) < 0.001) return;

    const rect = stage.getBoundingClientRect();
    const pointerX = event.clientX - rect.left - rect.width / 2;
    const pointerY = event.clientY - rect.top - rect.height / 2;
    const panX = Number(node._maskBrushPanX) || 0;
    const panY = Number(node._maskBrushPanY) || 0;
    const zoomRatio = nextZoom / oldZoom;
    node._maskBrushPanX = pointerX - (pointerX - panX) * zoomRatio;
    node._maskBrushPanY = pointerY - (pointerY - panY) * zoomRatio;
    node.properties.maskBrushZoom = nextZoom;
    if (nextZoom <= MIN_PREVIEW_ZOOM + 0.001) {
      node._maskBrushPanX = 0;
      node._maskBrushPanY = 0;
    }
    layoutImageFrame(node);
  }, { passive: false, capture: true });

  let panPointerId = null;
  let panLastX = 0;
  let panLastY = 0;
  stage.addEventListener("pointerdown", (event) => {
    if (event.button !== 1 || !node._maskBrushImageReady) return;
    event.preventDefault();
    event.stopPropagation();
    panPointerId = event.pointerId;
    panLastX = event.clientX;
    panLastY = event.clientY;
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener("pointermove", (event) => {
    if (event.pointerId !== panPointerId) return;
    event.preventDefault();
    event.stopPropagation();
    node._maskBrushPanX = (Number(node._maskBrushPanX) || 0) + event.clientX - panLastX;
    node._maskBrushPanY = (Number(node._maskBrushPanY) || 0) + event.clientY - panLastY;
    panLastX = event.clientX;
    panLastY = event.clientY;
    layoutImageFrame(node);
  });
  const finishPan = (event) => {
    if (event.pointerId !== panPointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    panPointerId = null;
  };
  stage.addEventListener("pointerup", finishPan);
  stage.addEventListener("pointercancel", finishPan);

  for (const button of root.querySelectorAll(".mcimb-shape")) {
    button.classList.toggle("is-active", button.dataset.shape === node.properties.maskBrushShape);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      node.properties.maskBrushShape = button.dataset.shape;
      for (const item of root.querySelectorAll(".mcimb-shape")) {
        item.classList.toggle("is-active", item === button);
      }
    });
  }

  sizeControl.range.addEventListener("input", () => {
    node.properties.maskBrushSize = Number(sizeControl.range.value);
    sizeControl.output.value = sizeControl.range.value;
    sizeControl.output.textContent = sizeControl.range.value;
  });
  opacityControl.range.addEventListener("input", () => {
    node.properties.maskBrushOpacity = Number(opacityControl.range.value) / 100;
    opacityControl.output.value = `${opacityControl.range.value}%`;
    opacityControl.output.textContent = `${opacityControl.range.value}%`;
  });
  opacityControl.output.value = `${opacityControl.range.value}%`;
  opacityControl.output.textContent = `${opacityControl.range.value}%`;

  node._maskBrushUndoButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!node._maskBrushStrokes?.length) return;
    node._maskBrushStrokes.pop();
    redrawMask(node);
    queueMaskUpload(node);
  });
  node._maskBrushClearButton.addEventListener("click", (event) => {
    event.stopPropagation();
    resetMaskState(node, true);
    setStatus(node, "遮罩已清空");
    node.graph?.setDirtyCanvas?.(true, true);
  });

  const pendingPoints = [];
  let drawFrame = 0;
  const appendPendingPoints = (event) => {
    const events = event.getCoalescedEvents?.() || [event];
    for (const item of events) {
      const point = canvasPoint(node, item);
      if (point) pendingPoints.push(point);
    }
  };
  const flushPoint = () => {
    drawFrame = 0;
    const stroke = node._maskBrushCurrentStroke;
    if (!stroke) {
      pendingPoints.length = 0;
      return;
    }
    while (pendingPoints.length) {
      const point = pendingPoints.shift();
      const previous = stroke.points[stroke.points.length - 1];
      if (Math.hypot(point.x - previous.x, point.y - previous.y) < 0.2) continue;
      stroke.points.push(point);
      drawIncrement(node, stroke, previous, point);
    }
  };

  overlay.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !node._maskBrushImageReady) return;
    event.preventDefault();
    event.stopPropagation();
    const point = canvasPoint(node, event);
    if (!point) return;
    overlay.setPointerCapture(event.pointerId);
    const stroke = {
      shape: node.properties.maskBrushShape || "circle",
      size: Math.max(1, Number(node.properties.maskBrushSize) || 80),
      opacity: Math.max(0.01, Math.min(1, Number(node.properties.maskBrushOpacity) || 0.85)),
      points: [point],
    };
    clearStrokeCanvas(node);
    liveOverlay.style.opacity = String(stroke.opacity);
    pendingPoints.length = 0;
    node._maskBrushCurrentStroke = stroke;
    node._maskBrushStrokes.push(stroke);
    drawIncrement(node, stroke, null, point);
    updateActionState(node);
  });
  overlay.addEventListener("pointermove", (event) => {
    if (!node._maskBrushCurrentStroke) return;
    event.preventDefault();
    event.stopPropagation();
    appendPendingPoints(event);
    if (!drawFrame) drawFrame = requestAnimationFrame(flushPoint);
  });
  const finishStroke = (event) => {
    if (!node._maskBrushCurrentStroke) return;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (event) appendPendingPoints(event);
    if (drawFrame) {
      cancelAnimationFrame(drawFrame);
    }
    flushPoint();
    const stroke = node._maskBrushCurrentStroke;
    compositeStroke(node, node._maskBrushMaskCanvas?.getContext("2d"), stroke);
    clearStrokeCanvas(node);
    renderOverlay(node);
    node._maskBrushCurrentStroke = null;
    if (event && overlay.hasPointerCapture(event.pointerId)) overlay.releasePointerCapture(event.pointerId);
    queueMaskUpload(node);
    node.graph?.setDirtyCanvas?.(true, true);
  };
  overlay.addEventListener("pointerup", finishStroke);
  overlay.addEventListener("pointercancel", finishStroke);

  for (const eventName of ["dragenter", "dragover"]) {
    root.addEventListener(eventName, (event) => {
      if (![...(event.dataTransfer?.files || [])].some(isImageFile) && eventName === "dragenter") return;
      event.preventDefault();
      event.stopPropagation();
      root.classList.add("is-dragging");
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    });
  }
  root.addEventListener("dragleave", (event) => {
    if (!root.contains(event.relatedTarget)) root.classList.remove("is-dragging");
  });
  root.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    root.classList.remove("is-dragging");
    const file = [...(event.dataTransfer?.files || [])].find(isImageFile);
    if (file) uploadDroppedImage(node, file);
  });

  for (const eventName of ["pointerdown", "pointermove", "pointerup", "wheel", "click"]) {
    root.querySelector(".mcimb-brush-panel").addEventListener(eventName, (event) => event.stopPropagation());
  }
  return root;
}

function initNode(node) {
  if (!node || node._imageMaskBrushReady) return;
  const imageWidget = findWidget(node, IMAGE_WIDGET);
  const maskWidget = findWidget(node, MASK_WIDGET);
  const inverseMaskWidget = findWidget(node, INVERSE_MASK_WIDGET);
  const originalNameWidget = findWidget(node, ORIGINAL_NAME_WIDGET);
  const originalImageWidget = findWidget(node, ORIGINAL_IMAGE_WIDGET);
  const requiresOriginalImage = node._maskBrushVariant === "v2";
  if (!imageWidget || !maskWidget || !inverseMaskWidget || !originalNameWidget || (requiresOriginalImage && !originalImageWidget)) {
    setTimeout(() => initNode(node), 50);
    return;
  }

  node._imageMaskBrushReady = true;
  node.properties ||= {};
  node.properties.maskBrushShape ||= "circle";
  node.properties.maskBrushSize ||= 80;
  node.properties.maskBrushOpacity ||= 0.85;
  node.properties.maskBrushZoom = Math.max(
    MIN_PREVIEW_ZOOM,
    Math.min(MAX_PREVIEW_ZOOM, Number(node.properties.maskBrushZoom) || MIN_PREVIEW_ZOOM),
  );
  node._maskBrushStrokes = [];
  hideWidget(node, MASK_WIDGET);
  hideWidget(node, INVERSE_MASK_WIDGET);
  hideWidget(node, ORIGINAL_NAME_WIDGET);
  if (node._maskBrushVariant === "v2") {
    hideWidget(node, TEXTURE_FILE_WIDGET);
    hideWidget(node, TEXTURE_TRANSFORM_WIDGET);
    hideWidget(node, ORIGINAL_IMAGE_WIDGET);
  }
  const currentImageName = originalNameFromImage(imageWidget.value);
  const storedOriginalName = String(originalNameWidget.value || "").trim();
  if (!storedOriginalName || (storedOriginalName === "image" && currentImageName !== "image")) {
    originalNameWidget.value = currentImageName;
  }
  if (originalImageWidget && !String(originalImageWidget.value || "").trim()) {
    const resolvedOriginalName = String(originalNameWidget.value || "").trim();
    originalImageWidget.value = findOriginalImageValue(imageWidget, resolvedOriginalName)
      || annotatedImageValue(imageWidget.value);
  }

  const root = createInterface(node);
  const widget = node.addDOMWidget("image_mask_brush", "MYCOMFNODE_IMAGE_MASK_BRUSH", root, {
    serialize: false,
    hideOnZoom: false,
    getValue: () => "",
    setValue: () => {},
  });
  widget.serialize = false;
  node._maskBrushWidget = widget;
  // computeSize must not depend on the current node height. ComfyUI includes this
  // value when calculating node height, so feeding the result back causes growth.
  widget.computeSize = (width) => [Math.max(MIN_NODE_WIDTH, width || MIN_NODE_WIDTH), VIEW_HEIGHT];
  fitNodeToContent(node);
  requestAnimationFrame(() => fitNodeToContent(node));
  setTimeout(() => fitNodeToContent(node), 80);

  node.onDrawBackground = function() {
    restoreMaskBrushDom(this);
    suppressNativePreview(this);
  };

  const originalDrawForeground = node.onDrawForeground;
  node.onDrawForeground = function() {
    const result = originalDrawForeground?.apply?.(this, arguments);
    restoreMaskBrushDom(this);
    suppressNativePreview(this);
    return result;
  };

  const originalOnResize = node.onResize;
  node.onResize = function() {
    const result = originalOnResize?.apply?.(this, arguments);
    fitNodeToContent(this);
    if (widget.element) {
      const contentHeight = Math.max(VIEW_HEIGHT, Math.min(MAX_NODE_HEIGHT, this.size?.[1] || DEFAULT_NODE_HEIGHT) - NODE_SHELL_HEIGHT);
      widget.element.style.height = `${contentHeight}px`;
    }
    requestAnimationFrame(() => layoutImageFrame(this));
    return result;
  };

  const originalMaskSerializer = maskWidget.serializeValue?.bind(maskWidget);
  maskWidget.serializeValue = async () => {
    if (node._maskBrushSavePromise) {
      try {
        await node._maskBrushSavePromise;
      } catch {
        // Preserve the previous valid value; the visible status already explains the failure.
      }
    }
    return maskWidget.value ?? await originalMaskSerializer?.() ?? "";
  };

  const originalInverseMaskSerializer = inverseMaskWidget.serializeValue?.bind(inverseMaskWidget);
  inverseMaskWidget.serializeValue = async () => {
    if (node._maskBrushSavePromise) {
      try {
        await node._maskBrushSavePromise;
      } catch {
        // Preserve the previous valid value; the visible status already explains the failure.
      }
    }
    return inverseMaskWidget.value ?? await originalInverseMaskSerializer?.() ?? "";
  };

  const originalImageCallback = imageWidget.callback?.bind(imageWidget);
  imageWidget.callback = function(value) {
    const result = originalImageCallback?.apply?.(this, arguments);
    if (node._maskBrushPreserveOriginalNameOnce) {
      node._maskBrushPreserveOriginalNameOnce = false;
    } else {
      originalNameWidget.value = originalNameFromImage(imageWidget.value ?? value ?? "");
    }
    if (originalImageWidget) {
      if (node._maskBrushPreserveOriginalImageOnce) {
        node._maskBrushPreserveOriginalImageOnce = false;
      } else {
        originalImageWidget.value = annotatedImageValue(imageWidget.value ?? value ?? "");
      }
    }
    setTimeout(() => {
      const nextValue = imageValueKey(imageWidget.value ?? value ?? "");
      if (nextValue !== node._maskBrushObservedImage) {
        node._maskBrushObservedImage = nextValue;
        loadSelectedImage(node, true);
      }
    }, 0);
    return result;
  };

  node._maskBrushObservedImage = imageValueKey(imageWidget.value);
  loadSelectedImage(node, false);
  suppressNativePreview(node);
  node._maskBrushWatchTimer = setInterval(() => {
    const current = imageValueKey(findWidget(node, IMAGE_WIDGET)?.value);
    if (current !== node._maskBrushObservedImage) {
      node._maskBrushObservedImage = current;
      loadSelectedImage(node, true);
    }
    suppressNativePreview(node);
  }, 300);

  node._maskBrushResizeObserver = new ResizeObserver(() => layoutImageFrame(node));
  node._maskBrushResizeObserver.observe(node._maskBrushStage);

  const originalDragOver = node.onDragOver;
  node.onDragOver = function(event) {
    if ([...(event?.dataTransfer?.files || [])].some(isImageFile)) {
      event.preventDefault?.();
      root.classList.add("is-dragging");
      return true;
    }
    return originalDragOver?.apply?.(this, arguments) ?? false;
  };
  const originalDragDrop = node.onDragDrop;
  node.onDragDrop = function(event) {
    const file = [...(event?.dataTransfer?.files || [])].find(isImageFile);
    if (file) {
      event.preventDefault?.();
      uploadDroppedImage(this, file);
      return true;
    }
    return originalDragDrop?.apply?.(this, arguments) ?? false;
  };

  const originalRemoved = node.onRemoved;
  node.onRemoved = function() {
    clearInterval(this._maskBrushWatchTimer);
    this._maskBrushResizeObserver?.disconnect();
    return originalRemoved?.apply?.(this, arguments);
  };
}

function initializeAndFit(node) {
  initNode(node);
  for (const delay of [0, 120, 600]) {
    setTimeout(() => {
      initNode(node);
      if (node?._imageMaskBrushReady) fitNodeToContent(node);
    }, delay);
  }
}

function installV2OutputIsolation() {
  if (api.queuePrompt?._myComfnodeMaskBrushV2Isolation) return;
  const previousQueuePrompt = api.queuePrompt;

  const wrappedQueuePrompt = async function(index, prompt, ...args) {
    const output = prompt?.output;
    if (output && typeof output === "object") {
      const v2Nodes = Object.entries(output).filter(([, node]) => node?.class_type === V2_NODE_CLASS);
      for (const [nodeId, node] of v2Nodes) {
        const inputs = node.inputs || {};
        const sourceId = `__mycmb_v2_source_${nodeId}`;
        const masksId = `__mycmb_v2_masks_${nodeId}`;

        output[sourceId] = {
          class_type: V2_SOURCE_CLASS,
          inputs: {
            image: inputs.image,
            original_name: inputs.original_name ?? "",
            texture_file: inputs.texture_file ?? "",
            texture_transform: inputs.texture_transform ?? "",
            original_image: inputs.original_image ?? "",
            ...(inputs.depth_map !== undefined ? { depth_map: inputs.depth_map } : {}),
          },
        };
        output[masksId] = {
          class_type: V2_MASKS_CLASS,
          inputs: {
            image: inputs.image,
            mask_file: inputs.mask_file ?? "",
            inverse_mask_file: inputs.inverse_mask_file ?? "",
            original_name: inputs.original_name ?? "",
          },
        };

        const replacements = new Map([
          [0, [sourceId, 0]], // 绘画图像
          [1, [masksId, 0]],  // 手绘遮罩
          [2, [masksId, 1]],  // 反向遮罩
          [3, [sourceId, 1]], // 贴图遮罩
          [4, [masksId, 2]],  // 原图原名称
          [5, [sourceId, 3]], // 原图
        ]);

        for (const target of Object.values(output)) {
          for (const [name, value] of Object.entries(target?.inputs || {})) {
            if (!Array.isArray(value) || value.length !== 2 || String(value[0]) !== String(nodeId)) continue;
            const replacement = replacements.get(Number(value[1]));
            if (replacement) target.inputs[name] = [...replacement];
          }
        }
      }
    }
    return previousQueuePrompt.call(this, index, prompt, ...args);
  };

  wrappedQueuePrompt._myComfnodeMaskBrushV2Isolation = true;
  wrappedQueuePrompt._myComfnodeMaskBrushV2Previous = previousQueuePrompt;
  api.queuePrompt = wrappedQueuePrompt;
}

export function registerImageMaskBrushExtension({ nodeClass = NODE_CLASS, variant = "v1" } = {}) {
  const extensionGuard = `__myComfnodeImageMaskBrushRegistered_${nodeClass}`;
  if (globalThis[extensionGuard]) return;
  globalThis[extensionGuard] = true;
  if (variant === "v2") installV2OutputIsolation();
  app.registerExtension({
    name: `MyComfnode.ImageMaskBrush.${variant}`,
    async nodeCreated(node) {
      if (node?.comfyClass === nodeClass || node?.type === nodeClass) {
        node._maskBrushVariant = variant;
        initializeAndFit(node);
      }
    },
    async loadedGraphNode(node) {
      if (node?.comfyClass === nodeClass || node?.type === nodeClass) {
        node._maskBrushVariant = variant;
        initializeAndFit(node);
      }
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
      if (nodeData.name !== nodeClass) return;
      const originalCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function() {
        const result = originalCreated?.apply?.(this, arguments);
        this._maskBrushVariant = variant;
        initializeAndFit(this);
        return result;
      };
      const originalConfigured = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function() {
        const result = originalConfigured?.apply?.(this, arguments);
        this._maskBrushVariant = variant;
        initializeAndFit(this);
        return result;
      };
    },
  });
}

registerImageMaskBrushExtension();
